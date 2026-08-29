import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Issue #287 - Pay & Send replay idempotency, and issue #286.
 *
 * The `jit_mail` branch of `transitionPaidCheckout` is protected against a
 * replayed Stripe event by five layers, none of which had a test:
 *
 *   1. claimStripeEvent  INSERT ... ON CONFLICT (event_id) DO NOTHING
 *   2. findCheckoutOrder SELECT ... FOR UPDATE on the order row
 *   3. the early return for FUNDED_OR_REVERSED statuses - both JIT terminal
 *      statuses, fulfillment_pending and refund_pending, are in that list
 *   4. the consumed-draft branch of createMailOrderFromDraftWithClient
 *   5. idx_letters_jit_order_unique (migration 021)
 *
 * The pack path got this coverage in #284. The JIT path has the worse blast
 * radius and had none: the existing suite covers only the negative case
 * (commerceAcid asserts letters = 0 when unmatched money blocks fulfilment),
 * and nothing drove a SUCCESSFUL fulfilment and then replayed it.
 *
 * WHY last_error_code IS NULL IS THE ASSERTION THAT MATTERS. The
 * `SAVEPOINT jit_fulfillment` catch converts ANY throw into refund_pending +
 * JIT_FULFILLMENT_REJECTED. That code is not in the auto-refund sweep's
 * exclusion list - only PAYMENT_AMOUNT_MISMATCH is - so a regression in any of
 * the five layers refunds a customer who is simultaneously keeping the mail,
 * with no human in the loop. Counting `letters` rows alone would not see it:
 * layer 5 keeps the count at one while the order slides into the refund lane.
 *
 * ON ASSERTING THE SETTLED RESULTS. The concurrent cases bind what
 * Promise.allSettled returns and pass it to expectAllFulfilled. The pack suite
 * learned this the hard way: discarding the settled results left removal of the
 * FOR UPDATE green across all twelve of its tests, because the loser read the
 * row unlocked, evaluated the status guard against its own stale copy, and died
 * on a constraint nothing observed.
 *
 * ORDERING CONSTRAINT: process.env.DATABASE_URL must be assigned before the
 * first import of src/db/index.js, which builds its Pool at module scope. The
 * static `migrate` import is safe because src/cli/migrate.ts uses its own
 * pg.Pool. Any static import here that transitively reaches src/db/index.js
 * would bind the service pool to tests/setup.ts's fallback URL, whose public
 * schema has no tables, and every commerce call would fail 42P01 - which this
 * repo's diagnostics collapse to database_error.
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

/** Run every cleanup step even if an earlier one rejects. */
async function settleAll(steps: Array<() => Promise<unknown>>): Promise<void> {
  for (const step of steps) {
    try {
      await step();
    } catch {
      // Deliberately swallowed: one failed teardown must not skip the rest.
    }
  }
}

/** Rejected settlements as `SQLSTATE: message`, for legible assertion output. */
function rejectionSummaries(results: PromiseSettledResult<unknown>[]): string[] {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map(r => {
      const reason = r.reason as { code?: string; message?: string } | undefined;
      return `${reason?.code ?? 'no-code'}: ${reason?.message ?? String(r.reason)}`;
    });
}

function expectAllFulfilled(results: PromiseSettledResult<unknown>[], expected: number): void {
  expect(rejectionSummaries(results)).toEqual([]);
  // Passed in rather than read off `results`, which would be a tautology: it
  // guards against a future edit dropping a delivery and leaving a
  // "concurrency" test driving one call.
  expect(results).toHaveLength(expected);
}

const JIT_AMOUNT_CENTS = 499;
const REQUIRED_CREDITS = 2;

describePostgres('Pay & Send fulfilment idempotency (#287, #286)', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let commerce: typeof import('../../src/services/commerceService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_jitidem');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 8 });

    process.env.DATABASE_URL = scoped;
    // Pay & Send is refused outright when the flag is off, before any of the
    // five layers is reached.
    process.env.JIT_PURCHASE_ENABLED = 'true';
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
    // letters, letter_drafts and letter_jobs are named explicitly rather than
    // left to CASCADE: this suite's whole subject is what lands in them.
    await pool.query(
      `TRUNCATE commerce_operational_alerts, commerce_operator_audit_events,
                redacted_content_quarantine, stripe_webhook_events,
                commerce_order_events, credit_consumption, credit_transactions,
                credit_ledger, image_entitlements, letter_jobs, letters,
                letter_drafts, orders, users
       RESTART IDENTITY CASCADE`
    );
  });

  /** A user, a pending draft, and a jit_mail order parked at checkout_pending. */
  async function seedPendingJitOrder(): Promise<{
    userId: string; orderId: string; sessionId: string; draftId: string;
  }> {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const userId = `user_${suffix}`;
    const orderId = `order_${suffix}`;
    const sessionId = `cs_${suffix}`;
    const draftId = randomUUID();

    await pool.query(`INSERT INTO users (user_id, email, credits) VALUES ($1, $2, 0)`, [
      userId,
      `${userId}@test.invalid`
    ]);
    await pool.query(
      `INSERT INTO letter_drafts (
         draft_id, user_id, sender, recipient, body_text, sign_off,
         required_credits, expires_at
       ) VALUES ($1, $2, '{}'::jsonb, '{"name":"Recipient"}'::jsonb, 'Hello',
                 'Regards', $3, NOW() + INTERVAL '1 day')`,
      [draftId, userId, REQUIRED_CREDITS]
    );
    await pool.query(
      `INSERT INTO orders (
         order_id, user_id, order_type, draft_id, product_code, product_snapshot,
         credits, amount_cents, currency, stripe_checkout_session_id,
         idempotency_key, status
       ) VALUES ($1, $2, 'jit_mail', $3, 'jit-letter', '{"mailType":"letter"}'::jsonb,
                 NULL, $4, 'usd', $5, $6, 'checkout_pending')`,
      [orderId, userId, draftId, JIT_AMOUNT_CENTS, sessionId, `jit-checkout:${suffix}`]
    );
    return { userId, orderId, sessionId, draftId };
  }

  function paidEvent(options: { eventId: string; sessionId: string }): unknown {
    return {
      id: options.eventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: options.sessionId,
          client_reference_id: null,
          metadata: {},
          payment_intent: `pi_${options.sessionId}`,
          payment_status: 'paid',
          // Must equal the order's amount_cents, or the paid-amount check files
          // a legitimate purchase as PAYMENT_AMOUNT_MISMATCH.
          amount_total: JIT_AMOUNT_CENTS,
          currency: 'usd',
          expires_at: Math.floor(Date.now() / 1000) + 3600
        }
      }
    };
  }

  async function scalar(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await pool.query<{ value: string }>(sql, params);
    return Number(rows[0].value);
  }

  const lettersForOrder = (orderId: string) =>
    scalar(
      `SELECT COUNT(*)::text AS value FROM letters WHERE funding_order_id = $1`,
      [orderId]
    );

  /** Column names here are literals at every call site; never caller input. */
  async function orderColumn<T>(orderId: string, column: string): Promise<T> {
    const { rows } = await pool.query(`SELECT ${column} AS value FROM orders WHERE order_id = $1`, [
      orderId
    ]);
    return rows[0].value as T;
  }

  /**
   * Everything one successful Pay & Send fulfilment must look like.
   *
   * The last_error_code assertion is not decoration: it is the difference
   * between "fulfilled once" and "fulfilled once, then auto-refunded because a
   * replay threw inside the savepoint".
   */
  async function expectExactlyOneFulfilment(orderId: string): Promise<void> {
    expect(await lettersForOrder(orderId)).toBe(1);
    expect(await orderColumn<string>(orderId, 'status')).toBe('fulfillment_pending');
    expect(await orderColumn<string | null>(orderId, 'last_error_code')).toBeNull();
  }

  it('fulfils exactly once for a single delivery, as the baseline', async () => {
    const { orderId, sessionId } = await seedPendingJitOrder();

    await expect(
      commerce.processStripeWebhookEvent(
        paidEvent({ eventId: `evt_${sessionId}`, sessionId }) as never
      )
    ).resolves.toEqual({ duplicate: false, orderId, status: 'fulfillment_pending' });

    await expectExactlyOneFulfilment(orderId);
  });

  it('treats a replay of the SAME event id as a duplicate and mails nothing further', async () => {
    // Layer 1: the event-id claim.
    const { orderId, sessionId } = await seedPendingJitOrder();
    const event = paidEvent({ eventId: `evt_${sessionId}`, sessionId });

    await expect(commerce.processStripeWebhookEvent(event as never)).resolves.toEqual({
      duplicate: false,
      orderId,
      status: 'fulfillment_pending'
    });
    await expect(commerce.processStripeWebhookEvent(event as never)).resolves.toEqual({
      duplicate: true
    });

    await expectExactlyOneFulfilment(orderId);
  });

  it('mails once when TWO DIFFERENT event ids arrive for the same session', async () => {
    // Sequential, so the row lock is never contended: this pins layer 3, the
    // funded-status early return, and nothing else. fulfillment_pending is in
    // FUNDED_OR_REVERSED_ORDER_STATUSES, so the second delivery must stop there
    // rather than reach the savepoint.
    const { orderId, sessionId } = await seedPendingJitOrder();

    await commerce.processStripeWebhookEvent(
      paidEvent({ eventId: `evt_a_${sessionId}`, sessionId }) as never
    );
    await commerce.processStripeWebhookEvent(
      paidEvent({ eventId: `evt_b_${sessionId}`, sessionId }) as never
    );

    await expectExactlyOneFulfilment(orderId);
  });

  it('mails once under CONCURRENT delivery of the same event id', async () => {
    // Layers 1 and 2 together.
    const { orderId, sessionId } = await seedPendingJitOrder();
    const event = paidEvent({ eventId: `evt_${sessionId}`, sessionId });

    const results = await Promise.allSettled([
      commerce.processStripeWebhookEvent(event as never),
      commerce.processStripeWebhookEvent(event as never)
    ]);
    expectAllFulfilled(results, 2);

    await expectExactlyOneFulfilment(orderId);
  });

  it('mails once under CONCURRENT delivery of two different event ids', async () => {
    // The case layer 1 cannot help with: two distinct claims both succeed, so
    // only the row lock and the status guard stand between them.
    const { orderId, sessionId } = await seedPendingJitOrder();

    const results = await Promise.allSettled([
      commerce.processStripeWebhookEvent(
        paidEvent({ eventId: `evt_a_${sessionId}`, sessionId }) as never
      ),
      commerce.processStripeWebhookEvent(
        paidEvent({ eventId: `evt_b_${sessionId}`, sessionId }) as never
      )
    ]);
    expectAllFulfilled(results, 2);

    await expectExactlyOneFulfilment(orderId);
  });

  it('converges an order stranded at paid instead of recovering it forever (#286)', async () => {
    // The consumed-draft branch of createMailOrderFromDraftWithClient returned
    // BEFORE the UPDATE that moves the order to fulfillment_pending, so
    // fulfillPaidOrder reported success while the row stayed at 'paid'. The
    // recovery sweep re-selected it on every run and the stuck-order alarm
    // counted it forever - and the order event log recorded a
    // paid -> fulfillment_pending transition the row contradicted.
    //
    // 'paid' is deliberately absent from FUNDED_OR_REVERSED_ORDER_STATUSES, so
    // no other layer catches this.
    const { orderId, sessionId } = await seedPendingJitOrder();

    // Fulfil normally, then wind the order back to 'paid' with its draft still
    // consumed - exactly the shape a crash between the two writes leaves.
    await commerce.processStripeWebhookEvent(
      paidEvent({ eventId: `evt_${sessionId}`, sessionId }) as never
    );
    await pool.query(
      `UPDATE orders SET status = 'paid', letter_id = NULL, fulfillment_started_at = NULL
       WHERE order_id = $1`,
      [orderId]
    );

    const first = await commerce.runCommerceMaintenance();
    expect(first.recoveredFulfillments).toBe(1);
    // The row must actually have moved. Before the fix it stayed at 'paid'.
    expect(await orderColumn<string>(orderId, 'status')).toBe('fulfillment_pending');

    const second = await commerce.runCommerceMaintenance();
    expect(second.recoveredFulfillments).toBe(0);
    expect(second.stuckOrders).toBe(0);

    // And no second letter was created along the way.
    await expectExactlyOneFulfilment(orderId);
  });

  it('does not walk a FULFILLED order backwards', async () => {
    // The hazard the status guard on the new update exists to prevent. A bare
    // WHERE order_id would turn a noisy-but-harmless bug into lifecycle
    // corruption, moving a completed order back to fulfillment_pending.
    const { orderId, sessionId } = await seedPendingJitOrder();
    await commerce.processStripeWebhookEvent(
      paidEvent({ eventId: `evt_${sessionId}`, sessionId }) as never
    );
    await pool.query(`UPDATE orders SET status = 'fulfilled' WHERE order_id = $1`, [orderId]);

    await commerce.runCommerceMaintenance();

    expect(await orderColumn<string>(orderId, 'status')).toBe('fulfilled');
    expect(await lettersForOrder(orderId)).toBe(1);
  });
});
