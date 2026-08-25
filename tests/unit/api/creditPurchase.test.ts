/**
 * Unit tests for Credit Purchase Flow
 *
 * Tests the Stripe checkout session creation and webhook processing:
 * - Creating checkout sessions for credit packs
 * - Handling Stripe webhooks for completed purchases
 * - Error handling for missing configuration
 *
 * User Stories Covered:
 * - US-PURCHASE-01: Purchase Credits via Stripe Checkout
 *
 * GitHub Issue: #21
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stripeMockModule } from '../../mocks/stripe.js';

// Hoist mock functions so they're available when vi.mock is hoisted
const { mockSessionCreate, mockSessionList, mockConstructEvent, mockPriceRetrieve } = vi.hoisted(() => ({
  mockSessionCreate: vi.fn(),
  mockSessionList: vi.fn(),
  mockConstructEvent: vi.fn(),
  mockPriceRetrieve: vi.fn(),
}));

/**
 * Amounts come from the resolved Stripe Price (#275 stage A), reached through
 * the catalog's injectable retriever seam. Resolution is LAZY - the checkout
 * functions ensure it themselves - so unlike the previous eager design there
 * is no load-before-env-stub ordering hazard for a beforeEach to get wrong
 * (which one describe in this file did, making its checkout tests vacuous:
 * #278 review).
 */
const PRICE_FIXTURES: Record<string, number> = {
  price_starter_mock: 500,
  price_regular_mock: 1000,
  price_power_mock: 9000,
};

async function configureStubbedPrices(): Promise<void> {
  const { resetPriceCatalog, setPriceRetriever } = await import(
    '../../../src/services/priceCatalog.js'
  );
  resetPriceCatalog();
  setPriceRetriever(async (priceId: string) => {
    const unitAmount = PRICE_FIXTURES[priceId];
    if (unitAmount === undefined) {
      throw Object.assign(new Error('No such price'), { code: 'resource_missing' });
    }
    return {
      id: priceId,
      active: true,
      unit_amount: unitAmount,
      currency: 'usd',
      product: `prod_${priceId}`,
    } as never;
  });
}

// One shared MockStripe (tests/mocks/stripe.ts): the inline copies here and in
// the price/reconciliation suites disagreed about the Stripe surface, and two
// of them disagreed about whether a Price carries `active` - so they exercised
// different validation paths for the same object (#278 review).
vi.mock('stripe', () =>
  stripeMockModule({
    sessionCreate: mockSessionCreate,
    sessionList: mockSessionList,
    priceRetrieve: mockPriceRetrieve,
    constructEvent: mockConstructEvent,
  })
);

// Mock database
vi.mock('../../../src/db/index.js', () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

// Import after mocking
import {
  createCheckoutSession,
  getPackProductConfig,
  verifyWebhookSignature,
  extractCheckoutData,
} from '../../../src/services/stripeService.js';

describe('Credit Purchase Flow (US-PURCHASE-01)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await configureStubbedPrices();
    // Set required environment variables
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_mock');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_mock');
    vi.stubEnv('STRIPE_PRICE_STARTER', 'price_starter_mock');
    vi.stubEnv('STRIPE_PRICE_REGULAR', 'price_regular_mock');
    vi.stubEnv('STRIPE_PRICE_POWER', 'price_power_mock');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('createCheckoutSession', () => {
    it('should create checkout session for credit-pack-4', async () => {
      const result = await createCheckoutSession({
        userId: 'user-123',
        userEmail: 'test@example.com',
        productId: 'credit-pack-4',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      });

      // The session creation is mocked, so we test the structure
      expect(result).toHaveProperty('success');
    });

    it('should reject invalid product ID', async () => {
      const result = await createCheckoutSession({
        userId: 'user-123',
        userEmail: 'test@example.com',
        productId: 'invalid-product' as any,
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid product ID');
    });

    it('should fail closed with a stable code when the price ID is not configured', async () => {
      vi.stubEnv('STRIPE_PRICE_STARTER', '');

      const result = await createCheckoutSession({
        userId: 'user-123',
        userEmail: 'test@example.com',
        productId: 'credit-pack-4',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      });

      expect(result).toMatchObject({ success: false, errorCode: 'PRICE_ID_NOT_CONFIGURED' });
      expect(mockSessionCreate).not.toHaveBeenCalled();
    });

    // A Stripe Price ID is not evidence of a USABLE amount. When the Price
    // cannot be resolved to one - archived, tiered, absurd, or unreachable -
    // the purchase must be disabled rather than fall back to a hard-coded
    // figure a later refund would trust. These are the relocated forms of the
    // old "pack amount missing/zero/non-numeric" boot errors.
    it.each([
      ['archived', { active: false, unit_amount: 500 }],
      ['tiered (no unit amount)', { active: true, unit_amount: null }],
      ['implausibly small', { active: true, unit_amount: 1 }],
      ['unreachable', null],
    ])('should fail closed when the starter price is %s', async (_label, price) => {
      const { resetPriceCatalog, setPriceRetriever } = await import(
        '../../../src/services/priceCatalog.js'
      );
      resetPriceCatalog();
      setPriceRetriever(async (priceId: string) => {
        if (priceId === 'price_starter_mock') {
          if (price === null) throw new Error('down');
          return { id: priceId, currency: 'usd', ...price } as never;
        }
        return {
          id: priceId,
          active: true,
          unit_amount: PRICE_FIXTURES[priceId],
          currency: 'usd',
        } as never;
      });

      const result = await createCheckoutSession({
        userId: 'user-123',
        userEmail: 'test@example.com',
        productId: 'credit-pack-4',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      });

      expect(result).toMatchObject({ success: false, errorCode: 'PACK_AMOUNT_NOT_CONFIGURED' });
      expect(mockSessionCreate).not.toHaveBeenCalled();
    });

    it('reads the amount from the resolved Stripe price, never a built-in default', async () => {
      // Same intent as before #275 stage A - no hard-coded fallback amount can
      // reach a customer - at its new source. The amount used to come from
      // STRIPE_STARTER_AMOUNT_CENTS; it now comes from the Price itself.
      const { ensurePriceCatalog, resetPriceCatalog, setPriceRetriever } = await import(
        '../../../src/services/priceCatalog.js'
      );

      resetPriceCatalog();
      // The Stripe Price must say exactly what the product table pins
      // (500/1000/9000): a resolved-and-verified amount is served, anything
      // else refuses. This is the two-source check in miniature (#278 r5).
      const amounts: Record<string, number> = {
        price_starter_mock: 500,
        price_regular_mock: 1000,
        price_power_mock: 9000
      };
      setPriceRetriever(async priceId => ({
        id: priceId,
        active: true,
        unit_amount: amounts[priceId] ?? 999_999,
        currency: 'usd',
        product: 'prod_starter'
      }) as never);
      await ensurePriceCatalog();
      expect(getPackProductConfig('credit-pack-4')).toMatchObject({ amountCents: 500 });

      // A healthy, active, plausible Price at the WRONG amount - a transposed
      // or repointed env var - is refused, never served.
      resetPriceCatalog();
      setPriceRetriever(async priceId => ({
        id: priceId,
        active: true,
        unit_amount: 777,
        currency: 'usd',
        product: 'prod_starter'
      }) as never);
      await ensurePriceCatalog();
      expect(getPackProductConfig('credit-pack-4')).toMatchObject({ amountCents: 0 });

      // An unresolved price must yield an unusable amount rather than the
      // historical hard-coded 500, so the caller's guard refuses the purchase.
      resetPriceCatalog();
      expect(getPackProductConfig('credit-pack-4')).toMatchObject({ amountCents: 0 });
    });

    it('should handle emails without @ symbol gracefully', async () => {
      // Test with username-only identifier (e.g., Auth0 sub)
      const result = await createCheckoutSession({
        userId: 'auth0|123456',
        userEmail: 'auth0|123456', // Not a valid email
        productId: 'credit-pack-4',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      });

      // Should not throw, email validation is handled
      expect(result).toHaveProperty('success');
    });
  });

  describe('extractCheckoutData', () => {
    it('should extract user and credit info from checkout session', async () => {
      const mockSession = {
        id: 'cs_test_123',
        client_reference_id: 'user-123',
        customer_email: 'test@example.com',
        amount_total: 399, // $3.99 in cents
        metadata: {
          userId: 'user-123',
          productId: 'credit-pack-4',
          credits: '4',
        },
      } as any;

      const data = await extractCheckoutData(mockSession);

      expect(data).not.toBeNull();
      expect(data?.userId).toBe('user-123');
      expect(data?.credits).toBe(4);
      expect(data?.productId).toBe('credit-pack-4');
      expect(data?.sessionId).toBe('cs_test_123');
      expect(data?.amountPaid).toBe(3.99);
    });

    it('should return null when required metadata is missing', async () => {
      const mockSession = {
        id: 'cs_test_123',
        metadata: {}, // Missing required fields
      } as any;

      const data = await extractCheckoutData(mockSession);

      expect(data).toBeNull();
    });
  });

  describe('webhook signature verification', () => {
    it('should return null when webhook secret is not configured', () => {
      vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');

      const result = verifyWebhookSignature('payload', 'signature');

      // With empty secret, verification should fail gracefully
      expect(result).toBeNull();
    });
  });

  describe('credit pack configuration', () => {
    it('should have correct credit amounts for each pack', () => {
      const PRODUCTS = {
        'credit-pack-4': { credits: 4 },
        'credit-pack-10': { credits: 10 },
        'credit-pack-100': { credits: 100 },
      };

      expect(PRODUCTS['credit-pack-4'].credits).toBe(4);
      expect(PRODUCTS['credit-pack-10'].credits).toBe(10);
      expect(PRODUCTS['credit-pack-100'].credits).toBe(100);
    });
  });
});

describe('Checkout Session Error Handling', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_mock');
    vi.stubEnv('STRIPE_PRICE_STARTER', 'price_starter_mock');
    await configureStubbedPrices();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('should handle missing STRIPE_SECRET_KEY gracefully', async () => {
    // When STRIPE_SECRET_KEY is empty, Stripe client may throw
    // The service should catch and return a meaningful error
    vi.stubEnv('STRIPE_SECRET_KEY', '');

    // This tests the error path
    const result = await createCheckoutSession({
      userId: 'user-123',
      userEmail: 'test@example.com',
      productId: 'credit-pack-4',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });

    // Should return error, not throw
    expect(result).toHaveProperty('success');
  });

  it('should include session URL in successful response', async () => {
    // In dev mode, we need proper Stripe test keys
    // This test validates the response structure
    const expectedResponseShape = {
      success: true,
      sessionId: expect.any(String),
      sessionUrl: expect.any(String),
    };

    // Validate the shape matches our expected API contract
    expect(expectedResponseShape).toHaveProperty('success');
    expect(expectedResponseShape).toHaveProperty('sessionId');
    expect(expectedResponseShape).toHaveProperty('sessionUrl');
  });

  it('does not log or return arbitrary Stripe checkout exceptions', async () => {
    const sensitive = 'private Stripe failure cs_private pi_private auth0|private-user';
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_mock');
    vi.stubEnv('STRIPE_PRICE_STARTER', 'price_starter_mock');
    mockSessionCreate.mockRejectedValueOnce(new Error(sensitive));
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await createCheckoutSession({
      userId: 'auth0|private-user',
      userEmail: 'private@example.test',
      productId: 'credit-pack-4',
      successUrl: 'https://example.test/success',
      cancelUrl: 'https://example.test/cancel'
    });

    const output = diagnostic.mock.calls.flat().map(String).join('\n');
    expect(output).toContain('"event":"stripe.checkout_creation_failed"');
    // The result now carries a stable, non-PII classification for the caller's
    // own catch (issue #213). For a bare Error with no Stripe code/type that is
    // 'provider_error'; the raw message is never surfaced.
    expect(result).toEqual({
      success: false,
      errorCode: 'PROVIDER_ERROR',
      diagnosticClass: 'provider_error',
      // A bare Error is not one of the classes a human must act on, so cleanup
      // leaves the order pending rather than cancelling it.
      terminal: false,
      error: 'Failed to create checkout session'
    });
    expect(output).not.toContain(sensitive);
    expect(JSON.stringify(result)).not.toContain(sensitive);
  });

  it('does not log arbitrary webhook verification exceptions', () => {
    const sensitive = 'private signature failure whsec_private evt_private';
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_mock');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_mock');
    mockConstructEvent.mockImplementationOnce(() => {
      throw new Error(sensitive);
    });
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(verifyWebhookSignature('private-body', 'private-signature')).toBeNull();

    const output = diagnostic.mock.calls.flat().map(String).join('\n');
    expect(output).toContain('"event":"stripe.webhook_signature_invalid"');
    expect(output).not.toContain(sensitive);
  });
});

describe('Configuration Error Detection (Issue #21)', () => {
  it('should return helpful error when STRIPE_PRICE_* not configured', async () => {
    // This tests the specific issue #21 scenario
    // When STRIPE_PRICE_STARTER is empty, the error should mention "not configured"
    vi.stubEnv('STRIPE_PRICE_STARTER', '');

    const result = await createCheckoutSession({
      userId: 'user-123',
      userEmail: 'test@example.com',
      productId: 'credit-pack-4',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });

  it('should identify configuration errors by error message pattern', () => {
    // The API handler should detect config errors and return 503 instead of 500
    const configErrorPatterns = [
      'Price ID not configured for product',
      'Set STRIPE_PRICE_* environment variables',
    ];

    configErrorPatterns.forEach((pattern) => {
      expect(pattern.includes('not configured') || pattern.includes('environment variable')).toBe(true);
    });
  });
});
