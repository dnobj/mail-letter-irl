import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Issue #150 - revoke Letter Packs on Stripe refunds and chargebacks.
 *
 * The approved policy splits the two, and these tests exist to hold that split
 * in place:
 *
 *   refund   -> claw back UNSPENT credits only, floor at zero, account untouched
 *   dispute  -> zero the pack balance AND block sends pending operator review
 *
 * The split is deliberate. A goodwill refund is customer-service initiated; a
 * chargeback is adversarial, and because letters cost real postage and printing
 * the exposure is physical goods rather than bookkeeping.
 *
 * These run against real PostgreSQL because the invariants here are transactional
 * - idempotency under replay, ordering, and the interaction between the ledger,
 * the users row and the dispute record cannot be proven against mocks.
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

/** Minimal Stripe dispute shaped for the fields the handler actually reads. */
function disputeFixture(overrides: Partial<Stripe.Dispute> & { id: string }): Stripe.Dispute {
  return {
    id: overrides.id,
    object: 'dispute',
    amount: 1999,
    charge: overrides.charge ?? `ch_${overrides.id}`,
    created: Math.floor(Date.now() / 1000),
    currency: 'usd',
    payment_intent: overrides.payment_intent ?? null,
    reason: 'fraudulent',
    status: 'needs_response',
    ...overrides
  } as unknown as Stripe.Dispute;
}

function disputeEvent(
  type: 'charge.dispute.created' | 'charge.dispute.closed',
  dispute: Stripe.Dispute,
  eventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 20)}`
): Stripe.Event {
  return { id: eventId, type, data: { object: dispute } } as unknown as Stripe.Event;
}

describePostgres('dispute and refund pack revocation', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let commerceService: typeof import('../../src/services/commerceService.js');
  let mailSendService: typeof import('../../src/services/mailSendService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_dispute');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 8 });

    process.env.DATABASE_URL = scoped;
    commerceService = await import('../../src/services/commerceService.js');
    mailSendService = await import('../../src/services/mailSendService.js');
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

  /** A user holding a purchased pack, with the ledger row that backs it. */
  async function seedPackHolder(options: {
    credits: number;
    spent?: number;
  }): Promise<{ userId: string; orderId: string; paymentIntentId: string }> {
    const userId = `user_${randomUUID()}`;
    const orderId = `order_${randomUUID()}`;
    const paymentIntentId = `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
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
       ) VALUES ($1, $2, $3, 1999, 'USD', $4, 'fulfilled', 'letter_pack', $5, $6)`,
      [orderId, userId, options.credits, paymentIntentId, 'starter', `idem_${orderId}`]
    );
    await pool.query(
      `INSERT INTO credit_ledger (
         user_id, initial_amount, remaining_amount, source_type,
         source_reference_id, activated_at, expiration_policy, status
       ) VALUES ($1, $2, $3, 'purchase', $4, NOW(), 'never', 'active')`,
      [userId, options.credits, remaining, orderId]
    );
    return { userId, orderId, paymentIntentId };
  }

  async function readAccount(userId: string) {
    const result = await pool.query<{
      credits: number;
      sends_blocked_at: Date | null;
      sends_blocked_reason: string | null;
    }>(
      'SELECT credits, sends_blocked_at, sends_blocked_reason FROM users WHERE user_id = $1',
      [userId]
    );
    return result.rows[0];
  }

  async function readLedgerStatuses(userId: string): Promise<string[]> {
    const result = await pool.query<{ status: string }>(
      `SELECT status FROM credit_ledger WHERE user_id = $1 AND source_type = 'purchase'`,
      [userId]
    );
    return result.rows.map(row => row.status);
  }

  it('revokes packs and blocks sends when a dispute is opened', async () => {
    const { userId, paymentIntentId } = await seedPackHolder({ credits: 10 });

    const dispute = disputeFixture({ id: `dp_${randomUUID().slice(0, 8)}`, payment_intent: paymentIntentId });
    const result = await commerceService.processStripeWebhookEvent(
      disputeEvent('charge.dispute.created', dispute)
    );

    expect(result.duplicate).toBe(false);

    const account = await readAccount(userId);
    expect(account.credits).toBe(0);
    expect(account.sends_blocked_at).not.toBeNull();
    expect(account.sends_blocked_reason).toBe('payment_disputed');
    expect(await readLedgerStatuses(userId)).toEqual(['revoked']);

    // The issue requires the dispute lifecycle to be persisted; before this
    // change stripe_disputes was never written to at all.
    const persisted = await pool.query<{ status: string; user_id: string | null }>(
      'SELECT status, user_id FROM stripe_disputes WHERE dispute_id = $1',
      [dispute.id]
    );
    expect(persisted.rowCount).toBe(1);
    expect(persisted.rows[0].user_id).toBe(userId);
  }, 60_000);

  it('does NOT revoke or block when the dispute is won', async () => {
    const { userId, paymentIntentId } = await seedPackHolder({ credits: 10 });

    const dispute = disputeFixture({
      id: `dp_${randomUUID().slice(0, 8)}`,
      payment_intent: paymentIntentId,
      status: 'won'
    });
    await commerceService.processStripeWebhookEvent(disputeEvent('charge.dispute.closed', dispute));

    // We kept the funds, so the customer effectively paid and must keep what they
    // bought. Revoking here would punish someone whose bank raised the dispute.
    const account = await readAccount(userId);
    expect(account.credits).toBe(10);
    expect(account.sends_blocked_at).toBeNull();
    expect(await readLedgerStatuses(userId)).toEqual(['active']);
  }, 60_000);

  it('is idempotent when the same dispute event is replayed', async () => {
    const { userId, paymentIntentId } = await seedPackHolder({ credits: 10 });
    const dispute = disputeFixture({ id: `dp_${randomUUID().slice(0, 8)}`, payment_intent: paymentIntentId });
    const event = disputeEvent('charge.dispute.created', dispute);

    const first = await commerceService.processStripeWebhookEvent(event);
    const before = await readAccount(userId);
    const second = await commerceService.processStripeWebhookEvent(event);
    const after = await readAccount(userId);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(after.credits).toBe(0);
    // The original block timestamp must survive: a later chargeback must not
    // mask when the account was first restricted.
    expect(after.sends_blocked_at?.toISOString()).toBe(before.sends_blocked_at?.toISOString());
    expect(await readLedgerStatuses(userId)).toEqual(['revoked']);
  }, 60_000);

  it('revokes even when the closed event arrives before the created event', async () => {
    const { userId, paymentIntentId } = await seedPackHolder({ credits: 10 });
    const disputeId = `dp_${randomUUID().slice(0, 8)}`;

    // Stripe does not guarantee ordering. A `closed` landing first must still
    // revoke, rather than leaving the packs quietly spendable.
    await commerceService.processStripeWebhookEvent(
      disputeEvent('charge.dispute.closed', disputeFixture({
        id: disputeId, payment_intent: paymentIntentId, status: 'lost'
      }))
    );
    const afterClosed = await readAccount(userId);
    expect(afterClosed.credits).toBe(0);

    const resolvedAfterClose = await pool.query<{ resolved_at: Date | null }>(
      'SELECT resolved_at FROM stripe_disputes WHERE dispute_id = $1', [disputeId]
    );
    expect(resolvedAfterClose.rows[0].resolved_at).not.toBeNull();

    await commerceService.processStripeWebhookEvent(
      disputeEvent('charge.dispute.created', disputeFixture({
        id: disputeId, payment_intent: paymentIntentId
      }))
    );

    // A late `created` must not reopen a settled dispute.
    const resolvedAfterCreate = await pool.query<{ resolved_at: Date | null }>(
      'SELECT resolved_at FROM stripe_disputes WHERE dispute_id = $1', [disputeId]
    );
    expect(resolvedAfterCreate.rows[0].resolved_at).not.toBeNull();
  }, 60_000);

  it('persists a dispute that matches no order, without failing', async () => {
    const disputeId = `dp_${randomUUID().slice(0, 8)}`;
    const dispute = disputeFixture({
      id: disputeId,
      payment_intent: `pi_orphan_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    });

    await commerceService.processStripeWebhookEvent(disputeEvent('charge.dispute.created', dispute));

    // Unmatched money is still money leaving the account; the operator reviewing
    // it needs the record even though no user could be resolved.
    const persisted = await pool.query<{ user_id: string | null }>(
      'SELECT user_id FROM stripe_disputes WHERE dispute_id = $1', [disputeId]
    );
    expect(persisted.rowCount).toBe(1);
    expect(persisted.rows[0].user_id).toBeNull();
  }, 60_000);

  it('blocks a new send once the account is restricted', async () => {
    const { userId } = await seedPackHolder({ credits: 5 });
    await pool.query(
      `UPDATE users SET sends_blocked_at = NOW(), sends_blocked_reason = 'payment_disputed'
       WHERE user_id = $1`,
      [userId]
    );

    const draftId = randomUUID();
    await pool.query(
      `INSERT INTO letter_drafts (
         draft_id, user_id, sender, recipient, body_text, sign_off,
         required_credits, status, expires_at
       ) VALUES ($1, $2, $3, $4, 'body', 'regards', 1, 'pending', NOW() + INTERVAL '1 day')`,
      [draftId, userId, JSON.stringify({ name: 'A' }), JSON.stringify({ name: 'B' })]
    );

    const client = await pool.connect();
    try {
      await expect(
        mailSendService.createMailOrderFromDraftWithClient(client, {
          draftId,
          userId,
          mailType: 'letter'
        })
      ).rejects.toMatchObject({ code: 'ACCOUNT_SENDS_BLOCKED' });
    } finally {
      client.release();
    }
  }, 60_000);
});
