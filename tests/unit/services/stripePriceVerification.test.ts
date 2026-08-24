/**
 * Issue #275. Stripe charges whatever the Price object says - the checkout
 * session is built from the price id alone, and STRIPE_*_AMOUNT_CENTS is never
 * sent. That amount is only what WE record, reconcile, and refund against.
 *
 * Nothing compared the two, so a drifted pair billed one figure and booked
 * another with no error and no log. The discovery event would have been a
 * refund that does not match its charge.
 *
 * The tests that matter here are the refusal paths. A happy-path test passes
 * just as well with the verification deleted, which is precisely why this
 * defect survived: the working case looks identical either way.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSessionCreate, mockPriceRetrieve } = vi.hoisted(() => ({
  mockSessionCreate: vi.fn(),
  mockPriceRetrieve: vi.fn()
}));

vi.mock('stripe', () => ({
  default: class MockStripe {
    checkout = { sessions: { create: mockSessionCreate } };
    prices = { retrieve: mockPriceRetrieve };
    webhooks = { constructEvent: vi.fn() };
  }
}));

const { createPackCheckoutSession } = await import('../../../src/services/stripeService.js');

const PRODUCT = {
  productCode: 'credit-pack-10',
  priceId: 'price_test_regular',
  amountCents: 1000,
  currency: 'usd',
  name: 'Regular Pack',
  description: 'Five prepaid letters'
};

function checkout(product = PRODUCT) {
  return createPackCheckoutSession({
    orderId: 'order-1',
    product,
    successUrl: 'https://example.test/ok',
    cancelUrl: 'https://example.test/no',
    idempotencyKey: 'key-1'
  });
}

describe('checkout verifies the configured amount against the Stripe price (#275)', () => {
  beforeEach(() => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_dummy');
    mockSessionCreate.mockReset();
    mockPriceRetrieve.mockReset();
    mockSessionCreate.mockResolvedValue({
      id: 'cs_test_1',
      url: 'https://checkout.test/session',
      expires_at: 1900000000
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('refuses to charge when the price amount disagrees with the configured amount', async () => {
    // The defect: Stripe would bill $12 while the ledger booked $10.
    mockPriceRetrieve.mockResolvedValue({ unit_amount: 1200, currency: 'usd' });

    const result = await checkout();

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PACK_AMOUNT_MISMATCH');
    // Must not transact. Returning an error while still creating the session
    // would be the worst outcome: charged, and recorded as failed.
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it('refuses on a currency mismatch even when the number matches', async () => {
    // 1000 cents is not 1000 pence. Easier to introduce than an amount drift,
    // and just as wrong.
    mockPriceRetrieve.mockResolvedValue({ unit_amount: 1000, currency: 'gbp' });

    const result = await checkout();

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PACK_AMOUNT_MISMATCH');
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it('refuses when the price carries no unit amount', async () => {
    // Tiered and metered prices report null. Unverifiable is not equal.
    mockPriceRetrieve.mockResolvedValue({ unit_amount: null, currency: 'usd' });

    const result = await checkout();

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PACK_AMOUNT_MISMATCH');
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it('classifies a mismatch as a configuration fault, not a database one', async () => {
    // #213 burned a schema hunt on a config problem because an uncarried error
    // defaulted to database_error. The class has to name the right subsystem.
    mockPriceRetrieve.mockResolvedValue({ unit_amount: 1200, currency: 'usd' });

    const result = await checkout();

    expect(result.diagnosticClass).toBe('configuration_error');
  });

  it('reports an unreachable price lookup as a provider error, not a mismatch', async () => {
    // "Cannot verify" and "verified as wrong" are different failures and must
    // not be conflated - one is transient, the other needs a human.
    mockPriceRetrieve.mockRejectedValue(Object.assign(new Error('down'), { type: 'api_error' }));

    const result = await checkout();

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_ERROR');
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it('proceeds when amount and currency both agree', async () => {
    mockPriceRetrieve.mockResolvedValue({ unit_amount: 1000, currency: 'usd' });

    const result = await checkout();

    expect(result.success).toBe(true);
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
    // Still charged from the price id - the verification changes what we
    // refuse, never what Stripe is asked to bill.
    const [args] = mockSessionCreate.mock.calls[0];
    expect(args.line_items).toEqual([{ price: 'price_test_regular', quantity: 1 }]);
  });

  it('compares case-insensitively, so USD and usd are the same currency', async () => {
    mockPriceRetrieve.mockResolvedValue({ unit_amount: 1000, currency: 'USD' });

    const result = await checkout();

    expect(result.success).toBe(true);
  });

  it('still refuses an unconfigured amount before ever calling Stripe', async () => {
    // The pre-existing guard must keep firing first: an amount of 0 is a
    // configuration fault we can detect without a round trip.
    const result = await checkout({ ...PRODUCT, amountCents: 0 });

    expect(result.errorCode).toBe('PACK_AMOUNT_NOT_CONFIGURED');
    expect(mockPriceRetrieve).not.toHaveBeenCalled();
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });
});
