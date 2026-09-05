/**
 * Unit tests for redeem_promo_code.
 *
 * Beta invitees given a code could only redeem it on the website, which meant
 * leaving the conversation. The service and its HTTP route already existed;
 * only the MCP tool was missing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../src/contracts/types.js';

const mocks = vi.hoisted(() => ({
  redeemPromoCode: vi.fn(),
  findUser: vi.fn()
}));

vi.mock('../../../src/services/promoService.js', () => ({
  redeemPromoCode: mocks.redeemPromoCode
}));
vi.mock('../../../src/services/userService.js', () => ({
  findUser: mocks.findUser
}));

import { redeemPromoCodeTool } from '../../../src/tools/redeemPromoCode.js';
import { CREDITS_PER_LETTER } from '../../../src/config/products.js';

const context = {
  user: { userId: 'user-1', creditsRemaining: 0, orders: [] },
  correlationId: 'test-correlation',
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
  now: () => new Date('2026-08-31T12:00:00Z'),
  persist: vi.fn()
} as unknown as ToolContext;

describe('redeem_promo_code', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUser.mockResolvedValue({ user_id: 'user-1', email: 'test@example.com' });
  });

  it('reports letters, never the credits the service returns', async () => {
    // The service speaks in the ledger unit. 10 credits is 5 letters, and
    // reporting "10" would overstate what the customer received by 2x (#308).
    mocks.redeemPromoCode.mockResolvedValue({ success: true, credits: 10 });

    const result = await redeemPromoCodeTool.handler({ code: 'WELCOME' }, context);

    expect(result.redeemed).toBe(true);
    expect(result.letters).toBe(10 / CREDITS_PER_LETTER);
    expect(result.message).not.toMatch(/credit/i);
  });

  it('rounds a partial letter down rather than promising one', async () => {
    mocks.redeemPromoCode.mockResolvedValue({ success: true, credits: 3 });

    const result = await redeemPromoCodeTool.handler({ code: 'ODD' }, context);

    expect(result.letters).toBe(1);
  });

  it('answers a bad code as a result, not an exception', async () => {
    // The model can only relay the reason if it arrives as data, and a
    // mistyped code is an ordinary outcome rather than a fault.
    mocks.redeemPromoCode.mockResolvedValue({
      success: false,
      error: 'Promo code has expired'
    });

    const result = await redeemPromoCodeTool.handler({ code: 'OLD' }, context);

    expect(result.redeemed).toBe(false);
    expect(result.message).toBe('Promo code has expired');
    expect(result.letters).toBeUndefined();
  });

  it.each([
    'Promo code not found',
    'You have already redeemed this promo code',
    'This promo code is for new users only',
    'Promo code redemption limit reached'
  ])('passes through the customer-safe reason: %s', async reason => {
    mocks.redeemPromoCode.mockResolvedValue({ success: false, error: reason });

    const result = await redeemPromoCodeTool.handler({ code: 'X' }, context);

    expect(result.message).toBe(reason);
  });

  it('never leaks an internal marker if the service ever produces one', async () => {
    // Guards the direction that matters without coupling to exact wording: the
    // reason is forwarded, so the test asserts what must never appear rather
    // than enumerating what may.
    mocks.redeemPromoCode.mockResolvedValue({ success: false, error: undefined });

    const result = await redeemPromoCodeTool.handler({ code: 'X' }, context);

    expect(result.message).toBe('That promo code could not be redeemed.');
    expect(result.message).not.toMatch(/campaign_id|SELECT |undefined|null/i);
  });

  it('surfaces an expiry when the granted letters have one', async () => {
    mocks.redeemPromoCode.mockResolvedValue({
      success: true,
      credits: 4,
      expiresAt: new Date('2026-12-25T00:00:00Z')
    });

    const result = await redeemPromoCodeTool.handler({ code: 'XMAS' }, context);

    expect(result.expiresAt).toBe('2026-12-25T00:00:00.000Z');
    expect(result.message).toMatch(/expire on 2026-12-25/);
  });

  it('omits expiry when the letters do not expire', async () => {
    mocks.redeemPromoCode.mockResolvedValue({ success: true, credits: 4 });

    const result = await redeemPromoCodeTool.handler({ code: 'FOREVER' }, context);

    expect(result.expiresAt).toBeUndefined();
    expect(result.message).not.toMatch(/expire/i);
  });

  it('trims the code and refuses an empty one without calling the service', async () => {
    await expect(redeemPromoCodeTool.handler({ code: '   ' }, context)).rejects.toThrow(
      /requires the promo code/
    );
    expect(mocks.redeemPromoCode).not.toHaveBeenCalled();

    mocks.redeemPromoCode.mockResolvedValue({ success: true, credits: 4 });
    await redeemPromoCodeTool.handler({ code: '  WELCOME  ' }, context);
    expect(mocks.redeemPromoCode).toHaveBeenCalledWith(
      expect.objectContaining({ promoCode: 'WELCOME' })
    );
  });

  it('proceeds when the account has no stored email', async () => {
    mocks.findUser.mockResolvedValue(null);
    mocks.redeemPromoCode.mockResolvedValue({ success: true, credits: 4 });

    await expect(
      redeemPromoCodeTool.handler({ code: 'WELCOME' }, context)
    ).resolves.toMatchObject({ redeemed: true });
  });

  it('describes itself without saying "credit"', async () => {
    expect(redeemPromoCodeTool.description).not.toMatch(/credit/i);
  });
});
