import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Issue #188 - finalize a refund instead of throwing after the money has gone.
 *
 * `requestRefund` asks Stripe for the refund and THEN records it. The recording
 * statement bound one parameter both to `status` (a varchar column) and to a
 * comparison against a bare literal, which PostgreSQL refuses to plan at all -
 * so every refund threw after Stripe had already paid the customer back. The
 * catch recorded REFUND_REQUEST_FAILED, the order stayed `refund_pending`, and
 * the pack revocation underneath never ran: refunded customers kept their
 * credits.
 *
 * The statement is the thing under test, so these run against real PostgreSQL.
 * A mocked `pg` cannot fail this way and never did - which is exactly how the
 * defect survived. Only the Stripe boundary is substituted, through the
 * injection seam the function takes; the database, the transaction and the
 * revocation are real.
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

describePostgres('refund finalization', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let commerce: typeof import('../../src/services/commerceService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_refundfin');
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

  /** A paid pack sitting at refund_pending, with credits and an entitlement. */
  async function seedRefundablePack(credits = 6): Promise<{
    userId: string;
    orderId: string;
    paymentIntentId: string;
  }> {
    const userId = `user_${randomUUID()}`;
    const orderId = `order_${randomUUID()}`;
    const paymentIntentId = `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

    await pool.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased)
       VALUES ($1, $2, $3, $3)`,
      [userId, `${userId}@test.invalid`, credits]
    );
    await pool.query(
      `INSERT INTO orders (
         order_id, user_id, credits, amount_cents, currency,
         stripe_payment_intent_id, status, order_type, product_code,
         idempotency_key, refund_attempts
       ) VALUES ($1, $2, $3, 1999, 'USD', $4, 'refund_pending', 'letter_pack',
                 'starter', $5, 0)`,
      [orderId, userId, credits, paymentIntentId, `idem_${orderId}`]
    );
    await pool.query(
      `INSERT INTO credit_ledger (
         user_id, initial_amount, remaining_amount, source_type,
         source_reference_id, source_order_id, activated_at, expires_at,
         expiration_policy, status
       ) VALUES ($1, $2, $2, 'purchase', $3, $3, NOW(), NOW() + INTERVAL '730 days',
                 'days_from_activation', 'active')`,
      [userId, credits, orderId]
    );
    return { userId, orderId, paymentIntentId };
  }

  /** Stripe answering that the refund went through. */
  function refundOperations(status: Stripe.Refund['status']): {
    retrieveRefund: (id: string) => Promise<Stripe.Refund>;
    findPaymentRefund: () => Promise<{ live: Stripe.Refund | null; ended: Stripe.Refund | null }>;
    createPaymentRefund: () => Promise<Stripe.Refund>;
  } {
    const refund = {
      id: `re_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      object: 'refund',
      status
    } as unknown as Stripe.Refund;
    return {
      retrieveRefund: async () => refund,
      findPaymentRefund: async () => ({ live: null, ended: null }),
      createPaymentRefund: async () => refund
    };
  }

  async function readOrder(orderId: string) {
    const result = await pool.query<{
      status: string;
      refunded_at: Date | null;
      stripe_refund_id: string | null;
      last_error_code: string | null;
    }>(
      `SELECT status, refunded_at, stripe_refund_id, last_error_code
         FROM orders WHERE order_id = $1`,
      [orderId]
    );
    return result.rows[0];
  }

  it('records the refund and revokes the pack', async () => {
    const { userId, orderId } = await seedRefundablePack(6);

    const finalized = await commerce.requestRefund(orderId, refundOperations('succeeded'));

    // Before the cast, this returned false: the statement threw after Stripe
    // had already paid the customer back.
    expect(finalized).toBe(true);

    const order = await readOrder(orderId);
    expect(order.status).toBe('refunded');
    expect(order.refunded_at).not.toBeNull();
    expect(order.stripe_refund_id).not.toBeNull();
    expect(order.last_error_code).toBeNull();

    // The whole point of finalizing: the credits go back with the money.
    const account = await pool.query<{ credits: number }>(
      'SELECT credits FROM users WHERE user_id = $1', [userId]
    );
    expect(account.rows[0].credits).toBe(0);
    const live = await pool.query(
      `SELECT 1 FROM credit_ledger
        WHERE user_id = $1 AND source_type = 'purchase' AND status <> 'revoked'`,
      [userId]
    );
    expect(live.rowCount).toBe(0);

    const events = await pool.query(
      `SELECT 1 FROM commerce_order_events
        WHERE order_id = $1 AND event_type = 'refund.requested'`,
      [orderId]
    );
    expect(events.rowCount).toBe(1);
  }, 60_000);

  it('leaves an unfinished refund pending, without revoking anything', async () => {
    const { userId, orderId } = await seedRefundablePack(6);

    const finalized = await commerce.requestRefund(orderId, refundOperations('pending'));

    expect(finalized).toBe(true);

    // The other arm of the same CASE. Stripe has not settled, so the order
    // holds at refund_pending and the credits stay with the customer - they
    // have neither the money nor a revoked pack yet.
    const order = await readOrder(orderId);
    expect(order.status).toBe('refund_pending');
    expect(order.refunded_at).toBeNull();
    expect(order.stripe_refund_id).not.toBeNull();

    const account = await pool.query<{ credits: number }>(
      'SELECT credits FROM users WHERE user_id = $1', [userId]
    );
    expect(account.rows[0].credits).toBe(6);
    const live = await pool.query(
      `SELECT 1 FROM credit_ledger
        WHERE user_id = $1 AND source_type = 'purchase' AND status <> 'revoked'`,
      [userId]
    );
    expect(live.rowCount).toBe(1);
  }, 60_000);

  it('does not revoke twice when the same refund is finalized again', async () => {
    const { userId, orderId } = await seedRefundablePack(6);
    const operations = refundOperations('succeeded');

    await commerce.requestRefund(orderId, operations);

    // Make the claim depend on the settled status and nothing else. The
    // retry-delay throttle would otherwise refuse the replay on its own, and
    // the assertion below would hold even with the settled-status predicate
    // deleted - proving the throttle rather than the thing it names. Backdating
    // updated_at does not work: migration 021 puts a BEFORE UPDATE trigger on
    // orders that rewrites it. Zeroing the attempt counter satisfies the
    // throttle's other arm instead.
    await pool.query(
      `UPDATE orders SET refund_attempts = 0 WHERE order_id = $1`,
      [orderId]
    );

    // A retry after the order has settled must find nothing left to claim: the
    // claim predicate requires refund_pending. Replay is where a refund path
    // pays twice, so it is asserted rather than assumed.
    const second = await commerce.requestRefund(orderId, operations);
    expect(second).toBe(false);

    const account = await pool.query<{ credits: number; credits_purchased: number }>(
      'SELECT credits, credits_purchased FROM users WHERE user_id = $1', [userId]
    );
    expect(account.rows[0].credits).toBe(0);
    expect(account.rows[0].credits_purchased).toBe(0);
    const revocations = await pool.query(
      `SELECT 1 FROM credit_ledger WHERE user_id = $1 AND source_type = 'refund'`,
      [userId]
    );
    expect(revocations.rowCount).toBe(1);
  }, 60_000);

  /** A Refund event as Stripe sends it, for a refund made in the dashboard (no metadata). */
  function refundEvent(type: string, paymentIntentId: string, status: string, id = `re_${randomUUID().replace(/-/g, '').slice(0, 20)}`) {
    return {
      id: `evt_${randomUUID().replace(/-/g, '')}`,
      type,
      data: { object: { id, object: 'refund', status, amount: 1999, payment_intent: paymentIntentId, charge: null, metadata: {} } }
    } as unknown as Stripe.Event;
  }

  async function openAlerts(orderId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM commerce_operational_alerts
        WHERE order_id = $1 AND alert_type = 'refund_not_completed' AND status <> 'resolved'`,
      [orderId]
    );
    return rows[0].n;
  }

  it('holds an order when its full refund comes back cancelled, again after a resolved alert, and lets go once refunded (#730)', async () => {
    const { userId, orderId, paymentIntentId } = await seedRefundablePack(6);

    await commerce.processStripeWebhookEvent(refundEvent('refund.updated', paymentIntentId, 'canceled'));
    expect(await readOrder(orderId)).toMatchObject({ status: 'refund_pending', last_error_code: 'REFUND_NOT_COMPLETED' });
    expect(await openAlerts(orderId)).toBe(1);

    // A second failure while the alert is open adds none; after it is resolved, a new one opens.
    await commerce.processStripeWebhookEvent(refundEvent('refund.failed', paymentIntentId, 'failed'));
    expect(await openAlerts(orderId)).toBe(1);
    await pool.query(
      `UPDATE commerce_operational_alerts SET status = 'resolved', resolved_at = NOW(), resolution_code = 'test', updated_at = NOW()
        WHERE order_id = $1 AND alert_type = 'refund_not_completed'`,
      [orderId]
    );
    await commerce.processStripeWebhookEvent(refundEvent('refund.updated', paymentIntentId, 'canceled'));
    expect(await openAlerts(orderId)).toBe(1);

    // The person refunds again in Stripe, and it succeeds: the order completes,
    // the hold clears, and the open alert closes itself.
    await commerce.processStripeWebhookEvent(refundEvent('refund.created', paymentIntentId, 'succeeded'));
    const done = await readOrder(orderId);
    expect(done).toMatchObject({ status: 'refunded', last_error_code: null });
    expect(await openAlerts(orderId)).toBe(0);
    const closed = await pool.query<{ resolution_code: string }>(
      `SELECT resolution_code FROM commerce_operational_alerts
        WHERE order_id = $1 AND alert_type = 'refund_not_completed' ORDER BY created_at DESC LIMIT 1`,
      [orderId]
    );
    expect(closed.rows[0].resolution_code).toBe('order_refunded');
    const account = await pool.query<{ credits: number }>('SELECT credits FROM users WHERE user_id = $1', [userId]);
    expect(account.rows[0].credits).toBe(0);
  }, 60_000);

  it('holds an order whose refund was cancelled at Stripe for a person, once, and refunds nothing (#730)', async () => {
    const { userId, orderId } = await seedRefundablePack(6);
    await pool.query(`UPDATE orders SET stripe_refund_id = 're_cancelled' WHERE order_id = $1`, [orderId]);
    let created = 0;
    const operations = {
      retrieveRefund: async () => ({ id: 're_cancelled', object: 'refund', status: 'canceled' }) as unknown as Stripe.Refund,
      findPaymentRefund: async () => ({ live: null, ended: null }),
      createPaymentRefund: async () => {
        created += 1;
        throw new Error('no new refund may be made');
      }
    };

    expect(await commerce.requestRefund(orderId, operations)).toBe(false);
    const order = await readOrder(orderId);
    expect(order).toMatchObject({ status: 'refund_pending', last_error_code: 'REFUND_NOT_COMPLETED' });
    const alerts = async () =>
      (
        await pool.query<{ severity: string; details: { refundId: string; refundStatus: string } }>(
          `SELECT severity, details FROM commerce_operational_alerts
            WHERE order_id = $1 AND alert_type = 'refund_not_completed'`,
          [orderId]
        )
      ).rows;
    expect(await alerts()).toEqual([{ severity: 'critical', details: { refundId: 're_cancelled', refundStatus: 'canceled' } }]);

    // Held: the claim refuses it however soon it is asked again, and the
    // account keeps its letters until a person decides.
    await pool.query(`UPDATE orders SET refund_attempts = 0 WHERE order_id = $1`, [orderId]);
    expect(await commerce.requestRefund(orderId, operations)).toBe(false);
    expect(created).toBe(0);
    expect(await alerts()).toHaveLength(1);
    const account = await pool.query<{ credits: number }>('SELECT credits FROM users WHERE user_id = $1', [userId]);
    expect(account.rows[0].credits).toBe(6);
  }, 60_000);
});
