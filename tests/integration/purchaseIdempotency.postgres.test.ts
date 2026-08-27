import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Issue #152 - purchase idempotency at the DATABASE boundary.
 *
 * Five layers stand between a replayed Stripe event and a second credit grant:
 *
 *   1. claimStripeEvent  INSERT ... ON CONFLICT (event_id) DO NOTHING
 *   2. findCheckoutOrder SELECT ... FOR UPDATE on the order row
 *   3. transitionPaidCheckout early-returns for FUNDED_OR_REVERSED statuses
 *   4. migration 023's partial unique index on credit_ledger(source_order_id)
 *   5. migration 027's BEFORE INSERT trigger, which keeps new purchase rows
 *      inside layer 4's reach
 *
 * Real PostgreSQL is mandatory and a mocked client would be actively
 * misleading: four of those five ARE database behaviour - conflict resolution,
 * row locking, a partial index, a trigger - and a mock would report every one
 * of them working while none of them existed.
 *
 * ON ASSERTING THE SETTLED RESULTS. Several tests below drive two concurrent
 * deliveries and then assert `results.map(r => r.status)`. That is not
 * ceremony. The first revision of this suite awaited Promise.allSettled and
 * discarded what it returned, and the consequence was that removing the
 * FOR UPDATE at commerceService.ts:957/:961 left ALL twelve tests green: the
 * loser read the order unlocked, evaluated the status guard against its own
 * stale in-memory row, proceeded, and died on a 23505 that nothing observed.
 * The row counts were identical either way. Binding the results is what makes
 * layers 2 and 3 individually mutation-sensitive.
 *
 * ON users.credits. addCreditsToLedgerWithClient increments users.credits
 * BEFORE it inserts the ledger row, so a suite that only counts ledger rows
 * cannot see a double grant that lands in the cached balance. Appending
 * `ON CONFLICT DO NOTHING` to the ledger INSERT - the natural way to make the
 * 23505 below "go away" - left six tests green while a replay credited a
 * customer 8 credits for a 4-credit pack. Every grant assertion here checks the
 * ledger, the cached balance, AND the credit_transactions row, because
 * criterion 1 says one grant and one purchase transaction.
 *
 * ORDERING CONSTRAINT: process.env.DATABASE_URL must be assigned before the
 * first import of src/db/index.js, which builds its Pool at module scope. The
 * static `migrate` import above is safe because src/cli/migrate.ts uses its own
 * pg.Pool. Adding any static import here that transitively reaches
 * src/db/index.js would silently bind the service pool to tests/setup.ts's
 * fallback URL, whose public schema has no tables, and every commerce call
 * would fail 42P01 - which this repo's diagnostics collapse to database_error.
 */

const { Pool } = pg;
const enabled = process.env.LIRL_RUN_POSTGRES_INTEGRATION === 'true';
const describePostgres = enabled ? describe : describe.skip;

function schemaName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function databaseUrlForSchema(baseUrl: string, schema: string): string {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}

/**
 * Run every cleanup step even if an earlier one rejects. Block 2 previously
 * awaited pool.end() first, and pg rejects that if a client errors while
 * draining - which skipped both the temp-directory removal and the DROP SCHEMA
 * below it, leaking a 26-table schema per aborted run.
 */
async function settleAll(steps: Array<() => Promise<unknown>>): Promise<void> {
  for (const step of steps) {
    try {
      await step();
    } catch {
      // Deliberately swallowed: one failed teardown must not skip the rest.
    }
  }
}

const PACK_CREDITS = 4;
const PACK_AMOUNT_CENTS = 500;

describePostgres('purchase idempotency at the database boundary (#152)', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let commerce: typeof import('../../src/services/commerceService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_idem');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 8 });

    process.env.DATABASE_URL = scoped;
    commerce = await import('../../src/services/commerceService.js');
    closeServicePool = (await import('../../src/db/index.js')).closePool;
  }, 180_000);

  afterAll(async () => {
    await settleAll([
      async () => closeServicePool?.(),
      async () => pool?.end(),
      async () => adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`),
      async () => adminPool?.end()
    ]);
  });

  beforeEach(async () => {
    // commerce_operator_audit_events and redacted_content_quarantine have no
    // foreign key to anything here, so CASCADE can never reach them. Neither is
    // written by a path this suite exercises today, and the audit table also
    // carries an append-only trigger that rejects DELETE - so the day one of
    // them IS written, only naming it here would clear it. The retention work
    // shipped exactly this bug.
    await pool.query(
      `TRUNCATE commerce_operational_alerts, commerce_operator_audit_events,
                redacted_content_quarantine, stripe_webhook_events,
                commerce_order_events, credit_consumption, credit_transactions,
                credit_ledger, image_entitlements, orders, users
       RESTART IDENTITY CASCADE`
    );
  });

  /** A user plus a pack order parked at checkout_pending, ready to be paid. */
  async function seedPendingPackOrder(options: { userId?: string } = {}): Promise<{
    userId: string; orderId: string; sessionId: string;
  }> {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const userId = options.userId ?? `user_${suffix}`;
    const orderId = `order_${suffix}`;
    const sessionId = `cs_${suffix}`;
    if (!options.userId) {
      await pool.query(`INSERT INTO users (user_id, email, credits) VALUES ($1, $2, 0)`, [
        userId,
        `${userId}@test.invalid`
      ]);
    }
    await pool.query(
      `INSERT INTO orders (
         order_id, user_id, order_type, product_code, product_snapshot, credits,
         amount_cents, currency, stripe_checkout_session_id, idempotency_key, status
       ) VALUES ($1, $2, 'letter_pack', 'credit-pack-4', '{}'::jsonb, $3,
                 $4, 'usd', $5, $6, 'checkout_pending')`,
      [orderId, userId, PACK_CREDITS, PACK_AMOUNT_CENTS, sessionId, `pack-checkout:${suffix}`]
    );
    return { userId, orderId, sessionId };
  }

  function paidEvent(options: {
    eventId: string;
    sessionId: string;
    amountCents?: number;
    currency?: string;
    type?: string;
  }): unknown {
    return {
      id: options.eventId,
      type: options.type ?? 'checkout.session.completed',
      data: {
        object: {
          id: options.sessionId,
          client_reference_id: null,
          metadata: {},
          payment_intent: `pi_${options.sessionId}`,
          payment_status: 'paid',
          amount_total: options.amountCents ?? PACK_AMOUNT_CENTS,
          currency: options.currency ?? 'usd',
          expires_at: Math.floor(Date.now() / 1000) + 3600
        }
      }
    };
  }

  async function scalar(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await pool.query<{ value: string }>(sql, params);
    return Number(rows[0].value);
  }

  const purchaseLedgerRows = (orderId: string) =>
    scalar(
      `SELECT COUNT(*)::text AS value FROM credit_ledger
       WHERE source_order_id = $1 AND source_type = 'purchase'`,
      [orderId]
    );

  const purchaseTransactionRows = (orderId: string) =>
    scalar(
      `SELECT COUNT(*)::text AS value FROM credit_transactions
       WHERE reference_id = $1 AND type = 'purchase'`,
      [orderId]
    );

  const totalCreditsRemaining = (userId: string) =>
    scalar(
      `SELECT COALESCE(SUM(remaining_amount), 0)::text AS value
       FROM credit_ledger WHERE user_id = $1`,
      [userId]
    );

  const cachedUserCredits = (userId: string) =>
    scalar(`SELECT credits::text AS value FROM users WHERE user_id = $1`, [userId]);

  const claimedEvents = (eventId: string) =>
    scalar(`SELECT COUNT(*)::text AS value FROM stripe_webhook_events WHERE event_id = $1`, [
      eventId
    ]);

  /** Column names here are literals at every call site; never caller input. */
  async function orderColumn<T>(orderId: string, column: string): Promise<T> {
    const { rows } = await pool.query(`SELECT ${column} AS value FROM orders WHERE order_id = $1`, [
      orderId
    ]);
    return rows[0].value as T;
  }

  const orderStatus = (orderId: string) => orderColumn<string>(orderId, 'status');

  /**
   * Every place a single successful pack grant must show up. Asserting only
   * credit_ledger is what let the users.credits path go unchecked.
   */
  async function expectExactlyOneGrant(userId: string, orderId: string): Promise<void> {
    expect(await purchaseLedgerRows(orderId)).toBe(1);
    expect(await purchaseTransactionRows(orderId)).toBe(1);
    expect(await totalCreditsRemaining(userId)).toBe(PACK_CREDITS);
    expect(await cachedUserCredits(userId)).toBe(PACK_CREDITS);
  }

  function insertLedgerRow(
    userId: string,
    orderId: string | null,
    sourceType: string
  ): Promise<pg.QueryResult> {
    return pool.query(
      `INSERT INTO credit_ledger (
         ledger_id, user_id, initial_amount, remaining_amount, source_type,
         source_reference_id, source_order_id, expires_at
       ) VALUES (gen_random_uuid(), $1, $2, $2, $3::credit_source_type,
                 COALESCE($4, 'legacy-ref'), $4, NOW() + INTERVAL '365 days')`,
      [userId, PACK_CREDITS, sourceType, orderId]
    );
  }

  /**
   * orders carries a BEFORE UPDATE trigger that rewrites updated_at to NOW(),
   * so ageing a row means suspending it. That the column cannot be back-dated
   * by an ordinary UPDATE is a property worth having - it is what makes the
   * stuck-order clock trustworthy - but a test cannot simulate elapsed time
   * without saying so.
   *
   * All statements run on ONE client inside a transaction, so an abrupt process
   * death rolls the DISABLE back instead of leaving the trigger off in a schema
   * whose afterAll never ran.
   */
  async function ageOrdersPastStuckThreshold(orderIds: string[]): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE orders DISABLE TRIGGER update_orders_updated_at');
      await client.query(
        `UPDATE orders SET updated_at = NOW() - INTERVAL '90 minutes' WHERE order_id = ANY($1)`,
        [orderIds]
      );
      await client.query('ALTER TABLE orders ENABLE TRIGGER update_orders_updated_at');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('grants exactly once for a single delivery, as the baseline', async () => {
    const { userId, orderId, sessionId } = await seedPendingPackOrder();

    await expect(
      commerce.processStripeWebhookEvent(
        paidEvent({ eventId: `evt_${sessionId}`, sessionId }) as never
      )
    ).resolves.toEqual({ duplicate: false, orderId, status: 'fulfilled' });

    await expectExactlyOneGrant(userId, orderId);
    expect(await orderStatus(orderId)).toBe('fulfilled');
  });

  it('treats a replay of the SAME event id as a duplicate and grants nothing further', async () => {
    const { userId, orderId, sessionId } = await seedPendingPackOrder();
    const event = paidEvent({ eventId: `evt_${sessionId}`, sessionId });

    await expect(commerce.processStripeWebhookEvent(event as never)).resolves.toEqual({
      duplicate: false,
      orderId,
      status: 'fulfilled'
    });
    // Stripe redelivers on any non-2xx, and on its own retry schedule for days.
    //
    // NOTE for acceptance criterion 2 ("return the existing completed result on
    // replay"): the duplicate branch returns ONLY { duplicate: true } - no
    // orderId, no status. This assertion is exact so the gap is recorded rather
    // than glossed. If the branch is ever changed to look up and return the
    // bound order, this test reddens and should be updated.
    await expect(commerce.processStripeWebhookEvent(event as never)).resolves.toEqual({
      duplicate: true
    });

    await expectExactlyOneGrant(userId, orderId);
  });

  it('grants once when TWO DIFFERENT event ids arrive for the same session', async () => {
    // Sequential, so the row lock is never contended: this pins layer 3, the
    // funded-status early return, and nothing else.
    const { userId, orderId, sessionId } = await seedPendingPackOrder();

    await commerce.processStripeWebhookEvent(
      paidEvent({ eventId: `evt_a_${sessionId}`, sessionId }) as never
    );
    await commerce.processStripeWebhookEvent(
      paidEvent({
        eventId: `evt_b_${sessionId}`,
        sessionId,
        type: 'checkout.session.async_payment_succeeded'
      }) as never
    );

    await expectExactlyOneGrant(userId, orderId);
  });

  it('grants once under CONCURRENT delivery of the same event id', async () => {
    const { userId, orderId, sessionId } = await seedPendingPackOrder();
    const event = paidEvent({ eventId: `evt_${sessionId}`, sessionId });

    // Genuinely simultaneous: transaction() takes a separate connection per
    // call, so these are two concurrent PostgreSQL sessions, not one.
    const results = await Promise.allSettled([
      commerce.processStripeWebhookEvent(event as never),
      commerce.processStripeWebhookEvent(event as never)
    ]);

    expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
    // Exactly one caller must be told it lost. Without this the test cannot
    // tell layer 1 doing its job from layer 3 quietly covering for it, and it
    // stays green when claimStripeEvent is stubbed to `return true`.
    const duplicates = results
      .filter((r): r is PromiseFulfilledResult<{ duplicate: boolean }> => r.status === 'fulfilled')
      .filter(r => r.value.duplicate === true);
    expect(duplicates).toHaveLength(1);

    await expectExactlyOneGrant(userId, orderId);
  });

  it('grants once under CONCURRENT delivery of two different event ids', async () => {
    // The worst case the issue names: two deliveries racing with nothing in
    // common but the order they both want to fund. Layer 1 cannot help - both
    // events claim successfully - so layers 2 and 3 are load-bearing here, and
    // asserting that NEITHER call rejected is what detects their removal.
    // Deleting the FOR UPDATE, or deleting 'fulfilled' from
    // FUNDED_OR_REVERSED_ORDER_STATUSES, each turn one 'fulfilled' into
    // 'rejected' via an unhandled 23505.
    const { userId, orderId, sessionId } = await seedPendingPackOrder();

    const results = await Promise.allSettled([
      commerce.processStripeWebhookEvent(
        paidEvent({ eventId: `evt_a_${sessionId}`, sessionId }) as never
      ),
      commerce.processStripeWebhookEvent(
        paidEvent({
          eventId: `evt_b_${sessionId}`,
          sessionId,
          type: 'checkout.session.async_payment_succeeded'
        }) as never
      )
    ]);

    expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
    await expectExactlyOneGrant(userId, orderId);
  });

  it('keeps two legitimate purchases by one user independent', async () => {
    // Acceptance criterion 3. Same user on purpose: grantImageEntitlementWithClient
    // takes lockAccountForBalanceChange on the shared account row, so a false
    // conflict or a deadlock between two genuine purchases surfaces only here.
    const first = await seedPendingPackOrder();
    const second = await seedPendingPackOrder({ userId: first.userId });

    const results = await Promise.allSettled([
      commerce.processStripeWebhookEvent(
        paidEvent({ eventId: `evt_${first.sessionId}`, sessionId: first.sessionId }) as never
      ),
      commerce.processStripeWebhookEvent(
        paidEvent({ eventId: `evt_${second.sessionId}`, sessionId: second.sessionId }) as never
      )
    ]);

    expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await purchaseLedgerRows(first.orderId)).toBe(1);
    expect(await purchaseLedgerRows(second.orderId)).toBe(1);
    expect(await totalCreditsRemaining(first.userId)).toBe(PACK_CREDITS * 2);
    expect(await cachedUserCredits(first.userId)).toBe(PACK_CREDITS * 2);
    expect(await orderStatus(first.orderId)).toBe('fulfilled');
    expect(await orderStatus(second.orderId)).toBe('fulfilled');
  });

  it('rolls back the cached balance too when the grant transaction fails', async () => {
    // The mandate names rollback, and it is load-bearing for one specific
    // reason: addCreditsToLedgerWithClient increments users.credits BEFORE it
    // inserts the ledger row. A partial commit would leave a customer holding
    // credits with no ledger entry behind them - money invented by a crash.
    const { userId, orderId, sessionId } = await seedPendingPackOrder();

    // Fault injection at the last write of the grant, so the rollback has the
    // most to undo: users.credits and the ledger row are both already written.
    await pool.query(`
      CREATE FUNCTION lirl_fail_grant() RETURNS TRIGGER AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER lirl_fail_grant BEFORE INSERT ON credit_transactions
        FOR EACH ROW EXECUTE FUNCTION lirl_fail_grant();
    `);
    try {
      const [outcome] = await Promise.allSettled([
        commerce.processStripeWebhookEvent(
          paidEvent({ eventId: `evt_${sessionId}`, sessionId }) as never
        )
      ]);
      expect(outcome.status).toBe('rejected');
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS lirl_fail_grant ON credit_transactions;
        DROP FUNCTION IF EXISTS lirl_fail_grant();
      `);
    }

    expect(await cachedUserCredits(userId)).toBe(0);
    expect(await purchaseLedgerRows(orderId)).toBe(0);
    expect(await purchaseTransactionRows(orderId)).toBe(0);
    expect(await orderStatus(orderId)).toBe('checkout_pending');
    // The event claim must roll back with everything else, or Stripe's retry
    // would be swallowed as a duplicate and the payment never booked at all.
    expect(await claimedEvents(`evt_${sessionId}`)).toBe(0);
  });

  it('refuses a CONFLICTING amount for the same session and grants nothing', async () => {
    const { userId, orderId, sessionId } = await seedPendingPackOrder();

    await commerce.processStripeWebhookEvent(
      paidEvent({ eventId: `evt_${sessionId}`, sessionId, amountCents: 100 }) as never
    );

    expect(await purchaseLedgerRows(orderId)).toBe(0);
    expect(await cachedUserCredits(userId)).toBe(0);
    expect(await orderStatus(orderId)).toBe('refund_pending');
    expect(await orderColumn<string>(orderId, 'last_error_code')).toBe('PAYMENT_AMOUNT_MISMATCH');
    // The attributable signal an operator can actually search for. The
    // stuck-order alarm emits a bare count across three statuses and cannot
    // tell a quarantine from refund backlog; this row names the reason.
    expect(
      await scalar(
        `SELECT COUNT(*)::text AS value FROM commerce_order_events
         WHERE order_id = $1 AND metadata->>'reason' = 'payment_amount_mismatch'`,
        [orderId]
      )
    ).toBe(1);
  });

  it('refuses a CONFLICTING currency for the same session and grants nothing', async () => {
    const { userId, orderId, sessionId } = await seedPendingPackOrder();

    // The amount deliberately MATCHES, so only the currency half of the
    // predicate can be what refuses.
    await commerce.processStripeWebhookEvent(
      paidEvent({ eventId: `evt_${sessionId}`, sessionId, currency: 'gbp' }) as never
    );

    expect(await purchaseLedgerRows(orderId)).toBe(0);
    expect(await cachedUserCredits(userId)).toBe(0);
    expect(await orderStatus(orderId)).toBe('refund_pending');
  });

  it('refuses to refund a quarantined mismatch even when asked directly', async () => {
    // The PAYMENT_AMOUNT_MISMATCH wall exists in TWO places: the maintenance
    // sweep's candidate SELECT, and requestRefund's own claim CTE. The first
    // revision of this suite drove only the sweep, which meant deleting either
    // copy alone left it green - each covered for the other.
    //
    // This drives requestRefund directly, the copy that matters: the wall every
    // future caller hits, sweep or not. It is observable without a Stripe key
    // because the claim CTE increments refund_attempts BEFORE any Stripe call,
    // so refund_attempts staying 0 means the claim refused - not that Stripe
    // was unreachable.
    const { orderId, sessionId } = await seedPendingPackOrder();
    await commerce.processStripeWebhookEvent(
      paidEvent({ eventId: `evt_${sessionId}`, sessionId, amountCents: 100 }) as never
    );

    await expect(commerce.requestRefund(orderId, 'operator asked')).resolves.toBe(false);

    expect(await orderColumn<number>(orderId, 'refund_attempts')).toBe(0);
    expect(await orderStatus(orderId)).toBe('refund_pending');
  });

  it('does not let the maintenance sweep auto-refund a quarantined mismatch', async () => {
    // The mass-refund guard. Without it, any Stripe-side amount change - a
    // promo code, adaptive pricing, tax - pushes real customers into the
    // quarantine and the sweep refunds every one of them with no human in the
    // loop (#278 round 7).
    //
    // The CONTROL order is what makes this falsifiable. It is identical except
    // for the error code, so it proves the sweep WOULD have claimed the
    // quarantined order: control refund_attempts goes to 1 (the claim CTE
    // increments before the Stripe call, which then fails for want of a key in
    // CI), quarantined stays 0. Asserting the returned refundAttempts instead
    // is unfalsifiable - that only rises when requestRefund returns true, which
    // needs a live Stripe call CI never has.
    const quarantined = await seedPendingPackOrder();
    await commerce.processStripeWebhookEvent(
      paidEvent({
        eventId: `evt_${quarantined.sessionId}`,
        sessionId: quarantined.sessionId,
        amountCents: 100
      }) as never
    );

    const control = await seedPendingPackOrder();
    await pool.query(
      `UPDATE orders
       SET status = 'refund_pending', refund_pending_at = NOW(),
           stripe_payment_intent_id = $2, last_error_code = 'JIT_FULFILLMENT_REJECTED'
       WHERE order_id = $1`,
      [control.orderId, `pi_${control.sessionId}`]
    );

    await ageOrdersPastStuckThreshold([quarantined.orderId, control.orderId]);

    const maintenance = await commerce.runCommerceMaintenance();

    expect(await orderColumn<number>(quarantined.orderId, 'refund_attempts')).toBe(0);
    expect(await orderColumn<number>(control.orderId, 'refund_attempts')).toBe(1);
    expect(await orderStatus(quarantined.orderId)).toBe('refund_pending');
    // And the quarantined order is not silently parked: the stuck-order alarm
    // is what brings an operator to it.
    expect(maintenance.stuckOrders).toBeGreaterThanOrEqual(1);
  });

  it('rejects a second purchase ledger row for one order at the DATABASE boundary', async () => {
    // Layer 4 alone, with the application removed from the picture - including
    // the source_type half of the index predicate: a refund row naming the SAME
    // order must still be allowed, or the index would be blocking legitimate
    // compensation rather than double grants.
    const { userId, orderId, sessionId } = await seedPendingPackOrder();
    await commerce.processStripeWebhookEvent(
      paidEvent({ eventId: `evt_${sessionId}`, sessionId }) as never
    );

    await expect(insertLedgerRow(userId, orderId, 'purchase')).rejects.toMatchObject({
      code: '23505',
      constraint: 'idx_credit_ledger_purchase_order_unique'
    });
    await expect(insertLedgerRow(userId, orderId, 'refund')).resolves.toBeDefined();

    expect(await purchaseLedgerRows(orderId)).toBe(1);
  });

  it('rejects a purchase grant that names no order at all', async () => {
    // Migration 027. Layer 4 is PARTIAL on `source_order_id IS NOT NULL`, so
    // before this trigger a purchase row with a NULL source_order_id inserted
    // freely and a second one inserted beside it - the index appeared to
    // protect the table while protecting nothing for those rows. No static
    // check could close it: three raw INSERT INTO credit_ledger statements in
    // src/ omit the source_order_id column entirely.
    const { userId } = await seedPendingPackOrder();

    await expect(insertLedgerRow(userId, null, 'purchase')).rejects.toMatchObject({
      code: '23514'
    });
    // Non-purchase grants are unaffected: promo, signup and adjustment credits
    // have no funding order by design.
    await expect(insertLedgerRow(userId, null, 'promo')).resolves.toBeDefined();
  });

  it('never double-grants an order stranded at paid, and reports the failure', async () => {
    // 'paid' is deliberately absent from FUNDED_OR_REVERSED_ORDER_STATUSES, so
    // layer 3 does NOT fire for an order left in that state and the replay
    // reaches the ledger INSERT. Layer 4 stops the double grant, but nothing
    // catches the 23505: the call rejects, which is a non-2xx to Stripe and an
    // indefinite redelivery loop, and runCommerceMaintenance's recovery query
    // is order_type = 'jit_mail', so a letter_pack at 'paid' is never swept.
    //
    // The rejection is ASSERTED rather than tolerated because it is the actual
    // behaviour - hiding it behind allSettled would let a future change that
    // silently double-grants pass this test.
    const { userId, orderId, sessionId } = await seedPendingPackOrder();
    await commerce.processStripeWebhookEvent(
      paidEvent({ eventId: `evt_${sessionId}`, sessionId }) as never
    );
    await pool.query(`UPDATE orders SET status = 'paid' WHERE order_id = $1`, [orderId]);

    const [outcome] = await Promise.allSettled([
      commerce.processStripeWebhookEvent(
        paidEvent({ eventId: `evt_replay_${sessionId}`, sessionId }) as never
      )
    ]);

    expect(outcome.status).toBe('rejected');
    await expectExactlyOneGrant(userId, orderId);
  });
});

/**
 * Migrations 023 and 027 applied to a database that ALREADY contains a double
 * grant.
 *
 * This needs its own database because the point is the state of the schema
 * BEFORE 023 exists: `credit_ledger.source_order_id` has not been added yet, so
 * historical rows carry only `source_reference_id`.
 *
 * 023's backfill adopts only unambiguous rows - exactly one purchase row
 * pointing at one order - and leaves anything already duplicated NULL, so the
 * unique index it then creates cannot fail on, or silently paper over, a
 * pre-existing double grant. A migration that aborted here would block every
 * later migration on any database that had ever double-granted.
 *
 * It also proves 027 is safe over that history. 027 is a BEFORE INSERT trigger
 * rather than a CHECK constraint precisely because a CHECK - even NOT VALID -
 * is enforced on UPDATE, and credit_ledger rows are updated on every
 * consumption. The last assertion here is that a surviving legacy lot is still
 * spendable; with a CHECK it would not be.
 */
describePostgres('migrations 023 and 027 over pre-existing duplicate grants (#152)', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let scoped: string;
  let staging: string;

  const CLEAN_ORDER = 'order_clean_backfill';
  const DUPLICATED_ORDER = 'order_already_double_granted';

  /** Copy the repository migrations whose numeric prefix is below `limit`. */
  async function stageMigrationsBelow(limit: number): Promise<string> {
    const directory = path.join(staging, `upto_${limit}`);
    await mkdir(directory, { recursive: true });
    const files = (await readdir(repositoryMigrations)).filter(
      file => file.endsWith('.sql') && Number.parseInt(file.slice(0, 3), 10) < limit
    );
    for (const file of files) {
      await copyFile(path.join(repositoryMigrations, file), path.join(directory, file));
    }
    return directory;
  }

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_idem_mig');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    scoped = databaseUrlForSchema(baseUrl, schema);
    staging = await mkdtemp(path.join(tmpdir(), 'lirl-152-'));

    await migrate({
      connectionString: scoped,
      migrationsDirectory: await stageMigrationsBelow(23)
    });
    pool = new Pool({ connectionString: scoped, max: 4 });
  }, 180_000);

  afterAll(async () => {
    await settleAll([
      async () => pool?.end(),
      async () => (staging ? rm(staging, { recursive: true, force: true }) : undefined),
      async () => adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`),
      async () => adminPool?.end()
    ]);
  });

  it('adopts unambiguous history, leaves a duplicated pair null, and completes', async () => {
    await pool.query(
      `INSERT INTO users (user_id, email, credits) VALUES ('mig-user', 'mig@test.invalid', 0)`
    );
    await pool.query(
      `INSERT INTO orders (
         order_id, user_id, order_type, product_code, product_snapshot, credits,
         amount_cents, currency, idempotency_key, status
       ) VALUES
         ($1, 'mig-user', 'letter_pack', 'credit-pack-4', '{}'::jsonb, 4, 500, 'usd',
          'pack-checkout:clean', 'fulfilled'),
         ($2, 'mig-user', 'letter_pack', 'credit-pack-4', '{}'::jsonb, 4, 500, 'usd',
          'pack-checkout:dup', 'fulfilled')`,
      [CLEAN_ORDER, DUPLICATED_ORDER]
    );
    // Pre-023 history: source_order_id does not exist yet, so the only link
    // back to the order is source_reference_id.
    await pool.query(
      `INSERT INTO credit_ledger (
         ledger_id, user_id, initial_amount, remaining_amount, source_type,
         source_reference_id, expires_at
       ) VALUES
         (gen_random_uuid(), 'mig-user', 4, 4, 'purchase', $1, NOW() + INTERVAL '365 days'),
         (gen_random_uuid(), 'mig-user', 4, 4, 'purchase', $2, NOW() + INTERVAL '365 days'),
         (gen_random_uuid(), 'mig-user', 4, 4, 'purchase', $2, NOW() + INTERVAL '365 days')`,
      [CLEAN_ORDER, DUPLICATED_ORDER]
    );

    // The whole point: this must not abort.
    await expect(
      migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations })
    ).resolves.toBeUndefined();

    const adopted = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM credit_ledger WHERE source_order_id = $1`,
      [CLEAN_ORDER]
    );
    expect(Number(adopted.rows[0].count)).toBe(1);

    const abstained = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM credit_ledger
       WHERE source_reference_id = $1 AND source_order_id IS NULL`,
      [DUPLICATED_ORDER]
    );
    expect(Number(abstained.rows[0].count)).toBe(2);

    // And the index the backfill was protecting is actually there afterwards.
    const index = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND indexname = 'idx_credit_ledger_purchase_order_unique'`,
      [schema]
    );
    expect(index.rowCount).toBe(1);

    // 027 is BEFORE INSERT, so the surviving NULL rows are still spendable. A
    // CHECK constraint here - even NOT VALID - would raise on this UPDATE and
    // make every legacy lot unspendable, which is why it is a trigger.
    await expect(
      pool.query(
        `UPDATE credit_ledger SET remaining_amount = remaining_amount - 1
         WHERE source_reference_id = $1 AND source_order_id IS NULL`,
        [DUPLICATED_ORDER]
      )
    ).resolves.toMatchObject({ rowCount: 2 });
  }, 180_000);
});
