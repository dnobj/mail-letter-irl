import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * GET /api/promo/validate/:code words a seed campaign's code as a gift code,
 * as redeem does (#432): a refusal comes from the same wording rule, and a
 * valid one names the gift letter it grants instead of "0 credits". An
 * ordinary campaign keeps its wording.
 *
 * The real handler runs, with authentication, the rate limit and the
 * validator's database read stubbed.
 */

vi.mock('../../../src/api/middleware/restAuth.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/api/middleware/restAuth.js')>()),
  authenticateRestRequest: vi.fn(async () => ({ ok: true, user: { userId: 'user-1', scopes: ['mail:read'] } }))
}));

vi.mock('../../../src/api/middleware/rateLimit.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/api/middleware/rateLimit.js')>()),
  rateLimitAccount: vi.fn(async () => false)
}));

vi.mock('../../../src/services/promoService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/promoService.js')>()),
  validatePromoCode: vi.fn()
}));

import { validatePromoCode } from '../../../src/services/promoService.js';
import { handleCreditApiRequest } from '../../../src/api/creditApiHandler.js';

const validate = vi.mocked(validatePromoCode);

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    campaign_id: 'campaign-1',
    code: 'JANE-SMITH',
    name: 'Jane',
    credits_amount: 0,
    expiration_days: 90,
    gift_generations_remaining: 1,
    ...overrides
  } as never;
}

async function ask(code: string): Promise<Record<string, unknown>> {
  const captured = { body: '' };
  const res = {
    statusCode: 0,
    setHeader: () => {},
    end(chunk?: string) {
      captured.body = chunk ?? '';
    }
  } as unknown as ServerResponse;
  const req = { method: 'GET', headers: { host: 'api.test' }, url: `/api/promo/validate/${code}` } as unknown as IncomingMessage;
  expect(await handleCreditApiRequest(req, res, `/api/promo/validate/${code}`)).toBe(true);
  expect(res.statusCode).toBe(200);
  return JSON.parse(captured.body);
}

beforeEach(() => {
  validate.mockReset();
});

describe('GET /api/promo/validate/:code', () => {
  it("refuses a seed campaign's code in gift-code words", async () => {
    validate.mockResolvedValue({
      valid: false,
      reason: 'Promo code redemption limit reached',
      reasonCode: 'limit_reached',
      campaign: campaign()
    });
    expect(await ask('JANE-SMITH')).toEqual({
      valid: false,
      reason: 'This gift code has been claimed as many times as it allows.'
    });
    expect(validate).toHaveBeenCalledWith('JANE-SMITH', 'user-1');
  });

  it("keeps an ordinary campaign's refusal as it was", async () => {
    validate.mockResolvedValue({
      valid: false,
      reason: 'Promo code redemption limit reached',
      reasonCode: 'limit_reached',
      campaign: campaign({ code: 'WELCOME5', credits_amount: 5, gift_generations_remaining: null })
    });
    expect(await ask('WELCOME5')).toEqual({ valid: false, reason: 'Promo code redemption limit reached' });
  });

  it('names the gift letter a valid seed code grants, and any credits with it', async () => {
    validate.mockResolvedValue({ valid: true, campaign: campaign() });
    expect((await ask('JANE-SMITH')).message).toBe('This gift code gives you a gift letter.');

    validate.mockResolvedValue({ valid: true, campaign: campaign({ credits_amount: 2 }) });
    expect((await ask('JANE-SMITH')).message).toBe('This gift code gives you a gift letter and 2 credits.');

    validate.mockResolvedValue({
      valid: true,
      campaign: campaign({ code: 'WELCOME5', credits_amount: 5, gift_generations_remaining: null })
    });
    expect((await ask('WELCOME5')).message).toBe('This code gives you 5 credits!');
  });
});
