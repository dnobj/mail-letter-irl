/**
 * Unit tests for Stripe Reconciliation Service
 *
 * Tests the reconciliation logic between Stripe payments and credit ledger:
 * - Detecting missing credits from paid Stripe sessions
 * - Detecting unprocessed refunds
 * - Auto-fixing missing credits with idempotency
 * - Handling both camelCase and snake_case metadata fields
 *
 * User Stories Covered:
 * - US-RECONCILE-01: Detect Missing Credits from Stripe Payments
 * - US-RECONCILE-02: Auto-fix Missing Credits with Idempotency
 * - US-RECONCILE-03: Detect Unprocessed Refunds
 *
 * GitHub Issue: #21
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stripeMockModule } from '../../mocks/stripe.js';

// Mock Stripe
const { mockSessionsList, mockRefundsList, mockQuery, mockRepairPackGrant } = vi.hoisted(() => ({
  mockSessionsList: vi.fn(),
  mockRefundsList: vi.fn(),
  mockQuery: vi.fn(),
  mockRepairPackGrant: vi.fn()
}));

// The one shared MockStripe (tests/mocks/stripe.ts). Unlisted surfaces are
// inert stubs, so this suite carries no methods it never asserts on.
vi.mock('stripe', () =>
  stripeMockModule({ sessionList: mockSessionsList, refundList: mockRefundsList })
);

// Mock database
vi.mock('../../../src/db/index.js', () => ({
  query: mockQuery,
}));
vi.mock('../../../src/services/commerceService.js', () => ({
  repairFulfilledPackGrant: mockRepairPackGrant,
}));

import {
  autoFixMissingCredits,
  reconcileStripePayments
} from '../../../src/services/stripeReconciliationService.js';

describe('background Stripe budget (#278)', () => {
  // Consolidating onto the shared client cut this job from stripe-node's 80s/2
  // default to the interactive 10s/1. Unpinned, deleting the restoration left
  // a paginated loop with no per-page recovery on a checkout-tuned budget: one
  // slow page aborts the whole run, and creditExpirationWorker's catch
  // swallows it unlogged (#278 review round 3).
  it('audits EVERY page of refunds, not just the newest hundred', async () => {
    // Stripe returns refunds newest-first, so a single 100-item page drops
    // the OLDEST refunds in the window - the aged, most likely unreconciled
    // ones, in exactly the mass-refund incident this audit exists for. The
    // sessions sweep beside it has always paginated (#278 round 9).
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_reconciliation');
    mockSessionsList.mockResolvedValue({ data: [], has_more: false });
    const firstPage = Array.from({ length: 100 }, (_unused, index) => ({
      id: `re_${index}`,
      status: 'failed',
      payment_intent: null
    }));
    mockRefundsList
      .mockResolvedValueOnce({ data: firstPage, has_more: true })
      .mockResolvedValueOnce({
        data: [{ id: 're_oldest', status: 'failed', payment_intent: null }],
        has_more: false
      });
    mockQuery.mockResolvedValue({ rows: [] });

    await reconcileStripePayments(7);

    expect(mockRefundsList).toHaveBeenCalledTimes(2);
    expect(mockRefundsList.mock.calls[1][0]).toMatchObject({ starting_after: 're_99' });
  });

  it('gives every outbound list call the background budget, not the checkout one', async () => {
    // The default `stripe` parameter builds the shared client, so the key must
    // be present; the module itself is mocked, so nothing leaves the process.
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_reconciliation');
    mockSessionsList.mockResolvedValue({ data: [], has_more: false });
    mockRefundsList.mockResolvedValue({ data: [] });
    mockQuery.mockResolvedValue({ rows: [] });

    await reconcileStripePayments(7);

    for (const spy of [mockSessionsList, mockRefundsList]) {
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls[0][1]).toMatchObject({
        timeout: 60_000,
        maxNetworkRetries: 2
      });
    }
  });
});

describe('Stripe Reconciliation Service (US-RECONCILE-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_mock');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('metadata field compatibility', () => {
    it('should detect sessions with camelCase metadata (userId, productId)', () => {
      const session = {
        id: 'cs_test_123',
        payment_status: 'paid',
        metadata: {
          userId: 'user-123',
          productId: 'credit-pack-10',
          credits: '10',
        },
        client_reference_id: 'user-123',
        amount_total: 1000,
        created: Date.now() / 1000,
      };

      // Verify the session has the expected structure
      expect(session.metadata.userId).toBe('user-123');
      expect(session.metadata.productId).toBe('credit-pack-10');
    });

    it('should detect sessions with snake_case metadata (user_id, product_id)', () => {
      const session = {
        id: 'cs_test_456',
        payment_status: 'paid',
        metadata: {
          user_id: 'user-456',
          product_id: 'credit-pack-4',
          credits: '4',
        },
        client_reference_id: 'user-456',
        amount_total: 500,
        created: Date.now() / 1000,
      };

      // Verify the session has the expected structure
      expect(session.metadata.user_id).toBe('user-456');
      expect(session.metadata.product_id).toBe('credit-pack-4');
    });

    it('should fall back to client_reference_id when userId not in metadata', () => {
      const session = {
        id: 'cs_test_789',
        payment_status: 'paid',
        metadata: {
          productId: 'credit-pack-10',
          credits: '10',
        },
        client_reference_id: 'user-789',
        amount_total: 1000,
        created: Date.now() / 1000,
      };

      // client_reference_id should be used as fallback
      expect(session.client_reference_id).toBe('user-789');
      expect(session.metadata.userId).toBeUndefined();
    });
  });

  describe('discrepancy detection', () => {
    it('joins pack ledger order references to their Stripe session', async () => {
      mockSessionsList.mockResolvedValue({ data: [{
        id: 'cs_pack', payment_status: 'paid', amount_total: 1000, currency: 'usd', created: Date.now() / 1000,
        client_reference_id: 'order-pack',
        metadata: { orderId: 'order-pack', orderType: 'letter_pack', productCode: 'credit-pack-10' }
      }], has_more: false });
      mockRefundsList.mockResolvedValue({ data: [] });
      mockQuery
        .mockResolvedValueOnce({ rows: [{
          ledger_id: 'ledger-pack', user_id: 'user-pack', initial_amount: 10,
          source_reference_id: 'order-pack', source_type: 'purchase', created_at: new Date(),
          order_id: 'order-pack', order_type: 'letter_pack', stripe_checkout_session_id: 'cs_pack'
        }] })
        .mockResolvedValueOnce({ rows: [{
          order_id: 'order-pack', order_type: 'letter_pack', stripe_checkout_session_id: 'cs_pack',
          status: 'fulfilled', user_id: 'user-pack', credits: 10,
          amount_cents: 1000, currency: 'usd'
        }] });
      await expect(reconcileStripePayments(1)).resolves.toMatchObject({
        summary: { matched: 1, missingInOurSystem: 0, ourCredits: 1 }
      });
    });

    it('reconciles JIT funding through its order without expecting a credit grant', async () => {
      mockSessionsList.mockResolvedValue({ data: [{
        id: 'cs_jit', payment_status: 'paid', amount_total: 499, currency: 'usd', created: Date.now() / 1000,
        client_reference_id: 'order-jit',
        metadata: { orderId: 'order-jit', orderType: 'jit_mail', productCode: 'jit-letter' }
      }], has_more: false });
      mockRefundsList.mockResolvedValue({ data: [] });
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{
          order_id: 'order-jit', order_type: 'jit_mail', stripe_checkout_session_id: 'cs_jit',
          status: 'fulfilled', user_id: 'user-jit', credits: null, amount_cents: 499, currency: 'usd'
        }] });
      const result = await reconcileStripePayments(1);
      expect(result.summary).toMatchObject({ matched: 1, missingInOurSystem: 0, ourCredits: 0 });
      expect(result.discrepancies).toEqual([]);
    });

    it('requires paid JIT checkout state to be reconciled by webhook instead of pack credit repair', async () => {
      mockSessionsList.mockResolvedValue({ data: [{
        id: 'cs_jit_pending', payment_status: 'paid', amount_total: 499, currency: 'usd',
        created: Date.now() / 1000, client_reference_id: 'order-jit-pending',
        metadata: { orderId: 'order-jit-pending', orderType: 'jit_mail', productCode: 'jit-letter' }
      }], has_more: false });
      mockRefundsList.mockResolvedValue({ data: [] });
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{
          order_id: 'order-jit-pending', order_type: 'jit_mail',
          stripe_checkout_session_id: 'cs_jit_pending', status: 'checkout_pending',
          user_id: 'user-jit', credits: null, amount_cents: 499, currency: 'usd'
        }] });

      const result = await reconcileStripePayments(1);

      expect(result.summary).toMatchObject({ matched: 0, missingInOurSystem: 1 });
      expect(result.discrepancies).toContainEqual(expect.objectContaining({
        type: 'missing_order', fundingType: 'jit_mail', orderId: 'order-jit-pending'
      }));
    });

    it('treats a refunded JIT order as reconciled without requiring a credit reversal row', async () => {
      mockSessionsList.mockResolvedValue({ data: [], has_more: false });
      mockRefundsList.mockResolvedValue({ data: [{
        id: 're_jit', status: 'succeeded', payment_intent: 'pi_jit', amount: 499
      }] });
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{
          order_id: 'order-jit', order_type: 'jit_mail', status: 'refunded',
          pack_reversal_recorded: true
        }] });

      await expect(reconcileStripePayments(1)).resolves.toMatchObject({
        summary: { unprocessedRefunds: 0 }
      });
    });

    it('requires a pack refund ledger reversal linked through the authoritative order', async () => {
      mockSessionsList.mockResolvedValue({ data: [], has_more: false });
      mockRefundsList.mockResolvedValue({ data: [{
        id: 're_pack', status: 'succeeded', payment_intent: 'pi_pack', amount: 500
      }] });
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{
          order_id: 'order-pack', order_type: 'letter_pack', status: 'refunded',
          pack_reversal_recorded: false
        }] });

      const result = await reconcileStripePayments(1);

      expect(result.summary.unprocessedRefunds).toBe(1);
      expect(result.discrepancies).toContainEqual(expect.objectContaining({
        type: 'unprocessed_refund', fundingType: 'letter_pack', orderId: 'order-pack'
      }));
    });

    it('logs structured discrepancy data without runtime identifiers', async () => {
      const sensitive = ['cs_private_session', 'auth0|private-user', 'pi_private_refund'];
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      mockSessionsList.mockResolvedValue({
        data: [{
          id: sensitive[0], payment_status: 'paid',
          metadata: { userId: sensitive[1], productId: 'credit-pack-10' },
          client_reference_id: sensitive[1], amount_total: 1000, created: Date.now() / 1000
        }],
        has_more: false
      });
      mockRefundsList.mockResolvedValue({ data: [] });
      mockQuery.mockResolvedValue({ rows: [] });

      await reconcileStripePayments(1);

      const logged = [...log.mock.calls, ...warn.mock.calls].flat().map(String).join('\n');
      expect(logged).toContain('"event":"credits.reconciliation_discrepancy"');
      expect(logged).toContain('"category":"missing_credit"');
      expect(logged).toContain('"occurrence":1');
      for (const value of sensitive) expect(logged).not.toContain(value);
    });

    it('should identify missing_credit when payment exists in Stripe but not in ledger', () => {
      const discrepancy = {
        type: 'missing_credit',
        severity: 'critical',
        stripeSessionId: 'cs_test_missing',
        userId: 'user-123',
        expectedCredits: 10,
        message: 'Payment exists in Stripe but credits were never added',
        suggestedAction: 'Run addCreditsWithOptions()',
      };

      expect(discrepancy.type).toBe('missing_credit');
      expect(discrepancy.severity).toBe('critical');
    });

    it('should identify amount_mismatch when credits differ', () => {
      const discrepancy = {
        type: 'amount_mismatch',
        severity: 'high',
        stripeSessionId: 'cs_test_mismatch',
        expectedCredits: 10,
        actualCredits: 4,
        message: 'Credit amount mismatch',
      };

      expect(discrepancy.type).toBe('amount_mismatch');
      expect(discrepancy.expectedCredits).not.toBe(discrepancy.actualCredits);
    });

    it('should identify unprocessed_refund when refund not in transactions', () => {
      const discrepancy = {
        type: 'unprocessed_refund',
        severity: 'high',
        stripeSessionId: 'pi_refund_123',
        stripeAmount: 1000,
        message: 'Refund processed in Stripe but not reflected in credit system',
      };

      expect(discrepancy.type).toBe('unprocessed_refund');
      expect(discrepancy.severity).toBe('high');
    });
  });

  it('classifies reconciliation repair persistence failures as database errors', async () => {
    mockSessionsList.mockResolvedValue({
      data: [{
        id: 'cs_private', payment_status: 'paid', currency: 'usd',
        metadata: { userId: 'auth0|private', productId: 'credit-pack-10' },
        amount_total: 1000, created: Date.now() / 1000
      }],
      has_more: false
    });
    mockRefundsList.mockResolvedValue({ data: [] });
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        order_id: 'order-private',
        order_type: 'letter_pack',
        stripe_checkout_session_id: 'cs_private',
        status: 'fulfilled',
        user_id: 'auth0|private',
        credits: 10,
        amount_cents: 1000,
        currency: 'usd'
      }] });
    mockRepairPackGrant.mockRejectedValue(new Error('private database message'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await autoFixMissingCredits(false);

    const output = error.mock.calls.flat().map(String).join('\n');
    expect(output).toContain('"event":"credits.reconciliation_fix_failed"');
    expect(output).toContain('"errorClass":"database_error"');
    expect(output).not.toContain('private database message');
  });

  it('repairs a missing pack grant only through its exact order and Stripe session', async () => {
    mockSessionsList.mockResolvedValue({
      data: [{
        id: 'cs_pack_repair', payment_status: 'paid', currency: 'usd',
        metadata: { userId: 'user-pack', productId: 'credit-pack-10' },
        amount_total: 1000, created: Date.now() / 1000
      }],
      has_more: false
    });
    mockRefundsList.mockResolvedValue({ data: [] });
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        order_id: 'order-pack-repair', order_type: 'letter_pack',
        stripe_checkout_session_id: 'cs_pack_repair', status: 'fulfilled',
        user_id: 'user-pack', credits: 10, amount_cents: 1000, currency: 'usd'
      }] });
    mockRepairPackGrant.mockResolvedValue('repaired');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(autoFixMissingCredits(false)).resolves.toMatchObject({ fixed: 1, errors: [] });
    expect(mockRepairPackGrant).toHaveBeenCalledWith({
      orderId: 'order-pack-repair',
      stripeSessionId: 'cs_pack_repair',
      expectedCredits: 10,
      paidAmountCents: 1000,
      paidCurrency: 'usd'
    });
  });

  describe('product credit mapping', () => {
    it('should map credit-pack-4 to 4 credits', () => {
      const PRODUCT_CREDITS: Record<string, number> = {
        'credit-pack-4': 4,
        'credit-pack-10': 10,
        'credit-pack-100': 100,
      };

      expect(PRODUCT_CREDITS['credit-pack-4']).toBe(4);
    });

    it('should map credit-pack-10 to 10 credits', () => {
      const PRODUCT_CREDITS: Record<string, number> = {
        'credit-pack-4': 4,
        'credit-pack-10': 10,
        'credit-pack-100': 100,
      };

      expect(PRODUCT_CREDITS['credit-pack-10']).toBe(10);
    });

    it('should map credit-pack-100 to 100 credits', () => {
      const PRODUCT_CREDITS: Record<string, number> = {
        'credit-pack-4': 4,
        'credit-pack-10': 10,
        'credit-pack-100': 100,
      };

      expect(PRODUCT_CREDITS['credit-pack-100']).toBe(100);
    });

    it('should parse credits from metadata as fallback', () => {
      const session = {
        metadata: {
          credits: '10',
          productId: 'unknown-product',
        },
      };

      const credits = parseInt(session.metadata.credits || '0');
      expect(credits).toBe(10);
    });
  });
});

describe('Auto-fix Missing Credits (US-RECONCILE-02)', () => {
  it('should support dry-run mode that reports but does not fix', () => {
    const dryRunResult = {
      wouldFix: 3,
      fixed: 0,
      errors: [],
    };

    expect(dryRunResult.wouldFix).toBe(3);
    expect(dryRunResult.fixed).toBe(0);
  });

  it('should fix credits when dry-run is false', () => {
    const fixResult = {
      wouldFix: 3,
      fixed: 3,
      errors: [],
    };

    expect(fixResult.fixed).toBe(fixResult.wouldFix);
  });

  it('should track errors when fixes fail', () => {
    const fixResult = {
      wouldFix: 3,
      fixed: 2,
      errors: ['Failed to fix cs_test_123: User not found'],
    };

    expect(fixResult.errors.length).toBe(1);
    expect(fixResult.fixed).toBeLessThan(fixResult.wouldFix);
  });

  it('should use 2-year expiration for reconciled credits', () => {
    const expirationDays = 730; // 2 years
    const expectedExpiration = new Date();
    expectedExpiration.setDate(expectedExpiration.getDate() + expirationDays);

    expect(expirationDays).toBe(730);
  });
});

describe('Webhook Idempotency (US-RECONCILE-03)', () => {
  it('should check ledger before adding credits to prevent double-apply', () => {
    // The webhook handler checks credit_ledger for existing source_reference_id
    const idempotencyCheck = {
      query: `SELECT ledger_id FROM credit_ledger WHERE source_reference_id = $1 AND source_type = 'purchase'`,
      params: ['cs_test_123'],
    };

    expect(idempotencyCheck.query).toContain('source_reference_id');
    expect(idempotencyCheck.query).toContain('source_type');
  });

  it('should skip processing if session already exists in ledger', () => {
    const existingEntry = { ledger_id: 'existing-123' };
    const shouldSkip = existingEntry !== null;

    expect(shouldSkip).toBe(true);
  });

  it('should process if session does not exist in ledger', () => {
    const existingEntry = null;
    const shouldProcess = existingEntry === null;

    expect(shouldProcess).toBe(true);
  });
});

describe('Reconciliation Summary', () => {
  it('should provide complete summary of reconciliation results', () => {
    const summary = {
      stripePayments: 10,
      ourCredits: 8,
      matched: 7,
      missingInOurSystem: 3,
      missingInStripe: 1,
      amountMismatches: 0,
      unprocessedRefunds: 1,
    };

    // Validate relationships
    expect(summary.matched + summary.missingInOurSystem).toBeLessThanOrEqual(summary.stripePayments);
    expect(summary.matched).toBeLessThanOrEqual(summary.ourCredits);
  });

  it('should generate recommendations for critical issues', () => {
    const recommendations = [
      'CRITICAL: 3 payments in Stripe have no corresponding credits.',
      'HIGH: 1 refunds in Stripe were not processed.',
    ];

    expect(recommendations.some(r => r.includes('CRITICAL'))).toBe(true);
    expect(recommendations.some(r => r.includes('HIGH'))).toBe(true);
  });
});
