import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The confirmation page's API (#470).
 *
 * Where the person presses Send, so the one door the model must never open:
 * only the website's own application may call it, only for the caller's own
 * draft, and a refusal is worded for the page rather than for a model. These
 * drive the real handler; authentication's outcome, the draft store, the send
 * service, the outbox and the balance read are faked.
 */

vi.mock('../../../src/api/middleware/restAuth.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/api/middleware/restAuth.js')>()),
  authenticateRestRequest: vi.fn()
}));
vi.mock('../../../src/api/middleware/rateLimit.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/api/middleware/rateLimit.js')>()),
  rateLimitAccount: vi.fn()
}));
vi.mock('../../../src/services/draftService.js', () => ({ getDraft: vi.fn() }));
vi.mock('../../../src/services/mailSendService.js', () => ({ createMailOrderFromDraft: vi.fn() }));
vi.mock('../../../src/services/letterJobService.js', () => ({ processLetterJob: vi.fn() }));
vi.mock('../../../src/db/index.js', () => ({ query: vi.fn() }));

import { authenticateRestRequest } from '../../../src/api/middleware/restAuth.js';
import { rateLimitAccount } from '../../../src/api/middleware/rateLimit.js';
import { getDraft } from '../../../src/services/draftService.js';
import { createMailOrderFromDraft } from '../../../src/services/mailSendService.js';
import { processLetterJob } from '../../../src/services/letterJobService.js';
import { query } from '../../../src/db/index.js';
import { DuplicateMailError } from '../../../src/services/duplicateMailService.js';
import { SpendLimitError } from '../../../src/services/betaSpendLimits.js';
import { BETA_ACCESS_MESSAGE } from '../../../src/auth/betaAccess.js';
import {
  handleSendConfirmationApiRequest,
  refusalFor
} from '../../../src/api/sendConfirmationApiHandler.js';
import * as diagnostics from '../../../src/utils/diagnosticLog.js';

const DRAFT_ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
const PATH = `/api/sends/${DRAFT_ID}`;
const WEBSITE = 'WebsiteClient01';

function request(method: string, body?: string): IncomingMessage {
  return Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), {
    method,
    headers: { authorization: 'Bearer x' }
  }) as unknown as IncomingMessage;
}

function response() {
  const state = { status: 0, body: '', headers: {} as Record<string, unknown> };
  const res = {
    statusCode: 0,
    setHeader(name: string, value: unknown) {
      state.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      state.status = this.statusCode;
      state.body = chunk ?? '';
    }
  };
  return { res: res as unknown as ServerResponse, state, json: () => JSON.parse(state.body) };
}

function signedIn(clientId: string | null = WEBSITE, userId = 'auth0|owner') {
  vi.mocked(authenticateRestRequest).mockResolvedValue({
    ok: true,
    user: { userId, scopes: ['mail:read', 'mail:draft', 'mail:send'], clientId: clientId ?? undefined }
  });
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    draft_id: DRAFT_ID,
    user_id: 'auth0|owner',
    mail_type: 'letter',
    status: 'pending',
    expires_at: new Date(Date.now() + 3_600_000),
    required_credits: 2,
    recipient: { name: 'Sam Rivera', addressLine1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
    sender: { name: 'Ada', addressLine1: '2 Oak Ave', city: 'Austin', state: 'TX', postalCode: '78702' },
    body_text: 'Hello',
    sign_off: 'Love',
    preview_html: '<div>preview</div>',
    ...overrides
  };
}

async function call(method: string, body?: string, path = PATH) {
  const out = response();
  const handled = await handleSendConfirmationApiRequest(request(method, body), out.res, path);
  return { handled, ...out };
}

describe('the confirmation page API (#470)', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('LETTER_IRL_SEND_CONFIRMATION_ENABLED', 'true');
    vi.stubEnv('LETTER_IRL_WEBSITE_CLIENT_ID', WEBSITE);
    vi.mocked(authenticateRestRequest).mockReset();
    vi.mocked(rateLimitAccount).mockReset();
    vi.mocked(rateLimitAccount).mockResolvedValue(false);
    vi.mocked(getDraft).mockReset();
    vi.mocked(createMailOrderFromDraft).mockReset();
    vi.mocked(processLetterJob).mockReset();
    vi.mocked(query).mockReset();
    vi.mocked(query).mockResolvedValue({ rows: [{ credits: 7 }] } as any);
    writeSpy = vi.spyOn(diagnostics, 'writeDiagnostic').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    writeSpy.mockRestore();
  });

  it('leaves other paths to the next handler', async () => {
    expect((await call('GET', undefined, '/api/sendsx')).handled).toBe(false);
    expect((await call('GET', undefined, '/api/letters')).handled).toBe(false);
  });

  it('does not exist while the rule is off', async () => {
    vi.stubEnv('LETTER_IRL_SEND_CONFIRMATION_ENABLED', 'false');
    signedIn();
    const { handled, state } = await call('POST');
    expect(handled).toBe(true);
    expect(state.status).toBe(404);
    expect(authenticateRestRequest).not.toHaveBeenCalled();
    expect(createMailOrderFromDraft).not.toHaveBeenCalled();
  });

  it('answers 404 for the bare prefix and deeper paths', async () => {
    signedIn();
    expect((await call('GET', undefined, '/api/sends')).state.status).toBe(404);
    expect((await call('GET', undefined, `/api/sends/${DRAFT_ID}/x`)).state.status).toBe(404);
  });

  it('allows only GET and POST', async () => {
    const { state } = await call('DELETE');
    expect(state.status).toBe(405);
    expect(state.headers.allow).toBe('GET, POST');
  });

  it("asks for the route's scope: read to look, send to send", async () => {
    signedIn();
    vi.mocked(getDraft).mockResolvedValue(draft() as any);
    await call('GET');
    expect(authenticateRestRequest).toHaveBeenLastCalledWith(expect.anything(), ['mail:read']);
    vi.mocked(createMailOrderFromDraft).mockResolvedValue({ alreadyConsumed: true, letter: { letter_id: 'L1' }, creditsRemaining: 4 } as any);
    await call('POST');
    expect(authenticateRestRequest).toHaveBeenLastCalledWith(expect.anything(), ['mail:send']);
  });

  it('passes an authentication failure through with its own status', async () => {
    vi.mocked(authenticateRestRequest).mockResolvedValue({ ok: false, reason: 'rejected', status: 401, message: 'no' });
    const { state } = await call('POST');
    expect(state.status).toBe(401);
    expect(getDraft).not.toHaveBeenCalled();
  });

  it.each([
    ['an MCP client', 'https://claude.ai/oauth/mcp-oauth-client-metadata'],
    ['ChatGPT', 'https://chatgpt.com/oauth/AbC123/client.json'],
    ['a token with no application', null]
  ])('refuses %s before reading the draft', async (_label, clientId) => {
    signedIn(clientId);
    const { state, json } = await call('POST', '{}');
    expect(state.status).toBe(403);
    expect(json()).toEqual({ error: 'website_only', message: 'Mail is sent from letterirl.com.' });
    expect(getDraft).not.toHaveBeenCalled();
    expect(createMailOrderFromDraft).not.toHaveBeenCalled();
  });

  it('refuses everyone while no website application is configured', async () => {
    vi.stubEnv('LETTER_IRL_WEBSITE_CLIENT_ID', '');
    signedIn('');
    const { state } = await call('POST', '{}');
    expect(state.status).toBe(403);
    expect(writeSpy).toHaveBeenCalledWith('warn', 'send.confirmation_client_refused', { configured: false });
  });

  it("answers someone else's draft exactly as a missing one", async () => {
    signedIn();
    vi.mocked(getDraft).mockResolvedValue(draft({ user_id: 'auth0|someone-else' }) as any);
    const theirs = await call('GET');
    vi.mocked(getDraft).mockResolvedValue(null);
    const missing = await call('GET');
    expect(theirs.state.status).toBe(404);
    expect(theirs.state.body).toBe(missing.state.body);
  });

  it.each(['not-a-uuid', '%E0%A4%A', `${DRAFT_ID}x`])('never asks the database about %j', async (id) => {
    signedIn();
    const { state } = await call('GET', undefined, `/api/sends/${id}`);
    expect(state.status).toBe(404);
    expect(getDraft).not.toHaveBeenCalled();
  });

  describe('GET', () => {
    it('shows a ready draft with its preview, cost and balance', async () => {
      signedIn();
      vi.mocked(getDraft).mockResolvedValue(draft() as any);
      const { state, json } = await call('GET');
      expect(state.status).toBe(200);
      expect(json()).toMatchObject({
        draftId: DRAFT_ID,
        mailType: 'letter',
        state: 'ready',
        orderId: null,
        previewHtml: '<div>preview</div>',
        lettersRequired: 1,
        lettersAvailable: 3,
        isGiftSend: false,
        recipient: { name: 'Sam Rivera', addressLine1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701' }
      });
      // Only the address fields the page shows.
      expect(json().recipient.country).toBeUndefined();
      expect(query).toHaveBeenCalledWith('SELECT credits FROM users WHERE user_id = $1', ['auth0|owner']);
    });

    it.each([
      ['sent', { status: 'consumed', consumed_letter_id: 'L9' }, 'L9'],
      ['expired', { status: 'expired' }, null],
      ['expired', { status: 'cancelled' }, null],
      ['expired', { expires_at: new Date(Date.now() - 1000) }, null]
    ])('shows a %s draft as such', async (expected, overrides, orderId) => {
      signedIn();
      vi.mocked(getDraft).mockResolvedValue(draft(overrides) as any);
      const { json } = await call('GET');
      expect(json().state).toBe(expected);
      expect(json().orderId).toBe(orderId);
    });

    it('counts a long letter and a postcard as the preview tools do', async () => {
      signedIn();
      vi.mocked(getDraft).mockResolvedValue(draft({ required_credits: 5 }) as any);
      expect((await call('GET')).json().lettersRequired).toBe(3);
      vi.mocked(getDraft).mockResolvedValue(draft({ mail_type: 'postcard', required_credits: 4 }) as any);
      expect((await call('GET')).json().lettersRequired).toBe(1);
    });
  });

  describe('POST', () => {
    const created = {
      alreadyConsumed: false,
      letter: { letter_id: 'L1' },
      job: { job_id: 'J1' },
      creditsRemaining: 5
    };

    it("sends the person's own draft and hands it to the printer", async () => {
      signedIn();
      vi.mocked(getDraft).mockResolvedValue(draft() as any);
      vi.mocked(createMailOrderFromDraft).mockResolvedValue(created as any);
      const { state, json } = await call('POST', '{}');
      expect(createMailOrderFromDraft).toHaveBeenCalledWith({
        draftId: DRAFT_ID,
        userId: 'auth0|owner',
        mailType: 'letter',
        allowDuplicate: false
      });
      expect(processLetterJob).toHaveBeenCalledWith('J1');
      expect(state.status).toBe(200);
      expect(json()).toEqual({ orderId: 'L1', alreadySent: false, lettersRemaining: 2 });
      expect(writeSpy).toHaveBeenCalledWith('info', 'send.confirmed_on_website', { mailType: 'letter', outcome: 'sent' });
    });

    it('sends a postcard as a postcard, and another copy only when asked', async () => {
      signedIn();
      vi.mocked(getDraft).mockResolvedValue(draft({ mail_type: 'postcard' }) as any);
      vi.mocked(createMailOrderFromDraft).mockResolvedValue(created as any);
      await call('POST', JSON.stringify({ sendAnotherCopy: true }));
      expect(createMailOrderFromDraft).toHaveBeenCalledWith(expect.objectContaining({ mailType: 'postcard', allowDuplicate: true }));
      await call('POST', JSON.stringify({ sendAnotherCopy: 'yes' }));
      expect(createMailOrderFromDraft).toHaveBeenLastCalledWith(expect.objectContaining({ allowDuplicate: false }));
    });

    it('returns the first order for a second press, without dispatching again', async () => {
      signedIn();
      vi.mocked(getDraft).mockResolvedValue(draft() as any);
      vi.mocked(createMailOrderFromDraft).mockResolvedValue({ ...created, alreadyConsumed: true, job: undefined } as any);
      const { json } = await call('POST');
      expect(json()).toEqual({ orderId: 'L1', alreadySent: true, lettersRemaining: 2 });
      expect(processLetterJob).not.toHaveBeenCalled();
    });

    it('reports a committed send as sent even when the printer hand-off fails', async () => {
      signedIn();
      vi.mocked(getDraft).mockResolvedValue(draft() as any);
      vi.mocked(createMailOrderFromDraft).mockResolvedValue(created as any);
      vi.mocked(processLetterJob).mockRejectedValue(new Error('provider down'));
      const { state } = await call('POST');
      expect(state.status).toBe(200);
      expect(writeSpy).toHaveBeenCalledWith('warn', 'send.confirmation_dispatch_deferred', expect.objectContaining({ mailType: 'letter' }));
    });

    it('refuses a body that is not JSON, before sending', async () => {
      signedIn();
      vi.mocked(getDraft).mockResolvedValue(draft() as any);
      const { state } = await call('POST', '{nope');
      expect(state.status).toBe(400);
      expect(createMailOrderFromDraft).not.toHaveBeenCalled();
    });

    it('answers a mail row with no outbox job as a failure, and logs it as one', async () => {
      signedIn();
      vi.mocked(getDraft).mockResolvedValue(draft() as any);
      vi.mocked(createMailOrderFromDraft).mockResolvedValue({ ...created, job: undefined } as any);
      const { state, json } = await call('POST');
      expect(state.status).toBe(500);
      expect(json().error).toBe('send_failed');
      expect(writeSpy).toHaveBeenCalledWith('error', 'send.confirmation_refused', expect.objectContaining({ reason: 'send_failed' }));
    });

    it('turns a service refusal into the page\'s words', async () => {
      signedIn();
      vi.mocked(getDraft).mockResolvedValue(draft() as any);
      vi.mocked(createMailOrderFromDraft).mockRejectedValue(new Error('Insufficient credits. Required: 2, Available: 0'));
      const { state, json } = await call('POST');
      expect(state.status).toBe(402);
      expect(json()).toEqual({
        error: 'no_letters',
        message: "You don't have enough letters for this. Buy letters, then come back and press Send."
      });
      expect(writeSpy).toHaveBeenCalledWith('info', 'send.confirmation_refused', expect.objectContaining({ reason: 'no_letters' }));
    });
  });
});

describe('refusalFor (#470)', () => {
  const coded = (code: string) => Object.assign(new Error(`internal ${code} detail`), { code });

  it('describes a duplicate by its fields, never by a service message', () => {
    const refusal = refusalFor(
      new DuplicateMailError({ kind: 'sent', mailType: 'letter', recipientName: 'Sam', ageSeconds: 7_325 } as any, 'internal text')
    );
    expect(refusal.status).toBe(409);
    expect(refusal.body).toEqual({
      error: 'duplicate',
      message: 'The same mail went out from this account in the last 24 hours.',
      duplicate: { kind: 'sent', mailType: 'letter', recipientName: 'Sam', ageMinutes: 122 }
    });
  });

  it('passes a spending limit through, since its words are ours', () => {
    const refusal = refusalFor(new SpendLimitError('MAIL_SENDING_DISABLED', 'Sending is paused right now.'));
    expect(refusal).toMatchObject({ status: 429, body: { error: 'limit', message: 'Sending is paused right now.' } });
  });

  it.each([
    ['ACCOUNT_SENDS_BLOCKED', 403, 'blocked'],
    ['BETA_ACCESS_DENIED', 403, 'beta'],
    ['DRAFT_NOT_FOUND', 404, 'not_found'],
    ['DRAFT_NOT_OWNED', 404, 'not_found'],
    ['DRAFT_EXPIRED', 410, 'expired'],
    ['DRAFT_CANCELLED', 410, 'expired'],
    ['DRAFT_CHECKOUT_PENDING', 409, 'checkout_open'],
    ['GIFT_LETTERS_DISABLED', 409, 'gift_unavailable'],
    ['GIFT_LETTER_UNAVAILABLE', 409, 'gift_unavailable'],
    ['DRAFT_INVALID_STATE', 409, 'unsendable'],
    ['DRAFT_INCOMPLETE', 409, 'unsendable'],
    ['DRAFT_WRONG_MAIL_TYPE', 409, 'unsendable'],
    ['DRAFT_FUNDING_CONFLICT', 409, 'unsendable'],
    ['SOMETHING_NEW', 500, 'send_failed']
  ])('maps %s to %i %s, without the service message', (code, status, reason) => {
    const refusal = refusalFor(coded(code));
    expect(refusal.status).toBe(status);
    expect(refusal.body.error).toBe(reason);
    expect(JSON.stringify(refusal.body)).not.toContain('internal');
  });

  it('uses the beta message for a beta refusal', () => {
    expect(refusalFor(coded('BETA_ACCESS_DENIED')).body.message).toBe(BETA_ACCESS_MESSAGE);
  });

  it('matches the ledger sentence only at its start', () => {
    expect(refusalFor(new Error('Insufficient credits. Required: 2')).reason).toBe('no_letters');
    expect(refusalFor(new Error('Wrapped: Insufficient credits.')).reason).toBe('send_failed');
    expect(refusalFor(new Error('Insufficient creditsX')).reason).toBe('send_failed');
  });

  it('never forwards an unknown error', () => {
    const refusal = refusalFor(new Error('connect ECONNREFUSED 10.0.0.1:5432'));
    expect(refusal.status).toBe(500);
    expect(JSON.stringify(refusal.body)).not.toContain('ECONNREFUSED');
  });
});
