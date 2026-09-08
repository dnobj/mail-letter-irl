import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Migration 031 rewrites historic provider messages in the three error columns
 * operators read to "provider_rejected http_<status>" (audit A-08). The code
 * no longer writes the message; this proves, against real PostgreSQL, that the
 * backfill's predicate catches the provider shape and nothing else, and that
 * re-running it is a no-op. Docker does not run on the owner's machine, so CI
 * is the only place this SQL is exercised before production runs it.
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

// The shape PostGrid produces, with the kind of content the audit was about.
const LEAKED = "HTTP 400: to.postalCode 'M5V 3L9' is not a valid postal code for 12 Private Lane";
const INTERNAL = 'new row for relation "letters" violates check constraint "valid_letter_status"';

describePostgres('migration 031 takes provider text out of the error columns', () => {
  let adminPool: pg.Pool;
  let owner: pg.Pool;
  let schema: string;
  const userId = `google-oauth2|${randomUUID().replace(/-/g, '')}`;
  const orderId = `order_${randomUUID()}`;
  const rejectedLetterId = randomUUID();
  const internalLetterId = randomUUID();
  const rejectedJobId = randomUUID();
  const internalJobId = randomUUID();

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_a08');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    owner = new Pool({ connectionString: scoped, max: 2 });

    await owner.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used) VALUES ($1, $2, 0, 2, 2)`,
      [userId, `${randomUUID()}@example.test`]
    );
    await owner.query(
      `INSERT INTO orders (order_id, user_id, credits, amount_cents, currency, status, order_type, product_code,
         idempotency_key, paid_at, last_error_code, last_error)
       VALUES ($1, $2, 1, 599, 'usd', 'refund_pending', 'jit_mail', 'jit_letter', $3, NOW(),
         'PROVIDER_SUBMISSION_FAILED', $4)`,
      [orderId, userId, `idem_${orderId}`, LEAKED]
    );
    for (const letterId of [rejectedLetterId, internalLetterId]) {
      await owner.query(
        `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, mail_type)
         VALUES ($1, $2, '{"body":"private words"}'::jsonb, '{"name":"Private Person"}'::jsonb, 2, 'failed', 'letter')`,
        [letterId, userId]
      );
    }
    // The historic shape: a definite rejection stored the provider's message
    // in both job columns; the same text went onto the order and its event.
    await owner.query(
      `INSERT INTO letter_jobs (job_id, letter_id, status, attempts, max_attempts, scheduled_at, idempotency_key,
         provider_outcome, last_error, error_message)
       VALUES ($1, $2, 'failed', 3, 3, NOW(), $1, 'definite_failure', $3, $3)`,
      [rejectedJobId, rejectedLetterId, LEAKED]
    );
    // A control row: an internal error message is not provider text and must
    // be left exactly as it was.
    await owner.query(
      `INSERT INTO letter_jobs (job_id, letter_id, status, attempts, max_attempts, scheduled_at, idempotency_key,
         provider_outcome, last_error, error_message)
       VALUES ($1, $2, 'failed', 3, 3, NOW(), $1, 'definite_failure', $3, $3)`,
      [internalJobId, internalLetterId, INTERNAL]
    );
    await owner.query(
      `INSERT INTO commerce_order_events (order_id, event_type, from_status, to_status, metadata)
       VALUES ($1, 'provider.terminal_failure', 'fulfillment_pending', 'refund_pending', $2::jsonb)`,
      [orderId, JSON.stringify({ error: LEAKED, jobId: rejectedJobId })]
    );
  });

  afterAll(async () => {
    await owner?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  async function readBack() {
    const jobs = await owner.query<{ job_id: string; last_error: string; error_message: string }>(
      `SELECT job_id, last_error, error_message FROM letter_jobs WHERE job_id = ANY($1)`,
      [[rejectedJobId, internalJobId]]
    );
    const order = await owner.query<{ last_error: string; last_error_code: string }>(
      `SELECT last_error, last_error_code FROM orders WHERE order_id = $1`,
      [orderId]
    );
    const event = await owner.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM commerce_order_events WHERE order_id = $1 AND event_type = 'provider.terminal_failure'`,
      [orderId]
    );
    return {
      rejected: jobs.rows.find((row) => row.job_id === rejectedJobId)!,
      internal: jobs.rows.find((row) => row.job_id === internalJobId)!,
      order: order.rows[0],
      event: event.rows[0].metadata
    };
  }

  it('rewrites provider messages to class and status, leaves other errors alone, and is idempotent', async () => {
    const sql = readFileSync(path.join(repositoryMigrations, '031_provider_error_minimisation.sql'), 'utf8');
    // The migration already ran once during migrate(); the seeded rows arrived
    // after it, so this is the backfill as production will experience it.
    await owner.query(sql);

    const first = await readBack();
    expect(first.rejected.last_error).toBe('provider_rejected http_400');
    expect(first.rejected.error_message).toBe('provider_rejected http_400');
    expect(first.order.last_error).toBe('provider_rejected http_400');
    expect(first.order.last_error_code).toBe('PROVIDER_SUBMISSION_FAILED');
    expect(first.event).toEqual({ errorClass: 'provider_rejected http_400', jobId: rejectedJobId });
    expect(first.internal.last_error).toBe(INTERNAL);
    expect(first.internal.error_message).toBe(INTERNAL);

    // Nothing from the message survives anywhere in the three tables.
    for (const table of ['letter_jobs', 'orders']) {
      const leaked = await owner.query(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE last_error LIKE '%M5V%' OR last_error LIKE '%Private Lane%'`
      );
      expect(leaked.rows[0].n).toBe(0);
    }
    const leakedEvents = await owner.query(
      `SELECT COUNT(*)::int AS n FROM commerce_order_events WHERE metadata::text LIKE '%M5V%'`
    );
    expect(leakedEvents.rows[0].n).toBe(0);

    await owner.query(sql);
    expect(await readBack()).toEqual(first);
  });
});
