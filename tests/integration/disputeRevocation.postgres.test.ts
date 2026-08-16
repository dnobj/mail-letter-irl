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
    // A real expiry, not NULL. An earlier version of this fixture left it unset,
    // which made the "compensation inherits the expiry" assertion compare null to
    // null - it would have passed even if the code dropped the expiry entirely.
    await pool.query(
      `INSERT INTO credit_ledger (
         user_id, initial_amount, remaining_amount, source_type,
         source_reference_id, activated_at, expires_at, expiration_policy, status
       ) VALUES ($1, $2, $3, 'purchase', $4, NOW(), NOW() + INTERVAL '730 days',
                 'days_from_activation', 'active')`,
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

  it('restores packs and lifts the block when a dispute is WON, in the real event order', async () => {
    const { userId, paymentIntentId } = await seedPackHolder({ credits: 10, spent: 4 });
    const disputeId = `dp_${randomUUID().slice(0, 8)}`;

    // Stripe ALWAYS emits created before closed. An earlier version of this test
    // fired closed(won) alone - an ordering Stripe never produces - and so passed
    // while the real sequence permanently confiscated a paying customer's packs.
    await commerceService.processStripeWebhookEvent(
      disputeEvent('charge.dispute.created', disputeFixture({
        id: disputeId, payment_intent: paymentIntentId, status: 'needs_response'
      }))
    );
    const duringDispute = await readAccount(userId);
    expect(duringDispute.credits).toBe(0);
    expect(duringDispute.sends_blocked_at).not.toBeNull();

    await commerceService.processStripeWebhookEvent(
      disputeEvent('charge.dispute.closed', disputeFixture({
        id: disputeId, payment_intent: paymentIntentId, status: 'won'
      }))
    );

    // We kept the funds, so the customer paid. They had 6 unspent when the
    // dispute opened; they get exactly those 6 back, not the original 10.
    const afterWin = await readAccount(userId);
    expect(afterWin.credits).toBe(6);
    expect(afterWin.sends_blocked_at).toBeNull();
    expect(afterWin.sends_blocked_reason).toBeNull();

    // The revocation is NOT reversed. It stays in history as a record of what
    // happened, and a separate linked grant makes the customer whole.
    expect(await readLedgerStatuses(userId)).toEqual(['revoked']);

    // Traceability: from the revoked lot, one indexed lookup finds both the
    // revocation and its compensation, and the compensation names the dispute.
    const purchase = await pool.query<{ ledger_id: string; expires_at: Date | null }>(
      `SELECT ledger_id, expires_at FROM credit_ledger
        WHERE user_id = $1 AND source_type = 'purchase'`,
      [userId]
    );
    const chain = await pool.query<{
      source_type: string;
      initial_amount: number;
      status: string;
      dispute_id: string | null;
      expires_at: Date | null;
    }>(
      `SELECT source_type, initial_amount, status,
              source_metadata->>'dispute_id' AS dispute_id, expires_at
         FROM credit_ledger
        WHERE related_ledger_id = $1
        ORDER BY created_at`,
      [purchase.rows[0].ledger_id]
    );
    const compensation = chain.rows.find(row => row.source_type === 'adjustment');
    expect(compensation).toBeDefined();
    expect(compensation?.initial_amount).toBe(6);
    expect(compensation?.status).toBe('active');
    expect(compensation?.dispute_id).toBe(disputeId);

    // The compensating lot must inherit the original lot's expiry. Credits are
    // consumed FIFO by expires_at, so a lot with a different window would
    // silently move the customer's expiry.
    expect(compensation?.expires_at).toEqual(purchase.rows[0].expires_at);

    // Accounting symmetry: revocation writes a credit_transactions debit, so the
    // compensation must write the matching credit or the ledger never balances.
    const txn = await pool.query<{ amount: number; balance_after: number }>(
      `SELECT amount, balance_after FROM credit_transactions
        WHERE user_id = $1 AND type = 'refund' ORDER BY transaction_id DESC LIMIT 1`,
      [userId]
    );
    expect(txn.rows[0]?.amount).toBe(6);
    expect(txn.rows[0]?.balance_after).toBe(6);
  }, 60_000);

  it('can claw back a compensation again if money leaves later', async () => {
    const { userId, paymentIntentId } = await seedPackHolder({ credits: 10, spent: 4 });
    const firstDispute = `dp_${randomUUID().slice(0, 8)}`;

    await commerceService.processStripeWebhookEvent(
      disputeEvent('charge.dispute.created', disputeFixture({
        id: firstDispute, payment_intent: paymentIntentId, status: 'needs_response'
      }))
    );
    await commerceService.processStripeWebhookEvent(
      disputeEvent('charge.dispute.closed', disputeFixture({
        id: firstDispute, payment_intent: paymentIntentId, status: 'won'
      }))
    );
    expect((await readAccount(userId)).credits).toBe(6);

    // The compensation lot must remain reachable by later claw-backs. Revocation
    // used to select only source_type='purchase', so a compensated lot sat
    // outside its scope forever and any subsequent money-out event no-opped -
    // leaving the customer with the money and the credits.
    await commerceService.processStripeWebhookEvent(
      disputeEvent('charge.dispute.created', disputeFixture({
        id: `dp_${randomUUID().slice(0, 8)}`,
        payment_intent: paymentIntentId,
        status: 'needs_response'
      }))
    );

    expect((await readAccount(userId)).credits).toBe(0);
  }, 60_000);

  it('compensates a lot only once, however many disputes touch the order', async () => {
    const { userId, paymentIntentId } = await seedPackHolder({ credits: 10, spent: 4 });

    for (const _ of [0, 1]) {
      const disputeId = `dp_${randomUUID().slice(0, 8)}`;
      await commerceService.processStripeWebhookEvent(
        disputeEvent('charge.dispute.created', disputeFixture({
          id: disputeId, payment_intent: paymentIntentId, status: 'needs_response'
        }))
      );
      await commerceService.processStripeWebhookEvent(
        disputeEvent('charge.dispute.closed', disputeFixture({
          id: disputeId, payment_intent: paymentIntentId, status: 'won'
        }))
      );
    }

    // Entitlement belongs to the lot: no lot is ever compensated twice. Each
    // new dispute revokes what the account holds and its favourable close
    // restores what THAT dispute took, so the balance returns to what the
    // customer paid for and never climbs above it.
    //
    // This asserted a count of one adjustment lot before issue #192. That count
    // was the shape of a defect rather than an invariant: compensation ignored
    // adjustment lots, so the second dispute revoked the first dispute's own
    // compensation and gave nothing back, leaving a customer who won both
    // disputes holding nothing. The balance is the honest invariant, and the
    // no-free-credits property is held by the per-lot key below.
    expect((await readAccount(userId)).credits).toBe(6);

    const compensations = await pool.query<{ related_ledger_id: string }>(
      `SELECT related_ledger_id FROM credit_ledger
        WHERE user_id = $1 AND source_type = 'adjustment'
          AND source_metadata->>'reason' = 'dispute_resolved_in_our_favour'`,
      [userId]
    );
    const restoredLots = compensations.rows.map(row => row.related_ledger_id);
    expect(new Set(restoredLots).size).toBe(restoredLots.length);
  }, 60_000);

  it('lifts the block on a win even while an unrelated inquiry is open', async () => {
    const { userId, paymentIntentId } = await seedPackHolder({ credits: 10 });
    const chargeback = `dp_${randomUUID().slice(0, 8)}`;

    await commerceService.processStripeWebhookEvent(
      disputeEvent('charge.dispute.created', disputeFixture({
        id: chargeback, payment_intent: paymentIntentId, status: 'needs_response'
      }))
    );
    // Assert the premise before the conclusion. Without this the test passes
    // vacuously if blocking regresses entirely - it would be asserting that an
    // absent block is absent.
    expect((await readAccount(userId)).sends_blocked_at).not.toBeNull();

    // An inquiry on the same account. It never blocks anything, so it must not
    // veto the unblock either - counting it left a customer who won their
    // chargeback blocked permanently, because the inquiry's own benign close is
    // not a favourable status and never retries the unblock.
    await pool.query(
      `INSERT INTO stripe_disputes (dispute_id, charge_id, user_id, amount_cents, currency, status)
       VALUES ($1, 'ch_inquiry', $2, 500, 'usd', 'warning_under_review')`,
      [`dp_inq_${randomUUID().slice(0, 8)}`, userId]
    );

    await commerceService.processStripeWebhookEvent(
      disputeEvent('charge.dispute.closed', disputeFixture({
        id: chargeback, payment_intent: paymentIntentId, status: 'won'
      }))
    );

    expect((await readAccount(userId)).sends_blocked_at).toBeNull();
  }, 60_000);

  /**
   * Where #150 meets #151.
   *
   * A prepaid send that terminally fails returns the pack as an adjustment lot
   * linked to the purchase lot it came from. The "already compensated" marker
   * matched any linked adjustment, so that returned lot made the purchase lot
   * look compensated - and a customer who then won a dispute got nothing back.
   */
  it('restores every lot a dispute took, including one a failed send returned', async () => {
    const { userId, orderId, paymentIntentId } = await seedPackHolder({ credits: 10, spent: 2 });
    const purchaseLot = await pool.query<{ ledger_id: string }>(
      `SELECT ledger_id FROM credit_ledger WHERE user_id = $1 AND source_type = 'purchase'`,
      [userId]
    );
    await pool.query(
      `INSERT INTO credit_ledger (
         user_id, initial_amount, remaining_amount, source_type,
         source_reference_id, source_metadata, activated_at,
         expires_at, expiration_policy, status, description, related_ledger_id
       ) VALUES ($1, 2, 2, 'adjustment', $2, $3, NOW(), NOW() + INTERVAL '730 days',
                 'days_from_activation', 'active', 'Returned after failed send', $4)`,
      [
        userId,
        orderId,
        JSON.stringify({
          reason: 'send_failed',
          letter_id: randomUUID(),
          failure_code: 'provider_definite_rejection',
          restores_ledger_id: purchaseLot.rows[0].ledger_id
        }),
        purchaseLot.rows[0].ledger_id
      ]
    );
    await pool.query(
      `UPDATE users SET credits = credits + 2 WHERE user_id = $1`, [userId]
    );
    expect((await readAccount(userId)).credits).toBe(10);

    const disputeId = `dp_${randomUUID().slice(0, 8)}`;
    await commerceService.processStripeWebhookEvent(
      disputeEvent('charge.dispute.created', disputeFixture({
        id: disputeId, payment_intent: paymentIntentId, status: 'needs_response'
      }))
    );
    // The dispute takes everything the order paid for, the returned lot
    // included.
    expect((await readAccount(userId)).credits).toBe(0);

    await commerceService.processStripeWebhookEvent(
      disputeEvent('charge.dispute.closed', disputeFixture({
        id: disputeId, payment_intent: paymentIntentId, status: 'won'
      }))
    );

    // Everything the dispute took comes back: the purchase lot's 8 and the
    // returned lot's 2. Two earlier versions of this code got it wrong in two
    // different ways - 0, when any linked adjustment read as "already
    // compensated", and 8, when compensation restored purchase lots only.
    expect((await readAccount(userId)).credits).toBe(10);

    // One compensation lot per restored lot, each linked to what it restores.
    const compensations = await pool.query<{ related_ledger_id: string; initial_amount: number }>(
      `SELECT related_ledger_id, initial_amount FROM credit_ledger
        WHERE user_id = $1 AND source_type = 'adjustment'
          AND source_metadata->>'reason' = 'dispute_resolved_in_our_favour'
        ORDER BY initial_amount`,
      [userId]
    );
    expect(compensations.rows.map(row => row.initial_amount)).toEqual([2, 8]);
    expect(new Set(compensations.rows.map(row => row.related_ledger_id)).size).toBe(2);
  }, 60_000);

  it('does NOT compensate a revocation that a refund caused', async () => {
    const { userId, orderId, paymentIntentId } = await seedPackHolder({ credits: 10, spent: 4 });

    // Simulate the state a refund leaves behind: lot revoked, audit row stamped
    // with the REFUND cause. This is the sequence that made the previous
    // implementation hand out free credits - an inquiry, then a goodwill refund
    // to resolve it, then the inquiry closing favourably, which reversed the
    // refund because both causes wrote identical audit rows.
    const lot = await pool.query<{ ledger_id: string }>(
      `SELECT ledger_id FROM credit_ledger WHERE user_id = $1 AND source_type = 'purchase'`,
      [userId]
    );
    await pool.query(
      `UPDATE credit_ledger SET remaining_amount = 0, status = 'revoked' WHERE ledger_id = $1`,
      [lot.rows[0].ledger_id]
    );
    await pool.query(
      `INSERT INTO credit_ledger (
         user_id, initial_amount, remaining_amount, source_type, source_reference_id,
         source_metadata, activated_at, expiration_policy, status, related_ledger_id
       ) VALUES ($1, 10, 0, 'refund', $2, $3, NOW(), 'never', 'revoked', $4)`,
      [
        userId,
        orderId,
        JSON.stringify({ reason: 'payment_refunded', order_id: orderId, remaining_at_revocation: 6 }),
        lot.rows[0].ledger_id
      ]
    );
    await pool.query('UPDATE users SET credits = 0 WHERE user_id = $1', [userId]);

    await commerceService.processStripeWebhookEvent(
      disputeEvent('charge.dispute.closed', disputeFixture({
        id: `dp_${randomUUID().slice(0, 8)}`, payment_intent: paymentIntentId, status: 'won'
      }))
    );

    // The customer already has their money back. Compensating here would hand
    // them the credits as well.
    expect((await readAccount(userId)).credits).toBe(0);
    const compensations = await pool.query(
      `SELECT 1 FROM credit_ledger WHERE user_id = $1 AND source_type = 'adjustment'`,
      [userId]
    );
    expect(compensations.rowCount).toBe(0);
  }, 60_000);

  it('flags rather than silently skipping a revocation with no recorded balance', async () => {
    const { userId, orderId, paymentIntentId } = await seedPackHolder({ credits: 10 });
    const disputeId = `dp_${randomUUID().slice(0, 8)}`;

    // A lot revoked before remaining_at_revocation was recorded. There is no way
    // to know what it held, so compensating would be inventing a number.
    const lot = await pool.query<{ ledger_id: string }>(
      `SELECT ledger_id FROM credit_ledger WHERE user_id = $1 AND source_type = 'purchase'`,
      [userId]
    );
    await pool.query(
      `UPDATE credit_ledger SET remaining_amount = 0, status = 'revoked' WHERE ledger_id = $1`,
      [lot.rows[0].ledger_id]
    );
    await pool.query(
      `INSERT INTO credit_ledger (
         user_id, initial_amount, remaining_amount, source_type, source_reference_id,
         source_metadata, activated_at, expiration_policy, status, related_ledger_id
       ) VALUES ($1, 10, 0, 'refund', $2, $3, NOW(), 'never', 'revoked', $4)`,
      [
        userId,
        orderId,
        // Carries the dispute id, as a real revocation does, but predates
        // remaining_at_revocation being recorded.
        JSON.stringify({ reason: 'payment_disputed', order_id: orderId, dispute_id: disputeId }),
        lot.rows[0].ledger_id
      ]
    );
    await pool.query('UPDATE users SET credits = 0 WHERE user_id = $1', [userId]);

    await commerceService.processStripeWebhookEvent(
      disputeEvent('charge.dispute.closed', disputeFixture({
        id: disputeId, payment_intent: paymentIntentId, status: 'won'
      }))
    );

    // Nothing granted, but somebody must be told - otherwise a customer who won
    // a dispute silently receives nothing.
    expect((await readAccount(userId)).credits).toBe(0);
    const alerts = await pool.query(
      `SELECT 1 FROM commerce_operational_alerts
        WHERE order_id = $1 AND alert_type = 'dispute_compensation_incomplete'`,
      [orderId]
    );
    expect(alerts.rowCount).toBe(1);
  }, 60_000);

  it('does not double-restore when a won dispute is replayed', async () => {
    const { userId, paymentIntentId } = await seedPackHolder({ credits: 10, spent: 4 });
    const disputeId = `dp_${randomUUID().slice(0, 8)}`;

    await commerceService.processStripeWebhookEvent(
      disputeEvent('charge.dispute.created', disputeFixture({
        id: disputeId, payment_intent: paymentIntentId, status: 'needs_response'
      }))
    );
    const won = disputeFixture({ id: disputeId, payment_intent: paymentIntentId, status: 'won' });
    await commerceService.processStripeWebhookEvent(disputeEvent('charge.dispute.closed', won));
    await commerceService.processStripeWebhookEvent(disputeEvent('charge.dispute.closed', won));

    // Distinct event ids, so claimStripeEvent does not suppress the second. The
    // restore itself must be idempotent or the customer is granted free credits.
    expect((await readAccount(userId)).credits).toBe(6);
  }, 60_000);

  it('does NOT revoke on a card-network inquiry, where no funds move', async () => {
    const { userId, paymentIntentId } = await seedPackHolder({ credits: 10 });
    const disputeId = `dp_${randomUUID().slice(0, 8)}`;

    // warning_* is an inquiry - a bank asking a question. No money is withdrawn.
    // Revoking here would confiscate a paying customer's balance over a query.
    await commerceService.processStripeWebhookEvent(
      disputeEvent('charge.dispute.created', disputeFixture({
        id: disputeId, payment_intent: paymentIntentId, status: 'warning_needs_response'
      }))
    );
    const duringInquiry = await readAccount(userId);
    expect(duringInquiry.credits).toBe(10);
    expect(duringInquiry.sends_blocked_at).toBeNull();

    await commerceService.processStripeWebhookEvent(
      disputeEvent('charge.dispute.closed', disputeFixture({
        id: disputeId, payment_intent: paymentIntentId, status: 'warning_closed'
      }))
    );
    const afterClose = await readAccount(userId);
    expect(afterClose.credits).toBe(10);
    expect(afterClose.sends_blocked_at).toBeNull();
    expect(await readLedgerStatuses(userId)).toEqual(['active']);
  }, 60_000);

  it('still revokes on an unrecognised status, failing safe', async () => {
    const { userId, paymentIntentId } = await seedPackHolder({ credits: 10 });

    await commerceService.processStripeWebhookEvent(
      disputeEvent('charge.dispute.created', disputeFixture({
        id: `dp_${randomUUID().slice(0, 8)}`,
        payment_intent: paymentIntentId,
        status: 'some_future_stripe_status'
      }))
    );

    // An unknown status must be treated as a loss, not silently ignored.
    expect((await readAccount(userId)).credits).toBe(0);
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

  it('does NOT block Pay & Send fulfilment, which runs after the charge', async () => {
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

    // Pay & Send fulfilment runs only after Stripe has charged the customer.
    // Refusing here would take the money and withhold the send in the same
    // transaction. It may fail for unrelated reasons in this fixture - what
    // must NOT happen is a block rejection.
    const client = await pool.connect();
    try {
      let code: string | undefined;
      try {
        await mailSendService.createMailOrderFromDraftWithClient(client, {
          draftId,
          userId,
          mailType: 'letter',
          funding: { type: 'jit_order', orderId: `order_${randomUUID()}` }
        });
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code).not.toBe('ACCOUNT_SENDS_BLOCKED');
    } finally {
      client.release();
    }
  }, 60_000);

  it('refuses a Pay & Send checkout for a blocked account, before any charge', async () => {
    const { userId } = await seedPackHolder({ credits: 0 + 1 });
    await pool.query(
      `UPDATE users SET sends_blocked_at = NOW(), sends_blocked_reason = 'payment_disputed'
       WHERE user_id = $1`,
      [userId]
    );

    const previous = process.env.JIT_PURCHASE_ENABLED;
    process.env.JIT_PURCHASE_ENABLED = 'true';
    try {
      await expect(
        commerceService.createJitCheckout({
          userId,
          draftId: randomUUID(),
          mailType: 'letter'
        } as Parameters<typeof commerceService.createJitCheckout>[0])
      ).rejects.toMatchObject({ code: 'ACCOUNT_SENDS_BLOCKED' });
    } finally {
      if (previous === undefined) delete process.env.JIT_PURCHASE_ENABLED;
      else process.env.JIT_PURCHASE_ENABLED = previous;
    }
  }, 60_000);
});
