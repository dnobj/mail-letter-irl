import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * A refund issued from the Stripe Dashboard reaches Letter IRL only as a
 * webhook. Nothing else deducts the letters: the reconciliation sweep flags an
 * unprocessed refund but never applies it. So the handler's behaviour on the
 * events an operator will actually produce IS the refund feature, and these
 * tests drive it against real PostgreSQL rather than a mocked query log.
 *
 * The approved policy (#150, see disputeRevocation.postgres.test.ts) is that a
 * refund claws back UNSPENT letters only, floored at zero, and leaves mail that
 * already went out alone. Two consequences are easy to lose and are pinned here:
 *
 *   - a PARTIAL refund is deliberately ignored, and the order event says so;
 *     until a partial-refund policy exists the customer keeps both the money
 *     and the letters, and the test that documents that must fail the day the
 *     policy changes;
 *   - a refund that Stripe reports as PENDING parks the order and touches no
 *     balance; only the later success revokes.
 */

const { Pool } = pg;
const enabled = process.env.LIRL_RUN_POSTGRES_INTEGRATION === 'true';
const describePostgres = enabled ? describe : describe.skip;

const PACK_AMOUNT_CENTS = 1999;

function schemaName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function databaseUrlForSchema(baseUrl: string, schema: string): string {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}

function stripeId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** `charge.refunded`, as the Dashboard produces it: a Charge with amount_refunded. */
function chargeRefundedEvent(
  paymentIntentId: string,
  amountRefunded: number,
  eventId = stripeId('evt')
): Stripe.Event {
  const charge = {
    id: stripeId('ch'),
    object: 'charge',
    payment_intent: paymentIntentId,
    amount: PACK_AMOUNT_CENTS,
    amount_refunded: amountRefunded
  } as unknown as Stripe.Charge;
  return { id: eventId, type: 'charge.refunded', data: { object: charge } } as unknown as Stripe.Event;
}

/** `refund.created` / `refund.updated`: a Refund object carrying its own status. */
function refundEvent(
  type: 'refund.created' | 'refund.updated',
  paymentIntentId: string,
  refundId: string,
  status: 'pending' | 'succeeded',
  amount = PACK_AMOUNT_CENTS
): Stripe.Event {
  const refund = {
    id: refundId,
    object: 'refund',
    payment_intent: paymentIntentId,
    charge: stripeId('ch'),
    status,
    amount
  } as unknown as Stripe.Refund;
  return { id: stripeId('evt'), type, data: { object: refund } } as unknown as Stripe.Event;
}

describePostgres('pack refunds issued from the Stripe Dashboard', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let commerceService: typeof import('../../src/services/commerceService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_packrefund');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 8 });

    process.env.DATABASE_URL = scoped;
    commerceService = await import('../../src/services/commerceService.js');
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

  /**
   * A user who paid for a pack and has already spent part of it. Two internal
   * credits are one letter, so credits: 4, spent: 2 is a two-letter pack with
   * one letter mailed.
   */
  async function seedPackHolder(options: {
    credits: number;
    spent?: number;
  }): Promise<{ userId: string; orderId: string; paymentIntentId: string }> {
    const userId = `user_${randomUUID()}`;
    const orderId = `order_${randomUUID()}`;
    const paymentIntentId = stripeId('pi');
    const spent = options.spent ?? 0;
    const remaining = options.credits - spent;

    await pool.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, `${userId}@test.invalid`, remaining, options.credits, spent]
    );
    await pool.query(
      `INSERT INTO orders (
         order_id, user_id, credits, amount_cents, currency,
         stripe_payment_intent_id, status, order_type,
         product_code, idempotency_key
       ) VALUES ($1, $2, $3, $4, 'USD', $5, 'fulfilled', 'letter_pack', $6, $7)`,
      [orderId, userId, options.credits, PACK_AMOUNT_CENTS, paymentIntentId, 'starter', `idem_${orderId}`]
    );
    await pool.query(
      `INSERT INTO credit_ledger (
         user_id, initial_amount, remaining_amount, source_type,
         source_reference_id, source_order_id, activated_at, expires_at,
         expiration_policy, status
       ) VALUES ($1, $2, $3, 'purchase', $4, $4, NOW(), NOW() + INTERVAL '730 days',
                 'days_from_activation', 'active')`,
      [userId, options.credits, remaining, orderId]
    );
    return { userId, orderId, paymentIntentId };
  }

  async function readUser(userId: string) {
    const result = await pool.query<{ credits: number; credits_purchased: number }>(
      'SELECT credits, credits_purchased FROM users WHERE user_id = $1',
      [userId]
    );
    return result.rows[0];
  }

  async function readOrder(orderId: string) {
    const result = await pool.query<{
      status: string;
      refunded_at: Date | null;
      refund_pending_at: Date | null;
      stripe_refund_id: string | null;
    }>(
      'SELECT status, refunded_at, refund_pending_at, stripe_refund_id FROM orders WHERE order_id = $1',
      [orderId]
    );
    return result.rows[0];
  }

  async function purchaseLot(userId: string) {
    const result = await pool.query<{ status: string; remaining_amount: number }>(
      `SELECT status, remaining_amount FROM credit_ledger
        WHERE user_id = $1 AND source_type = 'purchase'`,
      [userId]
    );
    expect(result.rowCount).toBe(1);
    return result.rows[0];
  }

  function parseJson(value: unknown): Record<string, unknown> {
    return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
  }

  async function refundAuditRows(userId: string) {
    const result = await pool.query<{
      initial_amount: number;
      remaining_amount: number;
      status: string;
      source_metadata: unknown;
    }>(
      `SELECT initial_amount, remaining_amount, status, source_metadata
         FROM credit_ledger WHERE user_id = $1 AND source_type = 'refund'`,
      [userId]
    );
    return result.rows.map(row => ({ ...row, metadata: parseJson(row.source_metadata) }));
  }

  async function orderEvents(orderId: string) {
    const result = await pool.query<{
      event_type: string;
      from_status: string | null;
      to_status: string | null;
      metadata: unknown;
    }>(
      'SELECT event_type, from_status, to_status, metadata FROM commerce_order_events WHERE order_id = $1',
      [orderId]
    );
    return result.rows.map(row => ({ ...row, metadata: parseJson(row.metadata) }));
  }

  async function creditTransactions(userId: string) {
    const result = await pool.query<{ amount: number; balance_after: number; type: string }>(
      'SELECT amount, balance_after, type FROM credit_transactions WHERE user_id = $1',
      [userId]
    );
    return result.rows;
  }

  it('a full refund claws back only the unspent letters and leaves sent mail alone', async () => {
    const { userId, orderId, paymentIntentId } = await seedPackHolder({ credits: 4, spent: 2 });

    const result = await commerceService.processStripeWebhookEvent(
      chargeRefundedEvent(paymentIntentId, PACK_AMOUNT_CENTS)
    );

    expect(result).toMatchObject({ duplicate: false, orderId, status: 'refunded' });

    const user = await readUser(userId);
    expect(user.credits).toBe(0);
    // Lifetime purchases lose the whole pack; the balance loses only what was left.
    expect(user.credits_purchased).toBe(0);

    expect(await purchaseLot(userId)).toEqual({ status: 'revoked', remaining_amount: 0 });

    const audit = await refundAuditRows(userId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ initial_amount: 4, remaining_amount: 0, status: 'revoked' });
    expect(audit[0].metadata).toMatchObject({
      reason: 'payment_refunded',
      order_id: orderId,
      remaining_at_revocation: 2
    });

    expect(await creditTransactions(userId)).toEqual([
      { amount: -2, balance_after: 0, type: 'refund' }
    ]);

    const order = await readOrder(orderId);
    expect(order.status).toBe('refunded');
    expect(order.refunded_at).not.toBeNull();
    // A Charge event carries no refund id; nothing is invented for it.
    expect(order.stripe_refund_id).toBeNull();
  }, 60_000);

  it('a fully spent pack refunds to a zero balance, never below it', async () => {
    const { userId, orderId, paymentIntentId } = await seedPackHolder({ credits: 4, spent: 4 });

    await commerceService.processStripeWebhookEvent(
      chargeRefundedEvent(paymentIntentId, PACK_AMOUNT_CENTS)
    );

    expect((await readUser(userId)).credits).toBe(0);
    expect(await purchaseLot(userId)).toEqual({ status: 'revoked', remaining_amount: 0 });
    // Nothing was left to take back, so no balance movement is booked...
    expect(await creditTransactions(userId)).toEqual([]);
    // ...but the revocation itself is still on record, with zero to restore.
    const audit = await refundAuditRows(userId);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ remaining_at_revocation: 0 });
    expect((await readOrder(orderId)).status).toBe('refunded');
  }, 60_000);

  it('a partial refund is recorded as ignored and moves nothing', async () => {
    const { userId, orderId, paymentIntentId } = await seedPackHolder({ credits: 4 });

    const result = await commerceService.processStripeWebhookEvent(
      chargeRefundedEvent(paymentIntentId, 999)
    );

    // The handler reports the order as it found it.
    expect(result).toMatchObject({ duplicate: false, orderId, status: 'fulfilled' });

    expect((await readUser(userId)).credits).toBe(4);
    expect(await purchaseLot(userId)).toEqual({ status: 'active', remaining_amount: 4 });
    expect(await refundAuditRows(userId)).toEqual([]);
    expect(await creditTransactions(userId)).toEqual([]);

    const order = await readOrder(orderId);
    expect(order.status).toBe('fulfilled');
    expect(order.refunded_at).toBeNull();
    expect(order.refund_pending_at).toBeNull();

    // The one durable trace: an order event that says the refund was seen and
    // deliberately not acted on. Delete this and a partial refund vanishes.
    const events = await orderEvents(orderId);
    expect(events).toContainEqual(
      expect.objectContaining({
        event_type: 'charge.refunded',
        from_status: 'fulfilled',
        to_status: 'fulfilled',
        metadata: expect.objectContaining({
          ignored: true,
          reason: 'partial_refund',
          refundedAmount: 999
        })
      })
    );
  }, 60_000);

  it('a pending refund parks the order, and only the later success revokes', async () => {
    const { userId, orderId, paymentIntentId } = await seedPackHolder({ credits: 4 });
    const refundId = stripeId('re');

    const pending = await commerceService.processStripeWebhookEvent(
      refundEvent('refund.created', paymentIntentId, refundId, 'pending')
    );
    expect(pending).toMatchObject({ status: 'refund_pending' });

    expect((await readUser(userId)).credits).toBe(4);
    expect(await purchaseLot(userId)).toEqual({ status: 'active', remaining_amount: 4 });
    let order = await readOrder(orderId);
    expect(order.status).toBe('refund_pending');
    expect(order.refund_pending_at).not.toBeNull();
    expect(order.refunded_at).toBeNull();
    expect(order.stripe_refund_id).toBe(refundId);

    const succeeded = await commerceService.processStripeWebhookEvent(
      refundEvent('refund.updated', paymentIntentId, refundId, 'succeeded')
    );
    expect(succeeded).toMatchObject({ status: 'refunded' });

    expect((await readUser(userId)).credits).toBe(0);
    expect(await purchaseLot(userId)).toEqual({ status: 'revoked', remaining_amount: 0 });
    order = await readOrder(orderId);
    expect(order.status).toBe('refunded');
    expect(order.refunded_at).not.toBeNull();
    expect(order.stripe_refund_id).toBe(refundId);
  }, 60_000);

  it('replays are duplicates, and a second event for the same refund revokes nothing more', async () => {
    const { userId, orderId, paymentIntentId } = await seedPackHolder({ credits: 4, spent: 2 });
    const eventId = stripeId('evt');

    await commerceService.processStripeWebhookEvent(
      chargeRefundedEvent(paymentIntentId, PACK_AMOUNT_CENTS, eventId)
    );
    expect((await readUser(userId)).credits).toBe(0);

    // Stripe's "Resend" of the same event.
    const replay = await commerceService.processStripeWebhookEvent(
      chargeRefundedEvent(paymentIntentId, PACK_AMOUNT_CENTS, eventId)
    );
    expect(replay).toEqual({ duplicate: true });

    // Stripe also delivers refund.updated for the same refund, under a new event id.
    const sibling = await commerceService.processStripeWebhookEvent(
      refundEvent('refund.updated', paymentIntentId, stripeId('re'), 'succeeded')
    );
    expect(sibling).toMatchObject({ duplicate: false, orderId, status: 'refunded' });

    const user = await readUser(userId);
    expect(user.credits).toBe(0);
    expect(user.credits_purchased).toBe(0);
    expect(await refundAuditRows(userId)).toHaveLength(1);
    expect(await creditTransactions(userId)).toHaveLength(1);
    expect(await orderEvents(orderId)).toContainEqual(
      expect.objectContaining({
        event_type: 'refund.updated',
        metadata: expect.objectContaining({ ignored: true, reason: 'already_refunded' })
      })
    );
  }, 60_000);
});
