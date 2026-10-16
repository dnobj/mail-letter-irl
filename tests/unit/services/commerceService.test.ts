import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Today's charge total, for the daily purchase cap (#179). Held on a hoisted
 * object so the db mock below can answer the cap's aggregate WITHOUT every
 * test's own mockImplementation having to know about it - two dozen call sites
 * replace mocks.query wholesale, and the cap FAILS CLOSED, so an unanswered
 * aggregate would refuse every checkout in this file.
 */
const capState = vi.hoisted(() => ({
  chargedTodayCents: 0,
  lettersTodayForUser: 0,
  lettersTodayGlobal: 0,
  /** Open Pay & Send orders today, added where a count includes them (#730). */
  openToday: 0
}));

/**
 * The account a checkout re-reads after its order insert (#449), answered
 * ahead of mocks.query for the same reason as the caps: the tests below queue
 * mocks.query responses in order, and this read must not consume one. Neither
 * erased nor blocked by default, so every older test runs as before.
 */
const accountState = vi.hoisted(() => {
  const state = {
    erasedAt: null as Date | null,
    blockedReason: null as string | null,
    reads: 0,
    answer(sql: unknown) {
      if (typeof sql !== 'string' || !sql.includes('SELECT erased_at, sends_blocked_reason FROM users')) {
        return undefined;
      }
      state.reads += 1;
      return Promise.resolve({
        rows: [{ erased_at: state.erasedAt, sends_blocked_reason: state.blockedReason }],
        rowCount: 1
      });
    }
  };
  return state;
});

/**
 * The duplicate check (#412), answered ahead of mocks.query for the same
 * reason as the caps: the tests below queue mocks.query responses in order,
 * and the check's queries must not consume them. The check runs on the order
 * transaction's client, so the default transaction below routes through
 * `answer` too. The draft is null by default, which skips the comparison, so
 * every older test runs as before. `trail`, when set, records every statement
 * from either side in the order it ran.
 */
const dupState = vi.hoisted(() => {
  const state = {
    draft: null as Record<string, unknown> | null,
    letters: [] as Record<string, unknown>[],
    orders: [] as Record<string, unknown>[],
    calls: [] as Array<{ sql: string; params: unknown[] }>,
    trail: null as string[] | null,
    /** The check's rows, or undefined for any other statement. */
    answer(sql: unknown, params?: unknown[]) {
      if (typeof sql !== 'string') return undefined;
      state.trail?.push(sql);
      if (!sql.includes('duplicate mail check')) return undefined;
      state.calls.push({ sql, params: params ?? [] });
      const rows = sql.includes('duplicate mail check: draft')
        ? (state.draft ? [state.draft] : [])
        : sql.includes('duplicate mail check: letters')
          ? state.letters
          : state.orders;
      return Promise.resolve({ rows, rowCount: rows.length });
    }
  };
  return state;
});

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
  getJitProductForCode: vi.fn(),
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

/**
 * The mail caps' own statements: their lock, and today's count, answered from
 * capState. Pay & Send checks them twice, before the transaction and inside
 * prepareJitOrder's once the order is a row (#730), so a transaction's client
 * is answered the same way, whatever client a test hands its callback.
 */
function spendCapAnswer(sql: unknown): Promise<{ rows: unknown[]; rowCount: number }> | null {
  if (typeof sql !== 'string') return null;
  if (sql.includes('pg_advisory_xact_lock(hashtext($1), hashtext($2))')) return Promise.resolve({ rows: [], rowCount: 1 });
  if (sql.includes('COUNT(*) AS count') && sql.includes('FROM letters')) {
    const scoped = sql.includes('user_id = $1');
    const open = sql.includes('UNION ALL') ? capState.openToday : 0;
    return Promise.resolve({
      rows: [{ count: String((scoped ? capState.lettersTodayForUser : capState.lettersTodayGlobal) + open) }],
      rowCount: 1
    });
  }
  return null;
}

function withSpendCapAnswers<C extends { query: (...args: never[]) => unknown }>(client: C): C {
  if (!client || typeof client.query !== 'function') return client;
  const inner = client.query.bind(client) as (sql: string, params?: unknown[]) => unknown;
  return Object.assign(Object.create(Object.getPrototypeOf(client)), client, {
    query: (sql: string, params?: unknown[]) => {
      const capped = spendCapAnswer(sql);
      if (!capped) return inner(sql, params);
      dupState.trail?.push(sql);
      return capped;
    }
  });
}

vi.mock('../../../src/db/index.js', () => ({
  // Intercepted ahead of mocks.query so the spend cap's aggregate is always
  // answered, whatever a given test does to mocks.query. Everything else falls
  // through untouched.
  query: (sql: string, params?: unknown[]) => {
    const duplicate = dupState.answer(sql, params);
    if (duplicate) return duplicate;
    // The limits' operator values (038): none set, so the environment's apply.
    if (typeof sql === 'string' && sql.includes('FROM daily_limit_overrides')) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (typeof sql === 'string' && sql.includes('SUM(amount_cents)')) {
      return Promise.resolve({
        rows: [{ total: String(capState.chargedTodayCents) }],
        rowCount: 1
      });
    }
    // Pay & Send is the one path that charges AND mails, so it consults the
    // mail ceilings here too - before any order row exists.
    const capped = spendCapAnswer(sql);
    if (capped) return capped;
    return mocks.query(sql, params);
  },
  transaction: (callback: (client: never) => unknown) =>
    mocks.transaction((client: never) => callback(withSpendCapAnswers(client as never) as never))
}));
// The operator's notices (#699): spied, never posted.
vi.mock('../../../src/services/operatorNotify.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/operatorNotify.js')>()),
  reportToOperator: vi.fn(async () => 'sent')
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
  // The checkout prices by the order's product (#578): the same double, keyed
  // by the code the order recorded.
  getJitProductConfigForCode: mocks.getJitProductForCode,
  getPackProductConfig: mocks.getPackProduct
}));

import {
  ACTIVE_JIT_STATUSES,
  FUNDED_OR_REVERSED_ORDER_STATUSES,
  PackAmountNotConfiguredError,
  createPackCheckout,
  createJitCheckout,
  fulfillPaidOrder,
  getSendEligibility,
  OPTION_NOT_SOLD_REASON,
  processStripeWebhookEvent,
  repairFulfilledPackGrant,
  requestRefund,
  revokePackLots,
  runCommerceMaintenance
} from '../../../src/services/commerceService.js';
import { OPERATOR_NOTICES, reportToOperator } from '../../../src/services/operatorNotify.js';
import { draftMailOption } from '../../../src/services/mailOptions.js';
import { optionRow } from '../../fixtures/mailOptions.js';
import { LIVE_PAY_AND_SEND_STATUSES } from '../../../src/services/draftService.js';
import { clearDiagnosticChangeSlot } from '../../../src/utils/diagnosticLog.js';
import { contentVersionOf } from '../../../src/services/contentVersion.js';

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

  it("fixes a draft's arrival date while any of the same orders is live (#535)", () => {
    expect([...LIVE_PAY_AND_SEND_STATUSES]).toEqual(ACTIVE_JIT_STATUSES);
  });

  it('treats every funded, reversed, disputed, or held order as terminal for checkout replay', () => {
    expect(FUNDED_OR_REVERSED_ORDER_STATUSES).toEqual([
      'fulfillment_pending', 'fulfilled', 'refund_pending', 'refunded', 'disputed', 'held'
    ]);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    // A checkout is priced by its order's product (#578): by default the same
    // double the quote reads, keyed by the code the order recorded.
    mocks.getJitProductForCode.mockImplementation((code: string) =>
      mocks.getJitProduct({ mailType: code === 'jit-postcard' ? 'postcard' : 'letter' })
    );
    capState.chargedTodayCents = 0;
    capState.lettersTodayForUser = 0;
    capState.lettersTodayGlobal = 0;
    capState.openToday = 0;
    dupState.draft = null;
    dupState.letters = [];
    dupState.orders = [];
    dupState.calls = [];
    dupState.trail = null;
    accountState.erasedAt = null;
    accountState.blockedReason = null;
    accountState.reads = 0;
    vi.stubEnv('IMAGE_ENTITLEMENTS_PER_JIT_ORDER', '1');
    // Rest arguments keep each call's arity, which toHaveBeenCalledWith compares.
    mocks.transaction.mockImplementation(async callback =>
      callback({
        query: (...args: [string, unknown[]?]) =>
          dupState.answer(...args) ?? accountState.answer(args[0]) ?? mocks.query(...args)
      })
    );
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
    mocks.findRefund.mockResolvedValue({ live: null, ended: null });
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

  describe('the purchase line the customer reads in their history (#460)', () => {
    const packSnapshot = { name: 'Starter Pack - 2 Letters', description: 'Two prepaid physical letters or postcards' };

    async function purchaseLine(productSnapshot: unknown): Promise<string> {
      const pendingPackOrder = {
        ...baseOrder, order_type: 'letter_pack', product_code: 'credit-pack-4', product_snapshot: productSnapshot,
        credits: 4, amount_cents: 500, draft_id: undefined, status: 'checkout_pending'
      };
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-1' }] };
        if (sql.includes('SELECT * FROM orders')) return { rows: [pendingPackOrder] };
        return { rows: [] };
      });
      await expect(processStripeWebhookEvent(checkoutEvent({ amount_total: 500 }) as any))
        .resolves.toMatchObject({ status: 'fulfilled' });
      expect(mocks.addCredits).toHaveBeenCalledTimes(1);
      return (mocks.addCredits.mock.calls[0][1] as { description: string }).description;
    }

    it('never names the pack by its internal code', async () => {
      const line = await purchaseLine(packSnapshot);
      expect(line).toBe('Purchased Starter Pack - 2 Letters');
      expect(line).not.toContain('credit-pack');
    });

    it('prefers the name recorded at checkout over the catalogue\'s', async () => {
      expect(await purchaseLine({ name: 'Starter Pack - Launch Offer' })).toBe('Purchased Starter Pack - Launch Offer');
    });

    it('falls back to the catalogue\'s name when the order recorded none', async () => {
      expect(await purchaseLine(null)).toBe('Purchased Starter Pack - 2 Letters');
    });

    // The column's default is '{}', and a malformed name must not print as
    // "Purchased [object Object]", "Purchased 42" or a bare "Purchased".
    it.each([
      ['an empty snapshot', {}],
      ['a blank name', { name: '   ' }],
      ['a name that is not text', { name: 42 }]
    ])('uses the catalogue\'s name for %s', async (_label, snapshot) => {
      expect(await purchaseLine(snapshot)).toBe('Purchased Starter Pack - 2 Letters');
    });

    it('says "a letter pack" when neither the order nor the catalogue has a name', async () => {
      const unknownPackOrder = {
        ...baseOrder, order_type: 'letter_pack', product_code: 'credit-pack-999', product_snapshot: {},
        draft_id: undefined, credits: 4, amount_cents: 500, currency: 'usd',
        status: 'fulfilled', stripe_checkout_session_id: 'cs-unknown', stripe_payment_intent_id: 'pi-unknown'
      };
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM orders')) return { rows: [unknownPackOrder] };
        return { rows: [] };
      });

      await expect(repairFulfilledPackGrant({
        orderId: 'order-1', stripeSessionId: 'cs-unknown', expectedCredits: 4,
        paidAmountCents: 500, paidCurrency: 'usd'
      })).resolves.toBe('repaired');

      expect(mocks.addCredits).toHaveBeenCalledTimes(1);
      expect((mocks.addCredits.mock.calls[0][1] as { description: string }).description).toBe('Purchased a letter pack');
    });

    it('writes the same line when a missed webhook is repaired from Stripe', async () => {
      // A recorded name the catalogue does not hold, so the repair is shown to
      // take the order's name, as the webhook does, and not the catalogue's.
      const fulfilledPackOrder = {
        ...baseOrder, order_type: 'letter_pack', product_code: 'credit-pack-4',
        product_snapshot: { name: 'Starter Pack - Launch Offer' },
        draft_id: undefined, credits: 4, amount_cents: 500, currency: 'usd',
        status: 'fulfilled', stripe_checkout_session_id: 'cs-repair', stripe_payment_intent_id: 'pi-repair'
      };
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM orders')) return { rows: [fulfilledPackOrder] };
        return { rows: [] };
      });

      await expect(repairFulfilledPackGrant({
        orderId: 'order-1', stripeSessionId: 'cs-repair', expectedCredits: 4,
        paidAmountCents: 500, paidCurrency: 'usd'
      })).resolves.toBe('repaired');

      expect(mocks.addCredits).toHaveBeenCalledTimes(1);
      const line = (mocks.addCredits.mock.calls[0][1] as { description: string }).description;
      expect(line).toBe('Purchased Starter Pack - Launch Offer');
      expect(line).not.toContain('credit-pack');
    });
  });

  describe('gift letters with a pack (docs/gift-letters.md)', () => {
    const pendingPackOrder = {
      ...baseOrder, order_type: 'letter_pack', product_code: 'credit-pack-4',
      credits: 4, amount_cents: 500, draft_id: undefined, status: 'checkout_pending'
    };

    function packWebhook() {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-1' }] };
        if (sql.includes('SELECT * FROM orders')) return { rows: [pendingPackOrder] };
        return { rows: [] };
      });
      return processStripeWebhookEvent(checkoutEvent({ amount_total: 500 }) as any);
    }

    afterEach(() => {
      delete process.env.LETTER_IRL_GIFT_LETTERS_ENABLED;
    });

    it('grants the pack its gift letter, keyed by the order, while the programme is on', async () => {
      process.env.LETTER_IRL_GIFT_LETTERS_ENABLED = 'true';
      await expect(packWebhook()).resolves.toMatchObject({ status: 'fulfilled' });
      const grants = mocks.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO gift_letters'));
      expect(grants).toHaveLength(1);
      // user, budget, source, reference, index, order
      expect(grants[0][1].slice(0, 6)).toEqual(['user-1', 1, 'pack_purchase', 'order-1', 0, 'order-1']);
      expect(String(grants[0][0])).toContain('ON CONFLICT (source, source_reference_id, grant_index) DO NOTHING');
    });

    it('grants none while the programme is off', async () => {
      await expect(packWebhook()).resolves.toMatchObject({ status: 'fulfilled' });
      expect(mocks.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO gift_letters'), expect.anything());
    });

    it("revokes a refunded pack's unsent gift letters and leaves its printed codes alone", async () => {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-gift-refund' }] };
        if (sql.includes('SELECT * FROM orders')) {
          return { rows: [{ ...baseOrder, order_type: 'letter_pack', credits: 4, amount_cents: 1999, status: 'fulfilled' }] };
        }
        if (sql.includes('UPDATE users')) return { rows: [{ credits: 0 }] };
        return { rows: [] };
      });
      await processStripeWebhookEvent({
        id: 'evt-gift-refund',
        type: 'charge.refunded',
        data: { object: { id: 'ch-1', payment_intent: 'pi-1', amount_refunded: 1999 } }
      } as any);
      expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE gift_letters SET status = 'revoked'"), ['order-1']);
      expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('source_reversed_at = COALESCE'), ['order-1']);
      expect(mocks.query).not.toHaveBeenCalledWith(expect.stringContaining("void_reason = 'purchase_reversed'"), expect.anything());
    });

    it('revokes the gift letters when a proportional refund takes every letter left, and only then', async () => {
      const order = { ...baseOrder, order_type: 'letter_pack', credits: 4, amount_cents: 500, status: 'fulfilled' } as any;
      async function refund(liveCredits: number, credits: number) {
        const calls: string[] = [];
        const client = {
          query: vi.fn(async (sql: string) => {
            calls.push(sql);
            if (sql.includes('SELECT ledger_id, remaining_amount FROM credit_ledger')) {
              return { rows: [{ ledger_id: 'lot-1', remaining_amount: liveCredits }] };
            }
            if (sql.includes('INSERT INTO credit_ledger')) return { rows: [{ ledger_id: 'audit-1' }] };
            if (sql.includes('FROM users') || sql.includes('UPDATE users')) return { rows: [{ credits: liveCredits }] };
            return { rows: [] };
          })
        };
        await revokePackLots(client as never, order, { credits, cause: 'partial_refund' });
        return calls;
      }
      // Two of four credits back: letters remain, so does the gift.
      expect((await refund(4, 2)).some(sql => sql.includes('UPDATE gift_letters'))).toBe(false);
      // The last two back: the purchase is reversed as far as it can be.
      const exhausting = await refund(2, 2);
      expect(exhausting.some(sql => sql.includes("UPDATE gift_letters SET status = 'revoked'"))).toBe(true);
      expect(exhausting.some(sql => sql.includes("void_reason = 'purchase_reversed'"))).toBe(false);
    });
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
      await requestRefund('order-1');
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
    mocks.findRefund.mockResolvedValue({ live: { id: 're-lock', status: 'succeeded' }, ended: null });
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
    // The read of the letters a pack paid for (#696) comes first, a plain read: it locks
    // each letter before the account, as every path that holds both does.
    const ordered = mocks.query.mock.calls
      .filter(call => !String(call[0]).includes('FROM gift_letters g'))
      .filter(call =>
        String(call[0]) === ACCOUNT_LOCK_SQL ||
        String(call[0]).includes('credit_ledger') ||
        String(call[0]).includes('image_entitlements'));
    expect([String(ordered[0]?.[0]), ordered[0]?.[1]]).toEqual([ACCOUNT_LOCK_SQL, ['user-1']]);
  });

  /**
   * Image generations come with purchases, except while image generation is
   * switched off (LETTER_IRL_IMAGE_GEN_MODE=off, src/config/imageGeneration.ts):
   * then no path grants any, so nobody is handed generations they cannot use.
   * Four paths grant: pack fulfilment, pack repair, Pay & Send fulfilment and
   * its maintenance recovery.
   */
  describe('image generations with a purchase, and the image switch', () => {
    // The suite's beforeEach stubs its own variables again for every test.
    afterEach(() => vi.unstubAllEnvs());

    const pendingPackOrder = {
      ...baseOrder, order_type: 'letter_pack', product_code: 'credit-pack-4',
      credits: 4, amount_cents: 500, draft_id: undefined, status: 'checkout_pending'
    };

    function packWebhook() {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-1' }] };
        if (sql.includes('SELECT * FROM orders')) return { rows: [pendingPackOrder] };
        return { rows: [] };
      });
      return processStripeWebhookEvent(checkoutEvent({ amount_total: 500 }) as any);
    }

    function payAndSendWebhook() {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-1' }] };
        if (sql.includes('SELECT * FROM orders')) return { rows: [baseOrder] };
        return { rows: [] };
      });
      return processStripeWebhookEvent(checkoutEvent());
    }

    function repairPack() {
      const packOrder = {
        ...baseOrder, order_id: 'pack-order', order_type: 'letter_pack', draft_id: undefined,
        status: 'fulfilled', credits: 4, amount_cents: 500, currency: 'usd',
        product_code: 'credit-pack-4', stripe_checkout_session_id: 'cs-pack'
      };
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes("order_type = 'letter_pack'")) return { rows: [packOrder] };
        return { rows: [] };
      });
      return repairFulfilledPackGrant({
        orderId: 'pack-order', stripeSessionId: 'cs-pack', expectedCredits: 4,
        paidAmountCents: 500, paidCurrency: 'usd'
      });
    }

    function recoverPayAndSend() {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.startsWith('SELECT * FROM orders WHERE order_id = $1')) {
          return { rows: [{ ...baseOrder, status: 'paid' }] };
        }
        return { rows: [] };
      });
      return fulfillPaidOrder('order-1');
    }

    const missedEvents = () =>
      mocks.query.mock.calls.filter(([sql, params]) =>
        String(sql).includes('INSERT INTO commerce_order_events') && (params as unknown[])[1] === 'jit.schedule_missed'
      );

    it.each([
      ['the webhook', () => payAndSendWebhook()],
      ['the hourly recovery', () => recoverPayAndSend()]
    ])('records on the order a mail date that passed before %s fulfilled it (#700)', async (_label, fulfil) => {
      mocks.createMail.mockResolvedValueOnce({ scheduleMissed: { arriveBy: '2026-10-16', mailOn: '2026-10-06' } });

      await fulfil();

      expect(missedEvents()).toHaveLength(1);
      const [, params] = missedEvents()[0];
      expect(params).toEqual(['order-1', 'jit.schedule_missed', null, null, JSON.stringify({ arriveBy: '2026-10-16', mailOn: '2026-10-06' })]);
    });

    it.each([
      ['the webhook', () => payAndSendWebhook()],
      ['the hourly recovery', () => recoverPayAndSend()]
    ])('records the miss in its own savepoint, and still fulfils when %s cannot write it (#700 review round 3)', async (_label, fulfil) => {
      mocks.createMail.mockResolvedValueOnce({ scheduleMissed: { arriveBy: '2026-10-16', mailOn: '2026-10-06' } });
      const base = mocks.query.getMockImplementation();
      // The helpers set their own implementation on the call; wrap it once they have.
      const failing = (impl: typeof base) => async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO commerce_order_events') && (params as unknown[])?.[1] === 'jit.schedule_missed') {
          throw Object.assign(new Error('statement timeout'), { code: '57014' });
        }
        return impl!(sql, params);
      };
      const original = mocks.query.mockImplementation.bind(mocks.query);
      const spy = vi.spyOn(mocks.query, 'mockImplementation').mockImplementation(impl => original(failing(impl as typeof base)));
      try {
        const result = await fulfil();
        expect(JSON.stringify(result ?? null)).not.toContain('refund_pending');
      } finally {
        spy.mockRestore();
      }
      const sqls = mocks.query.mock.calls.map(([sql]) => String(sql));
      expect(sqls).toContain('SAVEPOINT schedule_missed_event');
      expect(sqls).toContain('ROLLBACK TO SAVEPOINT schedule_missed_event');
      expect(sqls.some(sql => sql.includes("SET status = 'refund_pending'"))).toBe(false);
    });

    it.each([
      ['the webhook', () => payAndSendWebhook()],
      ['the hourly recovery', () => recoverPayAndSend()]
    ])('records nothing when %s fulfils mail on its date, or with none (#700)', async (_label, fulfil) => {
      await fulfil();
      expect(mocks.createMail).toHaveBeenCalled();
      expect(missedEvents()).toEqual([]);
      // Nor tries to: no savepoint for an event it has no dates for.
      expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('schedule_missed_event'))).toBe(false);
    });

    it('grants a pack its image generations while the switch is on', async () => {
      await expect(packWebhook()).resolves.toMatchObject({ status: 'fulfilled' });
      expect(mocks.grantEntitlement).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sourceType: 'letter_pack', sourceReferenceId: 'order-1', quantity: 10 })
      );
    });

    it('grants a pack its letters and no image generations while the switch is off', async () => {
      vi.stubEnv('LETTER_IRL_IMAGE_GEN_MODE', 'off');
      await expect(packWebhook()).resolves.toMatchObject({ status: 'fulfilled' });
      expect(mocks.addCredits).toHaveBeenCalledTimes(1);
      expect(mocks.grantEntitlement).not.toHaveBeenCalled();
    });

    it('still grants under redirect, which only stops generating', async () => {
      vi.stubEnv('LETTER_IRL_IMAGE_GEN_MODE', 'redirect');
      await expect(packWebhook()).resolves.toMatchObject({ status: 'fulfilled' });
      expect(mocks.grantEntitlement).toHaveBeenCalledTimes(1);
    });

    it('sends a Pay & Send letter and grants no image generations while the switch is off', async () => {
      vi.stubEnv('LETTER_IRL_IMAGE_GEN_MODE', 'off');
      await expect(payAndSendWebhook()).resolves.toMatchObject({ status: 'fulfillment_pending' });
      expect(mocks.createMail).toHaveBeenCalledTimes(1);
      expect(mocks.grantEntitlement).not.toHaveBeenCalled();
    });

    it('repairs a pack without image generations while the switch is off', async () => {
      vi.stubEnv('LETTER_IRL_IMAGE_GEN_MODE', 'off');
      await expect(repairPack()).resolves.toBe('repaired');
      expect(mocks.addCredits).toHaveBeenCalledTimes(1);
      expect(mocks.grantEntitlement).not.toHaveBeenCalled();
    });

    it('recovers a paid Pay & Send order with image generations only while the switch is on', async () => {
      await expect(recoverPayAndSend()).resolves.toBe(true);
      expect(mocks.grantEntitlement).toHaveBeenCalledTimes(1);

      mocks.grantEntitlement.mockClear();
      mocks.createMail.mockClear();
      vi.stubEnv('LETTER_IRL_IMAGE_GEN_MODE', 'off');
      await expect(recoverPayAndSend()).resolves.toBe(true);
      expect(mocks.createMail).toHaveBeenCalledTimes(1);
      expect(mocks.grantEntitlement).not.toHaveBeenCalled();
    });
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

  it('prices a reused order from the LIVE catalog, so a repoint takes effect', async () => {
    // Rounds 11-12 spliced the row's figures into this product, ending with
    // the price id pinned to the row - which stranded a checkout on an
    // archived Price that the pre-round-11 code completed successfully. The
    // splice existed to survive a concurrent memo invalidation, and that
    // machinery is gone, so this is one fresh derivation again (#278 r13).
    mocks.getJitProduct.mockReturnValue({
      productCode: 'jit-letter', priceId: 'price-jit-LIVE', amountCents: 499,
      currency: 'usd', name: 'Pay & Send One Physical Letter',
      description: 'x', mailType: 'letter'
    });
    const reusable = {
      ...baseOrder,
      amount_cents: 499,
      product_snapshot: { ...baseOrder.product_snapshot },
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
        product: expect.objectContaining({ priceId: 'price-jit-LIVE' })
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

    await requestRefund('order-q');

    const claim = mocks.query.mock.calls
      .map(([sql]) => String(sql))
      .find(sql => sql.includes("status = 'refund_pending'") && sql.includes('FOR UPDATE'));
    expect(claim).toBeDefined();
    expect(claim).toContain("last_error_code NOT IN ('PAYMENT_AMOUNT_MISMATCH', 'REFUND_NOT_COMPLETED')");
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

      getSendEligibility(0, 2, { mailType: 'letter' }); // outage 1: logs
      getSendEligibility(0, 2, { mailType: 'letter' }); // steady, identical: suppressed
      mocks.describeUnpriced.mockReturnValue({
        productCode: 'jit-letter',
        rule: 'price.amount_mismatch',
        diagnosticClass: 'configuration_error',
        detail: 'expected 499 / stripe 599'
      });
      getSendEligibility(0, 2, { mailType: 'letter' }); // a DIFFERENT fault: logs

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
    expect(cancel?.[1]?.[0]).toBe('order-1');
    // The code and its message move together, like every other cancel here.
    // Round 12 fixed the sibling branch and left this one, so the reprice
    // cancel kept the previous failure's text beside a fresh code (#278 r13).
    expect(String(cancel?.[0])).toContain('last_error = $2');
    expect(String(cancel?.[1]?.[1])).toMatch(/price changed/i);
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
    expect(sweep).toContain("last_error_code NOT IN ('PAYMENT_AMOUNT_MISMATCH', 'REFUND_NOT_COMPLETED')");
  });

  it('kicks the catalog with the JIT code even while Pay & Send is disabled', async () => {
    // The disabled short-circuit must not starve the catalog's unsold-state
    // clearing - that starvation is how toggle-off cooldowns survived to
    // resurface on re-enable (#278 round 7).
    mocks.jitEnabled.mockReturnValue(false);

    const eligibility = getSendEligibility(0, 2, { mailType: 'letter' });

    expect(eligibility.payAndSend.unavailableReason).toBe('Pay & Send is not enabled.');
    expect(mocks.ensurePriceCatalog).toHaveBeenCalledWith('jit-letter', 'send_eligibility_disabled');
  });

  describe('mail options, each at its own price (#578)', () => {
    const DRAFT = {
      draft_id: 'draft-1', user_id: 'user-1', mail_type: 'postcard', postcard_size: '6x4',
      required_credits: 2, status: 'pending',
      expires_at: new Date(Date.now() + 6 * 60 * 60_000)
    };

    it("reads a draft's option: its mail type and postcard size, letters one page", () => {
      expect(draftMailOption(optionRow({ mail_type: 'postcard', postcard_size: '6x11' }))).toEqual({
        mailType: 'postcard',
        postcardSize: '6x11'
      });
      expect(draftMailOption(optionRow({ mail_type: 'postcard', postcard_size: null }))).toEqual({
        mailType: 'postcard',
        postcardSize: '6x9'
      });
      expect(draftMailOption(optionRow({ mail_type: 'letter', postcard_size: '6x9' }))).toEqual({ mailType: 'letter' });
      expect(draftMailOption(optionRow({}))).toEqual({ mailType: 'letter' });
    });

    it("reads a letter's pages, and a postcard's never (#586)", () => {
      expect(draftMailOption(optionRow({ mail_type: 'letter', pages: 2 }))).toEqual({ mailType: 'letter', pages: 2 });
      expect(draftMailOption(optionRow({ mail_type: 'letter', pages: 3 }))).toEqual({ mailType: 'letter', pages: 3 });
      // One page is the letter it always was.
      expect(draftMailOption(optionRow({ mail_type: 'letter', pages: 1 }))).toEqual({ mailType: 'letter' });
      expect(draftMailOption(optionRow({ mail_type: 'letter', pages: null }))).toEqual({ mailType: 'letter' });
      // A count read back as text is still a count.
      expect(draftMailOption(optionRow({ mail_type: 'letter', pages: '2' }))).toEqual({ mailType: 'letter', pages: 2 });
      expect(draftMailOption(optionRow({ mail_type: 'postcard', postcard_size: '6x9', pages: 2 }))).toEqual({
        mailType: 'postcard',
        postcardSize: '6x9'
      });
    });

    it("quotes an option's own price, and asks for it by the option", () => {
      mocks.jitEnabled.mockReturnValue(true);
      mocks.getJitProduct.mockReturnValue({
        productCode: 'jit-postcard-4x6', priceId: 'price-4x6', amountCents: 399,
        currency: 'usd', name: 'Pay & Send One 4x6 Postcard', description: 'x', mailType: 'postcard'
      });

      const option = { mailType: 'postcard' as const, postcardSize: '6x4' as const };
      const eligibility = getSendEligibility(0, 2, option);

      expect(mocks.getJitProduct).toHaveBeenCalledWith(option);
      expect(eligibility.payAndSend).toMatchObject({ available: true, amountCents: 399, displayAmount: '3.99' });
      expect(mocks.ensurePriceCatalog).toHaveBeenCalledWith('jit-postcard-4x6', 'send_eligibility');
    });

    it('offers no Pay & Send for an option this deployment does not sell, and reports no fault', () => {
      mocks.jitEnabled.mockReturnValue(true);
      mocks.getJitProduct.mockReturnValue(null);
      const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const eligibility = getSendEligibility(0, 2, { mailType: 'letter', pages: 2 });

        expect(eligibility.payAndSend).toEqual({ available: false, unavailableReason: OPTION_NOT_SOLD_REASON });
        expect(OPTION_NOT_SOLD_REASON).toBe("Pay & Send isn't available for this mail.");
        // Kicked with the option's own code all the same, so the catalog
        // clears what it recorded while the option was sold.
        expect(mocks.ensurePriceCatalog).toHaveBeenCalledWith('jit-letter-2-pages', 'send_eligibility');
        const lines = [...diagnostic.mock.calls, ...warning.mock.calls].flat().map(String);
        expect(lines.filter(line => line.includes('pay_and_send_unpriced'))).toEqual([]);
      } finally {
        diagnostic.mockRestore();
        warning.mockRestore();
      }
    });

    it("kicks with the option's code while Pay & Send is off", () => {
      mocks.jitEnabled.mockReturnValue(false);

      getSendEligibility(0, 2, { mailType: 'postcard', postcardSize: '6x11' });

      expect(mocks.ensurePriceCatalog).toHaveBeenCalledWith('jit-postcard-11x6', 'send_eligibility_disabled');
    });

    it('offers Pay & Send, and no pack, for an option whatever the balance (#579)', () => {
      mocks.jitEnabled.mockReturnValue(true);
      mocks.getJitProduct.mockReturnValue({
        productCode: 'jit-postcard-4x6', priceId: 'price-4x6', amountCents: 399,
        currency: 'usd', name: 'Pay & Send One 4x6 Postcard', description: 'x', mailType: 'postcard'
      });

      const eligibility = getSendEligibility(200, 2, { mailType: 'postcard', postcardSize: '6x4' });

      expect(eligibility.payAndSend).toMatchObject({ available: true, amountCents: 399 });
      expect(eligibility.letterPack.available).toBe(false);
      expect(eligibility.packPays).toBe(false);
    });

    it('leaves pack-payable mail as it was: no packPays, the balance first', () => {
      mocks.jitEnabled.mockReturnValue(true);
      mocks.getJitProduct.mockReturnValue({
        productCode: 'jit-postcard', priceId: 'price-6x9', amountCents: 499,
        currency: 'usd', name: 'Pay & Send One Physical Postcard', description: 'x', mailType: 'postcard'
      });

      const eligibility = getSendEligibility(200, 2, { mailType: 'postcard', postcardSize: '6x9' });

      expect(eligibility).not.toHaveProperty('packPays');
      expect(eligibility.letterPack.available).toBe(true);
      expect(eligibility.payAndSend).toMatchObject({
        available: false,
        unavailableReason: 'Use your existing prepaid letter balance.'
      });
    });

    it("prices a long letter's checkout by its pages from the peek on: its price warmed, its amount capped (#586)", async () => {
      // A day's limit between the one-page price and the two-page price.
      vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS', '550');
      mocks.getJitProduct.mockImplementation((({ mailType, pages }: { mailType: string; pages?: number }) =>
        mailType === 'letter' && pages === 2
          ? {
              productCode: 'jit-letter-2-pages', priceId: 'price-2p', amountCents: 599,
              currency: 'usd', name: 'Pay & Send One Two-Page Letter', description: 'x', mailType: 'letter'
            }
          : {
              productCode: 'jit-letter', priceId: 'price-1p', amountCents: 499,
              currency: 'usd', name: 'Pay & Send One Physical Letter', description: 'x', mailType: 'letter'
            }) as never);
      mocks.query
        // In the order the checkout reads them: the send block, then the peek.
        .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
        .mockResolvedValueOnce({ rows: [{ mail_type: 'letter', postcard_size: null, pages: 2 }] })
        .mockResolvedValue({ rows: [] });

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }))
        .rejects.toMatchObject({ code: 'CHARGE_ABOVE_DAILY_CAP' });

      expect(String(mocks.query.mock.calls[1][0])).toContain(
        'SELECT mail_type, postcard_size, pages, mail_service FROM letter_drafts'
      );
      expect(mocks.ensurePriceCatalog).toHaveBeenCalledWith('jit-letter-2-pages');
      expect(mocks.getJitProduct).toHaveBeenCalledWith({ mailType: 'letter', pages: 2 });
      const sql = mocks.query.mock.calls.map(call => String(call[0]));
      expect(sql.some(statement => statement.includes('INSERT INTO orders'))).toBe(false);
    });

    it('peeks a draft that is gone as a one-page letter, then refuses it under the lock (#691)', async () => {
      mocks.getJitProduct.mockImplementation((() => ({
        productCode: 'jit-letter', priceId: 'price-1p', amountCents: 499,
        currency: 'usd', name: 'Pay & Send One Physical Letter', description: 'x', mailType: 'letter'
      })) as never);
      mocks.query
        .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValue({ rows: [] });

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });

      // No row reads as the plainest mail there is, never another kind: its price warms, and nothing is ordered.
      expect(mocks.getJitProduct).toHaveBeenCalledWith({ mailType: 'letter' });
      expect(mocks.getJitProduct).not.toHaveBeenCalledWith(expect.objectContaining({ mailType: 'postcard' }));
      const sql = mocks.query.mock.calls.map(call => String(call[0]));
      expect(sql.some(statement => statement.includes('INSERT INTO orders'))).toBe(false);
    });

    it("prices a certified letter's checkout by its service from the peek on: its price warmed, its amount capped (#625)", async () => {
      // A day's limit between the standard price and the certified price.
      vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS', '700');
      mocks.getJitProduct.mockImplementation((({ mailType, mailService }: { mailType: string; mailService?: string }) =>
        mailType === 'letter' && mailService === 'certified'
          ? {
              productCode: 'jit-letter-certified', priceId: 'price-cert', amountCents: 1199,
              currency: 'usd', name: 'Pay & Send One Certified Mail Letter', description: 'x', mailType: 'letter'
            }
          : {
              productCode: 'jit-letter', priceId: 'price-1p', amountCents: 499,
              currency: 'usd', name: 'Pay & Send One Physical Letter', description: 'x', mailType: 'letter'
            }) as never);
      mocks.query
        // In the order the checkout reads them: the send block, then the peek.
        .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
        .mockResolvedValueOnce({ rows: [{ mail_type: 'letter', postcard_size: null, pages: 1, mail_service: 'certified' }] })
        .mockResolvedValue({ rows: [] });

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }))
        .rejects.toMatchObject({ code: 'CHARGE_ABOVE_DAILY_CAP' });

      expect(mocks.ensurePriceCatalog).toHaveBeenCalledWith('jit-letter-certified');
      expect(mocks.getJitProduct).toHaveBeenCalledWith({ mailType: 'letter', mailService: 'certified' });
      const sql = mocks.query.mock.calls.map(call => String(call[0]));
      expect(sql.some(statement => statement.includes('INSERT INTO orders'))).toBe(false);
    });

    it('refuses a checkout for an option this deployment does not sell, before any order', async () => {
      // The 6x9 is sold and the 4x6 is not: a checkout priced by the mail
      // type alone would sell this 4x6 as a 6x9.
      mocks.getJitProduct.mockImplementation((({ postcardSize }: { postcardSize?: string }) =>
        postcardSize === '6x4'
          ? null
          : {
              productCode: 'jit-postcard', priceId: 'price-6x9', amountCents: 499,
              currency: 'usd', name: 'Pay & Send One Physical Postcard', description: 'x', mailType: 'postcard'
            }) as never);
      mocks.query
        // In the order the checkout reads them: the send block, then the peek.
        .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
        .mockResolvedValueOnce({ rows: [{ mail_type: 'postcard', postcard_size: '6x4' }] })
        .mockResolvedValueOnce({ rows: [DRAFT] })
        .mockResolvedValue({ rows: [] });

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }))
        .rejects.toMatchObject({ code: 'JIT_OPTION_NOT_SOLD' });

      // The peek ensures the option's own code, sold or not, so the catalog
      // clears what it held for it; the cap reads no price for it.
      expect(mocks.ensurePriceCatalog).toHaveBeenCalledWith('jit-postcard-4x6');
      // Priced by the draft's own option, the locked row's last of all, and
      // nothing inserted or opened.
      expect(mocks.getJitProduct).toHaveBeenLastCalledWith({ mailType: 'postcard', postcardSize: '6x4' });
      const sql = mocks.query.mock.calls.map(call => String(call[0]));
      expect(sql.some(statement => statement.includes('INSERT INTO orders'))).toBe(false);
      expect(mocks.createJitSession).not.toHaveBeenCalled();
    });

    it('refuses a checkout whose letter changed its pages since the peek, before any order (#586)', async () => {
      // A day's cap above either price, so only the change refuses it.
      vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS', '100000');
      mocks.getJitProduct.mockImplementation((({ mailType, pages }: { mailType: string; pages?: number }) =>
        mailType === 'letter' && pages === 2
          ? {
              productCode: 'jit-letter-2-pages', priceId: 'price-2p', amountCents: 599,
              currency: 'usd', name: 'Pay & Send One Two-Page Letter', description: 'x', mailType: 'letter'
            }
          : {
              productCode: 'jit-letter', priceId: 'price-1p', amountCents: 499,
              currency: 'usd', name: 'Pay & Send One Physical Letter', description: 'x', mailType: 'letter'
            }) as never);
      mocks.query
        // The send block, then the peek (one page, as the caps are checked),
        // then the locked row: new words ran it on to a second page meanwhile.
        .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
        .mockResolvedValueOnce({ rows: [{ mail_type: 'letter', postcard_size: null, pages: 1 }] })
        .mockResolvedValueOnce({ rows: [{ ...DRAFT, mail_type: 'letter', postcard_size: null, pages: 2 }] })
        .mockResolvedValue({ rows: [] });

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }))
        .rejects.toMatchObject({ code: 'DRAFT_CHANGED' });

      // Priced at the locked row's two pages, which is not what the caps checked.
      expect(mocks.getJitProduct).toHaveBeenLastCalledWith({ mailType: 'letter', pages: 2 });
      const sql = mocks.query.mock.calls.map(call => String(call[0]));
      expect(sql.some(statement => statement.includes('INSERT INTO orders'))).toBe(false);
      expect(mocks.createJitSession).not.toHaveBeenCalled();

      // Back on to one page meanwhile is refused too: the catalog was warmed, and
      // the caps checked, for the peek's product.
      mocks.query.mockReset();
      mocks.query
        .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
        .mockResolvedValueOnce({ rows: [{ mail_type: 'letter', postcard_size: null, pages: 2 }] })
        .mockResolvedValueOnce({ rows: [{ ...DRAFT, mail_type: 'letter', postcard_size: null, pages: 1 }] })
        .mockResolvedValue({ rows: [] });
      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }))
        .rejects.toMatchObject({ code: 'DRAFT_CHANGED' });
      expect(mocks.createJitSession).not.toHaveBeenCalled();
    });

    it("refuses to reuse a closing checkout made for the letter's old pages, cancelling nothing (#593 review round 1)", async () => {
      vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS', '100000');
      mocks.getJitProduct.mockImplementation((({ mailType, pages }: { mailType: string; pages?: number }) =>
        mailType === 'letter' && pages === 2
          ? {
              productCode: 'jit-letter-2-pages', priceId: 'price-2p', amountCents: 599,
              currency: 'usd', name: 'Pay & Send One Two-Page Letter', description: 'x', mailType: 'letter'
            }
          : {
              productCode: 'jit-letter', priceId: 'price-1p', amountCents: 499,
              currency: 'usd', name: 'Pay & Send One Physical Letter', description: 'x', mailType: 'letter'
            }) as never);
      // Its window passed, so new words ran the letter on to a second page; its
      // session is closing at the one-page price, and only Stripe's word cancels it.
      const closing = {
        ...baseOrder,
        stripe_checkout_session_id: 'cs-old',
        checkout_url: 'https://checkout.stripe.test/old',
        checkout_expires_at: new Date(Date.now() - 60_000)
      };
      mocks.query
        .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
        .mockResolvedValueOnce({ rows: [{ mail_type: 'letter', postcard_size: null, pages: 2 }] })
        .mockResolvedValueOnce({ rows: [{ ...DRAFT, mail_type: 'letter', postcard_size: null, pages: 2 }] })
        .mockResolvedValueOnce({ rows: [closing] })
        .mockResolvedValue({ rows: [] });

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }))
        .rejects.toMatchObject({ code: 'PREVIOUS_CHECKOUT_CLOSING' });
      expect(mocks.createJitSession).not.toHaveBeenCalled();
      const sql = mocks.query.mock.calls.map(call => String(call[0]));
      expect(sql.some(statement => statement.includes("status = 'cancelled'"))).toBe(false);
      expect(sql.some(statement => statement.includes('INSERT INTO orders'))).toBe(false);
    });

    it("prices a checkout by its order's product, never by its mail type", async () => {
      const optionProduct = {
        productCode: 'jit-postcard-4x6', priceId: 'price-4x6', amountCents: 399,
        currency: 'usd', name: 'Pay & Send One 4x6 Postcard', description: 'x', mailType: 'postcard'
      };
      // The mail type alone would name the 6x9, so the two doubles differ:
      // only the order's own product prices the session (#581 review r3).
      mocks.getJitProduct.mockReturnValue({
        productCode: 'jit-postcard', priceId: 'price-6x9', amountCents: 499,
        currency: 'usd', name: 'Pay & Send One Physical Postcard', description: 'x', mailType: 'postcard'
      });
      mocks.getJitProductForCode.mockReturnValue(optionProduct);
      const reusable = {
        ...baseOrder,
        product_code: 'jit-postcard-4x6',
        product_snapshot: { name: 'Pay & Send One 4x6 Postcard', mailType: 'postcard' },
        amount_cents: 399,
        stripe_checkout_session_id: 'cs-existing',
        checkout_url: null,
        checkout_expires_at: new Date(Date.now() + 90 * 60_000)
      };
      mocks.query
        // In the order the checkout reads them: the send block, then the peek.
        .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
        .mockResolvedValueOnce({ rows: [{ mail_type: 'postcard', postcard_size: '6x4' }] })
        .mockResolvedValueOnce({ rows: [DRAFT] })
        .mockResolvedValueOnce({ rows: [reusable] })
        .mockResolvedValue({ rows: [reusable] });
      mocks.createJitSession.mockResolvedValue({
        success: true, sessionId: 'cs-x', sessionUrl: 'https://s', expiresAt: new Date()
      });

      await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }).catch(() => undefined);

      expect(mocks.getJitProductForCode).toHaveBeenCalledWith('jit-postcard-4x6');
      expect(mocks.createJitSession).toHaveBeenCalledWith(
        expect.objectContaining({ product: optionProduct })
      );
    });

    it("cancels an order whose product is no longer sold when its session is made", async () => {
      mocks.getJitProduct.mockReturnValue({
        productCode: 'jit-postcard-4x6', priceId: 'price-4x6', amountCents: 399,
        currency: 'usd', name: 'Pay & Send One 4x6 Postcard', description: 'x', mailType: 'postcard'
      });
      mocks.getJitProductForCode.mockReturnValue(null);
      const reusable = {
        ...baseOrder,
        product_code: 'jit-postcard-4x6',
        amount_cents: 399,
        stripe_checkout_session_id: 'cs-existing',
        checkout_url: null,
        checkout_expires_at: new Date(Date.now() + 90 * 60_000)
      };
      mocks.query
        // In the order the checkout reads them: the send block, then the peek.
        .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
        .mockResolvedValueOnce({ rows: [{ mail_type: 'postcard', postcard_size: '6x4' }] })
        .mockResolvedValueOnce({ rows: [DRAFT] })
        .mockResolvedValueOnce({ rows: [reusable] })
        .mockResolvedValue({ rows: [{ order_id: 'order-1' }] });

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }))
        .rejects.toMatchObject({ code: 'PRICE_ID_NOT_CONFIGURED', diagnosticClass: 'configuration_error' });

      expect(mocks.createJitSession).not.toHaveBeenCalled();
      const cancel = mocks.query.mock.calls.find(call => String(call[0]).includes("SET status = 'cancelled'"));
      expect(cancel?.[1]).toEqual(['order-1', 'Pay & Send no longer sells jit-postcard-4x6', 'PRICE_ID_NOT_CONFIGURED']);
    });
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
      mocks.getJitProduct.mockImplementation((({ mailType }: { mailType: string }) => ({
        productCode: mailType === 'letter' ? 'jit-letter' : 'jit-postcard',
        priceId: 'price-jit',
        amountCents: 0,
        currency: 'usd',
        name: 'Pay & Send',
        description: 'One item'
      })) as never);

      for (let i = 0; i < 3; i += 1) {
        getSendEligibility(0, 2, { mailType: 'letter' });
        getSendEligibility(0, 1, { mailType: 'postcard' });
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
      getSendEligibility(0, 2, { mailType: 'letter' });

      mocks.describeUnpriced.mockReturnValue({
        productCode: 'jit-letter',
        rule: 'price.inactive',
        diagnosticClass: 'configuration_error'
      } as never);
      mocks.getJitProduct.mockReturnValue({
        productCode: 'jit-letter', priceId: 'price-jit', amountCents: 0,
        currency: 'usd', name: 'Pay & Send', description: 'One letter'
      });

      for (let i = 0; i < 5; i += 1) getSendEligibility(0, 2, { mailType: 'letter' });

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

  it('labels an unconfigured JIT price id configuration_error before any order write (#219)', async () => {
    // The twin of the pack case above, and the reason #219 can close.
    //
    // That issue was filed when createJitCheckout wrote the order row BEFORE
    // validating price config, leaving junk orders behind for
    // markCheckoutCreationFailure to annotate. #278's restructuring moved the
    // guard above the INSERT - but nothing pinned it there, which is how the
    // ordering drifted in the first place. The pack path has had this test
    // since #155; the JIT path never did.
    mocks.getJitProduct.mockReturnValue({
      productCode: 'jit-letter', priceId: '', amountCents: 499,
      currency: 'usd', name: 'Pay & Send One Physical Letter',
      description: 'x', mailType: 'letter'
    });
    // Keyed on SQL rather than call order: a positional chain silently
    // re-targets if a query is ever added ahead of these.
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('sends_blocked_reason')) return { rows: [{ sends_blocked_reason: null }] };
      if (sql.includes('mail_type FROM letter_drafts')) return { rows: [{ mail_type: 'letter' }] };
      if (sql.includes('FROM letter_drafts')) {
        return {
          rows: [{
            draft_id: 'draft-1', user_id: 'user-1', mail_type: 'letter',
            required_credits: 2, status: 'pending',
            expires_at: new Date(Date.now() + 86_400_000)
          }]
        };
      }
      return { rows: [] };
    });

    const error = await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }).catch(e => e);

    expect(error).toMatchObject({ code: 'JIT_NOT_CONFIGURED' });
    // The assertion #219 is actually about: nothing was written.
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO orders'),
      expect.anything()
    );
    expect(mocks.createJitSession).not.toHaveBeenCalled();
  });

  it('does NOT short-circuit a row that has a session id but no url (#279)', async () => {
    // The property that makes createJitCheckout's early return legitimately
    // DIFFER from prepareJitOrder's reuse branch.
    //
    // #279's first suggestion is to align them - extend that return to fire on
    // stripe_checkout_session_id as well as checkout_url. Tried and reverted,
    // because the fall-through it removes is a REPAIR: the retry carries the
    // SAME idempotency_key, so with unchanged parameters Stripe replays the
    // original session rather than opening a second, and attachCheckout's
    // COALESCE backfills the url onto it. Closing the path returns success:
    // true with checkoutUrl still NULL and leaves the draft blocked until the
    // checkout window lapses.
    //
    // Both outcomes need the same undemonstrated row shape, so this is not
    // "certain versus latent" - it is that the current code repairs the row and
    // the aligned guard cannot.
    //
    // Stated as a property rather than as "do not add that condition", so it
    // also catches any other early return that would answer without a url.
    mocks.getJitProduct.mockReturnValue({
      productCode: 'jit-letter', priceId: 'price-jit', amountCents: 499,
      currency: 'usd', name: 'Pay & Send One Physical Letter',
      description: 'x', mailType: 'letter'
    });
    const sessionWithoutUrl = {
      ...baseOrder,
      amount_cents: 499,
      product_snapshot: { ...baseOrder.product_snapshot },
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
      .mockResolvedValueOnce({ rows: [sessionWithoutUrl] })
      .mockResolvedValue({ rows: [sessionWithoutUrl] });
    mocks.createJitSession.mockResolvedValue({
      success: true, sessionId: 'cs-new', sessionUrl: 'https://checkout.example/pay',
      expiresAt: new Date()
    });

    await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }).catch(() => undefined);

    // The whole assertion. Add the condition #279 proposed and this reddens,
    // because the function would answer from the row instead of going to
    // Stripe - handing back success: true with checkout_url still NULL.
    expect(
      mocks.createJitSession,
      'a row with a session but no url must still reach Stripe: that call is how it obtains one'
    ).toHaveBeenCalled();
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

  describe('a dispute that escalates, and one already settled (#730)', () => {
    const disputedOrder = { ...baseOrder, status: 'fulfilled', stripe_payment_intent_id: 'pi-1' };

    async function deliver(
      type: string,
      status: string,
      prior?: { status: string; resolved_at: Date | null; user_id?: string | null },
      order: unknown = disputedOrder
    ) {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-1' }] };
        if (sql.includes('SELECT status, resolved_at, user_id FROM stripe_disputes')) {
          return { rows: prior ? [{ user_id: 'user-1', ...prior }] : [] };
        }
        if (sql.includes('SELECT * FROM orders')) return { rows: order ? [order] : [] };
        return { rows: [] };
      });
      await expect(processStripeWebhookEvent({
        id: 'evt-1', type, data: { object: {
          id: 'dp-1', payment_intent: 'pi-1', charge: 'ch-1', amount: 499,
          currency: 'usd', reason: 'fraudulent', status
        } }
      } as any)).resolves.toEqual({ duplicate: false });
    }
    const all = () => mocks.query.mock.calls as unknown as Array<[string, unknown[]]>;
    const calls = (fragment: string) => all().filter(([sql]) => String(sql).includes(fragment));
    const blocked = () => calls('sends_blocked_reason = COALESCE(sends_blocked_reason, $2)').length > 0;
    const markedDisputed = () => calls("UPDATE orders SET status = 'disputed'").length > 0;
    const alertsOfType = (type: string) =>
      calls('INSERT INTO commerce_operational_alerts').filter(([sql, params]) => params[2] === type || sql.includes(`'${type}'`));
    const disputeAlerts = () => alertsOfType('stripe_dispute_created');
    const keptStoredStatus = () => calls('INSERT INTO stripe_disputes')[0][1][11];
    const recordedOnly = () => {
      const event = calls('INSERT INTO commerce_order_events');
      expect(event).toHaveLength(1);
      return JSON.parse(String(event[0][1][4])).recordedOnly;
    };

    it.each(['charge.dispute.updated', 'charge.dispute.funds_withdrawn'])(
      'restricts the account when an inquiry becomes a chargeback (%s), and tells the operator once',
      async type => {
        await deliver(type, 'needs_response', { status: 'warning_needs_response', resolved_at: null });
        expect(blocked()).toBe(true);
        expect(markedDisputed()).toBe(true);
        expect(disputeAlerts()).toHaveLength(1);
        expect(JSON.parse(String(disputeAlerts()[0][1][4]))).toMatchObject({ escalatedBy: type });
        expect(keptStoredStatus()).toBe(false);
      }
    );

    it('treats an escalation with no earlier event as the first loss, not as an escalated inquiry', async () => {
      await deliver('charge.dispute.funds_withdrawn', 'needs_response');
      expect(blocked()).toBe(true);
      expect(disputeAlerts()).toHaveLength(1);
      expect(JSON.parse(String(disputeAlerts()[0][1][4]))).not.toHaveProperty('escalatedBy');
    });

    it('records a loss after an inquiry closed as stale: the network can no longer escalate it', async () => {
      await deliver('charge.dispute.updated', 'needs_response', { status: 'warning_closed', resolved_at: new Date() });
      expect(blocked()).toBe(false);
      expect(recordedOnly()).toBe('after_close');
    });

    it("does not keep a loss no order matched against an inquiry's event, so the next loss acts", async () => {
      await deliver('charge.dispute.created', 'warning_needs_response', { status: 'needs_response', resolved_at: null, user_id: null });
      expect(keptStoredStatus()).toBe(false);
      expect(blocked()).toBe(false);
    });

    it("updates the order's dispute status on a recorded event, unless the stored one stands", async () => {
      await deliver('charge.dispute.updated', 'under_review', { status: 'needs_response', resolved_at: null });
      expect(calls('UPDATE orders SET stripe_dispute_status = $2')[0][1]).toEqual(['order-1', 'under_review']);
      mocks.query.mockClear();
      await deliver('charge.dispute.updated', 'needs_response', { status: 'won', resolved_at: new Date() });
      expect(calls('UPDATE orders SET stripe_dispute_status = $2')).toHaveLength(0);
    });

    it('reads what it knew only after locking the order, which serialises one dispute\'s events', async () => {
      await deliver('charge.dispute.updated', 'needs_response', { status: 'warning_needs_response', resolved_at: null });
      const order = all().findIndex(([sql]) => sql.includes('SELECT * FROM orders'));
      const prior = all().findIndex(([sql]) => sql.includes('SELECT status, resolved_at, user_id FROM stripe_disputes'));
      const lock = all().findIndex(([sql]) => sql.includes('pg_advisory_xact_lock'));
      expect(order).toBeGreaterThan(-1);
      expect(prior).toBeGreaterThan(order);
      expect(lock).toBeGreaterThan(-1);
      expect(lock).toBeLessThan(prior);
      expect(all()[lock][1]).toEqual(['stripe_dispute:dp-1']);
    });

    it('acts on a loss recorded while no order matched, whose effects never ran', async () => {
      await deliver('charge.dispute.updated', 'under_review', { status: 'needs_response', resolved_at: null, user_id: null });
      expect(blocked()).toBe(true);
      expect(markedDisputed()).toBe(true);
    });

    it.each([
      ['charge.dispute.updated', 'under_review'],
      ['charge.dispute.funds_withdrawn', 'needs_response'],
      ['charge.dispute.created', 'needs_response']
    ])('records %s (%s) on a dispute already a loss, and repeats nothing', async (type, status) => {
      await deliver(type, status, { status: 'needs_response', resolved_at: null });
      expect(blocked()).toBe(false);
      expect(markedDisputed()).toBe(false);
      expect(disputeAlerts()).toHaveLength(0);
      expect(recordedOnly()).toBe('already_a_loss');
      expect(keptStoredStatus()).toBe(false);
    });

    it("keeps the chargeback's status when an inquiry's older event arrives after it", async () => {
      await deliver('charge.dispute.created', 'warning_needs_response', { status: 'needs_response', resolved_at: null });
      expect(blocked()).toBe(false);
      expect(recordedOnly()).toBe('already_a_loss');
      expect(keptStoredStatus()).toBe(true);
    });

    it('leaves an inquiry that is still an inquiry alone', async () => {
      await deliver('charge.dispute.updated', 'warning_under_review', { status: 'warning_needs_response', resolved_at: null });
      expect(blocked()).toBe(false);
      expect(markedDisputed()).toBe(false);
      expect(disputeAlerts()).toHaveLength(0);
      expect(recordedOnly()).toBe('still_an_inquiry');
    });

    it('still opens an inquiry as before', async () => {
      await deliver('charge.dispute.created', 'warning_needs_response');
      expect(blocked()).toBe(false);
      expect(markedDisputed()).toBe(true);
      expect(disputeAlerts()).toHaveLength(1);
    });

    it.each(['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.funds_withdrawn'])(
      'changes nothing for %s delivered after the dispute closed, and keeps its status',
      async type => {
        await deliver(type, 'needs_response', { status: 'won', resolved_at: new Date() });
        expect(blocked()).toBe(false);
        expect(disputeAlerts()).toHaveLength(0);
        expect(markedDisputed()).toBe(false);
        expect(recordedOnly()).toBe('after_close');
        expect(keptStoredStatus()).toBe(true);
      }
    );

    it('still acts on a losing close after an earlier one', async () => {
      await deliver('charge.dispute.closed', 'lost', { status: 'lost', resolved_at: new Date() });
      expect(blocked()).toBe(true);
      expect(keptStoredStatus()).toBe(false);
    });

    it('raises one unmatched alert per dispute, not one per update, and one for its close', async () => {
      await deliver('charge.dispute.created', 'needs_response', undefined, null);
      expect(alertsOfType('stripe_money_event_unmatched')).toHaveLength(1);
      mocks.query.mockClear();
      await deliver('charge.dispute.updated', 'under_review', { status: 'needs_response', resolved_at: null }, null);
      expect(alertsOfType('stripe_money_event_unmatched')).toHaveLength(0);
      expect(calls("SET processing_status = 'unmatched'")).toHaveLength(1);
      mocks.query.mockClear();
      await deliver('charge.dispute.closed', 'lost', { status: 'under_review', resolved_at: null }, null);
      expect(alertsOfType('stripe_money_event_unmatched')).toHaveLength(1);
    });

    it('alerts again when an unmatched inquiry becomes a chargeback, and not for its other updates', async () => {
      await deliver('charge.dispute.updated', 'needs_response', { status: 'warning_needs_response', resolved_at: null, user_id: null }, null);
      expect(alertsOfType('stripe_money_event_unmatched')).toHaveLength(1);
      mocks.query.mockClear();
      await deliver('charge.dispute.updated', 'warning_under_review', { status: 'warning_needs_response', resolved_at: null, user_id: null }, null);
      expect(alertsOfType('stripe_money_event_unmatched')).toHaveLength(0);
    });
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
      // send-block lookup, then the locked draft read.
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
    const eligibility = getSendEligibility(0, 2, { mailType: 'letter' });
    expect(eligibility).toMatchObject({
      payAndSend: {
        available: true,
        amountCents: 499,
        currency: 'usd'
      }
    });
    // prepaid{eligible,requiredCredits,availableCredits} is no longer served:
    // nothing read it, and it was the only place internal CREDIT units reached
    // a served schema. prepaidEligible is still computed internally - it is
    // what makes payAndSend.available true here, with a zero balance (#308).
    expect(eligibility).not.toHaveProperty('prepaid');
    mocks.jitEnabled.mockReturnValue(false);
    expect(getSendEligibility(0, 2, { mailType: 'letter' }).payAndSend).toMatchObject({
      available: false,
      unavailableReason: 'Pay & Send is not enabled.'
    });
  });

  it('kicks its own catalog warmup and serves a formatted display amount', async () => {
    // The accessor owns its warmup (a caller-by-convention kick left future
    // surfaces and the stdio lane silently unavailable), and it serves the
    // display string so widgets stop dividing minor units by 100 - which is
    // 100x wrong for zero-decimal currencies (#278 round 6).
    const eligibility = getSendEligibility(0, 2, { mailType: 'letter' });

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
      getSendEligibility(0, 2, { mailType: 'letter' });

      // Boot race: unpriced with NO recorded failure -> synthesized
      // not_resolved -> warn.
      mocks.describeUnpriced.mockReturnValue(null as never);
      mocks.getJitProduct.mockReturnValue({
        productCode: 'jit-letter', priceId: 'price-jit', amountCents: 0,
        currency: 'usd', name: 'Pay & Send', description: 'One letter'
      });
      getSendEligibility(0, 2, { mailType: 'letter' });

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

      expect(getSendEligibility(0, 2, { mailType: 'letter' }).payAndSend).toMatchObject({
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

  it('an unmatched partial refund raises a critical alert and moves nothing', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-partial' }] };
      }
      if (sql.includes('SELECT * FROM orders')) {
        return {
          rows: [
            {
              ...baseOrder,
              order_type: 'letter_pack',
              credits: 4,
              amount_cents: 1999,
              status: 'fulfilled'
            }
          ]
        };
      }
      if (sql.includes('INSERT INTO commerce_operational_alerts')) {
        return { rows: [{ alert_id: 'alert-1' }], rowCount: 1 };
      }
      return { rows: [] };
    });

    const result = await processStripeWebhookEvent({
      id: 'evt-partial',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch-1',
          payment_intent: 'pi-1',
          amount_refunded: 999
        }
      }
    } as any);

    // The order is reported exactly as it was found...
    expect(result).toMatchObject({ orderId: 'order-1', status: 'fulfilled' });
    // ...part of the money left through a refund the app did not issue, which
    // is operator work, so a critical alert is opened for the order...
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("'stripe_partial_refund_unmatched', 'critical'"),
      ['evt-partial', 'order-1', expect.stringContaining('"amountCents":999')]
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO commerce_order_events'),
      [
        'order-1',
        'charge.refunded',
        'fulfilled',
        'fulfilled',
        expect.stringContaining('"unmatchedPartialRefund":true')
      ]
    );
    // ...and no balance, ledger, entitlement, or order-status write happens.
    for (const forbidden of [
      'SET credits = GREATEST',
      'related_ledger_id',
      'UPDATE image_entitlements',
      'UPDATE orders'
    ]) {
      expect(mocks.query).not.toHaveBeenCalledWith(
        expect.stringContaining(forbidden),
        expect.anything()
      );
    }
  });

  it('folds the three events of one Dashboard partial refund into a single open alert', async () => {
    let openAlerts = 0;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-any' }] };
      }
      if (sql.includes('SELECT * FROM orders')) {
        return {
          rows: [
            {
              ...baseOrder,
              order_type: 'letter_pack',
              credits: 4,
              amount_cents: 1999,
              status: 'fulfilled'
            }
          ]
        };
      }
      if (sql.includes('SELECT alert_id') && sql.includes("'stripe_partial_refund_unmatched'")) {
        return openAlerts > 0 ? { rows: [{ alert_id: 'alert-1' }] } : { rows: [] };
      }
      if (sql.includes('INSERT INTO commerce_operational_alerts')) {
        openAlerts += 1;
        return { rows: [{ alert_id: 'alert-1' }], rowCount: 1 };
      }
      return { rows: [] };
    });

    const refund = {
      id: 're-partial',
      payment_intent: 'pi-1',
      charge: 'ch-1',
      status: 'succeeded',
      amount: 999
    };
    await processStripeWebhookEvent({
      id: 'evt-r1',
      type: 'refund.created',
      data: { object: refund }
    } as any);
    await processStripeWebhookEvent({
      id: 'evt-c1',
      type: 'charge.refunded',
      data: { object: { id: 'ch-1', payment_intent: 'pi-1', amount_refunded: 999 } }
    } as any);
    await processStripeWebhookEvent({
      id: 'evt-r2',
      type: 'refund.updated',
      data: { object: refund }
    } as any);

    const inserts = mocks.query.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO commerce_operational_alerts')
    );
    expect(inserts).toHaveLength(1);
    const folds = mocks.query.mock.calls.filter(([sql]) =>
      String(sql).includes("jsonb_set(details, '{events}'")
    );
    expect(folds).toHaveLength(2);
    expect(folds[1][1]).toEqual(['alert-1', expect.stringContaining('"eventType":"refund.updated"')]);
  });

  it('a full Dashboard refund after a proportional refund decrements lifetime purchases by the remainder only', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-remainder-after-partial' }] };
      }
      if (sql.includes('SELECT * FROM orders')) {
        return {
          rows: [
            {
              ...baseOrder,
              order_type: 'letter_pack',
              credits: 4,
              amount_cents: 500,
              status: 'fulfilled',
              // One letter (2 credits, 250 cents) already returned as cash.
              credits_refunded: 2,
              amount_refunded_cents: 250
            }
          ]
        };
      }
      if (sql.includes('SELECT ledger_id, initial_amount')) {
        return {
          rows: [
            {
              ledger_id: '00000000-0000-0000-0000-000000000004',
              initial_amount: 4,
              remaining_amount: 2,
              source_type: 'purchase'
            }
          ]
        };
      }
      if (sql.includes('UPDATE users')) return { rows: [{ credits: 0 }] };
      return { rows: [] };
    });

    // The Dashboard "refund remaining" arrives as a Refund for the remainder.
    await expect(
      processStripeWebhookEvent({
        id: 'evt-remainder-after-partial',
        type: 'refund.created',
        data: {
          object: {
            id: 're-remainder',
            payment_intent: 'pi-1',
            charge: 'ch-1',
            status: 'succeeded',
            amount: 250
          }
        }
      } as any)
    ).resolves.toMatchObject({ status: 'refunded' });

    // known (250) + this refund (250) completes the payment: the full path
    // runs, takes what is left, and lifetime spend drops by 4 - 2, not by 4.
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('SET credits = GREATEST'),
      [2, 2, 'user-1']
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("amount_refunded_cents = CASE WHEN $2::varchar = 'refunded' THEN amount_cents"),
      ['order-1', 'refunded', 're-remainder']
    );
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining("'stripe_partial_refund_unmatched'"),
      expect.anything()
    );
  });

  it('a refund.updated carrying the command id settles the command and adds to the confirmed figure', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-command' }] };
      }
      if (sql.includes('SELECT * FROM orders')) {
        return {
          rows: [{ ...baseOrder, order_type: 'letter_pack', credits: 4, amount_cents: 500, status: 'fulfilled' }]
        };
      }
      if (sql.includes('FROM commerce_pack_refunds WHERE pack_refund_id = $1')) {
        return {
          rows: [
            {
              pack_refund_id: 'pr-1',
              order_id: 'order-1',
              user_id: 'user-1',
              status: 'letters_revoked',
              letters: 1,
              credits: 2,
              amount_cents: 250,
              stripe_payment_intent_id: 'pi-1',
              stripe_refund_id: null
            }
          ]
        };
      }
      return { rows: [] };
    });

    await expect(
      processStripeWebhookEvent({
        id: 'evt-command',
        type: 'refund.updated',
        data: {
          object: {
            id: 're-cmd',
            payment_intent: 'pi-1',
            charge: 'ch-1',
            status: 'succeeded',
            amount: 250,
            metadata: { orderId: 'order-1', packRefundId: 'pr-1', lettersRefunded: '1' }
          }
        }
      } as any)
    ).resolves.toMatchObject({ orderId: 'order-1', status: 'fulfilled' });

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'succeeded', stripe_refund_id = $2"),
      ['pr-1', 're-cmd']
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('SET amount_refunded_cents = amount_refunded_cents + $2'),
      ['order-1', 250]
    );
    // Not an unmatched partial, not a full refund: nothing is revoked here.
    for (const forbidden of ["'stripe_partial_refund_unmatched'", 'SET credits = GREATEST', 'UPDATE orders\n       SET status']) {
      expect(mocks.query).not.toHaveBeenCalledWith(expect.stringContaining(forbidden), expect.anything());
    }
  });

  it('a refund.updated whose command id names a different order is an alert, not a settlement', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-mismatch' }] };
      }
      if (sql.includes('SELECT * FROM orders')) {
        return {
          rows: [{ ...baseOrder, order_type: 'letter_pack', credits: 4, amount_cents: 500, status: 'fulfilled' }]
        };
      }
      if (sql.includes('FROM commerce_pack_refunds WHERE pack_refund_id = $1')) {
        return {
          // Same payment intent and amount: the ORDER is the only thing that differs.
          rows: [{ pack_refund_id: 'pr-other', order_id: 'order-other', status: 'letters_revoked', amount_cents: 250, stripe_payment_intent_id: 'pi-1' }]
        };
      }
      return { rows: [] };
    });

    await processStripeWebhookEvent({
      id: 'evt-mismatch',
      type: 'refund.updated',
      data: {
        object: {
          id: 're-x',
          payment_intent: 'pi-1',
          charge: 'ch-1',
          status: 'succeeded',
          amount: 250,
          metadata: { packRefundId: 'pr-other' }
        }
      }
    } as any);

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("'stripe_partial_refund_unmatched', 'critical'"),
      ['evt-mismatch', 'order-1', expect.stringContaining('"reason":"command_mismatch"')]
    );
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'succeeded', stripe_refund_id = $2"),
      expect.anything()
    );
  });

  it('a second refund carrying a command that already names its refund is an alert, and leaves the command alone (#730)', async () => {
    for (const status of ['succeeded', 'stripe_pending']) {
      mocks.query.mockReset();
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) {
          return { rows: [{ event_id: 'evt-second' }] };
        }
        if (sql.includes('SELECT * FROM orders')) {
          return {
            rows: [{ ...baseOrder, order_type: 'letter_pack', credits: 4, amount_cents: 500, status: 'fulfilled' }]
          };
        }
        if (sql.includes('FROM commerce_pack_refunds WHERE pack_refund_id = $1')) {
          // Same order, payment intent and amount: only the refund differs.
          return {
            rows: [{ pack_refund_id: 'pr-1', order_id: 'order-1', status, amount_cents: 250, stripe_payment_intent_id: 'pi-1', stripe_refund_id: 're-first' }]
          };
        }
        return { rows: [] };
      });

      await processStripeWebhookEvent({
        id: 'evt-second',
        type: 'refund.updated',
        data: {
          object: {
            id: 're-second',
            payment_intent: 'pi-1',
            charge: 'ch-1',
            status: 'succeeded',
            amount: 250,
            metadata: { orderId: 'order-1', packRefundId: 'pr-1' }
          }
        }
      } as any);

      expect(mocks.query, status).toHaveBeenCalledWith(
        expect.stringContaining("'stripe_partial_refund_unmatched', 'critical'"),
        ['evt-second', 'order-1', expect.stringContaining('"reason":"another_refund"')]
      );
      expect(mocks.query, status).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE commerce_pack_refunds'), expect.anything());
    }
  });

  it('a charge.refunded within what the app already issued is a confirmation, not an alert', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-charge-confirm' }] };
      }
      if (sql.includes('SELECT * FROM orders')) {
        return {
          rows: [
            {
              ...baseOrder,
              order_type: 'letter_pack',
              credits: 4,
              amount_cents: 500,
              status: 'fulfilled',
              amount_refunded_cents: 250
            }
          ]
        };
      }
      return { rows: [] };
    });

    const result = await processStripeWebhookEvent({
      id: 'evt-charge-confirm',
      type: 'charge.refunded',
      data: { object: { id: 'ch-1', payment_intent: 'pi-1', amount_refunded: 250 } }
    } as any);

    expect(result).toMatchObject({ orderId: 'order-1', status: 'fulfilled' });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO commerce_order_events'),
      ['order-1', 'charge.refunded', 'fulfilled', 'fulfilled', expect.stringContaining('"chargePartialRefundConfirmed":true')]
    );
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining("'stripe_partial_refund_unmatched'"),
      expect.anything()
    );
  });
  it('parks a pending refund as refund_pending without revoking anything', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-pending' }] };
      }
      if (sql.includes('SELECT * FROM orders')) {
        return {
          rows: [
            {
              ...baseOrder,
              order_type: 'letter_pack',
              credits: 4,
              amount_cents: 1999,
              status: 'fulfilled'
            }
          ]
        };
      }
      return { rows: [] };
    });

    const result = await processStripeWebhookEvent({
      id: 'evt-pending',
      type: 'refund.created',
      data: {
        object: {
          id: 're-pending',
          payment_intent: 'pi-1',
          charge: 'ch-1',
          status: 'pending',
          amount: 1999
        }
      }
    } as any);

    expect(result).toMatchObject({ orderId: 'order-1', status: 'refund_pending' });
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('SET credits = GREATEST'),
      expect.anything()
    );
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('related_ledger_id'),
      expect.anything()
    );
    // The refund id is remembered on the order so the later success can be matched.
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE orders'),
      ['order-1', 'refund_pending', 're-pending']
    );
  });

  it('claws back only the unspent remainder of a refunded pack, never the letters already sent', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-remainder' }] };
      }
      if (sql.includes('SELECT * FROM orders')) {
        return {
          rows: [
            {
              ...baseOrder,
              order_type: 'letter_pack',
              credits: 4,
              amount_cents: 1999,
              status: 'fulfilled'
            }
          ]
        };
      }
      if (sql.includes('SELECT ledger_id, initial_amount')) {
        // Four credits bought (two letters); one letter already mailed.
        return {
          rows: [
            {
              ledger_id: '00000000-0000-0000-0000-000000000002',
              initial_amount: 4,
              remaining_amount: 2,
              source_type: 'purchase'
            }
          ]
        };
      }
      if (sql.includes('UPDATE users')) return { rows: [{ credits: 0 }] };
      return { rows: [] };
    });

    await expect(
      processStripeWebhookEvent({
        id: 'evt-remainder',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch-1',
            payment_intent: 'pi-1',
            amount_refunded: 1999
          }
        }
      } as any)
    ).resolves.toMatchObject({ status: 'refunded' });

    // The balance loses the 2 unspent credits; lifetime purchases lose the whole pack.
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('SET credits = GREATEST'),
      [2, 4, 'user-1']
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO credit_transactions'),
      ['user-1', -2, 0, 'order-1', expect.stringContaining('Revoked unused credits')]
    );
    // What was left is stamped on the audit row, so a later restore knows the figure.
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('related_ledger_id'),
      expect.arrayContaining([expect.stringContaining('"remaining_at_revocation":2')])
    );
    // A Charge event carries no refund id, so none is written.
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE orders'),
      ['order-1', 'refunded', null]
    );
  });

  it('refunds a fully spent pack to a zero balance without booking a negative movement', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-spent' }] };
      }
      if (sql.includes('SELECT * FROM orders')) {
        return {
          rows: [
            {
              ...baseOrder,
              order_type: 'letter_pack',
              credits: 4,
              amount_cents: 1999,
              status: 'fulfilled'
            }
          ]
        };
      }
      if (sql.includes('SELECT ledger_id, initial_amount')) {
        return {
          rows: [
            {
              ledger_id: '00000000-0000-0000-0000-000000000003',
              initial_amount: 4,
              remaining_amount: 0,
              source_type: 'purchase'
            }
          ]
        };
      }
      if (sql.includes('UPDATE users')) return { rows: [{ credits: 0 }] };
      return { rows: [] };
    });

    await expect(
      processStripeWebhookEvent({
        id: 'evt-spent',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch-1',
            payment_intent: 'pi-1',
            amount_refunded: 1999
          }
        }
      } as any)
    ).resolves.toMatchObject({ status: 'refunded' });

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('SET credits = GREATEST'),
      [0, 4, 'user-1']
    );
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO credit_transactions'),
      expect.anything()
    );
    // The lot is still revoked and audited, with nothing left to restore.
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'revoked'"),
      [['00000000-0000-0000-0000-000000000003']]
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('related_ledger_id'),
      expect.arrayContaining([expect.stringContaining('"remaining_at_revocation":0')])
    );
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

    await expect(requestRefund('order-1')).resolves.toBe(true);

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
      requestRefund('order-1'),
      requestRefund('order-1')
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect(mocks.findRefund).toHaveBeenCalledTimes(1);
    expect(mocks.createRefund).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("updated_at <= NOW() - ($3::int * INTERVAL '1 second')"),
      ['order-1', 5, 300]
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
    mocks.findRefund.mockResolvedValue({ live: { id: 're-recovered', status: 'pending' }, ended: null });

    await expect(requestRefund('order-1')).resolves.toBe(true);

    expect(mocks.findRefund).toHaveBeenCalledWith('pi-1', 'order-1', 499);
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  /**
   * #730: a refund that failed or was cancelled at Stripe holds the order for
   * a person. It used to be answered with another refund: one an operator
   * cancelled came back an hour later, and a failed one went to the same card.
   */
  describe('a refund that failed or was cancelled', () => {
    function claimedOrder(storedRefundId: string | null) {
      const statements: Array<{ sql: string; params: unknown[] }> = [];
      let claimed = false;
      mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
        statements.push({ sql: sql.replace(/\s+/g, ' '), params });
        if (sql.includes('WITH candidate AS')) {
          if (claimed) return { rows: [] };
          claimed = true;
          return {
            rows: [
              {
                ...baseOrder,
                status: 'refund_pending',
                refund_attempts: 2,
                previous_refund_attempts: 2,
                stripe_payment_intent_id: 'pi-1',
                stripe_refund_id: storedRefundId
              }
            ]
          };
        }
        if (sql.includes("ELSE 'REFUND_NOT_COMPLETED' END")) return { rows: [{ order_id: 'order-1' }], rowCount: 1 };
        if (sql.includes("'refund_not_completed'")) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });
      return statements;
    }

    it.each(['failed', 'canceled'])('holds the order when the stored refund is %s, and refunds nothing', async status => {
      const statements = claimedOrder('re-ended');
      mocks.retrieveRefund.mockResolvedValue({ id: 're-ended', status });

      await expect(requestRefund('order-1')).resolves.toBe(false);

      expect(mocks.createRefund).not.toHaveBeenCalled();
      const hold = statements.find(s => s.sql.includes("ELSE 'REFUND_NOT_COMPLETED' END"));
      // An amount-mismatch quarantine keeps its own code and message.
      expect(hold?.sql).toContain("last_error_code = CASE WHEN last_error_code = 'PAYMENT_AMOUNT_MISMATCH' THEN last_error_code ELSE 'REFUND_NOT_COMPLETED' END");
      expect(hold?.sql).toContain("last_error = CASE WHEN last_error_code = 'PAYMENT_AMOUNT_MISMATCH' THEN last_error");
      // Only while the order still names the refund the sweep read.
      expect(hold?.sql).toContain("WHERE order_id = $1 AND status = 'refund_pending' AND stripe_refund_id IS NOT DISTINCT FROM $2");
      expect(hold?.params).toEqual(['order-1', 're-ended']);
      const alert = statements.find(s => s.sql.includes("'refund_not_completed', 'critical'"));
      expect(alert?.params).toEqual(['order-1', JSON.stringify({ refundId: 're-ended', refundStatus: status })]);
      expect(statements.some(s => s.sql.includes('commerce_order_events') && s.params.includes('refund.not_completed'))).toBe(true);
    });

    it('holds the order when only the payment\'s refund list shows the ended refund', async () => {
      const statements = claimedOrder(null);
      mocks.findRefund.mockResolvedValue({ live: null, ended: { id: 're-dashboard', status: 'canceled' } });

      await expect(requestRefund('order-1')).resolves.toBe(false);

      expect(mocks.createRefund).not.toHaveBeenCalled();
      expect(statements.some(s => s.sql.includes("ELSE 'REFUND_NOT_COMPLETED' END"))).toBe(true);
    });

    describe('from the webhook', () => {
      function webhookStatements(orderStatus: string, storedRefundId: string | null = null) {
        const statements: Array<{ sql: string; params: unknown[] }> = [];
        const order = {
          ...baseOrder, order_type: 'letter_pack', product_code: 'credit-pack-4', draft_id: undefined,
          credits: 4, amount_cents: 500, currency: 'usd', status: orderStatus,
          stripe_payment_intent_id: 'pi-held', refund_attempts: 1, amount_refunded_cents: 0,
          stripe_refund_id: storedRefundId
        };
        mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
          statements.push({ sql: sql.replace(/\s+/g, ' '), params });
          if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-held' }], rowCount: 1 };
          if (sql.includes("ELSE 'REFUND_NOT_COMPLETED' END") && sql.includes('RETURNING order_id')) {
            return { rows: [{ order_id: 'order-1' }], rowCount: 1 };
          }
          if (sql.includes("'refund_not_completed', 'critical'")) return { rows: [], rowCount: 1 };
          if (sql.includes('FROM orders')) return { rows: [order], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        });
        return statements;
      }
      const event = (type: string, status: string) =>
        ({ id: 'evt-held', type, data: { object: { id: 're-dash', payment_intent: 'pi-held', charge: 'ch-held', amount: 500, status, metadata: {} } } }) as any;

      it.each(['failed', 'canceled'])('holds the order when a full refund comes back %s', async status => {
        const statements = webhookStatements('refund_pending');
        await processStripeWebhookEvent(event('refund.updated', status));
        const hold = statements.find(s => s.sql.includes("ELSE 'REFUND_NOT_COMPLETED' END"));
        expect(hold?.sql).toContain("WHERE order_id = $1 AND status = 'refund_pending' RETURNING");
        expect(hold?.params).toEqual(['order-1']);
        const alert = statements.find(s => s.sql.includes("'refund_not_completed', 'critical'"));
        expect(alert?.params).toEqual(['order-1', JSON.stringify({ refundId: 're-dash', refundStatus: status })]);
      });

      it('holds nothing for a refund still going', async () => {
        const statements = webhookStatements('refund_pending');
        await processStripeWebhookEvent(event('refund.updated', 'pending'));
        expect(statements.some(s => s.sql.includes("ELSE 'REFUND_NOT_COMPLETED' END"))).toBe(false);
      });

      function expectReleased(statements: Array<{ sql: string; params: unknown[] }>) {
        const cleared = statements.find(s => s.sql.includes('SET last_error_code = NULL, last_error = NULL'));
        expect(cleared?.sql).toContain("WHERE order_id = $1 AND last_error_code = 'REFUND_NOT_COMPLETED'");
        expect(cleared?.params).toEqual(['order-1']);
        // The alert stays open for a person: the completing event may be a stale one.
        expect(statements.some(s => s.sql.includes('commerce_operational_alerts') && s.sql.includes("status = 'resolved'"))).toBe(false);
      }

      it('clears the hold\'s code once the order is refunded, and leaves its alert for a person', async () => {
        const statements = webhookStatements('refund_pending');
        await processStripeWebhookEvent(event('refund.created', 'succeeded'));
        expectReleased(statements);
        expect(statements.some(s => s.sql.includes("ELSE 'REFUND_NOT_COMPLETED' END"))).toBe(false);
      });

      it('holds on a failure whichever refund the order named, since Stripe sends a refund\'s events in no set order', async () => {
        const statements = webhookStatements('refund_pending', 're-other');
        await processStripeWebhookEvent(event('refund.updated', 'failed'));
        expect(statements.some(s => s.sql.includes("ELSE 'REFUND_NOT_COMPLETED' END"))).toBe(true);
      });

    });

    it('clears a hold\'s code when the sweep finishes the refund itself', async () => {
      const statements = claimedOrder(null);
      mocks.findRefund.mockResolvedValue({ live: { id: 're-live', status: 'succeeded' }, ended: null });
      mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
        statements.push({ sql: sql.replace(/\s+/g, ' '), params });
        if (sql.includes('WITH candidate AS')) {
          return { rows: [{ ...baseOrder, status: 'refund_pending', refund_attempts: 1, previous_refund_attempts: 1, stripe_payment_intent_id: 'pi-1' }] };
        }
        if (sql.includes('SET stripe_refund_id = $2')) return { rows: [{ order_id: 'order-1' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });
      await expect(requestRefund('order-1')).resolves.toBe(true);
      const cleared = statements.find(s => s.sql.includes('SET last_error_code = NULL, last_error = NULL'));
      expect(cleared?.params).toEqual(['order-1']);
    });

    it('adopts a live refund over an ended one', async () => {
      claimedOrder('re-ended');
      mocks.retrieveRefund.mockResolvedValue({ id: 're-ended', status: 'failed' });
      mocks.findRefund.mockResolvedValue({ live: { id: 're-live', status: 'pending' }, ended: null });

      await expect(requestRefund('order-1')).resolves.toBe(true);
      expect(mocks.createRefund).not.toHaveBeenCalled();
    });

    it('makes a new attempt when the stored refund cannot be read and Stripe lists none', async () => {
      mocks.query
        .mockResolvedValueOnce({
          rows: [{ ...baseOrder, status: 'refund_pending', refund_attempts: 2, stripe_payment_intent_id: 'pi-1', stripe_refund_id: 're-stale' }]
        })
        .mockResolvedValueOnce({ rows: [{ refund_attempts: 3 }] });
      mocks.retrieveRefund.mockRejectedValue(new Error('No such refund'));
      mocks.createRefund.mockResolvedValue({ id: 're-new', status: 'pending' });

      await expect(requestRefund('order-1')).resolves.toBe(true);
      expect(mocks.createRefund).toHaveBeenCalledWith('pi-1', 'order-1', 3);
    });

    it('passes no amount for an order whose amount is not known', async () => {
      mocks.query.mockResolvedValueOnce({
        rows: [{ ...baseOrder, amount_known: false, status: 'refund_pending', refund_attempts: 1, previous_refund_attempts: 0, stripe_payment_intent_id: 'pi-1' }]
      });
      mocks.createRefund.mockResolvedValue({ id: 're-new', status: 'pending' });
      await requestRefund('order-1');
      expect(mocks.findRefund).toHaveBeenCalledWith('pi-1', 'order-1', null);
    });

    it('is skipped by the claim (the sweep: see the quarantine tests)', async () => {
      const statements = claimedOrder(null);
      await requestRefund('order-1');
      expect(statements[0].sql).toContain("last_error_code NOT IN ('PAYMENT_AMOUNT_MISMATCH', 'REFUND_NOT_COMPLETED')");
    });
  });

  /**
   * Issue #394. The three catches that stored error.message, the refund event
   * that copied a "reason" through, and the sweep that read last_error back to
   * pass it in. Every stored value is a class; no parameter may carry a
   * fragment of the message.
   */
  describe('error text minimisation (#394)', () => {
    const paramsRecorded = () => JSON.stringify(mocks.query.mock.calls.map(([, params]) => params));
    const eventInsert = (type: string) =>
      mocks.query.mock.calls.find(
        ([sql, params]) =>
          String(sql).includes('INSERT INTO commerce_order_events') && (params as unknown[])?.[1] === type
      );

    it.each([
      [
        'a draft check carrying its code',
        Object.assign(new Error('Draft draft-1 does not belong to this user'), {
          code: 'DRAFT_NOT_OWNED',
          diagnosticClass: 'DRAFT_NOT_OWNED'
        }),
        'DRAFT_NOT_OWNED'
      ],
      ['a plain error', new Error('relation "letters_secret" does not exist'), 'database_error'],
      ['a non-error throw', 'boom secret', 'unknown_error']
    ])('stores a class, never the message, when JIT fulfilment is rejected by %s', async (_label, thrown, expected) => {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-1' }] };
        if (sql.includes('SELECT * FROM orders')) return { rows: [baseOrder] };
        return { rows: [] };
      });
      mocks.createMail.mockRejectedValueOnce(thrown);

      await expect(processStripeWebhookEvent(checkoutEvent())).resolves.toMatchObject({ duplicate: false });

      const rejection = mocks.query.mock.calls.find(([sql]) =>
        String(sql).includes("last_error_code = 'JIT_FULFILLMENT_REJECTED'")
      );
      expect(rejection).toBeDefined();
      expect(rejection![1]).toEqual(['order-1', expected]);
      const event = eventInsert('jit.fulfillment_rejected');
      expect(event).toBeDefined();
      expect((event![1] as unknown[])[4]).toBe(JSON.stringify({ errorClass: expected }));
      expect(paramsRecorded()).not.toContain('secret');
      expect(paramsRecorded()).not.toContain('does not belong');
    });

    it('locks the order\'s draft before the order when recovering it, as every path does (#730)', async () => {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.startsWith('SELECT * FROM orders WHERE order_id = $1')) {
          return { rows: [{ ...baseOrder, status: 'paid' }] };
        }
        return { rows: [] };
      });
      mocks.createMail.mockRejectedValueOnce(Object.assign(new Error('stop here'), { code: 'DRAFT_EXPIRED' }));

      await fulfillPaidOrder('order-1');

      const statements = mocks.query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' '));
      const draftLock = statements.indexOf('SELECT draft_id FROM letter_drafts WHERE draft_id = $1 FOR NO KEY UPDATE');
      const orderLock = statements.indexOf('SELECT * FROM orders WHERE order_id = $1 FOR UPDATE');
      expect(statements[0]).toBe('SELECT * FROM orders WHERE order_id = $1');
      expect(draftLock).toBeGreaterThan(0);
      expect(orderLock).toBeGreaterThan(draftLock);
      expect(mocks.query.mock.calls[draftLock][1]).toEqual([baseOrder.draft_id]);
    });

    it('stores a class, never the message, when recovery of a paid order is rejected', async () => {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.startsWith('SELECT * FROM orders WHERE order_id = $1')) {
          return { rows: [{ ...baseOrder, status: 'paid' }] };
        }
        return { rows: [] };
      });
      mocks.createMail.mockRejectedValueOnce(
        Object.assign(new Error('Draft expired: draft-1'), { code: 'DRAFT_EXPIRED', diagnosticClass: 'DRAFT_EXPIRED' })
      );

      await expect(fulfillPaidOrder('order-1')).resolves.toBe(false);

      const failure = mocks.query.mock.calls.find(([sql]) => String(sql).includes("last_error_code = 'RECOVERY_FAILED'"));
      expect(failure).toBeDefined();
      expect(failure![1]).toEqual(['order-1', 'DRAFT_EXPIRED']);
      const event = eventInsert('maintenance.fulfillment_failed');
      expect(event).toBeDefined();
      expect((event![1] as unknown[])[4]).toBe(JSON.stringify({ errorClass: 'DRAFT_EXPIRED' }));
      expect(paramsRecorded()).not.toContain('Draft expired');
    });

    it('refunds a paid order whose draft is no longer the mail it paid for, as recovery finds it (#586)', async () => {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.startsWith('SELECT * FROM orders WHERE order_id = $1')) {
          return { rows: [{ ...baseOrder, status: 'paid' }] };
        }
        return { rows: [] };
      });
      mocks.createMail.mockRejectedValueOnce(
        Object.assign(new Error("Order order-1 paid for jit-letter, not draft draft-1's mail"), {
          code: 'JIT_PRODUCT_MISMATCH',
          diagnosticClass: 'JIT_PRODUCT_MISMATCH'
        })
      );

      await expect(fulfillPaidOrder('order-1')).resolves.toBe(false);

      const failure = mocks.query.mock.calls.find(([sql]) => String(sql).includes("last_error_code = 'RECOVERY_FAILED'"));
      expect(String(failure![0])).toContain("status = 'refund_pending'");
      expect(failure![1]).toEqual(['order-1', 'JIT_PRODUCT_MISMATCH']);
      expect(paramsRecorded()).not.toContain('paid for jit-letter');
    });

    it('labels an unclassified recovery failure database_error, the savepoint fallback', async () => {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.startsWith('SELECT * FROM orders WHERE order_id = $1')) {
          return { rows: [{ ...baseOrder, status: 'paid' }] };
        }
        return { rows: [] };
      });
      mocks.createMail.mockRejectedValueOnce(new Error('relation "letters_secret" does not exist'));

      await expect(fulfillPaidOrder('order-1')).resolves.toBe(false);

      const failure = mocks.query.mock.calls.find(([sql]) => String(sql).includes("last_error_code = 'RECOVERY_FAILED'"));
      expect(failure![1]).toEqual(['order-1', 'database_error']);
      expect((eventInsert('maintenance.fulfillment_failed')![1] as unknown[])[4]).toBe(JSON.stringify({ errorClass: 'database_error' }));
      expect(paramsRecorded()).not.toContain('secret');
    });

    it.each([
      [
        'an allowlisted Stripe code',
        Object.assign(new Error('No such payment_intent: pi-1 on acct_secret'), {
          type: 'StripeInvalidRequestError',
          code: 'resource_missing'
        }),
        'resource_missing'
      ],
      [
        'a Stripe type without a code',
        Object.assign(new Error('socket hang up at acct_secret'), { type: 'StripeConnectionError' }),
        'StripeConnectionError'
      ],
      ['a plain error', new Error('relation "orders_secret" does not exist'), 'unknown_error']
    ])('stores a class, never the message, when the refund request fails with %s', async (_label, thrown, expected) => {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('WITH candidate AS')) {
          return {
            rows: [
              {
                ...baseOrder,
                status: 'refund_pending',
                refund_attempts: 1,
                previous_refund_attempts: 0,
                stripe_payment_intent_id: 'pi-1',
                stripe_refund_id: null
              }
            ]
          };
        }
        return { rows: [] };
      });
      mocks.findRefund.mockResolvedValue({ live: null, ended: null });
      mocks.createRefund.mockRejectedValueOnce(thrown);

      await expect(requestRefund('order-1')).resolves.toBe(false);

      const failure = mocks.query.mock.calls.find(([sql]) => String(sql).includes("last_error_code = 'REFUND_REQUEST_FAILED'"));
      expect(failure).toBeDefined();
      expect(failure![1]).toEqual(['order-1', expected]);
      expect(paramsRecorded()).not.toContain('secret');
    });

    it('prefers a class a lower layer attached when the refund request fails', async () => {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('WITH candidate AS')) {
          return {
            rows: [{ ...baseOrder, status: 'refund_pending', refund_attempts: 1, previous_refund_attempts: 0, stripe_payment_intent_id: 'pi-1', stripe_refund_id: null }]
          };
        }
        return { rows: [] };
      });
      mocks.findRefund.mockResolvedValue({ live: null, ended: null });
      mocks.createRefund.mockRejectedValueOnce(
        Object.assign(new Error('Price price_secret is not configured'), { type: 'StripeInvalidRequestError', code: 'resource_missing', diagnosticClass: 'configuration_error' })
      );

      await expect(requestRefund('order-1')).resolves.toBe(false);

      const failure = mocks.query.mock.calls.find(([sql]) => String(sql).includes("last_error_code = 'REFUND_REQUEST_FAILED'"));
      expect(failure![1]).toEqual(['order-1', 'configuration_error']);
      expect(paramsRecorded()).not.toContain('secret');
    });

    it('records the refund id and the order error code on refund.requested, and claims without a reason', async () => {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('WITH candidate AS')) {
          return {
            rows: [
              {
                ...baseOrder,
                status: 'refund_pending',
                refund_attempts: 1,
                previous_refund_attempts: 0,
                stripe_payment_intent_id: 'pi-1',
                last_error_code: 'JIT_FULFILLMENT_REJECTED',
                last_error: 'DRAFT_EXPIRED'
              }
            ]
          };
        }
        if (sql.includes('SET stripe_refund_id = $2')) return { rows: [{ order_id: 'order-1' }] };
        return { rows: [] };
      });
      mocks.findRefund.mockResolvedValue({ live: null, ended: null });
      mocks.createRefund.mockResolvedValue({ id: 're-1', status: 'pending' });

      await expect(requestRefund('order-1')).resolves.toBe(true);

      const claim = mocks.query.mock.calls.find(([sql]) => String(sql).includes('WITH candidate AS'));
      expect(claim).toBeDefined();
      expect(String(claim![0])).not.toMatch(/last_error = /);
      expect(claim![1]).toEqual(['order-1', 5, 300]);
      const event = eventInsert('refund.requested');
      expect(event).toBeDefined();
      expect((event![1] as unknown[])[4]).toBe(JSON.stringify({ refundId: 're-1', lastErrorCode: 'JIT_FULFILLMENT_REJECTED' }));
      expect(paramsRecorded()).not.toContain('reason');
    });

    it('selects only the order id for the refund sweep and asks for each refund by id alone', async () => {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes("status = 'refund_pending'") && sql.includes('refund_attempts < $2')) {
          return { rows: [{ order_id: 'order-1' }] };
        }
        return { rows: [] };
      });
      mocks.retrieveSession.mockResolvedValue(null);

      await runCommerceMaintenance();

      const sweep = mocks.query.mock.calls
        .map(([sql]) => String(sql))
        .find(sql => sql.includes("status = 'refund_pending'") && sql.includes('refund_attempts < $2'));
      expect(sweep).toBeDefined();
      expect(sweep!.replace(/\s+/g, ' ')).toMatch(/^SELECT order_id FROM orders WHERE/);
      expect(sweep).not.toContain('last_error FROM');
      const claim = mocks.query.mock.calls.find(([sql]) => String(sql).includes('WITH candidate AS'));
      expect(claim).toBeDefined();
      expect(claim![1]).toEqual(['order-1', 5, 300]);
    });
  });
  describe('a retry that would send Stripe a different request (#279)', () => {
    // A retry of a sessionless order re-sends that order's idempotency key,
    // and Stripe refuses a key it has seen with different parameters rather
    // than replaying it. The refusal is not terminal, so the order stayed
    // checkout_pending and blocked the draft until its window ran out. The
    // order now records the request it depends on, and is reused only when a
    // retry would send the same one.
    const RETURN_BASE = 'https://return.test/purchase/return';
    const request = (orderId: string, extra: Record<string, string> = {}) => ({
      priceId: 'price-jit-letter',
      successUrl: `${RETURN_BASE}?outcome=success&order_id=${orderId}&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${RETURN_BASE}?outcome=cancelled&order_id=${orderId}`,
      ...extra
    });
    /** The draft's sessionless order, recorded with `stripeRequest` (none for an order from before #279). */
    const sessionless = (stripeRequest?: Record<string, string>) => ({
      ...baseOrder,
      product_snapshot: { ...baseOrder.product_snapshot, ...(stripeRequest ? { stripeRequest } : {}) },
      stripe_checkout_session_id: null,
      checkout_url: null,
      checkout_expires_at: new Date(Date.now() + 45 * 60_000)
    });
    const cancels = (code: string) =>
      mocks.query.mock.calls.filter(([sql]) => String(sql).includes(`last_error_code = '${code}'`));
    const inserts = () => mocks.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO orders'));

    let active: Record<string, unknown>[];
    beforeEach(() => {
      vi.stubEnv('JIT_CHECKOUT_RETURN_URL', RETURN_BASE);
      active = [];
      mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('sends_blocked_reason')) return { rows: [{ sends_blocked_reason: null }] };
        if (sql.includes('SELECT mail_type, postcard_size, pages, mail_service FROM letter_drafts')) {
          return { rows: [{ mail_type: 'letter', postcard_size: null, pages: 1, mail_service: 'standard' }] };
        }
        if (sql.includes('SELECT * FROM letter_drafts')) {
          return {
            rows: [{
              draft_id: 'draft-1', user_id: 'user-1', mail_type: 'letter', required_credits: 2,
              status: 'pending', expires_at: new Date(Date.now() + 6 * 60 * 60_000)
            }]
          };
        }
        if (sql.includes('status = ANY($2::varchar[])')) return { rows: active };
        if (sql.includes('SELECT credits FROM users')) return { rows: [{ credits: 0 }] };
        if (sql.includes('INSERT INTO orders')) {
          return {
            rows: [{
              ...baseOrder, order_id: params[0], product_snapshot: JSON.parse(String(params[4])),
              idempotency_key: params[7], checkout_expires_at: params[8]
            }]
          };
        }
        if (sql.includes('SET stripe_checkout_session_id = $2')) {
          return {
            rows: [{ ...baseOrder, order_id: params[0], stripe_checkout_session_id: params[1], checkout_url: params[2] }]
          };
        }
        if (sql.startsWith('SELECT * FROM orders WHERE order_id = $1')) {
          return { rows: [{ ...baseOrder, order_id: params[0] }] };
        }
        return { rows: [] };
      });
      mocks.createJitSession.mockResolvedValue({
        success: true,
        sessionId: 'cs-new',
        sessionUrl: 'https://checkout.stripe.test/cs-new',
        expiresAt: new Date(Date.now() + 40 * 60_000)
      });
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('records the Price and return URLs a new order sends Stripe', async () => {
      await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' });

      expect(inserts()).toHaveLength(1);
      const [orderId, , , , snapshot, , , key] = inserts()[0][1] as unknown[];
      expect(JSON.parse(String(snapshot)).stripeRequest).toEqual(request(String(orderId)));
      // What was recorded is what was sent, under the new order's own key.
      expect(mocks.createJitSession).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId,
          successUrl: request(String(orderId)).successUrl,
          cancelUrl: request(String(orderId)).cancelUrl,
          idempotencyKey: key
        })
      );
      expect(mocks.createJitSession.mock.calls[0][0].product.priceId).toBe('price-jit-letter');
    });

    it('reuses a sessionless order, and its key, when the retry sends the same request', async () => {
      active = [sessionless(request('order-1'))];

      const result = await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' });

      expect(result).toMatchObject({ orderId: 'order-1', reused: true });
      expect(inserts()).toHaveLength(0);
      expect(cancels('PRICE_CHANGED_BEFORE_SESSION')).toHaveLength(0);
      expect(cancels('CHECKOUT_REQUEST_CHANGED_BEFORE_SESSION')).toHaveLength(0);
      expect(mocks.createJitSession).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: 'order-1', idempotencyKey: 'jit-checkout:order-1' })
      );
    });

    it('cancels a sessionless order whose Price was repointed at the same amount, and opens a fresh one', async () => {
      active = [sessionless(request('order-1', { priceId: 'price-jit-letter-old' }))];

      await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' });

      const [cancel] = cancels('PRICE_CHANGED_BEFORE_SESSION');
      expect(cancel?.[1]).toEqual(['order-1', 'Configured price changed before a session was opened']);
      expect(cancels('CHECKOUT_REQUEST_CHANGED_BEFORE_SESSION')).toHaveLength(0);
      expect(inserts()).toHaveLength(1);
      const [orderId, , , , , , , key] = inserts()[0][1] as unknown[];
      expect(orderId).not.toBe('order-1');
      // A fresh key: the spent one is never sent with the new Price.
      expect(key).toBe(`jit-checkout:${String(orderId)}`);
      expect(mocks.createJitSession).toHaveBeenCalledTimes(1);
      expect(mocks.createJitSession.mock.calls[0][0].idempotencyKey).toBe(key);
    });

    it('cancels a sessionless order whose return URLs moved with their configuration', async () => {
      active = [
        sessionless(
          request('order-1', {
            successUrl: 'https://old.test/purchase/return?outcome=success&order_id=order-1&session_id={CHECKOUT_SESSION_ID}'
          })
        )
      ];

      await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' });

      const [cancel] = cancels('CHECKOUT_REQUEST_CHANGED_BEFORE_SESSION');
      expect(cancel?.[1]).toEqual(['order-1', 'Checkout return address changed before a session was opened']);
      expect(cancels('PRICE_CHANGED_BEFORE_SESSION')).toHaveLength(0);
      expect(inserts()).toHaveLength(1);
      expect(mocks.createJitSession.mock.calls[0][0].idempotencyKey).not.toBe('jit-checkout:order-1');

      // The cancel URL alone moving counts the same.
      vi.clearAllMocks();
      active = [
        sessionless(request('order-1', { cancelUrl: 'https://old.test/purchase/return?outcome=cancelled&order_id=order-1' }))
      ];
      await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' });
      expect(cancels('CHECKOUT_REQUEST_CHANGED_BEFORE_SESSION')).toHaveLength(1);
    });

    it('names a changed Price over changed URLs when both moved', async () => {
      active = [
        sessionless(request('order-1', { priceId: 'price-jit-letter-old', successUrl: 'https://old.test/x' }))
      ];

      await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' });

      expect(cancels('PRICE_CHANGED_BEFORE_SESSION')).toHaveLength(1);
      expect(cancels('CHECKOUT_REQUEST_CHANGED_BEFORE_SESSION')).toHaveLength(0);
    });

    it('judges an order from before the request was recorded on amount and currency, as before', async () => {
      active = [sessionless()];

      const result = await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' });

      expect(result).toMatchObject({ orderId: 'order-1', reused: true });
      expect(inserts()).toHaveLength(0);
    });

    it('records the change in the order history', async () => {
      active = [sessionless(request('order-1', { successUrl: 'https://old.test/x' }))];

      await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' });

      const event = mocks.query.mock.calls.find(
        ([sql, params]) => String(sql).includes('INSERT INTO commerce_order_events') &&
          (params as unknown[])?.[0] === 'order-1' &&
          (params as unknown[])?.[1] === 'checkout.request_changed_locally'
      );
      expect(event).toBeDefined();
    });

    describe('a checkout opened from the confirmation page (#579)', () => {
      const PAGE = {
        successUrl: 'https://site.example/confirm/draft-1?paid=1',
        cancelUrl: 'https://site.example/confirm/draft-1?paid=0'
      };

      it('returns the person to the page, as the new order records', async () => {
        await createJitCheckout({ userId: 'user-1', draftId: 'draft-1', returnTo: PAGE });

        expect(inserts()).toHaveLength(1);
        const [, , , , snapshot] = inserts()[0][1] as unknown[];
        expect(JSON.parse(String(snapshot)).stripeRequest).toEqual({ priceId: 'price-jit-letter', ...PAGE });
        expect(mocks.createJitSession).toHaveBeenCalledWith(expect.objectContaining(PAGE));
      });

      it("reuses the page's own sessionless order when the page retries", async () => {
        active = [sessionless({ priceId: 'price-jit-letter', ...PAGE })];

        const result = await createJitCheckout({ userId: 'user-1', draftId: 'draft-1', returnTo: PAGE });

        expect(result).toMatchObject({ orderId: 'order-1', reused: true });
        expect(inserts()).toHaveLength(0);
        expect(mocks.createJitSession).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order-1', ...PAGE }));
      });

      it('opens a fresh order when the page retries one an app began, as for a changed return address', async () => {
        active = [sessionless(request('order-1'))];

        await createJitCheckout({ userId: 'user-1', draftId: 'draft-1', returnTo: PAGE });

        expect(cancels('CHECKOUT_REQUEST_CHANGED_BEFORE_SESSION')).toHaveLength(1);
        expect(inserts()).toHaveLength(1);
        expect(mocks.createJitSession).toHaveBeenCalledWith(expect.objectContaining(PAGE));
      });
    });
  });

  describe('the duplicate check before a new checkout (#412)', () => {
    const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
    const mail = (extra: Record<string, unknown> = {}) => ({
      mail_type: 'letter',
      layout_type: 'text_only',
      postcard_size: null,
      sender: { name: 'Dee', addressLine1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '62701' },
      recipient: { name: 'Sam Rivera', addressLine1: '350 5th Ave', city: 'New York', state: 'NY', postalCode: '10118' },
      body_text: 'Hi Sam',
      sign_off: 'Best',
      header_image_md5: EMPTY_MD5,
      inline_image_md5: EMPTY_MD5,
      front_image_md5: EMPTY_MD5,
      age_seconds: 300,
      ...extra
    });
    const tagged = (label: string) => dupState.calls.filter(call => call.sql.includes(`duplicate mail check: ${label}`));
    const pendingDraft = (extra: Record<string, unknown> = {}) => ({
      draft_id: 'draft-1', user_id: 'user-1', mail_type: 'letter',
      required_credits: 2, status: 'pending',
      expires_at: new Date(Date.now() + 6 * 60 * 60_000),
      ...extra
    });
    /** The draft's current order, sessionless and at today's price unless a test says otherwise. */
    const currentOrder = (extra: Record<string, unknown> = {}) => ({
      ...baseOrder,
      stripe_checkout_session_id: null,
      checkout_url: null,
      checkout_expires_at: new Date(Date.now() + 45 * 60_000),
      ...extra
    });
    const INSERT = 'INSERT INTO orders';
    const inserted = () => mocks.query.mock.calls.some(([sql]) => String(sql).includes(INSERT));

    let draftRow: Record<string, unknown>;
    let activeRows: Record<string, unknown>[];
    let credits: number;
    let trail: string[];
    /** Where the first statement containing `fragment` ran. Throws when none did, so an order check cannot pass on -1. */
    const position = (fragment: string) => {
      const index = trail.findIndex(sql => sql.includes(fragment));
      if (index < 0) throw new Error(`no statement ran containing: ${fragment}`);
      return index;
    };

    beforeEach(() => {
      draftRow = pendingDraft();
      activeRows = [];
      credits = 0;
      trail = [];
      dupState.trail = trail;
      dupState.draft = mail();
      mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('sends_blocked_reason')) return { rows: [{ sends_blocked_reason: null }] };
        // The peek before the transaction reads the draft's option (#578), with its pages (#586).
        if (sql.includes('SELECT mail_type, postcard_size, pages, mail_service FROM letter_drafts')) {
          return { rows: [{ mail_type: draftRow.mail_type, postcard_size: draftRow.postcard_size ?? null, pages: draftRow.pages ?? 1, mail_service: draftRow.mail_service ?? 'standard' }] };
        }
        if (sql.includes('SELECT * FROM letter_drafts')) return { rows: [draftRow] };
        if (sql.includes('status = ANY($2::varchar[])')) return { rows: activeRows };
        if (sql.includes('SELECT credits FROM users')) return { rows: [{ credits }] };
        if (sql.includes(INSERT)) {
          return { rows: [{ ...baseOrder, order_id: params[0], checkout_expires_at: params[8] }] };
        }
        if (sql.includes('SET stripe_checkout_session_id = $2')) {
          return {
            rows: [{ ...baseOrder, order_id: params[0], stripe_checkout_session_id: params[1], checkout_url: params[2] }]
          };
        }
        if (sql.startsWith('SELECT * FROM orders WHERE order_id = $1')) {
          return { rows: [{ ...baseOrder, order_id: params[0] }] };
        }
        return { rows: [] };
      });
      mocks.createJitSession.mockResolvedValue({
        success: true,
        sessionId: 'cs-new',
        sessionUrl: 'https://checkout.stripe.test/cs-new',
        expiresAt: new Date(Date.now() + 40 * 60_000)
      });
    });

    it('refuses the same mail sent in the last day, as the last step before a new order', async () => {
      dupState.letters = [mail()];

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).rejects.toMatchObject({
        code: 'DUPLICATE_RECENT_MAIL',
        duplicate: { kind: 'sent', recipientName: 'Sam Rivera', ageSeconds: 300 }
      });

      expect(inserted()).toBe(false);
      expect(mocks.createJitSession).not.toHaveBeenCalled();
      // Thrown out of the order transaction, which the real one rolls back.
      expect(mocks.transaction).toHaveBeenCalledTimes(1);
      await expect(mocks.transaction.mock.results[0].value).rejects.toMatchObject({ code: 'DUPLICATE_RECENT_MAIL' });
      // After the draft lock, the look for an order to reuse, and the balance.
      const check = position('duplicate mail check: draft');
      expect(position('SELECT * FROM letter_drafts WHERE draft_id = $1 FOR NO KEY UPDATE')).toBeLessThan(check);
      expect(position('status = ANY($2::varchar[])')).toBeLessThan(check);
      expect(position('SELECT credits FROM users')).toBeLessThan(check);
      expect(tagged('draft')[0].params).toEqual(['draft-1', 'user-1']);
      expect(tagged('letters')[0].params).toEqual(['user-1', 'letter', '']);
      expect(tagged('orders')[0].params).toEqual(['user-1', 'draft-1', 'letter']);
    });

    it('refuses while a checkout for the same mail is still open', async () => {
      dupState.orders = [mail({ status: 'checkout_pending' })];

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).rejects.toMatchObject({
        code: 'DUPLICATE_RECENT_MAIL',
        duplicate: { kind: 'checkout_open' }
      });
      expect(inserted()).toBe(false);
    });

    it('opens a checkout for different mail', async () => {
      dupState.letters = [mail({ body_text: 'Hi Sam, again' })];

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).resolves.toMatchObject({
        success: true,
        reused: false,
        checkoutUrl: 'https://checkout.stripe.test/cs-new'
      });

      expect(tagged('letters')).toHaveLength(1);
      expect(position('duplicate mail check: orders')).toBeLessThan(position(INSERT));
      expect(mocks.createJitSession).toHaveBeenCalledTimes(1);
    });

    it('checks the mail caps again inside the transaction once the order is a row, under their locks (#730)', async () => {
      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).resolves.toMatchObject({ success: true, reused: false });

      const firstLock = position('pg_advisory_xact_lock(hashtext($1), hashtext($2))');
      // The early answer, before the transaction, counts letters alone and takes no lock.
      expect(position('COUNT(*) AS count FROM letters')).toBeLessThan(position(INSERT));
      expect(position(INSERT)).toBeLessThan(firstLock);
      expect(firstLock).toBeLessThan(position('UNION ALL'));
    });

    it('refuses the place an open checkout already holds, before any Stripe session (#730)', async () => {
      vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP', '3');
      capState.lettersTodayForUser = 2;
      // Another open checkout today, and this one once inserted.
      capState.openToday = 2;
      try {
        await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).rejects.toMatchObject({
          code: 'ACCOUNT_DAILY_MAIL_CAP'
        });
        expect(mocks.createJitSession).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('buys another copy when the person asked, without checking', async () => {
      dupState.letters = [mail()];

      await expect(
        createJitCheckout({ userId: 'user-1', draftId: 'draft-1', allowDuplicate: true })
      ).resolves.toMatchObject({ success: true, reused: false });

      expect(dupState.calls).toEqual([]);
      expect(inserted()).toBe(true);
    });

    it.each<[string, Record<string, unknown>]>([
      ['that already has a session', {
        stripe_checkout_session_id: 'cs-open',
        checkout_url: 'https://checkout.stripe.test/cs-open',
        checkout_expires_at: new Date(Date.now() + 20 * 60_000)
      }],
      ['without a session, at today\'s price', {}],
      ['that is paid', { status: 'paid' }]
    ])('hands back an order %s without comparing the mail', async (_label, extra) => {
      dupState.letters = [mail()];
      activeRows = [currentOrder(extra)];

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).resolves.toMatchObject({
        orderId: 'order-1',
        reused: true
      });

      expect(dupState.calls).toEqual([]);
      expect(inserted()).toBe(false);
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['too near expiry for Stripe', { checkout_expires_at: new Date(Date.now() + 10 * 60_000) }, 'CHECKOUT_WINDOW_TOO_SHORT'],
      ['priced before a price change', { amount_cents: 399 }, 'PRICE_CHANGED_BEFORE_SESSION']
    ])('checks the order that replaces a sessionless one %s', async (_label, extra, reason) => {
      dupState.letters = [mail()];
      activeRows = [currentOrder(extra)];

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).rejects.toMatchObject({
        code: 'DUPLICATE_RECENT_MAIL'
      });

      // Cancelled for a replacement first, in the transaction the refusal
      // then leaves, so the real one undoes the cancellation too.
      const cancel = mocks.query.mock.calls.find(([sql]) => String(sql).includes("SET status = 'cancelled'"));
      expect(JSON.stringify(cancel)).toContain(reason);
      expect(position("SET status = 'cancelled'")).toBeLessThan(position('duplicate mail check: draft'));
      expect(inserted()).toBe(false);
      await expect(mocks.transaction.mock.results[0].value).rejects.toMatchObject({ code: 'DUPLICATE_RECENT_MAIL' });
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['already sent', { status: 'consumed' }, 'DRAFT_INVALID_STATE'],
      ['cancelled', { status: 'cancelled' }, 'DRAFT_INVALID_STATE'],
      ['expired', { status: 'expired' }, 'DRAFT_EXPIRED'],
      ['past its expiry', { expires_at: new Date(Date.now() - 60_000) }, 'DRAFT_EXPIRED'],
      // Arrive-by (#535): refused before the charge; after it, fulfilment mails as soon as it can.
      ['past its mail date', { arrive_by: '2020-01-13', mail_on: '2020-01-02' }, 'SCHEDULE_PASSED']
    ])('refuses a draft that is %s for that reason, never as a copy of itself', async (_label, extra, code) => {
      dupState.letters = [mail()];
      draftRow = pendingDraft(extra);

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).rejects.toMatchObject({ code });

      expect(dupState.calls).toEqual([]);
    });

    describe('room on its mail date (#700)', () => {
      // A Thursday, 10:00 in New York: Fri Oct 16 mails on Tue Oct 6.
      const THURSDAY_MORNING = new Date('2026-10-01T14:00:00Z');
      let held: number;

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(THURSDAY_MORNING);
        vi.stubEnv('LETTER_IRL_SCHEDULE_DAILY_CAP', '2');
        draftRow = pendingDraft({ arrive_by: '2026-10-16', mail_on: '2026-10-06', expires_at: new Date(THURSDAY_MORNING.getTime() + 6 * 60 * 60_000) });
        held = 2;
        const base = mocks.query.getMockImplementation()!;
        mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
          if (sql.includes('GROUP BY mail_on')) return { rows: [] };
          if (sql.includes('AS held FROM letters')) return { rows: [{ held }] };
          return base(sql, params);
        });
      });

      afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      });

      it('refuses a full date before any order or session, naming the nearest dates with room', async () => {
        await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).rejects.toMatchObject({
          code: 'SCHEDULE_FULL',
          openArrivals: ['2026-10-13', '2026-10-14', '2026-10-15']
        });
        expect(inserted()).toBe(false);
        expect(mocks.createJitSession).not.toHaveBeenCalled();
        // Under the draft's lock, by a plain count: no date lock is held across the payment.
        expect(position('AS held FROM letters')).toBeGreaterThan(position('SELECT * FROM letter_drafts WHERE draft_id = $1 FOR NO KEY UPDATE'));
        expect(trail.some(sql => sql.includes('pg_advisory_xact_lock'))).toBe(false);
        // Its own mail date's count.
        const count = mocks.query.mock.calls.find(([sql]) => String(sql).includes('AS held FROM letters'))!;
        expect(count[1]).toEqual(['2026-10-06']);
      });

      it('opens the checkout for a date with room', async () => {
        held = 1;
        await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).resolves.toMatchObject({ status: 'checkout_pending' });
      });

      it.each(['paid', 'fulfillment_pending'])(
        'returns an order already %s as it always did, though its date has since filled or passed (review round 1)',
        async status => {
          activeRows = [currentOrder({ status, stripe_checkout_session_id: 'cs-paid', checkout_url: 'https://checkout.stripe.test/cs-paid' })];
          for (const dates of [{}, { arrive_by: '2026-10-12', mail_on: '2026-09-30' }]) {
            draftRow = { ...draftRow, ...dates };
            await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).resolves.toMatchObject({ reused: true });
          }
          expect(trail.some(sql => sql.includes('AS held FROM letters'))).toBe(false);
          expect(inserted()).toBe(false);
        }
      );

      it('returns a session already open, counted when it was made, though its date has since filled (review round 2)', async () => {
        activeRows = [currentOrder({ stripe_checkout_session_id: 'cs-open', checkout_url: 'https://checkout.stripe.test/cs-open' })];
        await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).resolves.toMatchObject({ reused: true });
        expect(trail.some(sql => sql.includes('AS held FROM letters'))).toBe(false);
        expect(mocks.createJitSession).not.toHaveBeenCalled();
      });

      it('takes a checkout URL alone for an open session, as the reuse does', async () => {
        activeRows = [currentOrder({ checkout_url: 'https://checkout.stripe.test/cs-url' })];
        await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).resolves.toMatchObject({ reused: true });
        expect(trail.some(sql => sql.includes('AS held FROM letters'))).toBe(false);
      });

      it('refuses a full date for an order whose session was never made, before one is', async () => {
        activeRows = [currentOrder()];
        await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).rejects.toMatchObject({
          code: 'SCHEDULE_FULL',
          diagnosticClass: 'SCHEDULE_FULL'
        });
        expect(mocks.createJitSession).not.toHaveBeenCalled();
        // After the look for the draft's order.
        expect(position('AS held FROM letters')).toBeGreaterThan(position('status = ANY($2::varchar[])'));
      });

      it('reuses an order whose session was never made when its date has room', async () => {
        held = 1;
        activeRows = [currentOrder()];
        await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).resolves.toMatchObject({ reused: true });
      });

      it('refuses a passed date, classed, for an order whose session was never made', async () => {
        activeRows = [currentOrder()];
        draftRow = { ...draftRow, arrive_by: '2026-10-12', mail_on: '2026-09-30' };
        await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).rejects.toMatchObject({
          code: 'SCHEDULE_PASSED',
          diagnosticClass: 'SCHEDULE_PASSED'
        });
        expect(mocks.createJitSession).not.toHaveBeenCalled();
      });

      it('returns a session already open though its date has passed, which may have been paid (review round 3)', async () => {
        activeRows = [currentOrder({ stripe_checkout_session_id: 'cs-open', checkout_url: 'https://checkout.stripe.test/cs-open' })];
        draftRow = { ...draftRow, arrive_by: '2026-10-12', mail_on: '2026-09-30' };
        await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).resolves.toMatchObject({ reused: true });
      });
    });

    describe('the content version the person was shown (#695)', () => {
      it('opens the checkout for the version shown', async () => {
        const result = await createJitCheckout({ userId: 'user-1', draftId: 'draft-1', contentVersion: contentVersionOf(draftRow) });
        expect(result.status).toBe('checkout_pending');
        expect(mocks.createJitSession).toHaveBeenCalled();
      });

      it('refuses a draft changed after it was shown, before any order or session', async () => {
        const shown = contentVersionOf(draftRow);
        draftRow = pendingDraft({ mail_service: 'certified' });
        await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1', contentVersion: shown }))
          .rejects.toMatchObject({ code: 'DRAFT_CHANGED_SINCE_SHOWN', diagnosticClass: 'DRAFT_CHANGED_SINCE_SHOWN' });
        expect(inserted()).toBe(false);
        expect(mocks.createJitSession).not.toHaveBeenCalled();
        // Under the draft's lock, so no edit lands between the comparison and the order.
        expect(position('SELECT * FROM letter_drafts WHERE draft_id = $1 FOR NO KEY UPDATE')).toBeGreaterThanOrEqual(0);
      });

      it('compares the draft as its lock reads it, not as any earlier read saw it', async () => {
        const shown = contentVersionOf(draftRow);
        const before = mocks.query.getMockImplementation()!;
        // Only the locked read sees the change: a comparison against anything read before the lock would pass.
        mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) =>
          sql.includes('SELECT * FROM letter_drafts WHERE draft_id = $1 FOR NO KEY UPDATE')
            ? { rows: [{ ...draftRow, body_text: 'Changed under the lock.' }] }
            : before(sql, params)
        );
        await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1', contentVersion: shown }))
          .rejects.toMatchObject({ code: 'DRAFT_CHANGED_SINCE_SHOWN' });
        expect(inserted()).toBe(false);
        expect(mocks.createJitSession).not.toHaveBeenCalled();
      });

      it('opens a checkout named without a version for one release, and logs it', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
          const result = await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' });
          expect(result.status).toBe('checkout_pending');
          expect(log.mock.calls.map(call => String(call[0])).join(' ')).toContain('checkout.content_version_missing');
        } finally {
          log.mockRestore();
        }
      });
    });

    it('reads the dates as the send does, so ones it could not read fail before any charge (#535)', async () => {
      dupState.letters = [mail()];
      // A Date, as pg without the DATE parser would give: the send would throw
      // after the charge, so the checkout must throw first.
      draftRow = pendingDraft({ arrive_by: '2099-01-16', mail_on: new Date('2099-01-06T00:00:00') });

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).rejects.toThrow(
        "letter_drafts.mail_on is not a 'YYYY-MM-DD' string"
      );
      expect(mocks.createJitSession).not.toHaveBeenCalled();
      expect(dupState.calls).toEqual([]);
    });

    it.each<[string, () => void, string]>([
      ['the balance can pay', () => { credits = 2; }, 'PREPAID_BALANCE_AVAILABLE'],
      ['the price is unresolved', () => {
        mocks.getJitProduct.mockReturnValue({
          productCode: 'jit-letter', priceId: 'price-jit-letter', amountCents: 0, currency: 'usd',
          name: 'Pay & Send One Physical Letter', description: 'x', mailType: 'letter'
        });
      }, 'JIT_NOT_CONFIGURED'],
      ['the draft expires too soon', () => {
        draftRow = pendingDraft({ expires_at: new Date(Date.now() + 35 * 60_000) });
      }, 'DRAFT_TOO_CLOSE_TO_EXPIRY']
    ])('gives other refusals first: %s', async (_label, arrange, code) => {
      dupState.letters = [mail()];
      arrange();

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).rejects.toMatchObject({ code });

      expect(dupState.calls).toEqual([]);
    });

    it.each([
      ['certified', 'jit-letter-certified', 1199],
      ['certified_return_receipt', 'jit-letter-certified-receipt', 1499]
    ] as const)(
      'opens a checkout for a %s draft at its own price, whatever the balance: no pack pays for it (#625)',
      async (mail_service, productCode, amountCents) => {
        credits = 200;
        draftRow = pendingDraft({ mail_service });
        mocks.getJitProduct.mockReturnValue({
          productCode, priceId: `price-${productCode}`, amountCents, currency: 'usd',
          name: 'Pay & Send One Certified Mail Letter', description: 'x', mailType: 'letter'
        });

        await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).resolves.toMatchObject({
          success: true,
          reused: false
        });

        expect(inserted()).toBe(true);
        // Priced by the draft's own option, service included.
        expect(mocks.getJitProduct).toHaveBeenCalledWith({ mailType: 'letter', mailService: mail_service });
      }
    );

    it.each(['standard', '', null])(
      'opens a checkout for a draft whose mail service is %j, which is what an ordinary letter is (#625)',
      async mail_service => {
        credits = 0;
        draftRow = pendingDraft({ mail_service });
        mocks.getJitProduct.mockReturnValue({
          productCode: 'jit-letter', priceId: 'price-1p', amountCents: 499, currency: 'usd',
          name: 'Pay & Send One Physical Letter', description: 'x', mailType: 'letter'
        });

        await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).resolves.toMatchObject({
          success: true,
          reused: false
        });

        expect(inserted()).toBe(true);
      }
    );

    it('opens a checkout for a 4x6 postcard whatever the balance: no pack pays for it (#579)', async () => {
      credits = 200;
      draftRow = pendingDraft({ mail_type: 'postcard', postcard_size: '6x4' });
      mocks.getJitProduct.mockReturnValue({
        productCode: 'jit-postcard-4x6', priceId: 'price-4x6', amountCents: 399, currency: 'usd',
        name: 'Pay & Send One 4x6 Postcard', description: 'x', mailType: 'postcard'
      });

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).resolves.toMatchObject({
        success: true,
        reused: false
      });

      expect(inserted()).toBe(true);
      // The balance is not even read for it.
      expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('SELECT credits FROM users'))).toBe(false);
    });

    it('still refuses a 6x9 postcard the balance can pay', async () => {
      credits = 2;
      draftRow = pendingDraft({ mail_type: 'postcard', postcard_size: '6x9' });

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).rejects.toMatchObject({
        code: 'PREPAID_BALANCE_AVAILABLE'
      });
    });

    it('comes after the account and cap gates', async () => {
      dupState.letters = [mail()];
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('sends_blocked_reason')) return { rows: [{ sends_blocked_reason: 'payment_disputed' }] };
        return { rows: [] };
      });

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).rejects.toMatchObject({
        code: 'ACCOUNT_SENDS_BLOCKED'
      });
      expect(dupState.calls).toEqual([]);
    });

    it('refuses an account erased while the checkout waited, after the insert and inside its transaction (#449)', async () => {
      accountState.erasedAt = new Date();

      await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).rejects.toMatchObject({
        code: 'ACCOUNT_SENDS_BLOCKED',
        diagnosticClass: 'authorization_error'
      });

      // After the insert, whose wait on the account row it depends on, and
      // thrown out of the order transaction, which the real one rolls back.
      expect(position('SELECT erased_at, sends_blocked_reason FROM users')).toBeGreaterThan(position(INSERT));
      await expect(mocks.transaction.mock.results[0].value).rejects.toMatchObject({ code: 'ACCOUNT_SENDS_BLOCKED' });
      expect(mocks.createJitSession).not.toHaveBeenCalled();
    });

    it('refuses an account blocked after the first check, without naming the block (#449)', async () => {
      accountState.blockedReason = 'payment_disputed';

      const error = await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' }).catch(caught => caught);

      expect(error).toMatchObject({ code: 'ACCOUNT_SENDS_BLOCKED' });
      expect(String(error.message)).not.toContain('payment_disputed');
      expect(mocks.createJitSession).not.toHaveBeenCalled();
    });
  });

  describe('a pack checkout for an account erased or blocked (#449)', () => {
    const PACK = { userId: 'user-1', userEmail: 'person@example.com', productId: 'credit-pack-4' as const };
    let trail: string[];
    const at = (fragment: string) => trail.findIndex(sql => sql.includes(fragment));

    beforeEach(() => {
      trail = [];
      dupState.trail = trail;
      mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO orders')) {
          return { rows: [{ ...baseOrder, order_id: params[0], order_type: 'letter_pack', draft_id: undefined }] };
        }
        if (sql.includes('SET stripe_checkout_session_id = $2')) {
          return { rows: [{ ...baseOrder, order_id: params[0], order_type: 'letter_pack', stripe_checkout_session_id: params[1] }] };
        }
        if (sql.startsWith('SELECT * FROM orders WHERE order_id = $1')) {
          return { rows: [{ ...baseOrder, order_id: params[0], order_type: 'letter_pack' }] };
        }
        return { rows: [] };
      });
      mocks.createPackSession.mockResolvedValue({
        success: true,
        sessionId: 'cs-pack',
        sessionUrl: 'https://checkout.stripe.test/cs-pack'
      });
    });

    it('refuses an erased account after the order insert, inside its transaction, before any session', async () => {
      accountState.erasedAt = new Date();

      await expect(createPackCheckout(PACK)).rejects.toMatchObject({
        code: 'ACCOUNT_SENDS_BLOCKED',
        diagnosticClass: 'authorization_error'
      });

      expect(at('INSERT INTO orders')).toBeGreaterThanOrEqual(0);
      expect(at('SELECT erased_at, sends_blocked_reason FROM users')).toBeGreaterThan(at('INSERT INTO orders'));
      expect(mocks.transaction).toHaveBeenCalledTimes(1);
      await expect(mocks.transaction.mock.results[0].value).rejects.toMatchObject({ code: 'ACCOUNT_SENDS_BLOCKED' });
      expect(mocks.createPackSession).not.toHaveBeenCalled();
    });

    it('refuses a blocked account without naming the block', async () => {
      accountState.blockedReason = 'payment_disputed';

      const error = await createPackCheckout(PACK).catch(caught => caught);

      expect(error).toMatchObject({ code: 'ACCOUNT_SENDS_BLOCKED' });
      expect(String(error.message)).not.toContain('payment_disputed');
      expect(mocks.createPackSession).not.toHaveBeenCalled();
    });

    it('opens the checkout for an account that is neither', async () => {
      await expect(createPackCheckout(PACK)).resolves.toMatchObject({ success: true, sessionId: 'cs-pack' });

      expect(accountState.reads).toBe(1);
      expect(mocks.createPackSession).toHaveBeenCalledTimes(1);
    });
  });
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

describe("mail a pack paid for, when the pack's money goes back (#696)", () => {
  const packOrder = {
    ...baseOrder, order_type: 'letter_pack', product_code: 'credit-pack-4',
    draft_id: undefined, credits: 4, amount_cents: 500, currency: 'usd',
    status: 'fulfilled', stripe_payment_intent_id: 'pi-hold', refund_attempts: 0
  };
  function script(order: Record<string, unknown> = packOrder, alertRaised = 1) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("'held_mail_funding_reversed'")) return { rows: [], rowCount: alertRaised };
      if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-hold' }] };
      if (sql.includes('UPDATE orders') && sql.includes('RETURNING order_id')) return { rows: [{ order_id: 'order-1' }] };
      if (sql.includes('FROM gift_letters g')) return { rows: [{ letter_id: 'letter-1' }, { letter_id: 'letter-2' }] };
      if (sql.startsWith('SELECT status FROM letters WHERE letter_id')) {
        // The second has gone to the printer: nothing to hold.
        return { rows: [{ status: params[0] === 'letter-1' ? 'queued' : 'sent' }] };
      }
      if (sql.includes('SET hold_reason = $2')) return { rows: [{ job_id: 'job-1' }], rowCount: 1 };
      if (sql.includes('FROM orders')) return { rows: [order] };
      return { rows: [] };
    });
    return calls;
  }
  const refund = (status: string) => ({
    id: 'evt-hold', type: 'refund.updated',
    data: { object: { id: 're-hold', payment_intent: 'pi-hold', charge: 'ch-hold', amount: 500, status, metadata: {} } }
  }) as any;
  const dispute = (status: string) => ({
    id: 'evt-hold', type: 'charge.dispute.created',
    data: { object: { id: 'dp-hold', charge: 'ch-hold', payment_intent: 'pi-hold', amount: 500, currency: 'usd', reason: 'fraudulent', status } }
  }) as any;
  const holds = (calls: Array<{ sql: string; params: unknown[] }>) => calls.filter(call => call.sql.includes('SET hold_reason = $2'));
  const alerts = (calls: Array<{ sql: string; params: unknown[] }>) =>
    calls.filter(call => call.sql.includes("'held_mail_funding_reversed'"));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async callback =>
      callback({ query: (...args: [string, unknown[]?]) => mocks.query(...args) })
    );
    mocks.findRefund.mockResolvedValue({ live: { id: 're-hold', status: 'succeeded' }, ended: null });
  });

  it('holds the queued letters a pack refunded in full paid for, before its lots go, and says so once', async () => {
    const calls = script();
    await processStripeWebhookEvent(refund('succeeded'));

    const funded = calls.find(call => call.sql.includes('FROM gift_letters g'))!;
    expect(funded.params).toEqual(['order-1', 'user-1', null]);
    const flat = funded.sql.replace(/\s+/g, ' ');
    // Through the pack's lots as their revocation finds them: every lot returned from the
    // purchase carries the order id, or its checkout session.
    expect(flat).toContain("AND (lot.source_order_id = $1 OR lot.source_reference_id = $1 OR lot.source_metadata->>'stripe_session_id' = $3)");
    // Only the order's own account's letters and lots.
    expect(flat).toContain('AND l.user_id = $2 AND lot.user_id = $2');
    // And the gift letters the pack granted.
    expect(flat).toContain('UNION SELECT l.letter_id FROM gift_letters g JOIN letters l ON l.letter_id = g.consumed_by_letter_id WHERE g.source_order_id = $1 AND l.user_id = $2');
    // Each letter locked before its job; only a queued one held, never dispatched mail.
    expect(calls.filter(call => call.sql.startsWith('SELECT status FROM letters WHERE letter_id')).map(call => call.params))
      .toEqual([['letter-1'], ['letter-2']]);
    expect(holds(calls).map(call => call.params)).toEqual([['letter-1', 'funding_reversed']]);
    expect(holds(calls)[0].sql).toContain("status IN ('pending', 'processing')");
    expect(holds(calls)[0].sql).toContain("provider_outcome = 'not_dispatched'");
    expect(alerts(calls)).toHaveLength(1);
    expect(alerts(calls)[0].params).toEqual(['evt-hold', 'order-1', JSON.stringify({ reason: 'funding_reversed', letters: 1 })]);
    // Before the account lock, so before the lots are revoked.
    const holdAt = calls.findIndex(call => call.sql.includes('SET hold_reason = $2'));
    expect(holdAt).toBeLessThan(calls.findIndex(call => call.sql === ACCOUNT_LOCK_SQL));
  });

  it('tells the operator when the order\'s alert is first raised, and not when it was raised already (#699)', async () => {
    script();
    await processStripeWebhookEvent(refund('succeeded'));
    expect(reportToOperator).toHaveBeenCalledTimes(1);
    expect(reportToOperator).toHaveBeenCalledWith('held_mail_funding', OPERATOR_NOTICES.heldMailFunding());

    vi.mocked(reportToOperator).mockClear();
    script(packOrder, 0);
    await processStripeWebhookEvent(refund('succeeded'));
    expect(reportToOperator).not.toHaveBeenCalled();
  });

  it.each([
    ['dispatching', 'processing'],
    ['ambiguous', 'held'],
    ['accepted', 'completed']
  ])('tells the operator when a Pay & Send order is refunded after its letter was %s, once (#699 review round 3)', async (outcome, jobStatus) => {
    const jitOrder = {
      ...baseOrder, order_type: 'jit_mail', letter_id: 'letter-9', status: 'fulfillment_pending',
      stripe_payment_intent_id: 'pi-hold', refund_attempts: 0
    };
    for (const raised of [1, 0]) {
      vi.mocked(reportToOperator).mockClear();
      const calls = script(jitOrder);
      const base = mocks.query.getMockImplementation()!;
      mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('SELECT job_id, status, provider_outcome FROM letter_jobs')) {
          calls.push({ sql, params });
          return { rows: [{ job_id: 'job-9', status: jobStatus, provider_outcome: outcome }] };
        }
        if (sql.includes("'refunded_mail_already_dispatched'")) {
          calls.push({ sql, params });
          return { rows: [], rowCount: raised };
        }
        return base(sql, params);
      });
      await processStripeWebhookEvent(refund('succeeded'));
      expect(calls.some(call => call.sql.includes("'refunded_mail_already_dispatched'")), String(raised)).toBe(true);
      if (raised) {
        expect(reportToOperator).toHaveBeenCalledWith('refunded_mail_dispatched', OPERATOR_NOTICES.refundedMailDispatched());
      } else {
        expect(reportToOperator).not.toHaveBeenCalledWith('refunded_mail_dispatched', expect.anything());
      }
    }
  });

  it('tells the operator when a dispute opens on a Pay & Send order whose letter the provider has (#699 review round 4)', async () => {
    const jitOrder = {
      ...baseOrder, order_type: 'jit_mail', letter_id: 'letter-9', status: 'fulfilled',
      stripe_payment_intent_id: 'pi-hold', refund_attempts: 0
    };
    const calls = script(jitOrder);
    const base = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT job_id, status, provider_outcome FROM letter_jobs')) {
        calls.push({ sql, params });
        return { rows: [{ job_id: 'job-9', status: 'completed', provider_outcome: 'accepted' }] };
      }
      if (sql.includes("'refunded_mail_already_dispatched'")) {
        calls.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      return base(sql, params);
    });
    vi.mocked(reportToOperator).mockClear();

    await processStripeWebhookEvent(dispute('needs_response'));

    expect(calls.some(call => call.sql.includes("'refunded_mail_already_dispatched'"))).toBe(true);
    expect(reportToOperator).toHaveBeenCalledWith('refunded_mail_dispatched', OPERATOR_NOTICES.refundedMailDispatched());
  });

  it('holds nothing while the refund is pending: it may still fail', async () => {
    mocks.findRefund.mockResolvedValue({ live: { id: 're-hold', status: 'pending' }, ended: null });
    const calls = script();
    await processStripeWebhookEvent(refund('pending'));
    expect(calls.some(call => call.sql.includes('FROM gift_letters g'))).toBe(false);
    expect(alerts(calls)).toEqual([]);
  });

  it('holds them for a dispute that takes the money, as funding_disputed', async () => {
    const calls = script();
    await processStripeWebhookEvent(dispute('needs_response'));
    expect(holds(calls).map(call => call.params)).toEqual([['letter-1', 'funding_disputed']]);
    expect(alerts(calls)[0].params[2]).toBe(JSON.stringify({ reason: 'funding_disputed', letters: 1 }));
  });

  it("holds nothing for a card network's inquiry, which takes no money", async () => {
    const calls = script();
    await processStripeWebhookEvent(dispute('warning_needs_response'));
    expect(calls.some(call => call.sql.includes('FROM gift_letters g'))).toBe(false);
  });

  it('raises no alert when nothing was waiting', async () => {
    const calls = script();
    mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-hold' }] };
      if (sql.includes('UPDATE orders') && sql.includes('RETURNING order_id')) return { rows: [{ order_id: 'order-1' }] };
      if (sql.includes('FROM gift_letters g')) return { rows: [{ letter_id: 'letter-1' }] };
      if (sql.startsWith('SELECT status FROM letters WHERE letter_id')) return { rows: [{ status: 'queued' }] };
      // Its job already taken past dispatch.
      if (sql.includes('SET hold_reason = $2')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM orders')) return { rows: [packOrder] };
      return { rows: [] };
    });
    await processStripeWebhookEvent(refund('succeeded'));
    expect(alerts(calls)).toEqual([]);
  });

  it("leaves a Pay & Send order's own letter to its own stop", async () => {
    const calls = script({ ...packOrder, order_type: 'jit_mail', letter_id: null });
    await processStripeWebhookEvent(refund('succeeded'));
    expect(calls.some(call => call.sql.includes('FROM gift_letters g'))).toBe(false);
  });
});
