import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Migration 032 takes raw error text and operator reasons out of every column
 * an operator reads that 031 did not cover (#394): orders.last_error under the
 * fulfilment, recovery, refund and submission codes; the jit.fulfillment_rejected,
 * refund.requested and operator.quarantine_released events; pre-023 outbox
 * failures; pack-refund failure text in the alert, the refund row and the
 * compensation lot; and maintenance_tasks.last_error. The code no longer writes
 * any of it; this proves, against real PostgreSQL, that each predicate catches
 * exactly the old shapes, leaves the already-classified rows byte-identical,
 * and is a no-op the second time. Docker does not run on the owner's machine,
 * so CI is the only place this SQL runs before production does.
 *
 * Unlike 031, whose control row was an INTERNAL message left alone, this
 * migration rewrites every whitespace-bearing value under the listed codes:
 * a message that is not provider text is still text. Every shape the live
 * path could have stored is seeded once, and every predicate has a control
 * that differs from the rewritten rows in exactly one term.
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

// Every seeded piece of text that must go carries this token, so one sweep of
// the seven tables proves nothing survived. Never a realistic id or address.
const TOKEN = 'fixture-leak-9a7b';
const HEX64 = 'a'.repeat(64);
const UNREACHABLE = 'Stripe unreachable after 3 attempts';

/**
 * Every message mailSendService and the outbox can throw inside the fulfilment
 * savepoints, in the shape the catches used to store, and the code each keeps.
 */
const MAPPED: Array<{ key: string; code: string; message: string }> = [
  { key: 'notFound', code: 'DRAFT_NOT_FOUND', message: `Draft not found: draft_${TOKEN}` },
  { key: 'expired', code: 'DRAFT_EXPIRED', message: `Draft expired: draft_${TOKEN}` },
  { key: 'cancelled', code: 'DRAFT_CANCELLED', message: `Draft was cancelled: draft_${TOKEN}` },
  { key: 'notOwned', code: 'DRAFT_NOT_OWNED', message: `Draft draft_${TOKEN} does not belong to this user` },
  { key: 'wrongType', code: 'DRAFT_WRONG_MAIL_TYPE', message: `Draft draft_${TOKEN} is a postcard, not a letter` },
  { key: 'noMail', code: 'DRAFT_INCOMPLETE', message: `Draft draft_${TOKEN} has no linked mail item` },
  { key: 'missingMail', code: 'DRAFT_INCOMPLETE', message: `Draft draft_${TOKEN} links to missing mail` },
  { key: 'fundingConflict', code: 'DRAFT_FUNDING_CONFLICT', message: `Draft draft_${TOKEN} was already consumed by different funding` },
  { key: 'invalidState', code: 'DRAFT_INVALID_STATE', message: `Draft draft_${TOKEN} is held` },
  { key: 'orderMissing', code: 'JIT_ORDER_NOT_FOUND', message: `Order not found: order_${TOKEN}` },
  { key: 'orderInvalid', code: 'JIT_ORDER_INVALID', message: `Order order_${TOKEN} is not a JIT order` },
  { key: 'orderNotOwned', code: 'JIT_ORDER_NOT_OWNED', message: 'JIT order ownership or draft binding does not match' },
  { key: 'orderNotPaid', code: 'JIT_ORDER_NOT_PAID', message: `Order order_${TOKEN} is checkout_pending` },
  { key: 'letterMissing', code: 'LETTER_NOT_FOUND', message: `Letter not found for outbox job: ${TOKEN}` }
];
const REWRITE_CODES = ['JIT_FULFILLMENT_REJECTED', 'RECOVERY_FAILED', 'REFUND_REQUEST_FAILED', 'PROVIDER_SUBMISSION_FAILED'];

describePostgres('migration 032 takes error text and reasons out of the operator columns', () => {
  let adminPool: pg.Pool;
  let owner: pg.Pool;
  let schema: string;
  const userId = `google-oauth2|${randomUUID().replace(/-/g, '')}`;
  const mappedOrders: Record<string, string> = {};
  const orders = {
    sqlMessage: `order_${randomUUID()}`,
    refundFallback: `order_${randomUUID()}`,
    providerForm: `order_${randomUUID()}`,
    alreadyClass: `order_${randomUUID()}`,
    sweepSentence: `order_${randomUUID()}`,
    otherCode: `order_${randomUUID()}`
  };
  const jobs = {
    oldText: randomUUID(),
    providerForm: randomUUID(),
    retryableClass: randomUUID(),
    pendingText: randomUUID(),
    failedBeforeDispatch: randomUUID(),
    failedClass: randomUUID()
  };
  const packRefunds = { text: randomUUID(), unreachable: randomUUID(), enumValue: randomUUID(), revokedText: randomUUID() };
  const ledger: Record<string, string> = {};
  // Token bookkeeping: how many seeded rows carry the token before the
  // backfill, and how many controls are expected to keep it afterwards.
  let tokensSeeded = 0;
  let tokensKept = 0;
  function tally(text: string | null, survives: boolean): void {
    if (text?.includes(TOKEN)) {
      tokensSeeded += 1;
      if (survives) tokensKept += 1;
    }
  }

  async function seedOrder(orderId: string, code: string, lastError: string, survives = false): Promise<void> {
    tally(lastError, survives);
    await owner.query(
      `INSERT INTO orders (order_id, user_id, credits, amount_cents, currency, stripe_payment_intent_id, status,
         order_type, product_code, idempotency_key, last_error_code, last_error, refund_pending_at)
       VALUES ($1, $2, 4, 1999, 'usd', $3, 'refund_pending', 'letter_pack', 'starter', $4, $5, $6, NOW())`,
      [orderId, userId, `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`, `idem_${orderId}`, code, lastError]
    );
  }

  async function seedEvent(orderId: string, eventType: string, metadata: Record<string, unknown>, survives = false): Promise<void> {
    tally(JSON.stringify(metadata), survives);
    await owner.query(
      `INSERT INTO commerce_order_events (order_id, event_type, from_status, to_status, metadata)
       VALUES ($1, $2, 'paid', 'refund_pending', $3::jsonb)`,
      [orderId, eventType, JSON.stringify(metadata)]
    );
  }

  /**
   * completed_at is its own parameter: binding the status parameter both to
   * the varchar column and to a comparison is the varchar-parameter defect
   * this repo has hit before (review round 1).
   */
  async function seedJob(jobId: string, status: string, outcome: string, text: string, survives = false): Promise<void> {
    tally(text, survives);
    const letterId = randomUUID();
    await owner.query(
      `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, mail_type)
       VALUES ($1, $2, '{"body":"private words"}'::jsonb, '{"name":"Private Person"}'::jsonb, 2, $3, 'letter')`,
      [letterId, userId, status === 'failed' ? 'failed' : 'queued']
    );
    await owner.query(
      `INSERT INTO letter_jobs (job_id, letter_id, status, attempts, max_attempts, scheduled_at, idempotency_key,
         next_attempt_at, completed_at, provider_outcome, last_error, error_message)
       VALUES ($1, $2, $3, 3, 3, NOW(), $1, NOW(), $4, $5, $6, $6)`,
      [jobId, letterId, status, status === 'failed' ? new Date() : null, outcome, text]
    );
  }

  async function seedPackRefund(packRefundId: string, orderId: string, status: 'failed' | 'letters_revoked', failureReason: string, survives = false): Promise<void> {
    tally(failureReason, survives);
    await owner.query(
      `INSERT INTO commerce_pack_refunds (pack_refund_id, order_id, user_id, environment, letters, credits, amount_cents,
         currency, status, stripe_payment_intent_id, stripe_idempotency_key, stripe_attempts, last_error_code,
         failure_reason, reason_code, actor_subject_hash, idempotency_key_hash, failed_at)
       VALUES ($1, $2, $3, 'development', 1, 2, 500, 'usd', $4, $5, $6, 1, $7, $8, 'customer_request', $9, $9, $10)`,
      [
        packRefundId, orderId, userId, status,
        `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`, `key_${packRefundId}`,
        status === 'failed' ? 'charge_already_refunded' : null, failureReason, HEX64,
        status === 'failed' ? new Date() : null
      ]
    );
  }

  async function seedAlert(orderId: string, packRefundId: string, failureReason: string, survives = false): Promise<void> {
    tally(failureReason, survives);
    await owner.query(
      `INSERT INTO commerce_operational_alerts (order_id, alert_type, severity, details)
       VALUES ($1, 'pack_refund_failed', 'critical', $2::jsonb)`,
      [orderId, JSON.stringify({ packRefundId, lastErrorCode: 'charge_already_refunded', failureReason, creditsRestored: 2 })]
    );
  }

  async function seedLedger(key: string, sourceType: string, reason: string, failureReason: string, survives = false): Promise<void> {
    tally(failureReason, survives);
    const result = await owner.query<{ ledger_id: string }>(
      `INSERT INTO credit_ledger (user_id, initial_amount, remaining_amount, source_type, source_reference_id, source_metadata,
         expiration_policy, status, description)
       VALUES ($1, 2, 2, $2::credit_source_type, $3, $4::jsonb, 'never', 'active', 'Restored after a failed proportional refund')
       RETURNING ledger_id`,
      [userId, sourceType, `ref_${key}`, JSON.stringify({ reason, order_id: orders.refundFallback, pack_refund_id: packRefunds.text, compensates_ledger_id: randomUUID(), failure_reason: failureReason })]
    );
    ledger[key] = result.rows[0].ledger_id;
  }

  async function seedTask(taskName: string, lastStatus: string, lastError: string | null, survives = false): Promise<void> {
    tally(lastError, survives);
    await owner.query(
      `INSERT INTO maintenance_tasks (task_name, last_status, last_error) VALUES ($1, $2, $3)`,
      [taskName, lastStatus, lastError]
    );
  }

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_394');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    owner = new Pool({ connectionString: scoped, max: 2 });

    await owner.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used) VALUES ($1, $2, 0, 4, 2)`,
      [userId, `${randomUUID()}@example.test`]
    );

    // orders and events: one row per mapped shape, spread over the four codes,
    // and the same shape on a jit.fulfillment_rejected event.
    for (const [i, shape] of MAPPED.entries()) {
      const orderId = `order_${randomUUID()}`;
      mappedOrders[shape.key] = orderId;
      await seedOrder(orderId, REWRITE_CODES[i % REWRITE_CODES.length], shape.message);
      await seedEvent(orderId, 'jit.fulfillment_rejected', { error: shape.message });
    }
    // prose that names no check, and the shapes that must survive
    await seedOrder(orders.sqlMessage, 'RECOVERY_FAILED', `duplicate key value violates unique constraint "${TOKEN}"`);
    await seedOrder(orders.refundFallback, 'REFUND_REQUEST_FAILED', 'Refund request failed');
    await seedOrder(orders.providerForm, 'PROVIDER_SUBMISSION_FAILED', 'provider_rejected http_400', true);
    await seedOrder(orders.alreadyClass, 'JIT_FULFILLMENT_REJECTED', 'DRAFT_NOT_FOUND', true);
    await seedOrder(orders.sweepSentence, 'REFUND_REQUEST_FAILED', 'Pre-provider fulfillment failure', true);
    await seedOrder(orders.otherCode, 'PAYMENT_AMOUNT_MISMATCH', `paid 1499 ${TOKEN}`, true);
    await seedEvent(orders.sqlMessage, 'jit.fulfillment_rejected', { error: `relation "${TOKEN}" does not exist` });
    await seedEvent(orders.alreadyClass, 'jit.fulfillment_rejected', { errorClass: 'DRAFT_NOT_FOUND' }, true);
    await seedEvent(orders.refundFallback, 'refund.requested', { reason: `Draft expired: draft_${TOKEN}`, refundId: 're_fixture' });
    await seedEvent(orders.otherCode, 'operator.quarantine_released', { reason: `support ticket ${TOKEN}`, clearedCode: 'PAYMENT_AMOUNT_MISMATCH' });
    await seedEvent(orders.providerForm, 'provider.terminal_failure', { errorClass: 'provider_rejected http_400' }, true);

    // outbox rows: the one shape that is rewritten, and a control per term
    // of the predicate (status, outcome, the provider form, the whitespace test).
    await seedJob(jobs.oldText, 'failed', 'definite_failure', `Address validation failed for ${TOKEN} Lane`);
    await seedJob(jobs.providerForm, 'failed', 'definite_failure', 'provider_rejected http_422', true);
    await seedJob(jobs.failedClass, 'failed', 'definite_failure', 'ETIMEDOUT', true);
    await seedJob(jobs.failedBeforeDispatch, 'failed', 'not_dispatched', `pre-dispatch ${TOKEN} failure`, true);
    await seedJob(jobs.pendingText, 'pending', 'not_dispatched', `retry after ${TOKEN}`, true);
    await seedJob(jobs.retryableClass, 'pending', 'not_dispatched', 'ETIMEDOUT', true);

    // pack refunds, their alerts and compensation lots
    await seedPackRefund(packRefunds.text, orders.refundFallback, 'failed', `Charge ch_${TOKEN} has already been refunded`);
    await seedPackRefund(packRefunds.unreachable, orders.sqlMessage, 'failed', UNREACHABLE, true);
    await seedPackRefund(packRefunds.enumValue, orders.providerForm, 'failed', 'expired_or_canceled_card', true);
    await seedPackRefund(packRefunds.revokedText, orders.alreadyClass, 'letters_revoked', `Charge ch_${TOKEN} still pending`, true);
    await seedAlert(orders.refundFallback, packRefunds.text, `Charge ch_${TOKEN} has already been refunded`);
    await seedAlert(orders.sqlMessage, packRefunds.unreachable, UNREACHABLE, true);
    await seedAlert(orders.providerForm, packRefunds.enumValue, 'expired_or_canceled_card', true);
    await seedLedger('text', 'adjustment', 'partial_refund_failed', `Charge ch_${TOKEN} has already been refunded`);
    await seedLedger('unreachable', 'adjustment', 'partial_refund_failed', UNREACHABLE, true);
    await seedLedger('operator', 'adjustment', 'operator_adjustment', `note ${TOKEN} kept`, true);
    await seedLedger('promo', 'promo', 'partial_refund_failed', `Charge ch_${TOKEN} refused`, true);

    // maintenance tasks
    await seedTask('provider-status-sync', 'failed', `connect ETIMEDOUT ${TOKEN}:5432`);
    await seedTask('recent-uploads-sweep', 'failed', 'recent uploads sweep failed: ETIMEDOUT', true);
    await seedTask('content-retention-sweep', 'failed', 'retention sweeps failed: database_error', true);
    await seedTask('content-retention-report', 'failed', 'retention preview failed: database_error', true);
    await seedTask('feature-requests-sweep', 'failed', 'feature requests sweep failed: ECONNRESET', true);
    await seedTask('daily-credit-and-draft-cleanup', 'completed', null, true);
    await seedTask('image-reservation-recovery', 'completed', `stale ${TOKEN} text`, true);
  }, 180_000);

  afterAll(async () => {
    await owner?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  async function readBack() {
    const orderRows = await owner.query<{ order_id: string; last_error: string | null; last_error_code: string }>(
      `SELECT order_id, last_error, last_error_code FROM orders WHERE user_id = $1 ORDER BY order_id`,
      [userId]
    );
    const events = await owner.query<{ order_id: string; event_type: string; metadata: Record<string, unknown> }>(
      `SELECT order_id, event_type, metadata FROM commerce_order_events
        WHERE order_id IN (SELECT order_id FROM orders WHERE user_id = $1)
        ORDER BY order_id, event_type`,
      [userId]
    );
    const jobRows = await owner.query<{ job_id: string; last_error: string | null; error_message: string | null }>(
      `SELECT job_id, last_error, error_message FROM letter_jobs WHERE job_id = ANY($1) ORDER BY job_id`,
      [Object.values(jobs)]
    );
    const alerts = await owner.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM commerce_operational_alerts WHERE alert_type = 'pack_refund_failed' ORDER BY details->>'packRefundId'`
    );
    const refunds = await owner.query<{ pack_refund_id: string; failure_reason: string | null; last_error_code: string | null }>(
      `SELECT pack_refund_id, failure_reason, last_error_code FROM commerce_pack_refunds WHERE pack_refund_id = ANY($1) ORDER BY pack_refund_id`,
      [Object.values(packRefunds)]
    );
    const lots = await owner.query<{ ledger_id: string; source_metadata: Record<string, unknown> }>(
      `SELECT ledger_id, source_metadata FROM credit_ledger WHERE ledger_id = ANY($1) ORDER BY ledger_id`,
      [Object.values(ledger)]
    );
    const tasks = await owner.query<{ task_name: string; last_error: string | null; last_status: string }>(
      `SELECT task_name, last_error, last_status FROM maintenance_tasks ORDER BY task_name`
    );
    const byOrder = Object.fromEntries(orderRows.rows.map((row) => [row.order_id, row]));
    const byJob = Object.fromEntries(jobRows.rows.map((row) => [row.job_id, row]));
    const byRefund = Object.fromEntries(refunds.rows.map((row) => [row.pack_refund_id, row]));
    const byLot = Object.fromEntries(lots.rows.map((row) => [row.ledger_id, row]));
    const byTask = Object.fromEntries(tasks.rows.map((row) => [row.task_name, row]));
    return { byOrder, events: events.rows, byJob, alerts: alerts.rows, byRefund, byLot, byTask };
  }

  async function leakCount(): Promise<number> {
    const sweep = await owner.query<{ n: number }>(
      `SELECT (
         (SELECT COUNT(*) FROM orders WHERE last_error LIKE $1)
       + (SELECT COUNT(*) FROM commerce_order_events WHERE metadata::text LIKE $1)
       + (SELECT COUNT(*) FROM letter_jobs WHERE last_error LIKE $1 OR error_message LIKE $1)
       + (SELECT COUNT(*) FROM commerce_operational_alerts WHERE details::text LIKE $1)
       + (SELECT COUNT(*) FROM commerce_pack_refunds WHERE failure_reason LIKE $1)
       + (SELECT COUNT(*) FROM credit_ledger WHERE source_metadata::text LIKE $1)
       + (SELECT COUNT(*) FROM maintenance_tasks WHERE last_error LIKE $1)
       )::int AS n`,
      [`%${TOKEN}%`]
    );
    return sweep.rows[0].n;
  }

  it('rewrites every old shape to a class, leaves classified rows alone, and is idempotent', async () => {
    const sql = readFileSync(path.join(repositoryMigrations, '032_error_text_minimisation.sql'), 'utf8');
    // Every seeded row that carries the token is counted before the backfill;
    // only the controls that must keep their text remain afterwards.
    expect(tokensSeeded).toBeGreaterThan(tokensKept);
    expect(await leakCount()).toBe(tokensSeeded);

    // The migration already ran once during migrate(); the seeded rows arrived
    // after it, so this is the backfill as production will experience it.
    await owner.query(sql);
    const first = await readBack();

    // 1 and 2. every mapped shape keeps its code on the order and on the event
    const event = (orderId: string, type: string) =>
      first.events.find((row) => row.order_id === orderId && row.event_type === type)?.metadata;
    for (const shape of MAPPED) {
      expect(first.byOrder[mappedOrders[shape.key]].last_error, shape.key).toBe(shape.code);
      expect(event(mappedOrders[shape.key], 'jit.fulfillment_rejected'), shape.key).toEqual({ errorClass: shape.code });
    }
    // prose that names no check becomes the label; the provider form, an
    // existing class, the sweep's sentence and a row under another code stay
    expect(first.byOrder[orders.sqlMessage].last_error).toBe('error_text_removed');
    expect(first.byOrder[orders.refundFallback].last_error).toBe('error_text_removed');
    expect(first.byOrder[orders.providerForm].last_error).toBe('provider_rejected http_400');
    expect(first.byOrder[orders.alreadyClass].last_error).toBe('DRAFT_NOT_FOUND');
    expect(first.byOrder[orders.sweepSentence].last_error).toBe('Pre-provider fulfillment failure');
    expect(first.byOrder[orders.otherCode].last_error).toBe(`paid 1499 ${TOKEN}`);
    for (const row of Object.values(first.byOrder)) expect(row.last_error_code).not.toBeNull();
    expect(event(orders.sqlMessage, 'jit.fulfillment_rejected')).toEqual({ errorClass: 'error_text_removed' });
    expect(event(orders.alreadyClass, 'jit.fulfillment_rejected')).toEqual({ errorClass: 'DRAFT_NOT_FOUND' });

    // 3 and 4. reasons go, the other keys stay
    expect(event(orders.refundFallback, 'refund.requested')).toEqual({ refundId: 're_fixture' });
    expect(event(orders.otherCode, 'operator.quarantine_released')).toEqual({ clearedCode: 'PAYMENT_AMOUNT_MISMATCH' });
    expect(event(orders.providerForm, 'provider.terminal_failure')).toEqual({ errorClass: 'provider_rejected http_400' });

    // 5. outbox: only the failed, definite, unclassified pair is rewritten
    const jobPair = (jobId: string, value: string) => ({ job_id: jobId, last_error: value, error_message: value });
    expect(first.byJob[jobs.oldText]).toEqual(jobPair(jobs.oldText, 'error_text_removed'));
    expect(first.byJob[jobs.providerForm]).toEqual(jobPair(jobs.providerForm, 'provider_rejected http_422'));
    expect(first.byJob[jobs.failedClass]).toEqual(jobPair(jobs.failedClass, 'ETIMEDOUT'));
    expect(first.byJob[jobs.failedBeforeDispatch]).toEqual(jobPair(jobs.failedBeforeDispatch, `pre-dispatch ${TOKEN} failure`));
    expect(first.byJob[jobs.pendingText]).toEqual(jobPair(jobs.pendingText, `retry after ${TOKEN}`));
    expect(first.byJob[jobs.retryableClass]).toEqual(jobPair(jobs.retryableClass, 'ETIMEDOUT'));

    // 6, 7 and 8. pack-refund text goes from a failed refund's three places;
    // the enum value, the template, a revoked refund and other lots stay
    const alertFor = (packRefundId: string) => first.alerts.find((row) => row.details.packRefundId === packRefundId)?.details;
    expect(alertFor(packRefunds.text)).toEqual({ packRefundId: packRefunds.text, lastErrorCode: 'charge_already_refunded', creditsRestored: 2 });
    expect(alertFor(packRefunds.unreachable)).toMatchObject({ failureReason: UNREACHABLE });
    expect(alertFor(packRefunds.enumValue)).toMatchObject({ failureReason: 'expired_or_canceled_card' });
    expect(first.byRefund[packRefunds.text].failure_reason).toBeNull();
    expect(first.byRefund[packRefunds.text].last_error_code).toBe('charge_already_refunded');
    expect(first.byRefund[packRefunds.unreachable].failure_reason).toBe(UNREACHABLE);
    expect(first.byRefund[packRefunds.enumValue].failure_reason).toBe('expired_or_canceled_card');
    expect(first.byRefund[packRefunds.revokedText].failure_reason).toBe(`Charge ch_${TOKEN} still pending`);
    expect(first.byLot[ledger.text].source_metadata).not.toHaveProperty('failure_reason');
    expect(first.byLot[ledger.text].source_metadata).toMatchObject({ reason: 'partial_refund_failed', pack_refund_id: packRefunds.text });
    expect(first.byLot[ledger.unreachable].source_metadata).toMatchObject({ failure_reason: UNREACHABLE });
    expect(first.byLot[ledger.operator].source_metadata).toMatchObject({ failure_reason: `note ${TOKEN} kept` });
    expect(first.byLot[ledger.promo].source_metadata).toMatchObject({ failure_reason: `Charge ch_${TOKEN} refused` });

    // 9. maintenance tasks: the driver message goes; the runner's wrapped
    // prefixes, a completed task's NULL and a completed task's text stay
    expect(first.byTask['provider-status-sync'].last_error).toBe('error_text_removed');
    expect(first.byTask['recent-uploads-sweep'].last_error).toBe('recent uploads sweep failed: ETIMEDOUT');
    expect(first.byTask['content-retention-sweep'].last_error).toBe('retention sweeps failed: database_error');
    expect(first.byTask['content-retention-report'].last_error).toBe('retention preview failed: database_error');
    expect(first.byTask['feature-requests-sweep'].last_error).toBe('feature requests sweep failed: ECONNRESET');
    expect(first.byTask['daily-credit-and-draft-cleanup'].last_error).toBeNull();
    expect(first.byTask['image-reservation-recovery'].last_error).toBe(`stale ${TOKEN} text`);

    // Nothing carrying the token survives, except the controls that must.
    expect(await leakCount()).toBe(tokensKept);

    await owner.query(sql);
    expect(await readBack()).toEqual(first);
    expect(await leakCount()).toBe(tokensKept);
  });
});
