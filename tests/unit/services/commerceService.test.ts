import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  addCredits: vi.fn(),
  grantEntitlement: vi.fn(),
  createMail: vi.fn(),
  createJitSession: vi.fn(),
  createPackSession: vi.fn(),
  createRefund: vi.fn(),
  findRefund: vi.fn(),
  retrieveRefund: vi.fn(),
  retrieveSession: vi.fn(),
  jitEnabled: vi.fn(),
  getJitProduct: vi.fn(),
  getPackProduct: vi.fn(),
  ensurePriceCatalog: vi.fn(),
  describeUnpriced: vi.fn(() => null)
}));

/**
 * commerceService awaits ensurePriceCatalog() at three chokepoints (#275
 * stage A). This suite mocked stripeService but not the catalog, so the REAL
 * resolver ran from a unit suite: its default retriever is
 * getStripeClient().prices.retrieve, which with STRIPE_SECRET_KEY absent threw
 * into a swallowed catch - the ensure calls were exercised as silent no-ops and
 * nothing here would have noticed if all three were deleted - and with a key
 * present in a developer's shell became real outbound requests to
 * api.stripe.com, under a 10s client timeout against vitest's 10s testTimeout
 * (#278 review round 2).
 */
vi.mock('../../../src/services/priceCatalog.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/services/priceCatalog.js')>();
  return {
  ensurePriceCatalog: mocks.ensurePriceCatalog,
  // The guards read describeUnpriced (non-null by contract); the fixtures
  // still drive it through getPriceResolutionFailure so each test states its
  // catalog verdict the same way it always did, with the synthesized
  // transient record as the null-case default - mirroring production.
  // Null from a fixture means "no recorded failure": the synthesized
  // transient record is the null-case default, mirroring production's
  // non-null contract. The knob carries the REAL seam's name - the earlier
  // getPriceResolutionFailure knob cemented a describeUnpriced wiring that
  // never existed in src (#278 round 8).
  describeUnpriced: (productCode: string) =>
    mocks.describeUnpriced(productCode) ?? {
      productCode,
      rule: 'price.not_resolved',
      diagnosticClass: 'provider_error'
    },
  // The REAL formatter, not a retype of it: this string is the slot
  // SIGNATURE that decides whether a fault logs at all, and it has changed
  // in four consecutive rounds - a copy here could not fail when the real
  // one drifts, which is the whole defect these tests exist to catch
  // (#278 round 11; the readyz suite already does this).
  formatPriceFailureSummary: actual.formatPriceFailureSummary,
  // Swallows like production kick: aliasing straight to the ensure mock let a
  // mockRejectedValue fixture leak an unhandled rejection from fire-and-forget
  // call sites - a failure mode the real kick structurally cannot produce.
  kickPriceCatalog: (...args: unknown[]) => {
    try {
      void Promise.resolve(mocks.ensurePriceCatalog(...args)).catch(() => undefined);
    } catch {
      /* swallowed, as in production */
    }
  }
  };
});

vi.mock('../../../src/db/index.js', () => ({
  query: mocks.query,
  transaction: mocks.transaction
}));
vi.mock('../../../src/services/creditLedgerService.js', () => ({
  addCreditsToLedgerWithClient: mocks.addCredits
}));
vi.mock('../../../src/services/imageGenerationLimitService.js', () => ({
  grantImageEntitlementWithClient: mocks.grantEntitlement
}));
vi.mock('../../../src/services/mailSendService.js', () => ({
  createMailOrderFromDraftWithClient: mocks.createMail
}));
vi.mock('../../../src/services/stripeService.js', () => ({
  createJitCheckoutSession: mocks.createJitSession,
  createPackCheckoutSession: mocks.createPackSession,
  createPaymentRefund: mocks.createRefund,
  findPaymentRefund: mocks.findRefund,
  retrieveRefund: mocks.retrieveRefund,
  retrieveCheckoutSession: mocks.retrieveSession,
  isJitPurchaseEnabled: mocks.jitEnabled,
  getJitProductConfig: mocks.getJitProduct,
  getPackProductConfig: mocks.getPackProduct
}));

import {
  ACTIVE_JIT_STATUSES,
  FUNDED_OR_REVERSED_ORDER_STATUSES,
  PackAmountNotConfiguredError,
  createPackCheckout,
  createJitCheckout,
  getSendEligibility,
  processStripeWebhookEvent,
  repairFulfilledPackGrant,
  requestRefund,
  runCommerceMaintenance
} from '../../../src/services/commerceService.js';
import { clearDiagnosticChangeSlot } from '../../../src/utils/diagnosticLog.js';

const baseOrder = {
  order_id: 'order-1',
  user_id: 'user-1',
  order_type: 'jit_mail',
  draft_id: 'draft-1',
  product_code: 'jit-letter',
  product_snapshot: {
    name: 'Pay & Send One Physical Letter',
    mailType: 'letter'
  },
  amount_cents: 499,
  currency: 'usd',
  payment_provider: 'stripe',
  idempotency_key: 'jit-checkout:order-1',
  status: 'checkout_pending',
  refund_attempts: 0,
  created_at: new Date(),
  updated_at: new Date()
};

function checkoutEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs-1',
        client_reference_id: 'order-1',
        metadata: { orderId: 'order-1' },
        payment_status: 'paid',
        payment_intent: 'pi-1',
        amount_total: 499,
        currency: 'usd',
        expires_at: Math.floor(Date.now() / 1000) + 1800,
        ...overrides
      }
    }
  } as any;
}

const ACCOUNT_LOCK_SQL = 'SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE';

describe('commerceService', () => {
  it('uses the same active JIT status set as the database uniqueness policy', () => {
    expect(ACTIVE_JIT_STATUSES).toEqual([
      'checkout_pending', 'paid', 'fulfillment_pending', 'refund_pending', 'disputed', 'held'
    ]);
  });

  it('treats every funded, reversed, disputed, or held order as terminal for checkout replay', () => {
    expect(FUNDED_OR_REVERSED_ORDER_STATUSES).toEqual([
      'fulfillment_pending', 'fulfilled', 'refund_pending', 'refunded', 'disputed', 'held'
    ]);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('IMAGE_ENTITLEMENTS_PER_JIT_ORDER', '1');
    mocks.transaction.mockImplementation(async callback => callback({ query: mocks.query }));
    mocks.jitEnabled.mockReturnValue(true);
    mocks.getJitProduct.mockReturnValue({
      productCode: 'jit-letter',
      priceId: 'price-jit-letter',
      amountCents: 499,
      currency: 'usd',
      name: 'Pay & Send One Physical Letter',
      description: 'Payment authorizes mailing this exact item.',
      mailType: 'letter'
    });
    mocks.getPackProduct.mockReturnValue({
      productCode: 'credit-pack-4',
      priceId: 'price-pack',
      amountCents: 500,
      currency: 'usd',
      name: 'Starter Pack - 2 Letters',
      description: 'Two prepaid physical letters',
      credits: 4
    });
    mocks.createMail.mockResolvedValue({});
    mocks.grantEntitlement.mockResolvedValue({ entitlement_id: 'ent-1' });
    mocks.findRefund.mockResolvedValue(null);
    // vi.clearAllMocks() resets call history but NOT mockReturnValue, and this
    // one decides throw-vs-refuse for a paid webhook - so a leftover from an
    // earlier test silently changed a later test's outcome, and adding or
    // reordering a test could flip an assertion nobody edited (#278 r3).
    mocks.describeUnpriced.mockReturnValue(null as never);
  });

  it('sweeps session-less orders whose checkout_expires_at is NULL', async () => {
    // Pack orders are INSERTed without checkout_expires_at, and NULL <= NOW()
    // is UNKNOWN - so a pack whose session creation failed non-terminally was
    // a zombie the orphan sweep could never reclaim, stranded in
    // checkout_pending forever with no alarm (the stuck-order check watches
    // paid statuses only) (#278 review round 4).
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.retrieveSession.mockResolvedValue(null);

    await runCommerceMaintenance();

    const orphanSweep = mocks.query.mock.calls
      .map(([sql]) => String(sql))
      .find(sql => sql.includes("status = 'checkout_pending'") && sql.includes('stripe_checkout_session_id IS NULL'));
    expect(orphanSweep).toBeDefined();
    expect(orphanSweep).toContain('checkout_expires_at IS NULL');
  });

  it('never touches the price catalog from the webhook path', async () => {
    // The money already moved. Adoption prices from the static product table
    // and the paid-amount comparison verifies the charge, so a live Stripe
    // read here can only add failure modes - webhook 500 loops on transient
    // faults, paid money stranded during a key rotation (#278 review r5).
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-1' }] };
      if (sql.includes('SELECT * FROM orders')) return { rows: [baseOrder] };
      return { rows: [] };
    });

    await processStripeWebhookEvent(checkoutEvent({
      metadata: { orderId: 'order-1', orderType: 'jit_mail', productCode: 'jit-letter' }
    }));

    expect(mocks.ensurePriceCatalog).not.toHaveBeenCalled();
  });

  it('claims concurrent Stripe event replays so only one can send or grant', async () => {
    let claimed = false;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [{ event_id: 'evt-1' }] };
      }
      if (sql.includes('SELECT * FROM orders')) return { rows: [baseOrder] };
      return { rows: [] };
    });

    const [first, replay] = await Promise.all([
      processStripeWebhookEvent(checkoutEvent()),
      processStripeWebhookEvent(checkoutEvent())
    ]);

    expect(first).toMatchObject({
      duplicate: false,
      status: 'fulfillment_pending'
    });
    expect(replay).toEqual({ duplicate: true });
    expect(mocks.createMail).toHaveBeenCalledTimes(1);
    expect(mocks.createMail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        draftId: 'draft-1',
        funding: { type: 'jit_order', orderId: 'order-1' }
      })
    );
    expect(mocks.grantEntitlement).toHaveBeenCalledTimes(1);
  });

  it('rolls back a webhook claim after a transaction crash so replay can recover', async () => {
    let committedClaim = false;
    let crashBeforeOrderLock = true;
    mocks.transaction.mockImplementation(async callback => {
      let transactionClaim = committedClaim;
      const transactionQuery = vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) {
          if (transactionClaim) return { rows: [] };
          transactionClaim = true;
          return { rows: [{ event_id: 'evt-1' }] };
        }
        if (sql.includes('SELECT * FROM orders')) {
          if (crashBeforeOrderLock) {
            crashBeforeOrderLock = false;
            throw new Error('database process terminated before commit');
          }
          return { rows: [baseOrder] };
        }
        return { rows: [] };
      });

      const result = await callback({ query: transactionQuery });
      committedClaim = transactionClaim;
      return result;
    });

    await expect(processStripeWebhookEvent(checkoutEvent())).rejects.toThrow(
      'database process terminated before commit'
    );
    await expect(processStripeWebhookEvent(checkoutEvent())).resolves.toMatchObject({
      duplicate: false,
      status: 'fulfillment_pending'
    });

    expect(mocks.createMail).toHaveBeenCalledTimes(1);
    expect(mocks.grantEntitlement).toHaveBeenCalledTimes(1);
    expect(committedClaim).toBe(true);
  });

  it('commits a dispute alert with its event claim so handler failure can replay', async () => {
    let committedClaim = false;
    let failAlertInsert = true;
    let alertInsertions = 0;
    mocks.transaction.mockImplementation(async callback => {
      let transactionClaim = committedClaim;
      const transactionQuery = vi.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) {
          if (transactionClaim) return { rows: [] };
          transactionClaim = true;
          return { rows: [{ event_id: 'evt-dispute' }] };
        }
        if (sql.includes('INSERT INTO commerce_operational_alerts')) {
          alertInsertions += 1;
          expect(String(params[3])).not.toContain('dp-sensitive');
          expect(String(params[3])).not.toContain('ch-sensitive');
          if (failAlertInsert) {
            failAlertInsert = false;
            throw new Error('alert insert failed before transaction commit');
          }
          return { rows: [] };
        }
        return { rows: [] };
      });
      const result = await callback({ query: transactionQuery });
      committedClaim = transactionClaim;
      return result;
    });
    const event = {
      id: 'evt-dispute',
      type: 'charge.dispute.created',
      data: {
        object: {
          id: 'dp-sensitive',
          charge: 'ch-sensitive',
          amount: 499,
          currency: 'usd',
          reason: 'fraudulent',
          status: 'needs_response'
        }
      }
    } as any;

    await expect(processStripeWebhookEvent(event)).rejects.toThrow('alert insert failed');
    await expect(processStripeWebhookEvent(event)).resolves.toEqual({ duplicate: false });

    expect(alertInsertions).toBe(2);
    expect(committedClaim).toBe(true);
  });

  it.each(['disputed', 'held', 'refunded', 'fulfilled'])(
    'ignores a replayed paid checkout for a %s order instead of re-granting',
    async (status) => {
      const guarded = {
        ...baseOrder, order_type: 'letter_pack', product_code: 'credit-pack-4',
        credits: 4, amount_cents: 500, status
      };
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-1' }] };
        if (sql.includes('SELECT * FROM orders')) return { rows: [guarded] };
        return { rows: [] };
      });

      await expect(processStripeWebhookEvent(checkoutEvent({ amount_total: 500 }) as any))
        .resolves.toMatchObject({ duplicate: false, status });

      expect(mocks.addCredits).not.toHaveBeenCalled();
      expect(mocks.grantEntitlement).not.toHaveBeenCalled();
      expect(mocks.query).not.toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'paid'"),
        expect.anything()
      );
    }
  );

  it('binds a pack grant to its funding order so the database can reject a replay', async () => {
    const pendingPackOrder = {
      ...baseOrder, order_type: 'letter_pack', product_code: 'credit-pack-4',
      credits: 4, amount_cents: 500, draft_id: undefined, status: 'checkout_pending'
    };
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-1' }] };
      if (sql.includes('SELECT * FROM orders')) return { rows: [pendingPackOrder] };
      return { rows: [] };
    });

    await expect(processStripeWebhookEvent(checkoutEvent({ amount_total: 500 }) as any))
      .resolves.toMatchObject({ status: 'fulfilled' });

    expect(mocks.addCredits).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceType: 'purchase', sourceOrderId: 'order-1' })
    );
  });

  // Deterministic proof of the canonical order. The PostgreSQL concurrency
  // tests can only ever show the absence of a deadlock on the interleavings
  // they happen to hit; this asserts the statement order itself.
  it.each([
    ['refund webhook', async () => {
      await processStripeWebhookEvent({
        id: 'evt-refund-lock', type: 'refund.updated', data: { object: {
          id: 're-lock', payment_intent: 'pi-lock', charge: 'ch-lock',
          amount: 500, status: 'succeeded', metadata: {}
        } }
      } as any);
    }],
    ['operator refund request', async () => {
      await requestRefund('order-1', 'operator requested');
    }],
    ['reconciliation pack repair', async () => {
      await repairFulfilledPackGrant({
        orderId: 'order-1', stripeSessionId: 'cs-lock', expectedCredits: 4,
        paidAmountCents: 500, paidCurrency: 'usd'
      });
    }]
  ])('locks the account row before any ledger or entitlement write (%s)', async (_label, run) => {
    const packOrder = {
      ...baseOrder, order_type: 'letter_pack', product_code: 'credit-pack-4',
      draft_id: undefined, credits: 4, amount_cents: 500, currency: 'usd',
      status: 'fulfilled', stripe_checkout_session_id: 'cs-lock',
      stripe_payment_intent_id: 'pi-lock', refund_attempts: 0
    };
    mocks.findRefund.mockResolvedValue({ id: 're-lock', status: 'succeeded' });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-refund-lock' }] };
      if (sql.includes('UPDATE orders') && sql.includes('RETURNING order_id')) {
        return { rows: [{ order_id: 'order-1' }] };
      }
      if (sql.includes('FROM orders')) return { rows: [packOrder] };
      if (sql.includes('FROM credit_ledger')) return { rows: [] };
      return { rows: [] };
    });

    await run().catch(() => undefined);
    // The scenario must actually reach ledger/entitlement work, or the
    // assertion below would be vacuously satisfied by an empty trace.
    expect(mocks.query.mock.calls.some(call =>
      String(call[0]).includes('credit_ledger') ||
      String(call[0]).includes('image_entitlements'))).toBe(true);

    // Exact-match the account lock, not merely "contains FOR UPDATE": the
    // ledger statements this guards against are themselves SELECT ... FOR
    // UPDATE, so a looser predicate would still pass with the lock removed.
    const ordered = mocks.query.mock.calls
      .filter(call =>
        String(call[0]) === ACCOUNT_LOCK_SQL ||
        String(call[0]).includes('credit_ledger') ||
        String(call[0]).includes('image_entitlements'));
    expect([String(ordered[0]?.[0]), ordered[0]?.[1]]).toEqual([ACCOUNT_LOCK_SQL, ['user-1']]);
  });

  it('adopts a paid legacy session from the product table, whatever the catalog says', async () => {
    // Adoption of already-paid money must not depend on the current state of
    // a Stripe lookup: terminal-classed blips stranded paying customers as
    // permanently unmatched, transient-classed ones 500-looped the webhook on
    // the schedule Stripe uses to disable endpoints. The pinned amount is the
    // business agreement; the paid-amount comparison downstream verifies the
    // actual charge against it (#278 review round 5). The catalog mocks here
    // scream "unpriced" precisely to prove they are not consulted.
    mocks.describeUnpriced.mockReturnValue({
      productCode: 'credit-pack-4',
      rule: 'price.inactive',
      diagnosticClass: 'configuration_error'
    } as never);
    mocks.getPackProduct.mockReturnValue({
      productCode: 'credit-pack-4',
      priceId: 'price-pack',
      amountCents: 0,
      currency: 'usd',
      credits: 4,
      name: 'Starter Pack',
      description: 'Two prepaid letters'
    });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-legacy' }] };
      if (sql.includes('INSERT INTO orders')) {
        return { rows: [{
          ...baseOrder,
          order_id: 'stripe-cs-legacy',
          order_type: 'letter_pack',
          product_code: 'credit-pack-4',
          credits: 4,
          amount_cents: 500,
          status: 'paid'
        }] };
      }
      return { rows: [] };
    });

    await expect(processStripeWebhookEvent(checkoutEvent({
      id: 'cs-legacy',
      client_reference_id: null,
      metadata: { userId: 'user-1', productId: 'credit-pack-4' },
      amount_total: 500
    }) as any)).resolves.toMatchObject({ duplicate: false });

    // The order is INSERTed at the TABLE's pinned amount (500 for the
    // starter), not at anything the mocked-out catalog could have said.
    const insert = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO orders')
    );
    expect(insert).toBeDefined();
    expect(insert?.[1]).toEqual(expect.arrayContaining([500, 4, 'credit-pack-4']));
    // And nothing was BOOKED as unmatched: the money found its order. (The
    // adoption flow legitimately SELECTs previously-unmatched events to
    // reconcile them, so match the write, not the phrase.)
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET processing_status = 'unmatched'"),
      expect.anything()
    );
    expect(mocks.getPackProduct).not.toHaveBeenCalled();
  });

  it('does not raise a money alarm for an UNPAID legacy session', async () => {
    // The gate runs for every legacy-metadata session, including expiries and
    // failed async payments, whose amount_total is a historical price nobody
    // paid. Logging those at error made an unpaid expiry indistinguishable
    // from the real paid-mismatch alarm this event name exists for, and the
    // payload carried nothing to tell them apart (#278 round 9).
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-x' }] };
        return { rows: [] };
      });

      await processStripeWebhookEvent(
        checkoutEvent({
          payment_status: 'unpaid',
          amount_total: 399,
          client_reference_id: null,
          metadata: { userId: 'user-1', productCode: 'credit-pack-4' }
        })
      );

      const lines = (spy: typeof errorSpy) =>
        spy.mock.calls
          .flat()
          .map(String)
          .filter(line => line.includes('commerce.legacy_adoption_amount_mismatch'));
      expect(lines(errorSpy)).toHaveLength(0);
      expect(lines(infoSpy)).toHaveLength(1);
      expect(lines(infoSpy)[0]).toContain('"paymentStatus":"unpaid"');
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it('still raises the money alarm when a PAID legacy session disagrees', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-y' }] };
        return { rows: [] };
      });

      await processStripeWebhookEvent(
        checkoutEvent({
          payment_status: 'paid',
          amount_total: 399,
          client_reference_id: null,
          metadata: { userId: 'user-1', productCode: 'credit-pack-4' }
        })
      );

      const lines = errorSpy.mock.calls
        .flat()
        .map(String)
        .filter(line => line.includes('commerce.legacy_adoption_amount_mismatch'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"paymentStatus":"paid"');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('refuses a draft too close to expiry to carry a reusable window', async () => {
    // The stamped value is min(configured, draftExpiry), so raising only the
    // configured branch left a draft in its last 40 minutes stamping barely
    // above Stripe's floor - the seconds-wide reuse window round 11 believed
    // it had closed, still open for exactly those checkouts (#278 round 12).
    mocks.getJitProduct.mockReturnValue({
      productCode: 'jit-letter', priceId: 'price-jit', amountCents: 499,
      currency: 'usd', name: 'Pay & Send One Physical Letter',
      description: 'x', mailType: 'letter'
    });
    mocks.query
      .mockResolvedValueOnce({ rows: [{ mail_type: 'letter' }] })
      .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
      .mockResolvedValueOnce({
        rows: [{
          draft_id: 'draft-1', user_id: 'user-1', mail_type: 'letter',
          required_credits: 2, status: 'pending',
          // Past Stripe's 30-minute floor, inside the floor plus the reuse
          // budget: a session could be opened, but not a reusable one.
          expires_at: new Date(Date.now() + 35 * 60_000)
        }]
      })
      .mockResolvedValue({ rows: [] });

    await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }))
      .rejects.toMatchObject({ code: 'DRAFT_TOO_CLOSE_TO_EXPIRY' });
  });

  it('reports an EXPIRED draft as expired, not as already sent', async () => {
    // The sweeper flips aged drafts to 'expired', and the generic
    // invalid-state throw told the customer it had "already been sent or
    // cancelled" - false, and contradicting what the same draft got one
    // sweep cycle earlier (#278 round 12).
    mocks.query
      .mockResolvedValueOnce({ rows: [{ mail_type: 'letter' }] })
      .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
      .mockResolvedValueOnce({
        rows: [{
          draft_id: 'draft-1', user_id: 'user-1', mail_type: 'letter',
          required_credits: 2, status: 'expired',
          expires_at: new Date(Date.now() + 6 * 60 * 60_000)
        }]
      })
      .mockResolvedValue({ rows: [] });

    await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }))
      .rejects.toMatchObject({ code: 'DRAFT_EXPIRED' });
  });

  it('records WHY a live row was retired, in both audit columns', async () => {
    // A row inside Stripe's floor has not expired, and saying so in order
    // history is a statement an operator acts on. Round 11 also wrote only
    // the code, leaving the previous failure's message beside it, so the two
    // columns described different events (#278 round 12).
    mocks.getJitProduct.mockReturnValue({
      productCode: 'jit-letter', priceId: 'price-jit', amountCents: 499,
      currency: 'usd', name: 'Pay & Send One Physical Letter',
      description: 'x', mailType: 'letter'
    });
    const tooShort = {
      ...baseOrder,
      stripe_checkout_session_id: null,
      checkout_url: null,
      last_error: 'Failed to create Pay & Send checkout',
      last_error_code: 'CHECKOUT_CREATION_FAILED',
      checkout_expires_at: new Date(Date.now() + 20 * 60_000)
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [{ mail_type: 'letter' }] })
      .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
      .mockResolvedValueOnce({
        rows: [{
          draft_id: 'draft-1', user_id: 'user-1', mail_type: 'letter',
          required_credits: 2, status: 'pending',
          expires_at: new Date(Date.now() + 6 * 60 * 60_000)
        }]
      })
      .mockResolvedValueOnce({ rows: [tooShort] })
      .mockResolvedValue({ rows: [baseOrder] });
    mocks.createJitSession.mockResolvedValue({
      success: true, sessionId: 'cs-fresh', sessionUrl: 'https://s', expiresAt: new Date()
    });

    await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }).catch(() => undefined);

    const cancel = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("SET status = 'cancelled'") && String(sql).includes('last_error')
    );
    expect(cancel).toBeDefined();
    expect(cancel?.[1]).toContain('CHECKOUT_WINDOW_TOO_SHORT');
    // The statement writes the PAIR: a code without its message leaves the
    // previous failure's text beside it.
    expect(String(cancel?.[0])).toContain('last_error = $3');
    expect(String(cancel?.[1]?.[2])).toMatch(/too short/i);
  });

  it('charges the price id recorded on the row, not a later catalog read', async () => {
    // The amount came from the row while the price id came from a live read,
    // so a repoint between insert and session-create opened a session on the
    // NEW Price against the OLD recorded amount - the customer pays one
    // figure, the row holds another, and a legitimate purchase is filed as
    // PAYMENT_AMOUNT_MISMATCH (#278 round 12).
    mocks.getJitProduct.mockReturnValue({
      productCode: 'jit-letter', priceId: 'price-jit-REPOINTED', amountCents: 599,
      currency: 'usd', name: 'Pay & Send One Physical Letter',
      description: 'x', mailType: 'letter'
    });
    const reusable = {
      ...baseOrder,
      amount_cents: 499,
      product_snapshot: { ...baseOrder.product_snapshot, priceId: 'price-jit-AS-SOLD' },
      stripe_checkout_session_id: 'cs-existing',
      checkout_url: null,
      checkout_expires_at: new Date(Date.now() + 90 * 60_000)
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [{ mail_type: 'letter' }] })
      .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
      .mockResolvedValueOnce({
        rows: [{
          draft_id: 'draft-1', user_id: 'user-1', mail_type: 'letter',
          required_credits: 2, status: 'pending',
          expires_at: new Date(Date.now() + 6 * 60 * 60_000)
        }]
      })
      .mockResolvedValueOnce({ rows: [reusable] })
      .mockResolvedValue({ rows: [reusable] });
    mocks.createJitSession.mockResolvedValue({
      success: true, sessionId: 'cs-x', sessionUrl: 'https://s', expiresAt: new Date()
    });

    await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }).catch(() => undefined);

    expect(mocks.createJitSession).toHaveBeenCalledWith(
      expect.objectContaining({
        product: expect.objectContaining({
          priceId: 'price-jit-AS-SOLD',
          amountCents: 499
        })
      })
    );
  });

  it('refuses to reuse a sessionless order too close to expiry for Stripe', async () => {
    // Stripe rejects a Checkout Session whose expires_at is under 30 minutes
    // away, and a reused sessionless row forwards its stored expiry verbatim.
    // A row created 10 minutes ago on the default 30-minute window has ~20
    // left, so every retry was rejected and left pending - the customer could
    // not open a checkout for that draft until the row aged out (#278 r10).
    mocks.getJitProduct.mockReturnValue({
      productCode: 'jit-letter', priceId: 'price-jit', amountCents: 499,
      currency: 'usd', name: 'Pay & Send One Physical Letter',
      description: 'x', mailType: 'letter'
    });
    const tooClose = {
      ...baseOrder,
      stripe_checkout_session_id: null,
      checkout_url: null,
      checkout_expires_at: new Date(Date.now() + 20 * 60_000)
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [{ mail_type: 'letter' }] })
      .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
      .mockResolvedValueOnce({
        rows: [{
          draft_id: 'draft-1', user_id: 'user-1', mail_type: 'letter',
          required_credits: 2, status: 'pending',
          expires_at: new Date(Date.now() + 6 * 60 * 60_000)
        }]
      })
      .mockResolvedValueOnce({ rows: [tooClose] })
      .mockResolvedValue({ rows: [baseOrder] });
    mocks.createJitSession.mockResolvedValue({
      success: true, sessionId: 'cs-fresh', sessionUrl: 'https://s', expiresAt: new Date()
    });

    await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }).catch(() => undefined);

    const cancelled = mocks.query.mock.calls
      .map(([sql]) => String(sql))
      .some(sql => sql.includes("SET status = 'cancelled'"));
    expect(cancelled).toBe(true);
  });

  it('treats an UNRESOLVED catalog as no verdict, never as a price change', async () => {
    // amountCents 0 is the catalog's unresolved sentinel. Three review angles
    // read the reprice branch as cancelling a reusable order during a
    // transient Stripe blip; the enclosing transaction happened to roll the
    // cancel back, but the branch must not fire at all (#278 round 8).
    mocks.getJitProduct.mockReturnValue({
      productCode: 'jit-letter', priceId: 'price-jit', amountCents: 0,
      currency: 'usd', name: 'Pay & Send One Physical Letter',
      description: 'x', mailType: 'letter'
    });
    const stale = {
      ...baseOrder,
      amount_cents: 499,
      stripe_checkout_session_id: null,
      checkout_url: null,
      checkout_expires_at: new Date(Date.now() + 45 * 60_000)
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [{ mail_type: 'letter' }] })
      .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
      .mockResolvedValueOnce({
        rows: [{
          draft_id: 'draft-1', user_id: 'user-1', mail_type: 'letter',
          required_credits: 2, status: 'pending',
          expires_at: new Date(Date.now() + 60 * 60_000)
        }]
      })
      .mockResolvedValueOnce({ rows: [stale] });

    await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }))
      .rejects.toMatchObject({ code: 'JIT_NOT_CONFIGURED' });

    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining("'PRICE_CHANGED_BEFORE_SESSION'"),
      expect.anything()
    );
  });

  it('never lets the reprice branch touch a sessionless order in a hold state', async () => {
    // Reachable only via operator surgery, but the reprice-cancel must never
    // be the thing that clears a financial hold (#278 round 8).
    mocks.getJitProduct.mockReturnValue({
      productCode: 'jit-letter', priceId: 'price-jit-v2', amountCents: 599,
      currency: 'usd', name: 'Pay & Send One Physical Letter',
      description: 'x', mailType: 'letter'
    });
    const held = {
      ...baseOrder,
      status: 'disputed',
      amount_cents: 499,
      stripe_checkout_session_id: null,
      checkout_url: null,
      checkout_expires_at: new Date(Date.now() + 45 * 60_000)
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [{ mail_type: 'letter' }] })
      .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
      .mockResolvedValueOnce({
        rows: [{
          draft_id: 'draft-1', user_id: 'user-1', mail_type: 'letter',
          required_credits: 2, status: 'pending',
          expires_at: new Date(Date.now() + 60 * 60_000)
        }]
      })
      .mockResolvedValueOnce({ rows: [held] });
    mocks.createJitSession.mockResolvedValue({
      success: true, sessionId: 'cs-h', sessionUrl: 'https://s', expiresAt: new Date()
    });

    await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }).catch(() => undefined);

    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'cancelled'"),
      expect.anything()
    );
  });

  it('the refund claim itself refuses a PAYMENT_AMOUNT_MISMATCH quarantine', async () => {
    // Round 7 put the gate in the sweep's candidate SELECT - ONE consumer.
    // The exported money-mover must carry the same wall so a future caller
    // (admin bulk-retry, second sweep) cannot bypass it (#278 round 8).
    mocks.query.mockResolvedValue({ rows: [] });

    await requestRefund('order-q', 'sweep retry');

    const claim = mocks.query.mock.calls
      .map(([sql]) => String(sql))
      .find(sql => sql.includes("status = 'refund_pending'") && sql.includes('FOR UPDATE'));
    expect(claim).toBeDefined();
    expect(claim).toContain("last_error_code <> 'PAYMENT_AMOUNT_MISMATCH'");
  });

  it('unmatched-money recovery never erases the quarantine marker', async () => {
    // The recovery UPDATE overwrote last_error_code unconditionally; on a
    // quarantined row that erased the exact marker the refund gates key on
    // (#278 round 8).
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-r' }] };
      if (sql.includes('SELECT * FROM orders')) return { rows: [baseOrder] };
      if (sql.includes("processing_status = 'unmatched'") && sql.includes('FOR UPDATE')) {
        return { rows: [{ event_id: 'evt-m', event_type: 'refund.created' }] };
      }
      return { rows: [] };
    });

    await processStripeWebhookEvent(checkoutEvent());

    const recovery = mocks.query.mock.calls
      .map(([sql]) => String(sql))
      .find(sql => sql.includes('UNMATCHED_MONEY_EVENT_RECOVERED'));
    expect(recovery).toBeDefined();
    expect(recovery).toContain("CASE WHEN last_error_code = 'PAYMENT_AMOUNT_MISMATCH'");
  });

  it('dedupes an identical quote fault and re-logs a CHANGED one', () => {
    // The quote surface reports on change only, through the catalog's own
    // canonical signature. The recovery axis of that signature - the
    // resolution epoch, which re-arms the slot after a recovery no quote
    // observed - is pinned against the REAL counter in priceCatalog.test.ts
    // ('folds the resolution epoch into the signature'), because this suite
    // stubs the catalog's state and cannot move a real epoch (#278 r8, r11).
    clearDiagnosticChangeSlot('commerce.pay_and_send_unpriced:jit-letter');
    const diag = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mocks.jitEnabled.mockReturnValue(true);
      mocks.getJitProduct.mockReturnValue({
        productCode: 'jit-letter', priceId: 'price-jit', amountCents: 0,
        currency: 'usd', name: 'Pay & Send One Physical Letter',
        description: 'x', mailType: 'letter'
      });
      mocks.describeUnpriced.mockReturnValue({
        productCode: 'jit-letter',
        rule: 'price.inactive',
        diagnosticClass: 'configuration_error'
      });

      getSendEligibility(0, 2, 'letter'); // outage 1: logs
      getSendEligibility(0, 2, 'letter'); // steady, identical: suppressed
      mocks.describeUnpriced.mockReturnValue({
        productCode: 'jit-letter',
        rule: 'price.amount_mismatch',
        diagnosticClass: 'configuration_error',
        detail: 'expected 499 / stripe 599'
      });
      getSendEligibility(0, 2, 'letter'); // a DIFFERENT fault: logs

      const lines = diag.mock.calls
        .flat()
        .map(String)
        .filter(line => line.includes('"event":"commerce.pay_and_send_unpriced"'));
      expect(lines).toHaveLength(2);
      // and the figures reach the operator on the quote surface too
      expect(lines[1]).toContain('expected 499 / stripe 599');
    } finally {
      diag.mockRestore();
      clearDiagnosticChangeSlot('commerce.pay_and_send_unpriced:jit-letter');
    }
  });

  it('cancels a sessionless pending JIT order priced under an OLD pin and starts fresh', async () => {
    // Round 7's money-path find: session creation failed, the price was
    // repointed+repinned, the customer retried inside the checkout window.
    // Reusing the old row would build the NEW session against the OLD
    // amount - customer pays 599 vs a 499 row, PAYMENT_AMOUNT_MISMATCH, and
    // (before the sweep exclusion) an auto-refund of a legitimate purchase.
    // Nothing was ever paid on a sessionless row, so it cancels free.
    mocks.getJitProduct.mockReturnValue({
      productCode: 'jit-letter', priceId: 'price-jit-v2', amountCents: 599,
      currency: 'usd', name: 'Pay & Send One Physical Letter',
      description: 'x', mailType: 'letter'
    });
    const stale = {
      ...baseOrder,
      amount_cents: 499,
      stripe_checkout_session_id: null,
      checkout_url: null,
      checkout_expires_at: new Date(Date.now() + 45 * 60_000)
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [{ mail_type: 'letter' }] }) // peek
      .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
      .mockResolvedValueOnce({
        rows: [{
          draft_id: 'draft-1', user_id: 'user-1', mail_type: 'letter',
          required_credits: 2, status: 'pending',
          expires_at: new Date(Date.now() + 60 * 60_000)
        }]
      })
      .mockResolvedValueOnce({ rows: [stale] }) // active-order lookup
      .mockResolvedValueOnce({ rows: [] }) // cancel UPDATE
      .mockResolvedValueOnce({ rows: [] }) // order event
      .mockResolvedValueOnce({ rows: [{ ...baseOrder, amount_cents: 599 }] }); // fresh INSERT
    mocks.createJitSession.mockResolvedValue({
      success: true, sessionId: 'cs-fresh', sessionUrl: 'https://s', expiresAt: new Date()
    });

    await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }).catch(() => undefined);

    const cancel = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("'PRICE_CHANGED_BEFORE_SESSION'")
    );
    expect(cancel).toBeDefined();
    expect(cancel?.[1]).toEqual(['order-1']);
  });

  it('reuses a pending JIT order untouched when its Stripe session already exists', async () => {
    // The session fixes what the customer pays; it matches the row. Reuse.
    mocks.getJitProduct.mockReturnValue({
      productCode: 'jit-letter', priceId: 'price-jit-v2', amountCents: 599,
      currency: 'usd', name: 'Pay & Send One Physical Letter',
      description: 'x', mailType: 'letter'
    });
    const withSession = {
      ...baseOrder,
      amount_cents: 499,
      stripe_checkout_session_id: 'cs-old',
      checkout_url: 'https://checkout.stripe.com/old',
      checkout_expires_at: new Date(Date.now() + 45 * 60_000)
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [{ mail_type: 'letter' }] })
      .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
      .mockResolvedValueOnce({
        rows: [{
          draft_id: 'draft-1', user_id: 'user-1', mail_type: 'letter',
          required_credits: 2, status: 'pending',
          expires_at: new Date(Date.now() + 60 * 60_000)
        }]
      })
      .mockResolvedValueOnce({ rows: [withSession] });

    const result = await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' });

    expect(result).toMatchObject({ orderId: 'order-1', reused: true });
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining("'PRICE_CHANGED_BEFORE_SESSION'"),
      expect.anything()
    );
  });

  it('never auto-refunds a PAYMENT_AMOUNT_MISMATCH quarantine from the sweep', async () => {
    // Round 6 gated the adoption PRODUCER of the quarantine; the sweep - the
    // CONSUMER - would still have auto-refunded any normally-created order a
    // Stripe-side amount change pushed into it. The exclusion lives in the
    // sweep's own WHERE (#278 round 7).
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.retrieveSession.mockResolvedValue(null);

    await runCommerceMaintenance();

    const sweep = mocks.query.mock.calls
      .map(([sql]) => String(sql))
      .find(sql => sql.includes("status = 'refund_pending'") && sql.includes('refund_attempts <'));
    expect(sweep).toBeDefined();
    expect(sweep).toContain("last_error_code <> 'PAYMENT_AMOUNT_MISMATCH'");
  });

  it('kicks the catalog with the JIT code even while Pay & Send is disabled', async () => {
    // The disabled short-circuit must not starve the catalog's unsold-state
    // clearing - that starvation is how toggle-off cooldowns survived to
    // resurface on re-enable (#278 round 7).
    mocks.jitEnabled.mockReturnValue(false);

    const eligibility = getSendEligibility(0, 2, 'letter');

    expect(eligibility.payAndSend.unavailableReason).toBe('Pay & Send is not enabled.');
    expect(mocks.ensurePriceCatalog).toHaveBeenCalledWith('jit-letter', 'send_eligibility_disabled');
  });

  it('refuses to adopt a paid session whose amount disagrees with the pin', async () => {
    // The unit half of the round-6 gate: paid 999 against a 500 pin must NOT
    // insert an order (an inserted mismatch reaches the order-type-agnostic
    // refund sweep and auto-refunds a legitimate historical purchase); it
    // books the money as unmatched for an operator instead.
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-mm' }] };
      return { rows: [] };
    });

    await expect(processStripeWebhookEvent(checkoutEvent({
      id: 'cs-mm',
      client_reference_id: null,
      metadata: { userId: 'user-1', productId: 'credit-pack-4' },
      amount_total: 999
    }) as never)).resolves.toMatchObject({ duplicate: false });

    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO orders'),
      expect.anything()
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("SET processing_status = 'unmatched'"),
      expect.anything()
    );
  });

  it('adopts a legacy session keyed by productCode, the key this codebase writes', async () => {
    // Reconciliation replays events for sessions the CURRENT app created,
    // whose metadata carries productCode only - reading just the legacy
    // productId keys made those unadoptable (#278 review round 4).
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-pc' }] };
      if (sql.includes('INSERT INTO orders')) {
        return { rows: [{ ...baseOrder, order_id: 'stripe-cs-pc', order_type: 'letter_pack', product_code: 'credit-pack-4', credits: 4, status: 'paid' }] };
      }
      return { rows: [] };
    });

    await processStripeWebhookEvent(checkoutEvent({
      id: 'cs-pc',
      client_reference_id: null,
      metadata: { userId: 'user-1', productCode: 'credit-pack-4' },
      amount_total: 500
    }) as never).catch(() => undefined);

    const insert = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO orders')
    );
    expect(insert?.[1]).toEqual(expect.arrayContaining(['credit-pack-4']));
  });

  it('does not retry an UNPAID event just because a price is cooling down', async () => {
    // The throw exists to stop a PAYING customer being booked as unmatched
    // money. This function is also reached for checkout.session.expired and
    // async_payment_failed, which carry none - throwing for those made Stripe
    // redeliver an event where "retry adoption" is meaningless, on the schedule
    // that eventually disables a webhook endpoint (#278 review round 3).
    mocks.describeUnpriced.mockReturnValue({
      productCode: 'credit-pack-4',
      rule: 'price.lookup_failed',
      diagnosticClass: 'StripeConnectionError'
    } as never);
    mocks.getPackProduct.mockReturnValue({
      productCode: 'credit-pack-4',
      priceId: 'price-pack',
      amountCents: 0,
      currency: 'usd',
      credits: 4,
      name: 'Starter Pack',
      description: 'Two prepaid letters'
    });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-expired' }] };
      return { rows: [] };
    });

    await expect(processStripeWebhookEvent(checkoutEvent({
      id: 'cs-expired',
      client_reference_id: null,
      metadata: { userId: 'user-1', productId: 'credit-pack-4' },
      payment_status: 'unpaid',
      amount_total: 0
    }) as never)).resolves.toMatchObject({ duplicate: false });
  });

  it('keeps per-product fault dedupe under interleaved letter/postcard traffic', async () => {
    // A single shared dedupe slot meant the letter and postcard faults
    // evicted each other on every alternation, restoring exactly the
    // one-error-line-per-quote flood the throttle exists to prevent (#278
    // review round 4).
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mocks.describeUnpriced.mockImplementation(((productCode: string) => ({
        productCode,
        rule: 'price.inactive',
        diagnosticClass: 'configuration_error'
      })) as never);
      mocks.getJitProduct.mockImplementation(((mailType: string) => ({
        productCode: mailType === 'letter' ? 'jit-letter' : 'jit-postcard',
        priceId: 'price-jit',
        amountCents: 0,
        currency: 'usd',
        name: 'Pay & Send',
        description: 'One item'
      })) as never);

      for (let i = 0; i < 3; i += 1) {
        getSendEligibility(0, 2, 'letter');
        getSendEligibility(0, 1, 'postcard');
      }

      const emitted = diagnostic.mock.calls
        .flat()
        .map(String)
        .filter(line => line.includes('commerce.pay_and_send_unpriced'));
      expect(emitted).toHaveLength(2); // one per product, not one per quote
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('reports a steady Pay & Send pricing fault once, not once per quote', async () => {
    // getSendEligibility is a synchronous accessor on the quote path, and the
    // catalog's own header notes quotes vastly outnumber purchases - so an
    // unconditional error line turned one persistent config fault into a
    // continuous error stream scaling with traffic (#278 review round 3).
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // The dedupe map is module state that survives between tests, so start
      // from a RECOVERY: a healthy quote clears this product's entry (also
      // pinning the clear-on-recovery path), making the count below exact.
      mocks.getJitProduct.mockReturnValue({
        productCode: 'jit-letter', priceId: 'price-jit', amountCents: 499,
        currency: 'usd', name: 'Pay & Send', description: 'One letter'
      });
      getSendEligibility(0, 2, 'letter');

      mocks.describeUnpriced.mockReturnValue({
        productCode: 'jit-letter',
        rule: 'price.inactive',
        diagnosticClass: 'configuration_error'
      } as never);
      mocks.getJitProduct.mockReturnValue({
        productCode: 'jit-letter', priceId: 'price-jit', amountCents: 0,
        currency: 'usd', name: 'Pay & Send', description: 'One letter'
      });

      for (let i = 0; i < 5; i += 1) getSendEligibility(0, 2, 'letter');

      const emitted = diagnostic.mock.calls
        .flat()
        .map(String)
        .filter(line => line.includes('commerce.pay_and_send_unpriced'));
      expect(emitted).toHaveLength(1);
    } finally {
      diagnostic.mockRestore();
    }
  });

  // The gate is "did money move", not "which event carried the news". A
  // delayed-payment method lands its money on async_payment_succeeded, so
  // narrowing this to checkout.session.completed would silently drop it.
  it.each(['checkout.session.completed', 'checkout.session.async_payment_succeeded'])(
    'records unmatched money whichever paid event delivers it (%s)',
    async (eventType) => {
      mocks.getPackProduct.mockReturnValue(null);
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-1' }] };
        return { rows: [] };
      });

      const event = checkoutEvent({ client_reference_id: null, metadata: {} }) as any;
      event.type = eventType;

      await expect(processStripeWebhookEvent(event)).resolves.toMatchObject({ duplicate: false });

      expect(mocks.query).toHaveBeenCalledWith(
        expect.stringContaining("processing_status = 'unmatched'"),
        ['evt-1', 'pi-1']
      );
      expect(mocks.query).toHaveBeenCalledWith(
        expect.stringContaining("'stripe_money_event_unmatched'"),
        expect.arrayContaining(['evt-1'])
      );
    }
  );

  it('does not raise unmatched money for an unpaid session that matches no order', async () => {
    mocks.getPackProduct.mockReturnValue(null);
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-1' }] };
      return { rows: [] };
    });

    await expect(processStripeWebhookEvent(checkoutEvent({
      client_reference_id: null, metadata: {}, payment_status: 'unpaid'
    }) as any)).resolves.toMatchObject({ duplicate: false });

    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining("'stripe_money_event_unmatched'"),
      expect.anything()
    );
  });

  it('refuses a pack checkout when its amount is not configured', async () => {
    mocks.getPackProduct.mockReturnValue({
      productCode: 'credit-pack-4',
      priceId: 'price-pack',
      amountCents: 0,
      currency: 'usd',
      name: 'Starter Pack',
      description: 'Two prepaid letters'
    });

    await expect(createPackCheckout({
      userId: 'user-1', userEmail: 'user@example.test', productId: 'credit-pack-4',
      successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/no'
    } as never)).rejects.toBeInstanceOf(PackAmountNotConfiguredError);

    // No authoritative order may exist for an amount we cannot reconcile.
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO orders'),
      expect.anything()
    );
    expect(mocks.createPackSession).not.toHaveBeenCalled();
  });

  it.each([
    ['a real configuration fault', 'price.inactive', 'configuration_error', 'configuration_error'],
    // The class the CATALOG recorded must survive, not be flattened. This
    // guard throws 22 lines before createPackCheckoutSession, so the branch in
    // stripeService that forwards the real class is unreachable on this path -
    // hard-coding configuration_error here made the pack path structurally
    // incapable of reporting a transient fault, and sent the operator hunting
    // a config problem during a 30-second outage (#278 review round 2).
    ['a Stripe outage', 'price.lookup_failed', 'StripeConnectionError', 'StripeConnectionError'],
    // Never attempted or in flight: the catalog calls that transient by
    // definition, and terminal is what cancels a customer's order.
    ['a catalog that has not attempted yet', null, null, 'provider_error']
  ])(
    'carries the catalog class for %s, so #213 is not reintroduced one layer up',
    async (_label, rule, catalogClass, expectedClass) => {
      // Issue #213: this guard throws before any query runs, so the handler's
      // catch has no statement to blame and defaults an uncarried error to
      // database_error - the mislabel that turned a missing amount into a
      // schema hunt for a config problem.
      mocks.describeUnpriced.mockReturnValue(
        rule ? ({ productCode: 'credit-pack-4', rule, diagnosticClass: catalogClass } as never) : null
      );
      mocks.getPackProduct.mockReturnValue({
        productCode: 'credit-pack-4', priceId: 'price-pack', amountCents: 0,
        currency: 'usd', name: 'Starter Pack', description: 'Two prepaid letters', credits: 4
      });

      const error = await createPackCheckout({
        userId: 'user-1', userEmail: 'user@example.test', productId: 'credit-pack-4',
        successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/no'
      } as never).catch(e => e);

      expect(error).toBeInstanceOf(PackAmountNotConfiguredError);
      expect(error).toMatchObject({ diagnosticClass: expectedClass });
    }
  );

  it('labels an unconfigured pack price id configuration_error before any order write', async () => {
    // The sibling guard, same #213 trap: a missing STRIPE_PRICE_* threw a bare
    // error that also read as database_error.
    mocks.getPackProduct.mockReturnValue({
      productCode: 'credit-pack-4', priceId: '', amountCents: 500,
      currency: 'usd', name: 'Starter Pack', description: 'Two prepaid letters', credits: 4
    });

    const error = await createPackCheckout({
      userId: 'user-1', userEmail: 'user@example.test', productId: 'credit-pack-4',
      successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/no'
    } as never).catch(e => e);

    expect(error).toMatchObject({ diagnosticClass: 'configuration_error' });
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO orders'),
      expect.anything()
    );
    expect(mocks.createPackSession).not.toHaveBeenCalled();
  });

  it('carries the Stripe failure class up when the checkout session cannot be created', async () => {
    // Issue #213: when Stripe rejects the session (e.g. a Price ID that does
    // not exist in this account), the thrown error must carry the resolved
    // class so the handler's catch logs the real cause rather than defaulting
    // to a database label.
    mocks.getPackProduct.mockReturnValue({
      productCode: 'credit-pack-4',
      priceId: 'price-pack',
      amountCents: 500,
      currency: 'usd',
      name: 'Starter Pack',
      description: 'Two prepaid letters'
    });
    mocks.query.mockResolvedValue({ rows: [{ order_id: 'order-1' }] });
    mocks.createPackSession.mockResolvedValue({
      success: false,
      errorCode: 'PROVIDER_ERROR',
      diagnosticClass: 'resource_missing',
      error: 'Failed to create checkout session'
    });

    await expect(createPackCheckout({
      userId: 'user-1', userEmail: 'user@example.test', productId: 'credit-pack-4',
      successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/no'
    } as never)).rejects.toMatchObject({ diagnosticClass: 'resource_missing' });
  });

  it('records the required durable resolution code when a Stripe dispute closes', async () => {
    const disputedOrder = { ...baseOrder, status: 'disputed', stripe_payment_intent_id: 'pi-1' };
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-close' }] };
      if (sql.includes('SELECT * FROM orders')) return { rows: [disputedOrder] };
      if (sql.includes("alert_type = 'stripe_dispute_created'")) {
        expect(params).toEqual(['order-1', 'stripe_dispute_won', 'dp-closed']);
      }
      return { rows: [] };
    });

    await expect(processStripeWebhookEvent({
      id: 'evt-close', type: 'charge.dispute.closed', data: { object: {
        id: 'dp-closed', payment_intent: 'pi-1', charge: 'ch-closed', amount: 499,
        currency: 'usd', reason: 'fraudulent', status: 'won'
      } }
    } as any)).resolves.toEqual({ duplicate: false });

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('resolution_code = $2'),
      ['order-1', 'stripe_dispute_won', 'dp-closed']
    );
  });

  it('repairs a fulfilled pack grant atomically through the exact order/session binding', async () => {
    const packOrder = {
      ...baseOrder,
      order_id: 'pack-order',
      order_type: 'letter_pack',
      draft_id: undefined,
      status: 'fulfilled',
      credits: 4,
      amount_cents: 500,
      currency: 'usd',
      product_code: 'credit-pack-4',
      stripe_checkout_session_id: 'cs-pack'
    };
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("order_type = 'letter_pack'")) return { rows: [packOrder] };
      if (sql.includes('SELECT ledger_id FROM credit_ledger')) return { rows: [] };
      return { rows: [] };
    });

    await expect(repairFulfilledPackGrant({
      orderId: 'pack-order', stripeSessionId: 'cs-pack', expectedCredits: 4,
      paidAmountCents: 500, paidCurrency: 'usd'
    })).resolves.toBe('repaired');

    expect(mocks.addCredits).toHaveBeenCalledTimes(1);
    expect(mocks.grantEntitlement).toHaveBeenCalledTimes(1);
  });

  it('refuses pack repair when the provider session does not match the locked order', async () => {
    mocks.query.mockResolvedValue({ rows: [{
      ...baseOrder, order_type: 'letter_pack', status: 'fulfilled', credits: 4,
      amount_cents: 500, stripe_checkout_session_id: 'cs-authoritative'
    }] });

    await expect(repairFulfilledPackGrant({
      orderId: 'order-1', stripeSessionId: 'cs-attacker', expectedCredits: 4,
      paidAmountCents: 500, paidCurrency: 'usd'
    })).rejects.toThrow('does not match');
    expect(mocks.addCredits).not.toHaveBeenCalled();
    expect(mocks.grantEntitlement).not.toHaveBeenCalled();
  });

  it('persists an authoritative pack order before creating its Stripe session', async () => {
    const pendingPack = {
      ...baseOrder,
      order_id: 'pack-order',
      order_type: 'letter_pack',
      draft_id: undefined,
      credits: 4,
      product_code: 'credit-pack-4',
      product_snapshot: { name: 'Starter Pack - 2 Letters' },
      amount_cents: 500,
      idempotency_key: 'pack-checkout:pack-order'
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [pendingPack] })
      .mockResolvedValueOnce({ rows: [pendingPack] })
      .mockResolvedValueOnce({
        rows: [
          {
            ...pendingPack,
            stripe_checkout_session_id: 'cs-pack',
            checkout_url: 'https://checkout.stripe.com/c/pay/pack'
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [] });
    mocks.createPackSession.mockResolvedValueOnce({
      success: true,
      sessionId: 'cs-pack',
      sessionUrl: 'https://checkout.stripe.com/c/pay/pack'
    });

    const result = await createPackCheckout({
      userId: 'user-1',
      userEmail: 'person@example.com',
      productId: 'credit-pack-4',
      successUrl: 'https://letterirl.com/success',
      cancelUrl: 'https://letterirl.com/cancel'
    });

    expect(result).toMatchObject({
      success: true,
      sessionId: 'cs-pack',
      orderId: 'pack-order'
    });
    expect(mocks.query.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createPackSession.mock.invocationCallOrder[0]
    );
    expect(mocks.createPackSession).toHaveBeenCalledWith(
      expect.objectContaining({
        product: expect.objectContaining({ amountCents: 500, credits: 4 })
      })
    );
  });

  it('does not fulfill checkout.session.completed until payment_status is paid', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-unpaid' }] };
      }
      if (sql.includes('SELECT * FROM orders')) return { rows: [baseOrder] };
      return { rows: [] };
    });

    const result = await processStripeWebhookEvent({
      ...checkoutEvent({ payment_status: 'unpaid', payment_intent: null }),
      id: 'evt-unpaid'
    });

    expect(result).toMatchObject({
      duplicate: false,
      status: 'checkout_pending'
    });
    expect(mocks.createMail).not.toHaveBeenCalled();
    expect(mocks.grantEntitlement).not.toHaveBeenCalled();
  });

  it('claims and ignores an unrelated Checkout session without retrying forever', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-unrelated' }] };
      }
      if (sql.includes('SELECT * FROM orders')) return { rows: [] };
      return { rows: [] };
    });

    const result = await processStripeWebhookEvent({
      ...checkoutEvent({ client_reference_id: null, metadata: {} }),
      id: 'evt-unrelated'
    });

    expect(result).toEqual({ duplicate: false });
    expect(mocks.createMail).not.toHaveBeenCalled();
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it('does not authorize an order from a different attached Checkout session', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-session-mismatch' }] };
      }
      if (sql.includes('SELECT * FROM orders')) {
        return {
          rows: [{ ...baseOrder, stripe_checkout_session_id: 'cs-original' }]
        };
      }
      return { rows: [] };
    });

    const result = await processStripeWebhookEvent({
      ...checkoutEvent(),
      id: 'evt-session-mismatch'
    });

    expect(result).toMatchObject({ status: 'checkout_pending' });
    expect(mocks.createMail).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO commerce_order_events'),
      expect.arrayContaining([
        'order-1',
        'checkout.session.completed',
        'checkout_pending',
        'checkout_pending',
        expect.stringContaining('checkout_session_mismatch')
      ])
    );
  });

  it('moves a paid amount mismatch to refund_pending without fulfillment', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-mismatch' }] };
      }
      if (sql.includes('SELECT * FROM orders')) return { rows: [baseOrder] };
      return { rows: [] };
    });

    const result = await processStripeWebhookEvent({
      ...checkoutEvent({ amount_total: 1 }),
      id: 'evt-mismatch'
    });

    expect(result).toMatchObject({ status: 'refund_pending' });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'refund_pending'"),
      ['order-1', expect.stringContaining('Expected 499 usd; received 1 usd')]
    );
    expect(mocks.createMail).not.toHaveBeenCalled();
  });

  it('ignores a late failure event after an order has already been fulfilled', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-late-failure' }] };
      }
      if (sql.includes('SELECT * FROM orders')) {
        return { rows: [{ ...baseOrder, status: 'fulfilled' }] };
      }
      return { rows: [] };
    });

    const result = await processStripeWebhookEvent({
      ...checkoutEvent({ payment_status: 'unpaid' }),
      id: 'evt-late-failure',
      type: 'checkout.session.async_payment_failed'
    });

    expect(result).toMatchObject({ status: 'fulfilled' });
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'payment_failed'"),
      expect.anything()
    );
  });

  it('rejects cross-user draft checkout before calling Stripe', async () => {
    // Issue #150 added a send-block lookup ahead of the draft read. This account
    // is not blocked, so the original assertion below is unchanged.
    // createJitCheckout peeks the draft's mail type (unlocked, advisory)
    // before the money transaction, to ensure exactly one product's price.
    mocks.query.mockResolvedValueOnce({ rows: [{ mail_type: 'letter' }] });
    mocks.query.mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] });
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          draft_id: 'draft-1',
          user_id: 'other-user',
          status: 'pending',
          expires_at: new Date(Date.now() + 60 * 60_000)
        }
      ]
    });

    await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).rejects.toMatchObject(
      { code: 'DRAFT_NOT_OWNED' }
    );
    expect(mocks.createJitSession).not.toHaveBeenCalled();
  });

  it('reuses the one active checkout for a draft', async () => {
    const existing = {
      ...baseOrder,
      stripe_checkout_session_id: 'cs-1',
      checkout_url: 'https://checkout.stripe.com/c/pay/test',
      checkout_expires_at: new Date(Date.now() + 45 * 60_000)
    };
    mocks.query
      // The draft-type peek runs first (unlocked, advisory), then the #150
      // send-block lookup, then the FOR UPDATE draft read.
      .mockResolvedValueOnce({ rows: [{ mail_type: 'letter' }] })
      .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
      .mockResolvedValueOnce({
        rows: [
          {
            draft_id: 'draft-1',
            user_id: 'user-1',
            mail_type: 'letter',
            required_credits: 2,
            status: 'pending',
            expires_at: new Date(Date.now() + 60 * 60_000)
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [existing] });

    const result = await createJitCheckout({
      userId: 'user-1',
      draftId: 'draft-1'
    });
    expect(result).toMatchObject({
      orderId: 'order-1',
      checkoutUrl: existing.checkout_url,
      reused: true
    });
    expect(mocks.createJitSession).not.toHaveBeenCalled();
  });

  it('reuses the durable order and Stripe key after checkout attachment crashes', async () => {
    const draft = {
      draft_id: 'draft-1',
      user_id: 'user-1',
      mail_type: 'letter',
      required_credits: 2,
      status: 'pending',
      expires_at: new Date(Date.now() + 60 * 60_000)
    };
    let storedOrder: typeof baseOrder & {
      checkout_expires_at?: Date;
      stripe_checkout_session_id?: string;
      checkout_url?: string;
    } | null = null;
    let failAttachment = true;
    mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT * FROM letter_drafts')) return { rows: [draft] };
      if (sql.includes("WHERE draft_id = $1 AND order_type = 'jit_mail'")) {
        return { rows: storedOrder ? [storedOrder] : [] };
      }
      if (sql.includes('SELECT credits FROM users')) return { rows: [{ credits: 0 }] };
      if (sql.includes('INSERT INTO orders')) {
        storedOrder = {
          ...baseOrder,
          order_id: String(params[0]),
          idempotency_key: `jit-checkout:${String(params[0])}`,
          checkout_expires_at: params[8] as Date
        };
        return { rows: [storedOrder] };
      }
      if (sql.startsWith('SELECT * FROM orders WHERE order_id')) {
        return { rows: storedOrder ? [storedOrder] : [] };
      }
      if (sql.includes('SET stripe_checkout_session_id = $2')) {
        if (failAttachment) {
          failAttachment = false;
          throw new Error('database process terminated before checkout attachment commit');
        }
        storedOrder = {
          ...storedOrder!,
          stripe_checkout_session_id: String(params[1]),
          checkout_url: String(params[2])
        };
        return { rows: [storedOrder] };
      }
      return { rows: [] };
    });
    mocks.createJitSession.mockResolvedValue({
      success: true,
      sessionId: 'cs-replayed',
      sessionUrl: 'https://checkout.stripe.com/c/pay/replayed'
    });

    await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).rejects.toThrow(
      'checkout attachment commit'
    );
    const recovered = await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' });

    expect(recovered).toMatchObject({
      orderId: storedOrder?.order_id,
      sessionId: 'cs-replayed',
      reused: true
    });
    expect(mocks.createJitSession).toHaveBeenCalledTimes(2);
    const idempotencyKeys = mocks.createJitSession.mock.calls.map(
      ([params]) => params.idempotencyKey
    );
    expect(new Set(idempotencyKeys).size).toBe(1);
    expect(idempotencyKeys[0]).toBe(storedOrder?.idempotency_key);
  });

  it('reports exact server-configured Pay & Send eligibility only when enabled', () => {
    expect(getSendEligibility(0, 2, 'letter')).toMatchObject({
      prepaid: { eligible: false },
      payAndSend: {
        available: true,
        amountCents: 499,
        currency: 'usd'
      }
    });
    mocks.jitEnabled.mockReturnValue(false);
    expect(getSendEligibility(0, 2, 'letter').payAndSend).toMatchObject({
      available: false,
      unavailableReason: 'Pay & Send is not enabled.'
    });
  });

  it('kicks its own catalog warmup and serves a formatted display amount', async () => {
    // The accessor owns its warmup (a caller-by-convention kick left future
    // surfaces and the stdio lane silently unavailable), and it serves the
    // display string so widgets stop dividing minor units by 100 - which is
    // 100x wrong for zero-decimal currencies (#278 round 6).
    const eligibility = getSendEligibility(0, 2, 'letter');

    expect(mocks.ensurePriceCatalog).toHaveBeenCalledWith('jit-letter', 'send_eligibility');
    expect(eligibility.payAndSend.displayAmount).toBe('4.99');
  });

  it('logs the boot race at WARN, and a recorded fault at ERROR', async () => {
    // price.not_resolved is the quote-raced-the-warmup state - routine on
    // every deploy and guaranteed on the first stdio quote. Five review
    // angles corroborated that an error-level line there is a per-deploy
    // false alarm; a RECORDED failure is news and stays at error (#278 r6).
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Recovery first: the dedupe map survives between tests.
      getSendEligibility(0, 2, 'letter');

      // Boot race: unpriced with NO recorded failure -> synthesized
      // not_resolved -> warn.
      mocks.describeUnpriced.mockReturnValue(null as never);
      mocks.getJitProduct.mockReturnValue({
        productCode: 'jit-letter', priceId: 'price-jit', amountCents: 0,
        currency: 'usd', name: 'Pay & Send', description: 'One letter'
      });
      getSendEligibility(0, 2, 'letter');

      const warned = warnSpy.mock.calls.flat().map(String).join('\n');
      const errored = errorSpy.mock.calls.flat().map(String).join('\n');
      expect(warned).toContain('commerce.pay_and_send_unpriced');
      expect(errored).not.toContain('commerce.pay_and_send_unpriced');
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it.each([
    ['a permanently archived price', 'configuration_error', true, 'Pay & Send pricing is not configured.'],
    ['a Stripe blip', 'StripeConnectionError', false, 'Pay & Send is temporarily unavailable. Please try again shortly.']
  ])(
    'tells the customer which kind of unavailable %s is',
    (_label, diagnosticClass, terminal, expectedReason) => {
      // Both used to produce the identical permanent-sounding "not configured"
      // message, and getSendEligibility logged nothing at all - so a 30-second
      // outage switched Pay & Send off across every quote and the operator
      // heard about it from a customer (#278 review round 2).
      mocks.describeUnpriced.mockReturnValue({
        productCode: 'jit-letter',
        rule: 'price.lookup_failed',
        diagnosticClass,
        terminal
      } as never);
      mocks.getJitProduct.mockReturnValue({
        productCode: 'jit-letter', priceId: 'price-jit', amountCents: 0,
        currency: 'usd', name: 'Pay & Send', description: 'One letter'
      });

      expect(getSendEligibility(0, 2, 'letter').payAndSend).toMatchObject({
        available: false,
        unavailableReason: expectedReason
      });
    }
  );

  it('reconciles a missed paid session before expiring pending checkouts', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("order_type = 'jit_mail' AND status = 'paid'")) return { rows: [] };
      if (sql.includes("status = 'checkout_pending' AND stripe_checkout_session_id")) {
        return { rows: [{ order_id: 'order-1', stripe_checkout_session_id: 'cs-1' }] };
      }
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'reconcile-event' }] };
      }
      if (sql.includes('SELECT * FROM orders')) return { rows: [baseOrder] };
      if (sql.includes("UPDATE orders SET status = 'cancelled'")) return { rows: [], rowCount: 0 };
      if (sql.includes("WHERE status = 'refund_pending'")) return { rows: [] };
      if (sql.includes('SELECT COUNT(*) AS count FROM orders')) return { rows: [{ count: '0' }] };
      return { rows: [] };
    });
    mocks.retrieveSession.mockResolvedValue({
      ...checkoutEvent().data.object,
      payment_status: 'paid'
    });

    await runCommerceMaintenance();

    const expiryCall = mocks.query.mock.calls.findIndex(([sql]) =>
      String(sql).includes("UPDATE orders SET status = 'cancelled'")
    );
    expect(expiryCall).toBeGreaterThan(-1);
    expect(mocks.retrieveSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.query.mock.invocationCallOrder[expiryCall]
    );
    expect(mocks.createMail).toHaveBeenCalledTimes(1);
  });

  it('keeps a completed asynchronous Checkout session pending while payment is unpaid', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("order_type = 'jit_mail' AND status = 'paid'")) return { rows: [] };
      if (sql.includes("status = 'checkout_pending' AND stripe_checkout_session_id")) {
        return { rows: [{ order_id: 'order-1', stripe_checkout_session_id: 'cs-1' }] };
      }
      if (sql.includes("UPDATE orders SET status = 'cancelled'")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WHERE status = 'refund_pending'")) return { rows: [] };
      if (sql.includes('SELECT COUNT(*) AS count FROM orders')) return { rows: [{ count: '0' }] };
      return { rows: [] };
    });
    mocks.retrieveSession.mockResolvedValue({
      ...checkoutEvent().data.object,
      status: 'complete',
      payment_status: 'unpaid',
      payment_intent: null
    });

    await expect(runCommerceMaintenance()).resolves.toMatchObject({ expiredCheckouts: 0 });

    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining("WHERE order_id = $1 AND status = 'checkout_pending'"),
      ['order-1']
    );
  });

  it.each(['pending', 'succeeded'])(
    'does not start full-refund recovery or revoke entitlements for a %s partial refund',
    async refundStatus => {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) {
          return { rows: [{ event_id: 'evt-partial-refund' }] };
        }
        if (sql.includes('SELECT * FROM orders')) {
          return { rows: [{ ...baseOrder, status: 'fulfillment_pending' }] };
        }
        return { rows: [] };
      });

      const result = await processStripeWebhookEvent({
        id: 'evt-partial-refund',
        type: 'refund.updated',
        data: {
          object: {
            id: 're-partial',
            payment_intent: 'pi-1',
            metadata: { orderId: 'order-1' },
            status: refundStatus,
            amount: 100
          }
        }
      } as any);

      expect(result).toMatchObject({ status: 'fulfillment_pending' });
      expect(mocks.query).not.toHaveBeenCalledWith(
        expect.stringContaining('UPDATE image_entitlements'),
        expect.anything()
      );
      expect(mocks.query).not.toHaveBeenCalledWith(
        expect.stringContaining('SET status = $2'),
        expect.anything()
      );
    }
  );

  it('ignores a later full-refund event after the order is already refunded', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-refund-replay' }] };
      }
      if (sql.includes('SELECT * FROM orders')) {
        return {
          rows: [
            {
              ...baseOrder,
              order_type: 'letter_pack',
              credits: 4,
              status: 'refunded'
            }
          ]
        };
      }
      return { rows: [] };
    });

    const result = await processStripeWebhookEvent({
      id: 'evt-refund-replay',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch-1',
          payment_intent: 'pi-1',
          amount_refunded: 499
        }
      }
    } as any);

    expect(result).toMatchObject({ status: 'refunded' });
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE users'),
      expect.anything()
    );
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE image_entitlements'),
      expect.anything()
    );
  });

  it('redacts order, session, and exception details from reconciliation diagnostics', async () => {
    const sensitive = 'private reconciliation failure order-private cs-private pi-private';
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("order_type = 'jit_mail' AND status = 'paid'")) return { rows: [] };
      if (sql.includes("status = 'checkout_pending' AND stripe_checkout_session_id")) {
        return {
          rows: [{ order_id: 'order-private', stripe_checkout_session_id: 'cs-private' }]
        };
      }
      if (sql.includes("UPDATE orders SET status = 'cancelled'")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WHERE status = 'refund_pending'")) return { rows: [] };
      if (sql.includes('SELECT COUNT(*) AS count FROM orders')) {
        return { rows: [{ count: '0' }] };
      }
      return { rows: [] };
    });
    mocks.retrieveSession.mockRejectedValue(new Error(sensitive));
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runCommerceMaintenance();

    const output = diagnostic.mock.calls.flat().map(String).join('\n');
    expect(output).toContain('"event":"commerce.checkout_reconciliation_failed"');
    for (const value of [sensitive, 'order-private', 'cs-private', 'pi-private']) {
      expect(output).not.toContain(value);
    }
    diagnostic.mockRestore();
  });

  it('revokes a refunded pack once and links a refund ledger audit row', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-pack-refund' }] };
      }
      if (sql.includes('SELECT * FROM orders')) {
        return {
          rows: [
            {
              ...baseOrder,
              order_type: 'letter_pack',
              credits: 4,
              status: 'fulfilled'
            }
          ]
        };
      }
      if (sql.includes('SELECT ledger_id, initial_amount')) {
        return {
          rows: [
            {
              ledger_id: '00000000-0000-0000-0000-000000000001',
              initial_amount: 4,
              remaining_amount: 2
            }
          ]
        };
      }
      if (sql.includes('UPDATE users')) return { rows: [{ credits: 3 }] };
      return { rows: [] };
    });

    await expect(
      processStripeWebhookEvent({
        id: 'evt-pack-refund',
        type: 'refund.updated',
        data: {
          object: {
            id: 're-pack',
            payment_intent: 'pi-1',
            metadata: { orderId: 'order-1' },
            status: 'succeeded',
            amount: 499
          }
        }
      } as any)
    ).resolves.toMatchObject({ status: 'refunded' });

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('related_ledger_id'),
      expect.arrayContaining([
        'user-1',
        4,
        'order-1',
        expect.stringContaining('payment_refunded'),
        expect.stringContaining('Payment refund'),
        '00000000-0000-0000-0000-000000000001'
      ])
    );
    expect(
      mocks.query.mock.calls.filter(([sql]) => String(sql).includes('SET credits = GREATEST'))
    ).toHaveLength(1);
  });

  it('retrieves an existing pending refund instead of creating another refund', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          ...baseOrder,
          status: 'refund_pending',
          refund_attempts: 5,
          stripe_payment_intent_id: 'pi-1',
          stripe_refund_id: 're-1'
        }
      ]
    });
    mocks.retrieveRefund.mockResolvedValue({ id: 're-1', status: 'succeeded' });

    await expect(requestRefund('order-1', 'retry')).resolves.toBe(true);

    expect(mocks.retrieveRefund).toHaveBeenCalledWith('re-1');
    expect(mocks.findRefund).not.toHaveBeenCalled();
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it('leases a refund so concurrent workers make only one external request', async () => {
    let refundClaimed = false;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('WITH candidate AS')) {
        if (refundClaimed) return { rows: [] };
        refundClaimed = true;
        return {
          rows: [
            {
              ...baseOrder,
              status: 'refund_pending',
              refund_attempts: 1,
              previous_refund_attempts: 0,
              stripe_payment_intent_id: 'pi-1'
            }
          ]
        };
      }
      if (sql.includes('SET stripe_refund_id = $2')) {
        return { rows: [{ order_id: 'order-1' }] };
      }
      return { rows: [] };
    });
    mocks.createRefund.mockResolvedValue({ id: 're-1', status: 'pending' });

    const results = await Promise.all([
      requestRefund('order-1', 'provider rejected'),
      requestRefund('order-1', 'provider rejected')
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect(mocks.findRefund).toHaveBeenCalledTimes(1);
    expect(mocks.createRefund).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("updated_at <= NOW() - ($4 * INTERVAL '1 second')"),
      ['order-1', 'provider rejected', 5, 300]
    );
  });

  it('finds a previously created refund before retrying after a persistence failure', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          ...baseOrder,
          status: 'refund_pending',
          refund_attempts: 5,
          previous_refund_attempts: 5,
          stripe_payment_intent_id: 'pi-1',
          stripe_refund_id: null
        }
      ]
    });
    mocks.findRefund.mockResolvedValue({ id: 're-recovered', status: 'pending' });

    await expect(requestRefund('order-1', 'retry')).resolves.toBe(true);

    expect(mocks.findRefund).toHaveBeenCalledWith('pi-1', 'order-1');
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it.each(['failed', 'canceled'])(
    'uses a new idempotency attempt after a known %s refund',
    async terminalRefundStatus => {
      mocks.query
        .mockResolvedValueOnce({
          rows: [
            {
              ...baseOrder,
              status: 'refund_pending',
              refund_attempts: 2,
              stripe_payment_intent_id: 'pi-1',
              stripe_refund_id: 're-failed'
            }
          ]
        })
        .mockResolvedValueOnce({ rows: [{ refund_attempts: 3 }] });
      mocks.retrieveRefund.mockResolvedValue({
        id: 're-failed',
        status: terminalRefundStatus
      });
      mocks.createRefund.mockResolvedValue({ id: 're-retry', status: 'pending' });

      await expect(requestRefund('order-1', 'retry')).resolves.toBe(true);

      expect(mocks.findRefund).toHaveBeenCalledWith('pi-1', 'order-1');
      expect(mocks.createRefund).toHaveBeenCalledWith('pi-1', 'order-1', 3);
    }
  );
});

/**
 * Issue #275. The price-drift guard refuses a checkout on a configuration
 * fault. That refusal happens AFTER the order row is committed, and a
 * configuration fault cannot be retried away, so leaving the row pending is not
 * inert:
 *
 *  - a pack order strands forever, because the pack INSERT omits
 *    checkout_expires_at and the only sweeper for session-less rows compares
 *    `checkout_expires_at <= NOW()`, which is never true for NULL;
 *  - a JIT order blocks its draft from prepaid sending for the whole ~30 minute
 *    window, behind a "checkout in progress" that does not exist.
 *
 * Both leaks predate the guard but were rare, needing a transient Stripe throw.
 * Making the guard fire deterministically turned them into certainties under
 * drift. These tests exist because a mutation setting `terminal: false` at both
 * call sites passed the entire suite.
 */
describe('checkout refusal cleanup (#275)', () => {
  const PACK_PARAMS = {
    userId: 'user-1',
    userEmail: 'person@example.com',
    productId: 'credit-pack-4' as const,
    successUrl: 'https://letterirl.com/success',
    cancelUrl: 'https://letterirl.com/cancel'
  };

  function statementsRun(): string[] {
    return mocks.query.mock.calls.map(call => String(call[0]));
  }

  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockResolvedValue({ rows: [{ ...baseOrder, order_id: 'pack-order' }] });
  });

  it('cancels the order when the price configuration is refused', async () => {
    mocks.createPackSession.mockResolvedValueOnce({
      success: false,
      errorCode: 'PACK_AMOUNT_NOT_CONFIGURED',
      diagnosticClass: 'configuration_error',
      error: 'Configured amount does not match the Stripe price'
    });

    await expect(createPackCheckout(PACK_PARAMS)).rejects.toThrow();

    const cancelled = statementsRun().filter(sql => /SET status = 'cancelled'/.test(sql));
    expect(cancelled).toHaveLength(1);
    // Guarded on the status it expects, so a concurrent path cannot be stomped.
    expect(cancelled[0]).toMatch(/status = 'checkout_pending'/);
    // The transition is recorded, not silently applied.
    expect(statementsRun().some(sql => /INSERT INTO commerce_order_events/.test(sql))).toBe(true);
  });

  it('carries the real error code onto the order rather than a generic one', async () => {
    mocks.createPackSession.mockResolvedValueOnce({
      success: false,
      errorCode: 'PACK_AMOUNT_NOT_CONFIGURED',
      diagnosticClass: 'configuration_error',
      error: 'Configured amount does not match the Stripe price'
    });

    await expect(createPackCheckout(PACK_PARAMS)).rejects.toThrow();

    const update = mocks.query.mock.calls.find(call =>
      /SET status = 'cancelled'/.test(String(call[0]))
    );
    expect(update?.[1]).toContain('PACK_AMOUNT_NOT_CONFIGURED');
  });

  it('leaves a transient provider failure pending, so a retry can still succeed', async () => {
    // The counterpart, and the reason this is not simply "cancel on any
    // failure": a Stripe blip must not burn the customer's order.
    mocks.createPackSession.mockResolvedValueOnce({
      success: false,
      errorCode: 'PROVIDER_ERROR',
      diagnosticClass: 'api_connection_error',
      error: 'Failed to create checkout session'
    });

    await expect(createPackCheckout(PACK_PARAMS)).rejects.toThrow();

    expect(statementsRun().some(sql => /SET status = 'cancelled'/.test(sql))).toBe(false);
    expect(statementsRun().some(sql => /last_error_code/.test(sql))).toBe(true);
  });
});
