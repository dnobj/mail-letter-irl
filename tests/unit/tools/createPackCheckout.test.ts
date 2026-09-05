/**
 * Unit tests for create_pack_checkout.
 *
 * The tool exists because buying a Letter Pack in ChatGPT opened a static
 * website URL rather than a Stripe checkout, while Pay & Send created a session
 * server-side. The website handoff carries no identity, so a customer not
 * signed in there bought credits that never reached the account the card could
 * see - the failure mode written into #306 as an *expected* outcome.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../src/contracts/types.js';

const mocks = vi.hoisted(() => ({
  createPackCheckout: vi.fn(),
  findUser: vi.fn()
}));

vi.mock('../../../src/services/commerceService.js', () => ({
  createPackCheckout: mocks.createPackCheckout
}));
vi.mock('../../../src/services/userService.js', () => ({
  findUser: mocks.findUser
}));

import { createPackCheckoutTool } from '../../../src/tools/createPackCheckout.js';
import { PACK_PRODUCTS } from '../../../src/config/products.js';

const context = {
  user: { userId: 'user-1', creditsRemaining: 0, orders: [] },
  correlationId: 'test-correlation',
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
  now: () => new Date('2026-08-31T12:00:00Z'),
  persist: vi.fn()
} as unknown as ToolContext;

function checkoutResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    orderId: 'ord-1',
    checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test',
    amountCents: 1000,
    currency: 'usd',
    productDescription: 'Regular Pack - 5 Letters',
    status: 'checkout_pending',
    reused: false,
    ...overrides
  };
}

describe('create_pack_checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUser.mockResolvedValue({ user_id: 'user-1', email: 'test@example.com' });
    mocks.createPackCheckout.mockResolvedValue(checkoutResult());
  });

  it.each([
    ['starter', 'credit-pack-4', 2],
    ['regular', 'credit-pack-10', 5],
    ['power', 'credit-pack-100', 50]
  ])('maps %s to %s and reports %i letters', async (pack, productCode, letters) => {
    // The catalogue names its products after CREDITS, so a mis-mapping here
    // would charge for one pack and promise the letters of another.
    const result = await createPackCheckoutTool.handler({ pack } as never, context);

    expect(mocks.createPackCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ productId: productCode, userId: 'user-1' })
    );
    expect(result.letters).toBe(letters);
  });

  it('reports the letter counts the catalogue defines, not a local copy', async () => {
    // Guards the pairing above against the catalogue changing underneath it.
    const expected = Object.fromEntries(
      PACK_PRODUCTS.map(product => [product.productCode, product.letters])
    );
    expect(expected).toEqual({
      'credit-pack-4': 2,
      'credit-pack-10': 5,
      'credit-pack-100': 50
    });
  });

  it('omits the return URLs so the service derives them', async () => {
    // The order id is created INSIDE createPackCheckout, so this tool has
    // nothing to build a return URL from. Passing a guess would send the
    // customer somewhere that cannot resolve their order.
    await createPackCheckoutTool.handler({ pack: 'starter' } as never, context);

    const params = mocks.createPackCheckout.mock.calls[0][0];
    expect(params.successUrl).toBeUndefined();
    expect(params.cancelUrl).toBeUndefined();
  });

  it('refuses an unknown pack without calling the service', async () => {
    await expect(
      createPackCheckoutTool.handler({ pack: 'enormous' } as never, context)
    ).rejects.toThrow(/starter, regular, power/);

    expect(mocks.createPackCheckout).not.toHaveBeenCalled();
  });

  it('withholds the checkout URL when the order is already paid', async () => {
    mocks.createPackCheckout.mockResolvedValue(
      checkoutResult({ status: 'fulfilled', reused: true })
    );

    const result = await createPackCheckoutTool.handler({ pack: 'regular' } as never, context);

    expect(result.checkoutUrl).toBeUndefined();
    expect(result.message).toMatch(/already paid or being fulfilled/i);
  });

  it('proceeds when the account has no stored email', async () => {
    // Stripe uses it to prefill a receipt; it is not a reason to block a sale.
    mocks.findUser.mockResolvedValue(null);

    await expect(
      createPackCheckoutTool.handler({ pack: 'starter' } as never, context)
    ).resolves.toBeDefined();
    expect(mocks.createPackCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ userEmail: '' })
    );
  });

  describe('customer-facing failures', () => {
    async function failWith(code: string, extra: Record<string, unknown> = {}) {
      mocks.createPackCheckout.mockRejectedValueOnce(
        Object.assign(new Error('internal detail'), { code, ...extra })
      );
      return createPackCheckoutTool
        .handler({ pack: 'starter' } as never, context)
        .then(
          () => {
            throw new Error('expected a rejection');
          },
          (error: Error) => error
        );
    }

    it('never forwards the internal block reason to the customer', async () => {
      // sends_blocked_reason carries values like "payment_disputed". Forwarding
      // the upstream message put that in front of the end user (#278 round 12).
      const error = await failWith('ACCOUNT_SENDS_BLOCKED');

      expect(error.message).toBe(
        'Purchasing is disabled on this account. Please contact support.'
      );
      expect(error.message).not.toMatch(/internal detail|disputed/i);
    });

    it('keeps the carried diagnostic class rather than flattening it', async () => {
      // A bare Error here would log a precisely classified fault as
      // unknown_error (#278 round 4).
      const error = await failWith('PROVIDER_ERROR', {
        diagnosticClass: 'configuration_error'
      });

      expect((error as { diagnosticClass?: string }).diagnosticClass).toBe(
        'configuration_error'
      );
      expect((error as { code?: string }).code).toBe('PROVIDER_ERROR');
    });

    it('distinguishes a permanent pricing fault from a transient one', async () => {
      const terminal = await failWith('PRICE_ID_NOT_CONFIGURED', {
        diagnosticClass: 'configuration_error'
      });
      const transient = await failWith('PRICE_ID_NOT_CONFIGURED');

      expect(terminal.message).toMatch(/not configured/i);
      expect(transient.message).toMatch(/temporarily unavailable/i);
      expect(terminal.message).not.toBe(transient.message);
    });

    it('says something useful for an unrecognised code', async () => {
      const error = await failWith('SOMETHING_NEW');
      expect(error.message).toBe('Unable to start the letter pack checkout. Please try again.');
    });
  });

  it('never says "credit" to the customer', async () => {
    // The whole point of the starter/regular/power mapping and the letters
    // field. Credits are internal (2 per letter) and the product codes are
    // named after them, so a leak here is one edit away at all times (#308).
    const result = await createPackCheckoutTool.handler({ pack: 'power' } as never, context);
    const customerFacing = [result.message, result.productDescription].join(' ');

    expect(customerFacing).not.toMatch(/credit/i);
    expect(createPackCheckoutTool.description).not.toMatch(/credit/i);
  });
});
