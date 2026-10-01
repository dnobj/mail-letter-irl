import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * POST /api/letters/:letterId/cancel (#535): the website's cancel of held
 * mail, through the same service as cancel_scheduled_mail, in words for a page.
 */

vi.mock('../../../src/api/middleware/restAuth.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/api/middleware/restAuth.js')>()),
  authenticateRestRequest: vi.fn()
}));

vi.mock('../../../src/api/middleware/rateLimit.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/api/middleware/rateLimit.js')>()),
  rateLimitAccount: vi.fn()
}));

vi.mock('../../../src/db/index.js', () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../../../src/services/scheduledMailService.js', () => ({ cancelScheduledMail: vi.fn() }));

import { authenticateRestRequest } from '../../../src/api/middleware/restAuth.js';
import { rateLimitAccount } from '../../../src/api/middleware/rateLimit.js';
import { cancelScheduledMail } from '../../../src/services/scheduledMailService.js';
import { CANCEL_REFUSAL_WORDS, handleLetterApiRequest } from '../../../src/api/letterApiHandler.js';
import { requiredRestScopes } from '../../../src/auth/restScopes.js';

function call(method: string, url: string) {
  const captured = { status: 0, body: '' };
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end(chunk?: string) {
      captured.status = (this as unknown as { statusCode: number }).statusCode;
      captured.body = chunk ?? '';
    }
  } as unknown as ServerResponse;
  const req = { method, url, headers: { host: 'api.test' } } as unknown as IncomingMessage;
  return handleLetterApiRequest(req, res, url).then(handled => ({
    handled,
    status: captured.status,
    body: captured.body ? JSON.parse(captured.body) : null
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRestRequest).mockResolvedValue({
    ok: true,
    user: { userId: 'auth0|user-1', scopes: ['mail:draft'] }
  } as never);
  vi.mocked(rateLimitAccount).mockResolvedValue(false);
});

describe('POST /api/letters/:letterId/cancel (#535)', () => {
  it("cancels the caller's held letter and says what went back", async () => {
    vi.mocked(cancelScheduledMail).mockResolvedValue({
      ok: true,
      cancelled: {
        letterId: 'ltr 1',
        alreadyCancelled: false,
        returned: { kind: 'letters', count: 1 },
        shortfall: 'none',
        arriveBy: '2026-10-16',
        mailOn: '2026-10-06'
      }
    });

    const { handled, status, body } = await call('POST', '/api/letters/ltr%201/cancel');

    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(cancelScheduledMail).toHaveBeenCalledWith({ letterId: 'ltr 1', userId: 'auth0|user-1' });
    expect(body).toEqual({
      letterId: 'ltr 1',
      status: 'cancelled',
      alreadyCancelled: false,
      returned: { kind: 'letters', count: 1 },
      shortfall: 'none',
      arriveBy: '2026-10-16',
      mailOn: '2026-10-06',
      message: 'Cancelled. The letter it cost is back in the balance.'
    });
  });

  it("asks for the route's own scope, mail:draft", async () => {
    vi.mocked(cancelScheduledMail).mockResolvedValue({ ok: false, refusal: 'not_found' });
    await call('POST', '/api/letters/ltr-1/cancel');
    expect(vi.mocked(authenticateRestRequest).mock.calls[0][1]).toEqual(['mail:draft']);
    expect(requiredRestScopes('POST', '/api/letters/ltr-1/cancel')).toEqual(['mail:draft']);
  });

  it.each([
    ['not_found', 404],
    ['not_scheduled', 409],
    ['pay_and_send', 409],
    ['too_late', 409],
    ['busy', 409]
  ] as const)('answers a refusal (%s) with %i, its code and words for a page', async (refusal, statusCode) => {
    vi.mocked(cancelScheduledMail).mockResolvedValue({ ok: false, refusal });

    const { status, body } = await call('POST', '/api/letters/ltr-1/cancel');

    expect(status).toBe(statusCode);
    // `code` is what the website's API client reads; `error` what the other routes answer.
    expect(body).toEqual({ error: refusal, code: refusal, message: CANCEL_REFUSAL_WORDS[refusal] });
    // No tool names: a page has no list_orders to call.
    expect(body.message).not.toMatch(/list_orders|get_order_status|confirm: true/);
  });

  it('leaves GET of the same path to the routes that exist', async () => {
    const { status } = await call('GET', '/api/letters/ltr-1/cancel');
    expect(status).toBe(404);
    expect(cancelScheduledMail).not.toHaveBeenCalled();
  });
});
