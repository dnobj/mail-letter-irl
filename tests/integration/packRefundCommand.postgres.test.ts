import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * The proportional-refund command (#323) against real PostgreSQL: the
 * transaction that revokes letters and records intent, the Stripe call under
 * the stored idempotency key, the settlement the webhook and the sweep share,
 * and the compensation when Stripe will not pay out.
 *
 * Stripe is a stub behind the PackRefundOperations seam, the way the JIT
 * refund suites substitute it. Everything else - lots, ledger audit rows,
 * balances, the command row, the operator audit row, alerts, order events,
 * uniqueness, and the tier predicate - is the real schema.
 */

const { Pool } = pg;
const enabled = process.env.LIRL_RUN_POSTGRES_INTEGRATION === 'true';
const describePostgres = enabled ? describe : describe.skip;

const COMMAND_ENV = {
  LETTER_IRL_DEPLOYMENT_ENVIRONMENT: 'development',
  LETTER_IRL_PACK_REFUND_COMMAND_ENABLED: 'true'
} as NodeJS.ProcessEnv;

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

type CreateParams = Parameters<
  typeof import('../../src/services/packRefundService.js')['livePackRefundOperations']['createPartialPaymentRefund']
>[0];

function refundFor(params: CreateParams, status: string, id = stripeId('re')): Stripe.Refund {
  return {
    id,
    object: 'refund',
    status,
    amount: params.amountCents,
    payment_intent: params.paymentIntentId,
    metadata: {
      orderId: params.orderId,
      packRefundId: params.packRefundId,
      lettersRefunded: String(params.lettersRefunded)
    }
  } as unknown as Stripe.Refund;
}

/** A Stripe seam that answers create with `status`, or throws what it is given. */
function stubStripe(options: {
  createStatus?: string;
  createError?: unknown;
  listed?: Stripe.Refund[];
}) {
  const created: CreateParams[] = [];
  const seam = {
    async createPartialPaymentRefund(params: CreateParams): Promise<Stripe.Refund> {
      created.push(params);
      if (options.createError) throw options.createError;
      return refundFor(params, options.createStatus ?? 'succeeded');
    },
    async listPaymentRefunds(): Promise<Stripe.Refund[]> {
      return options.listed ?? [];
    },
    async retrieveRefund(): Promise<Stripe.Refund> {
      throw new Error('retrieveRefund not expected in this case');
    }
  };
  return { seam, created };
}

function refundEvent(
  type: 'refund.updated' | 'refund.failed',
  refund: Stripe.Refund,
  eventId = stripeId('evt')
): Stripe.Event {
  return { id: eventId, type, data: { object: refund } } as unknown as Stripe.Event;
}

describePostgres('proportional pack refund command', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let packRefund: typeof import('../../src/services/packRefundService.js');
  let commerce: typeof import('../../src/services/commerceService.js');
  let tier: typeof import('../../src/services/tierService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_packcmd');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 8 });

    process.env.DATABASE_URL = scoped;
    packRefund = await import('../../src/services/packRefundService.js');
    commerce = await import('../../src/services/commerceService.js');
    tier = await import('../../src/services/tierService.js');
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

  /** A fulfilled pack with `spent` credits already used, priced at `amountCents`. */
  async function seedPackHolder(options: {
    credits: number;
    spent?: number;
    amountCents?: number;
  }): Promise<{ userId: string; orderId: string; paymentIntentId: string; sessionId: string }> {
    const userId = `user_${randomUUID()}`;
    const orderId = `order_${randomUUID()}`;
    const paymentIntentId = stripeId('pi');
    const sessionId = stripeId('cs');
    const spent = options.spent ?? 0;
    const remaining = options.credits - spent;
    const amountCents = options.amountCents ?? 1000;

    await pool.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, `${userId}@test.invalid`, remaining, options.credits, spent]
    );
    await pool.query(
      `INSERT INTO orders (
         order_id, user_id, credits, amount_cents, currency, stripe_payment_intent_id,
         stripe_checkout_session_id, status, order_type, product_code, idempotency_key
       ) VALUES ($1, $2, $3, $4, 'usd', $5, $6, 'fulfilled', 'letter_pack', $7, $8)`,
      [orderId, userId, options.credits, amountCents, paymentIntentId, sessionId, 'starter', `idem_${orderId}`]
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
    return { userId, orderId, paymentIntentId, sessionId };
  }

  function command(orderId: string, letters: number, key = `key-${randomUUID()}`) {
    return {
      orderId,
      letters,
      reasonCode: 'goodwill_unused',
      actor: { id: 'operator-test' },
      idempotencyKey: key,
      environment: 'development' as const
    };
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
      credits_refunded: number;
      amount_refunded_cents: number;
      refunded_at: Date | null;
    }>(
      'SELECT status, credits_refunded, amount_refunded_cents, refunded_at FROM orders WHERE order_id = $1',
      [orderId]
    );
    return result.rows[0];
  }

  async function lots(userId: string) {
    const result = await pool.query<{ source_type: string; status: string; remaining_amount: number }>(
      `SELECT source_type, status, remaining_amount FROM credit_ledger
        WHERE user_id = $1 AND source_type IN ('purchase', 'adjustment') ORDER BY created_at ASC`,
      [userId]
    );
    return result.rows;
  }

  function parseJson(value: unknown): Record<string, unknown> {
    return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
  }

  async function auditRows(userId: string) {
    const result = await pool.query<{ initial_amount: number; source_metadata: unknown }>(
      `SELECT initial_amount, source_metadata FROM credit_ledger
        WHERE user_id = $1 AND source_type = 'refund' ORDER BY created_at ASC`,
      [userId]
    );
    return result.rows.map(row => ({ initial_amount: row.initial_amount, metadata: parseJson(row.source_metadata) }));
  }

  async function commandRows(orderId: string) {
    const result = await pool.query<{
      pack_refund_id: string;
      status: string;
      stripe_refund_id: string | null;
      stripe_attempts: number;
      last_error_code: string | null;
      amount_cents: number;
      compensation_ledger_id: string | null;
    }>(
      `SELECT pack_refund_id, status, stripe_refund_id, stripe_attempts, last_error_code, amount_cents, compensation_ledger_id
         FROM commerce_pack_refunds WHERE order_id = $1 ORDER BY created_at ASC`,
      [orderId]
    );
    return result.rows;
  }

  async function alerts(orderId: string) {
    const result = await pool.query<{ alert_type: string; details: unknown }>(
      'SELECT alert_type, details FROM commerce_operational_alerts WHERE order_id = $1',
      [orderId]
    );
    return result.rows.map(row => ({ alert_type: row.alert_type, details: parseJson(row.details) }));
  }

  async function transactions(userId: string) {
    const result = await pool.query<{ amount: number; type: string }>(
      'SELECT amount, type FROM credit_transactions WHERE user_id = $1 ORDER BY created_at ASC',
      [userId]
    );
    return result.rows;
  }

  it('refunds 40 of 50 letters: letters first, then Stripe, then the confirmed figure', async () => {
    const { userId, orderId, paymentIntentId } = await seedPackHolder({ credits: 100, spent: 20, amountCents: 9000 });
    const stripe = stubStripe({ createStatus: 'succeeded' });

    const result = await packRefund.refundPackLetters(command(orderId, 40), stripe.seam, COMMAND_ENV);

    expect(result).toMatchObject({ status: 'succeeded', amountCents: 7200, replayed: false });
    expect(stripe.created).toEqual([
      {
        paymentIntentId,
        amountCents: 7200,
        orderId,
        packRefundId: result.packRefundId,
        lettersRefunded: 40,
        idempotencyKey: `pack-refund:${result.packRefundId}`
      }
    ]);

    expect(await readUser(userId)).toEqual({ credits: 0, credits_purchased: 20 });
    expect(await lots(userId)).toEqual([{ source_type: 'purchase', status: 'depleted', remaining_amount: 0 }]);
    const audit = await auditRows(userId);
    expect(audit).toHaveLength(1);
    expect(audit[0].initial_amount).toBe(80);
    expect(audit[0].metadata).toMatchObject({
      reason: 'partial_refund',
      pack_refund_id: result.packRefundId,
      letters_refunded: 40,
      credits_taken: 80
    });
    expect(await transactions(userId)).toEqual([{ amount: -80, type: 'refund' }]);
    expect(await readOrder(orderId)).toMatchObject({
      status: 'fulfilled',
      credits_refunded: 80,
      amount_refunded_cents: 7200,
      refunded_at: null
    });
    const rows = await commandRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'succeeded', amount_cents: 7200 });
    expect(rows[0].stripe_refund_id).toMatch(/^re_/);
    const operatorAudit = await pool.query(
      `SELECT 1 FROM commerce_operator_audit_events WHERE operation = 'pack_refund' AND target_type = 'order'`
    );
    expect(operatorAudit.rowCount).toBeGreaterThanOrEqual(1);
    const events = await pool.query<{ event_type: string }>(
      'SELECT event_type FROM commerce_order_events WHERE order_id = $1 ORDER BY created_at ASC',
      [orderId]
    );
    expect(events.rows.map(row => row.event_type)).toEqual(['pack_refund.letters_revoked', 'pack_refund.stripe_response']);
  }, 60_000);

  it('takes letters in consumption order across a failed-send return lot and the purchase lot', async () => {
    const { userId, orderId } = await seedPackHolder({ credits: 10, spent: 4, amountCents: 1000 });
    // Two credits came back from a failed send, expiring sooner than the pack.
    await pool.query(
      `INSERT INTO credit_ledger (
         user_id, initial_amount, remaining_amount, source_type, source_reference_id,
         source_metadata, activated_at, expires_at, expiration_policy, status
       ) VALUES ($1, 2, 2, 'adjustment', $2, $3, NOW(), NOW() + INTERVAL '100 days', 'days_from_activation', 'active')`,
      [userId, orderId, JSON.stringify({ reason: 'send_failed', order_id: orderId })]
    );
    await pool.query('UPDATE users SET credits = credits + 2 WHERE user_id = $1', [userId]);
    const stripe = stubStripe({ createStatus: 'succeeded' });

    const result = await packRefund.refundPackLetters(command(orderId, 3), stripe.seam, COMMAND_ENV);
    expect(result.status).toBe('succeeded');

    // 6 credits: all 2 of the sooner-expiring return lot, then 4 of the pack.
    const after = await lots(userId);
    expect(after).toContainEqual({ source_type: 'adjustment', status: 'depleted', remaining_amount: 0 });
    expect(after).toContainEqual({ source_type: 'purchase', status: 'active', remaining_amount: 2 });
    const audit = await auditRows(userId);
    expect(audit.map(row => row.initial_amount)).toEqual([2, 4]);
    expect((await readUser(userId)).credits).toBe(2);
  }, 60_000);

  it('refuses under real constraints, before anything moves', async () => {
    const { userId, orderId } = await seedPackHolder({ credits: 4, amountCents: 500 });
    const stripe = stubStripe({ createStatus: 'succeeded' });

    await expect(packRefund.refundPackLetters(command(orderId, 3), stripe.seam, COMMAND_ENV)).rejects.toMatchObject({
      code: 'PACK_REFUND_TOO_MANY_LETTERS'
    });
    await expect(packRefund.refundPackLetters(command(orderId, 2), stripe.seam, COMMAND_ENV)).rejects.toMatchObject({
      code: 'PACK_REFUND_WOULD_BE_FULL'
    });
    expect(stripe.created).toHaveLength(0);
    expect(await commandRows(orderId)).toEqual([]);
    expect((await readUser(userId)).credits).toBe(4);

    const first = await packRefund.refundPackLetters(command(orderId, 1), stripe.seam, COMMAND_ENV);
    expect(first.status).toBe('succeeded');
    // One proportional refund per pack: the second command is refused.
    await expect(packRefund.refundPackLetters(command(orderId, 1), stripe.seam, COMMAND_ENV)).rejects.toMatchObject({
      code: 'PACK_REFUND_ALREADY_ISSUED'
    });
    expect(stripe.created).toHaveLength(1);
  }, 60_000);

  it('refuses a disputed payment', async () => {
    const { orderId, paymentIntentId } = await seedPackHolder({ credits: 10 });
    await pool.query(
      `INSERT INTO stripe_disputes (dispute_id, charge_id, payment_intent_id, amount_cents, status)
       VALUES ($1, $2, $3, 1000, 'needs_response')`,
      [stripeId('dp'), stripeId('ch'), paymentIntentId]
    );
    const stripe = stubStripe({ createStatus: 'succeeded' });
    await expect(packRefund.refundPackLetters(command(orderId, 1), stripe.seam, COMMAND_ENV)).rejects.toMatchObject({
      code: 'PACK_REFUND_DISPUTED'
    });
    expect(stripe.created).toHaveLength(0);
  }, 60_000);

  it('compensates the customer with the original expiry when Stripe refuses outright', async () => {
    const { userId, orderId } = await seedPackHolder({ credits: 10, spent: 2, amountCents: 1000 });
    const stripe = stubStripe({
      createError: Object.assign(new Error('Charge has already been refunded'), { code: 'charge_already_refunded' })
    });

    const result = await packRefund.refundPackLetters(command(orderId, 2), stripe.seam, COMMAND_ENV);
    expect(result.status).toBe('compensated');

    // Balance and lifetime purchases are back where they were...
    expect(await readUser(userId)).toEqual({ credits: 8, credits_purchased: 10 });
    expect(await readOrder(orderId)).toMatchObject({ status: 'fulfilled', credits_refunded: 0, amount_refunded_cents: 0 });
    // ...through a new lot carrying the pack's expiry, not by editing history.
    const after = await lots(userId);
    expect(after).toContainEqual({ source_type: 'purchase', status: 'active', remaining_amount: 4 });
    expect(after).toContainEqual({ source_type: 'adjustment', status: 'active', remaining_amount: 4 });
    const expiry = await pool.query<{ purchase: Date; adjustment: Date }>(
      `SELECT (SELECT expires_at FROM credit_ledger WHERE user_id = $1 AND source_type = 'purchase') AS purchase,
              (SELECT expires_at FROM credit_ledger WHERE user_id = $1 AND source_type = 'adjustment') AS adjustment`,
      [userId]
    );
    expect(expiry.rows[0].adjustment.getTime()).toBe(expiry.rows[0].purchase.getTime());
    const rows = await commandRows(orderId);
    expect(rows[0]).toMatchObject({ status: 'compensated', last_error_code: 'charge_already_refunded' });
    expect(rows[0].compensation_ledger_id).not.toBeNull();
    expect(await alerts(orderId)).toContainEqual(
      expect.objectContaining({ alert_type: 'pack_refund_failed' })
    );
    expect((await transactions(userId)).map(row => row.amount)).toEqual([-4, 4]);
    // The slot is free again: a corrected command can be issued.
    const retry = await packRefund.refundPackLetters(command(orderId, 1), stubStripe({ createStatus: 'succeeded' }).seam, COMMAND_ENV);
    expect(retry.status).toBe('succeeded');
  }, 60_000);

  it('keeps the letters revoked when Stripe gives no answer, and the sweep adopts the refund by metadata', async () => {
    const { userId, orderId } = await seedPackHolder({ credits: 10, amountCents: 1000 });
    const flaky = stubStripe({
      createError: Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' })
    });

    const result = await packRefund.refundPackLetters(command(orderId, 2), flaky.seam, COMMAND_ENV);
    expect(result.status).toBe('letters_revoked');
    expect((await readUser(userId)).credits).toBe(6);
    expect((await commandRows(orderId))[0]).toMatchObject({ status: 'letters_revoked', stripe_attempts: 1 });

    // Make the row due, then sweep with a seam that lists the refund Stripe
    // did create: adopted, never created twice.
    await pool.query(
      `UPDATE commerce_pack_refunds SET updated_at = NOW() - INTERVAL '1 hour' WHERE pack_refund_id = $1`,
      [result.packRefundId]
    );
    const listed = refundFor(flaky.created[0], 'succeeded');
    const sweepSeam = stubStripe({ createStatus: 'succeeded', listed: [listed] });
    const swept = await packRefund.reconcilePackRefunds(sweepSeam.seam);
    expect(swept).toMatchObject({ adopted: 1, retried: 0 });
    expect(sweepSeam.created).toHaveLength(0);
    expect((await commandRows(orderId))[0]).toMatchObject({ status: 'succeeded', stripe_refund_id: listed.id });
    expect((await readOrder(orderId)).amount_refunded_cents).toBe(200);
  }, 60_000);

  it('settles once when the webhook hears first, and treats replays and siblings as no-ops', async () => {
    const { orderId } = await seedPackHolder({ credits: 10, amountCents: 1000 });
    const pendingStripe = stubStripe({ createStatus: 'pending' });
    const result = await packRefund.refundPackLetters(command(orderId, 2), pendingStripe.seam, COMMAND_ENV);
    expect(result.status).toBe('stripe_pending');

    const refund = refundFor(pendingStripe.created[0], 'succeeded', (await commandRows(orderId))[0].stripe_refund_id!);
    const eventId = stripeId('evt');
    await commerce.processStripeWebhookEvent(refundEvent('refund.updated', refund, eventId));
    expect((await commandRows(orderId))[0]).toMatchObject({ status: 'succeeded' });
    expect((await readOrder(orderId)).amount_refunded_cents).toBe(200);

    const replay = await commerce.processStripeWebhookEvent(refundEvent('refund.updated', refund, eventId));
    expect(replay).toEqual({ duplicate: true });
    await commerce.processStripeWebhookEvent(refundEvent('refund.updated', refund));
    expect((await readOrder(orderId)).amount_refunded_cents).toBe(200);
    expect(await alerts(orderId)).toEqual([]);
  }, 60_000);

  it('a Dashboard refund of the remainder after a proportional refund is the full refund', async () => {
    const { userId, orderId, paymentIntentId } = await seedPackHolder({ credits: 10, amountCents: 1000 });
    const stripe = stubStripe({ createStatus: 'succeeded' });
    await packRefund.refundPackLetters(command(orderId, 1), stripe.seam, COMMAND_ENV);
    expect(await readUser(userId)).toEqual({ credits: 8, credits_purchased: 8 });

    const remainder = {
      id: stripeId('re'),
      object: 'refund',
      status: 'succeeded',
      amount: 800,
      payment_intent: paymentIntentId,
      charge: stripeId('ch')
    } as unknown as Stripe.Refund;
    await commerce.processStripeWebhookEvent({ id: stripeId('evt'), type: 'refund.created', data: { object: remainder } } as unknown as Stripe.Event);

    expect(await readOrder(orderId)).toMatchObject({ status: 'refunded', amount_refunded_cents: 1000, credits_refunded: 2 });
    // Lifetime purchases drop by what the pack still represented (10 - 2), not by 10 again.
    expect(await readUser(userId)).toEqual({ credits: 0, credits_purchased: 0 });
    expect(await lots(userId)).toEqual([{ source_type: 'purchase', status: 'revoked', remaining_amount: 0 }]);
    expect(await alerts(orderId)).toEqual([]);
  }, 60_000);

  it('a refund that fails after settling is compensated and lowers the confirmed figure', async () => {
    const { userId, orderId } = await seedPackHolder({ credits: 10, amountCents: 1000 });
    const stripe = stubStripe({ createStatus: 'succeeded' });
    const result = await packRefund.refundPackLetters(command(orderId, 2), stripe.seam, COMMAND_ENV);
    expect((await readOrder(orderId)).amount_refunded_cents).toBe(200);

    const failed = {
      ...refundFor(stripe.created[0], 'failed', (await commandRows(orderId))[0].stripe_refund_id!),
      failure_reason: 'expired_or_canceled_card'
    } as unknown as Stripe.Refund;
    await commerce.processStripeWebhookEvent(refundEvent('refund.failed', failed));

    expect((await commandRows(orderId))[0]).toMatchObject({ status: 'compensated', last_error_code: 'STRIPE_REFUND_FAILED' });
    expect(await readUser(userId)).toEqual({ credits: 10, credits_purchased: 10 });
    expect(await readOrder(orderId)).toMatchObject({ credits_refunded: 0, amount_refunded_cents: 0 });
    expect(await alerts(orderId)).toContainEqual(
      expect.objectContaining({ alert_type: 'pack_refund_failed', details: expect.objectContaining({ packRefundId: result.packRefundId }) })
    );
  }, 60_000);

  it('a partially refunded pack still counts as a purchase for the tier', async () => {
    const { userId, orderId } = await seedPackHolder({ credits: 10, amountCents: 1000 });
    for (let i = 0; i < 2; i += 1) {
      await pool.query(
        `INSERT INTO credit_ledger (user_id, initial_amount, remaining_amount, source_type, source_reference_id,
           activated_at, expires_at, expiration_policy, status)
         VALUES ($1, 10, 10, 'purchase', $2, NOW() - INTERVAL '200 days', NOW() + INTERVAL '500 days', 'days_from_activation', 'active')`,
        [userId, `order_${randomUUID()}`]
      );
    }
    await packRefund.refundPackLetters(command(orderId, 1), stubStripe({ createStatus: 'succeeded' }).seam, COMMAND_ENV);
    const calculated = await tier.calculateUserTier(userId);
    expect(calculated.purchaseCount).toBe(3);
  }, 60_000);

  it('serialises two operators on the same pack: exactly one command lands', async () => {
    const { orderId } = await seedPackHolder({ credits: 10, amountCents: 1000 });
    const stripe = stubStripe({ createStatus: 'succeeded' });
    const outcomes = await Promise.allSettled([
      packRefund.refundPackLetters(command(orderId, 1, `key-a-${randomUUID()}`), stripe.seam, COMMAND_ENV),
      packRefund.refundPackLetters(command(orderId, 1, `key-b-${randomUUID()}`), stripe.seam, COMMAND_ENV)
    ]);
    const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled');
    const rejected = outcomes.filter(outcome => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'PACK_REFUND_ALREADY_ISSUED' });
    expect(stripe.created).toHaveLength(1);
    expect(await commandRows(orderId)).toHaveLength(1);
  }, 60_000);
});
