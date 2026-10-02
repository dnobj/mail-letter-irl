import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The confirmation page takes the Pay & Send payment for mail no pack pays
 * for (#579): the draft says so, with its price, and a checkout route opens a
 * Stripe checkout that returns to the page. The real handler runs; sign-in,
 * the draft store, the commerce service and the price catalog are faked.
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
vi.mock('../../../src/services/commerceService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/commerceService.js')>()),
  createJitCheckout: vi.fn(),
  getSendEligibility: vi.fn()
}));
vi.mock('../../../src/services/priceCatalog.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/priceCatalog.js')>()),
  ensurePriceCatalog: vi.fn()
}));

import { authenticateRestRequest } from '../../../src/api/middleware/restAuth.js';
import { rateLimitAccount } from '../../../src/api/middleware/rateLimit.js';
import { getDraft } from '../../../src/services/draftService.js';
import { query } from '../../../src/db/index.js';
import { createJitCheckout, getSendEligibility } from '../../../src/services/commerceService.js';
import { ensurePriceCatalog } from '../../../src/services/priceCatalog.js';
import { DuplicateMailError } from '../../../src/services/duplicateMailService.js';
import { SpendLimitError } from '../../../src/services/betaSpendLimits.js';
import { BETA_ACCESS_MESSAGE, BetaAccessDeniedError } from '../../../src/auth/betaAccess.js';
import {
  checkoutRefusalFor,
  handleSendConfirmationApiRequest
} from '../../../src/api/sendConfirmationApiHandler.js';
import { confirmationCheckoutReturnUrls } from '../../../src/config/sendConfirmation.js';
import * as diagnostics from '../../../src/utils/diagnosticLog.js';

const DRAFT_ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
const PATH = `/api/sends/${DRAFT_ID}`;
const CHECKOUT = `${PATH}/checkout`;
const WEBSITE = 'WebsiteClient01';
const SITE = 'https://site.example';

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
    mail_type: 'postcard',
    postcard_size: '6x4',
    status: 'pending',
    expires_at: new Date(Date.now() + 3_600_000),
    required_credits: 2,
    recipient: { name: 'Sam Rivera', addressLine1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
    sender: { name: 'Ada', addressLine1: '2 Oak Ave', city: 'Austin', state: 'TX', postalCode: '78702' },
    message: 'Hello',
    preview_html: '<div>preview</div>',
    ...overrides
  };
}

async function call(method: string, path: string, body?: string) {
  const out = response();
  const handled = await handleSendConfirmationApiRequest(request(method, body), out.res, path);
  return { handled, ...out };
}

const PAY = {
  available: true,
  amountCents: 399,
  currency: 'usd',
  displayAmount: '3.99',
  productDescription: 'Payment authorizes Letter IRL to print and mail this exact 4x6 postcard.'
};

describe('the confirmation page takes Pay & Send for mail no pack pays for (#579)', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('LETTER_IRL_SEND_CONFIRMATION_ENABLED', 'true');
    vi.stubEnv('LETTER_IRL_WEBSITE_CLIENT_ID', WEBSITE);
    vi.stubEnv('LETTER_IRL_WEBSITE_BASE_URL', SITE);
    vi.mocked(rateLimitAccount).mockResolvedValue(false);
    vi.mocked(query).mockResolvedValue({ rows: [{ credits: 10 }] } as never);
    vi.mocked(getSendEligibility).mockReturnValue({
      payAndSend: PAY,
      letterPack: { available: false, purchaseUrl: SITE },
      packPays: false
    });
    vi.mocked(createJitCheckout).mockResolvedValue({
      success: true,
      orderId: 'order-1',
      checkoutUrl: 'https://checkout.stripe.test/cs-1',
      amountCents: 399,
      currency: 'usd',
      productDescription: 'Pay & Send One 4x6 Postcard',
      expiresAt: '2026-10-02T12:00:00.000Z',
      status: 'checkout_pending',
      reused: false
    } as never);
    signedIn();
    writeSpy = vi.spyOn(diagnostics, 'writeDiagnostic').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    writeSpy.mockRestore();
  });

  describe('the draft, as the page shows it', () => {
    it('says no pack pays for it, and gives its Pay & Send price, resolved first', async () => {
      vi.mocked(getDraft).mockResolvedValue(draft() as never);

      const { state, json } = await call('GET', PATH);

      expect(state.status).toBe(200);
      expect(json()).toMatchObject({ packPays: false, payment: PAY });
      expect(ensurePriceCatalog).toHaveBeenCalledWith('jit-postcard-4x6');
      expect(getSendEligibility).toHaveBeenCalledWith(0, 2, { mailType: 'postcard', postcardSize: '6x4' });
    });

    it('says nothing new for mail a pack pays for', async () => {
      for (const row of [draft({ postcard_size: '6x9' }), draft({ mail_type: 'letter', postcard_size: null })]) {
        vi.mocked(getDraft).mockResolvedValue(row as never);
        const { json } = await call('GET', PATH);
        expect(json()).not.toHaveProperty('packPays');
        expect(json()).not.toHaveProperty('payment');
      }
      expect(getSendEligibility).not.toHaveBeenCalled();
      expect(ensurePriceCatalog).not.toHaveBeenCalled();
    });

    it('offers no payment for a draft no longer ready, but still says no pack pays', async () => {
      vi.mocked(getDraft).mockResolvedValue(draft({ status: 'expired' }) as never);
      const { json } = await call('GET', PATH);
      expect(json()).toMatchObject({ state: 'expired', packPays: false });
      expect(json()).not.toHaveProperty('payment');
      expect(ensurePriceCatalog).not.toHaveBeenCalled();
    });
  });

  describe('the checkout route', () => {
    it('opens a checkout that returns to this page, for the signed-in person and their draft', async () => {
      vi.mocked(getDraft).mockResolvedValue(draft() as never);

      const { state, json } = await call('POST', CHECKOUT);

      expect(state.status).toBe(200);
      expect(createJitCheckout).toHaveBeenCalledWith({
        userId: 'auth0|owner',
        draftId: DRAFT_ID,
        allowDuplicate: false,
        returnTo: {
          successUrl: `${SITE}/confirm/${DRAFT_ID}?paid=1`,
          cancelUrl: `${SITE}/confirm/${DRAFT_ID}?paid=0`
        }
      });
      expect(json()).toEqual({
        orderId: 'order-1',
        status: 'checkout_pending',
        checkoutUrl: 'https://checkout.stripe.test/cs-1',
        amountCents: 399,
        currency: 'usd',
        expiresAt: '2026-10-02T12:00:00.000Z',
        reused: false
      });
    });

    it('buys another copy when the person asked, and opens nothing for a paid order', async () => {
      vi.mocked(getDraft).mockResolvedValue(draft() as never);
      vi.mocked(createJitCheckout).mockResolvedValueOnce({
        success: true, orderId: 'order-1', checkoutUrl: 'https://checkout.stripe.test/cs-1', amountCents: 399,
        currency: 'usd', productDescription: 'x', status: 'paid', reused: true
      } as never);

      const { json } = await call('POST', CHECKOUT, JSON.stringify({ sendAnotherCopy: true }));

      expect(vi.mocked(createJitCheckout).mock.calls[0][0]).toMatchObject({ allowDuplicate: true });
      expect(json()).toMatchObject({ status: 'paid', checkoutUrl: null, expiresAt: null, reused: true });
    });

    it('takes only POST', async () => {
      const { state } = await call('GET', CHECKOUT);
      expect(state.status).toBe(405);
      expect(state.headers.allow).toBe('POST');
      expect(createJitCheckout).not.toHaveBeenCalled();
    });

    it("is the website's alone, for the person's own draft, and gone with the send rule off", async () => {
      vi.mocked(getDraft).mockResolvedValue(draft() as never);
      signedIn('SomeOtherApp');
      expect((await call('POST', CHECKOUT)).state.status).toBe(403);

      signedIn(WEBSITE, 'auth0|someone-else');
      expect((await call('POST', CHECKOUT)).state.status).toBe(404);

      signedIn();
      vi.stubEnv('LETTER_IRL_SEND_CONFIRMATION_ENABLED', 'false');
      expect((await call('POST', CHECKOUT)).state.status).toBe(404);

      expect(createJitCheckout).not.toHaveBeenCalled();
    });

    it('answers a body that is not JSON, opening nothing', async () => {
      vi.mocked(getDraft).mockResolvedValue(draft() as never);
      const { state, json } = await call('POST', CHECKOUT, '{nope');
      expect(state.status).toBe(400);
      expect(json()).toEqual({ error: 'invalid_json' });
      expect(createJitCheckout).not.toHaveBeenCalled();
    });

    it("words a refusal for the page, and logs it", async () => {
      vi.mocked(getDraft).mockResolvedValue(draft() as never);
      vi.mocked(createJitCheckout).mockRejectedValueOnce(
        Object.assign(new Error('internal detail'), { code: 'PREPAID_BALANCE_AVAILABLE' })
      );

      const { state, json } = await call('POST', CHECKOUT);

      expect(state.status).toBe(409);
      expect(json()).toEqual({
        error: 'use_letters',
        message: 'You have letters for this, so there is nothing to pay. Press Send instead.'
      });
      expect(writeSpy).toHaveBeenCalledWith('info', 'send.confirmation_checkout_refused', expect.objectContaining({
        mailType: 'postcard',
        reason: 'use_letters'
      }));
    });
  });

  describe('checkoutRefusalFor', () => {
    const coded = (code: string) => Object.assign(new Error('internal'), { code });

    it.each([
      ['DRAFT_TOO_CLOSE_TO_EXPIRY', 410, 'expired'],
      ['DRAFT_IS_GIFT', 409, 'gift'],
      ['PREPAID_BALANCE_AVAILABLE', 409, 'use_letters'],
      ['JIT_OPTION_NOT_SOLD', 409, 'not_sold'],
      ['JIT_DISABLED', 503, 'pay_unavailable'],
      ['JIT_NOT_CONFIGURED', 503, 'pay_unavailable'],
      ['PRICE_ID_NOT_CONFIGURED', 503, 'pay_unavailable'],
      ['PROVIDER_ERROR', 503, 'pay_unavailable'],
      // The send's own refusals, as the send words them.
      ['ACCOUNT_SENDS_BLOCKED', 403, 'blocked'],
      ['BETA_ACCESS_DENIED', 403, 'beta'],
      ['DRAFT_NOT_FOUND', 404, 'not_found'],
      ['DRAFT_NOT_OWNED', 404, 'not_found'],
      ['DRAFT_EXPIRED', 410, 'expired'],
      ['SCHEDULE_PASSED', 409, 'schedule_passed'],
      ['DRAFT_INVALID_STATE', 409, 'unsendable'],
      ['SOMETHING_NEW', 500, 'checkout_failed']
    ])('maps %s to %i %s, without the service message', (code, status, reason) => {
      const refusal = checkoutRefusalFor(coded(code));
      expect(refusal.status).toBe(status);
      expect(refusal.body.error).toBe(reason);
      expect(JSON.stringify(refusal.body)).not.toContain('internal');
    });

    it("words the checkout's own beta refusal, which carries no code", () => {
      expect(checkoutRefusalFor(new BetaAccessDeniedError())).toEqual({
        status: 403,
        reason: 'beta',
        body: { error: 'beta', message: BETA_ACCESS_MESSAGE }
      });
    });

    it('words the duplicate and the daily limit as the send does', () => {
      const duplicate = new DuplicateMailError(
        { kind: 'paid', mailType: 'postcard', recipientName: 'Sam Rivera', ageSeconds: 300 } as never,
        'internal'
      );
      expect(checkoutRefusalFor(duplicate)).toMatchObject({ status: 409, reason: 'duplicate' });
      const limit = new SpendLimitError('CHARGE_ABOVE_DAILY_CAP', 'This purchase is more than one account can spend in a day.');
      expect(checkoutRefusalFor(limit)).toMatchObject({ status: 429, reason: 'limit' });
    });
  });

  it('names the return addresses from the confirmation page', () => {
    expect(confirmationCheckoutReturnUrls('d 1', { LETTER_IRL_WEBSITE_BASE_URL: 'https://w.example/' })).toEqual({
      successUrl: 'https://w.example/confirm/d%201?paid=1',
      cancelUrl: 'https://w.example/confirm/d%201?paid=0'
    });
  });
});
