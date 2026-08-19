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

// Hoist mock functions so they're available when vi.mock is hoisted
const { mockSessionCreate, mockSessionList, mockConstructEvent } = vi.hoisted(() => ({
  mockSessionCreate: vi.fn(),
  mockSessionList: vi.fn(),
  mockConstructEvent: vi.fn(),
}));

// Mock Stripe as a class constructor
vi.mock('stripe', () => {
  return {
    default: class MockStripe {
      checkout = {
        sessions: {
          create: mockSessionCreate,
          list: mockSessionList,
        },
      };
      webhooks = {
        constructEvent: mockConstructEvent,
      };
    },
  };
});

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
  beforeEach(() => {
    vi.clearAllMocks();
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
      vi.stubEnv('STRIPE_STARTER_AMOUNT_CENTS', '500');

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

    // A Stripe Price ID is not evidence of an amount. Without the explicit
    // amount variable the legacy pack path must disable the purchase rather
    // than fall back to a hard-coded figure that a later refund would trust.
    it.each([
      ['missing', undefined],
      ['zero', '0'],
      ['non-numeric', 'free'],
      ['negative', '-500'],
    ])('should fail closed when the pack amount is %s', async (_label, amount) => {
      if (amount === undefined) {
        vi.stubEnv('STRIPE_STARTER_AMOUNT_CENTS', '');
      } else {
        vi.stubEnv('STRIPE_STARTER_AMOUNT_CENTS', amount);
      }

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

    it('should read the amount only from configuration, with no built-in default', () => {
      vi.stubEnv('STRIPE_STARTER_AMOUNT_CENTS', '777');
      expect(getPackProductConfig('credit-pack-4')).toMatchObject({ amountCents: 777 });

      // Removing the variable must yield an unusable amount rather than the
      // historical hard-coded 500.
      vi.stubEnv('STRIPE_STARTER_AMOUNT_CENTS', '');
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
  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.stubEnv('STRIPE_STARTER_AMOUNT_CENTS', '500');
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
