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
 * The issue was written when the only protection was a check-then-insert in
 * application code. Since then four independent layers have landed, and none
 * of them has a test that proves it holds:
 *
 *   1. claimStripeEvent  INSERT ... ON CONFLICT (event_id) DO NOTHING
 *   2. findCheckoutOrder SELECT ... FOR UPDATE on the order row
 *   3. transitionPaidCheckout returns early for FUNDED_OR_REVERSED statuses
 *   4. migration 023's partial unique index on credit_ledger(source_order_id)
 *
 * This suite exists to establish, with evidence rather than by reading, which
 * of those actually stop a double grant - and to leave a red test behind if any
 * of them is ever removed. Every case below is a case the issue names.
 *
 * Real PostgreSQL is mandatory here and a mocked client would be actively
 * misleading: three of the four layers ARE database behaviour (conflict
 * resolution, row locking, a partial index). A mock would report every one of
 * them working while none of them existed.
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
    await closeServicePool?.();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE commerce_operational_alerts, stripe_webhook_events, commerce_order_events,
                credit_consumption, credit_transactions, credit_ledger,
                image_entitlements, orders, users
       RESTART IDENTITY CASCADE`
    );
  });

  /** A user plus a pack order parked at checkout_pending, ready to be paid. */
  async function seedPendingPackOrder(): Promise<{
    userId: string; orderId: string; sessionId: string;
  }> {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const userId = `user_${suffix}`;
    const orderId = `order_${suffix}`;
    const sessionId = `cs_${suffix}`;
    await pool.query(`INSERT INTO users (user_id, email, credits) VALUES ($1, $2, 0)`, [
      userId,
      `${userId}@test.invalid`
    ]);
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

  async function purchaseLedgerRows(orderId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM credit_ledger
       WHERE source_order_id = $1 AND source_type = 'purchase'`,
      [orderId]
    );
    return Number(rows[0].count);
  }

  async function orderStatus(orderId: string): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM orders WHERE order_id = $1`,
      [orderId]
    );
    return rows[0].status;
  }

  async function totalCreditsRemaining(userId: string): Promise<number> {
    const { rows } = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(remaining_amount), 0)::text AS total
       FROM credit_ledger WHERE user_id = $1`,
      [userId]
    );
    return Number(rows[0].total);
  }

  it('grants exactly once for a single delivery, as the baseline', async () => {
    const { userId, orderId, sessionId } = await seedPendingPackOrder();

    // The whole shape, not a subset: `status` is what the webhook handler
    // reports back to Stripe, and a grant that silently stopped short of
    // fulfilled would still satisfy an assertion on `duplicate` alone.
    await expect(
      commerce.processStripeWebhookEvent(paidEvent({ eventId: `evt_${sessionId}`, sessionId }) as never)
    ).resolves.toEqual({ duplicate: false, orderId, status: 'fulfilled' });

    expect(await purchaseLedgerRows(orderId)).toBe(1);
    expect(await totalCreditsRemaining(userId)).toBe(PACK_CREDITS);
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
    await expect(commerce.processStripeWebhookEvent(event as never)).resolves.toEqual({
      duplicate: true
    });

    expect(await purchaseLedgerRows(orderId)).toBe(1);
    expect(await totalCreditsRemaining(userId)).toBe(PACK_CREDITS);
  });

  it('grants once when TWO DIFFERENT event ids arrive for the same session', async () => {
    // The event-id claim cannot help here: both events claim successfully.
    // Only the order-row lock plus the funded-status guard stop the second
    // grant, which is the layer the issue is actually about.
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

    expect(await purchaseLedgerRows(orderId)).toBe(1);
    expect(await totalCreditsRemaining(userId)).toBe(PACK_CREDITS);
  });

  it('grants once under CONCURRENT delivery of the same event id', async () => {
    const { userId, orderId, sessionId } = await seedPendingPackOrder();
    const event = paidEvent({ eventId: `evt_${sessionId}`, sessionId });

    // Genuinely simultaneous: two connections out of the service pool, neither
    // awaited before the other starts.
    const outcomes = await Promise.allSettled([
      commerce.processStripeWebhookEvent(event as never),
      commerce.processStripeWebhookEvent(event as never)
    ]);

    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(2);
    expect(await purchaseLedgerRows(orderId)).toBe(1);
    expect(await totalCreditsRemaining(userId)).toBe(PACK_CREDITS);
  });

  it('grants once under CONCURRENT delivery of two different event ids', async () => {
    // The worst case the issue names: two deliveries racing with nothing in
    // common but the order they both want to fund.
    const { userId, orderId, sessionId } = await seedPendingPackOrder();

    await Promise.allSettled([
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

    expect(await purchaseLedgerRows(orderId)).toBe(1);
    expect(await totalCreditsRemaining(userId)).toBe(PACK_CREDITS);
  });

  it('refuses a CONFLICTING amount for the same session and grants nothing', async () => {
    const { userId, orderId, sessionId } = await seedPendingPackOrder();

    await commerce.processStripeWebhookEvent(
      paidEvent({ eventId: `evt_${sessionId}`, sessionId, amountCents: 100 }) as never
    );

    expect(await purchaseLedgerRows(orderId)).toBe(0);
    expect(await totalCreditsRemaining(userId)).toBe(0);
    expect(await orderStatus(orderId)).toBe('refund_pending');
  });

  it('refuses a CONFLICTING currency for the same session and grants nothing', async () => {
    const { userId, orderId, sessionId } = await seedPendingPackOrder();

    await commerce.processStripeWebhookEvent(
      paidEvent({ eventId: `evt_${sessionId}`, sessionId, currency: 'gbp' }) as never
    );

    expect(await purchaseLedgerRows(orderId)).toBe(0);
    expect(await totalCreditsRemaining(userId)).toBe(0);
    expect(await orderStatus(orderId)).toBe('refund_pending');
  });

  it('leaves a mismatched payment for an operator instead of auto-refunding it', async () => {
    // Acceptance criterion 4 is "rejected AND observable". Rejection is the
    // test above; this is the observability half, and the more dangerous one.
    //
    // The maintenance sweep refunds refund_pending orders automatically, and
    // excludes PAYMENT_AMOUNT_MISMATCH by one clause. Without that clause any
    // Stripe-side amount change - a promo code, adaptive pricing, tax - would
    // push real customers into the quarantine and the sweep would mass-refund
    // every one of them with no human in the loop (#278 round 7). This test is
    // what reddens if the clause is edited out.
    const { orderId, sessionId } = await seedPendingPackOrder();
    await commerce.processStripeWebhookEvent(
      paidEvent({ eventId: `evt_${sessionId}`, sessionId, amountCents: 100 }) as never
    );
    // The sweep also requires a payment intent, so the order qualifies on
    // every count except the exclusion under test.
    const { rows } = await pool.query<{ intent: string | null }>(
      `SELECT stripe_payment_intent_id AS intent FROM orders WHERE order_id = $1`,
      [orderId]
    );
    expect(rows[0].intent).not.toBeNull();
    // orders carries a BEFORE UPDATE trigger that rewrites updated_at to NOW(),
    // so ageing the row means suspending it for exactly this statement. That
    // the column cannot be back-dated by an ordinary UPDATE is a property worth
    // having - it is what makes the stuck-order clock trustworthy - but it does
    // mean a test cannot simulate the passage of time without saying so.
    await pool.query('ALTER TABLE orders DISABLE TRIGGER update_orders_updated_at');
    try {
      await pool.query(
        `UPDATE orders SET updated_at = NOW() - INTERVAL '90 minutes' WHERE order_id = $1`,
        [orderId]
      );
    } finally {
      await pool.query('ALTER TABLE orders ENABLE TRIGGER update_orders_updated_at');
    }

    const maintenance = await commerce.runCommerceMaintenance();

    expect(maintenance.refundAttempts).toBe(0);
    // And it is not silently parked either: the stuck-order alarm is what
    // brings an operator to it.
    expect(maintenance.stuckOrders).toBeGreaterThanOrEqual(1);
    expect(await orderStatus(orderId)).toBe('refund_pending');
  });

  it('rejects a second purchase ledger row for one order at the DATABASE boundary', async () => {
    // Layer 4 on its own, with the application code removed from the picture.
    // If migration 023's partial index is ever dropped or its predicate edited,
    // this is the test that reddens.
    const { userId, orderId, sessionId } = await seedPendingPackOrder();
    await commerce.processStripeWebhookEvent(
      paidEvent({ eventId: `evt_${sessionId}`, sessionId }) as never
    );

    await expect(
      pool.query(
        `INSERT INTO credit_ledger (
           ledger_id, user_id, initial_amount, remaining_amount, source_type,
           source_reference_id, source_order_id, expires_at
         ) VALUES (gen_random_uuid(), $1, $2, $2, 'purchase', $3, $3,
                   NOW() + INTERVAL '365 days')`,
        [userId, PACK_CREDITS, orderId]
      )
    ).rejects.toMatchObject({ code: '23505' });

    expect(await purchaseLedgerRows(orderId)).toBe(1);
  });

  it('does NOT constrain purchase rows whose source_order_id is null', async () => {
    // Migration 023 backfilled only unambiguous history and left the rest NULL,
    // and the index is partial on `source_order_id IS NOT NULL`. So pre-023
    // rows sit permanently outside the constraint. This is the residual gap
    // behind acceptance criterion 5, pinned here so it is a known shape rather
    // than a surprise: if a future migration closes it, this test reddens and
    // should be deleted.
    const { userId } = await seedPendingPackOrder();

    for (let i = 0; i < 2; i += 1) {
      await pool.query(
        `INSERT INTO credit_ledger (
           ledger_id, user_id, initial_amount, remaining_amount, source_type,
           source_reference_id, source_order_id, expires_at
         ) VALUES (gen_random_uuid(), $1, $2, $2, 'purchase', 'legacy-ref', NULL,
                   NOW() + INTERVAL '365 days')`,
        [userId, PACK_CREDITS]
      );
    }

    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM credit_ledger
       WHERE user_id = $1 AND source_order_id IS NULL AND source_type = 'purchase'`,
      [userId]
    );
    expect(Number(rows[0].count)).toBe(2);
  });

  it('never double-grants an order stranded at paid, whatever the call reports', async () => {
    // `paid` is deliberately absent from FUNDED_OR_REVERSED_ORDER_STATUSES, so
    // the application guard does NOT fire for an order left in that state. The
    // invariant asserted here is the one that matters regardless of how the
    // call resolves: the customer is not credited twice.
    const { userId, orderId, sessionId } = await seedPendingPackOrder();
    await commerce.processStripeWebhookEvent(
      paidEvent({ eventId: `evt_${sessionId}`, sessionId }) as never
    );
    await pool.query(`UPDATE orders SET status = 'paid' WHERE order_id = $1`, [orderId]);

    await Promise.allSettled([
      commerce.processStripeWebhookEvent(
        paidEvent({ eventId: `evt_replay_${sessionId}`, sessionId }) as never
      )
    ]);

    expect(await purchaseLedgerRows(orderId)).toBe(1);
    expect(await totalCreditsRemaining(userId)).toBe(PACK_CREDITS);
  });
});

/**
 * Migration 023 applied to a database that ALREADY contains a double grant.
 *
 * This is the last case #152's test mandate names, and it needs its own
 * database because the point is the state of the schema BEFORE 023 exists:
 * `credit_ledger.source_order_id` has not been added yet, so historical rows
 * carry only `source_reference_id`.
 *
 * The property under test is that 023 is safe to deploy over real history. Its
 * backfill adopts only unambiguous rows - exactly one purchase row pointing at
 * one order - and leaves anything already duplicated NULL, so the unique index
 * it then creates cannot fail on, or silently paper over, a pre-existing
 * double grant. A migration that aborted here would block every later
 * migration on any database that had ever double-granted.
 */
describePostgres('migration 023 over pre-existing duplicate grants (#152)', () => {
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
    await pool?.end();
    if (staging) await rm(staging, { recursive: true, force: true });
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
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
  }, 180_000);
});

