import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';

const { Pool } = pg;
const enabled = process.env.LIRL_RUN_POSTGRES_INTEGRATION === 'true';
const describePostgres = enabled ? describe : describe.skip;
const repositoryMigrations = path.resolve(process.cwd(), 'db', 'migrations');
const execFileAsync = promisify(execFile);

async function actualMigration022(): Promise<{ name: string; sql: string }> {
  const repository022 = (await readdir(repositoryMigrations)).find(file => file.startsWith('022_'));
  if (repository022) {
    return { name: repository022, sql: await (await import('node:fs/promises')).readFile(
      path.join(repositoryMigrations, repository022), 'utf8'
    ) };
  }
  const { stdout } = await execFileAsync('git', [
    'show', 'origin/codex/issue-162-foundation:db/migrations/022_admin_audit.sql'
  ], { cwd: process.cwd(), maxBuffer: 2_000_000 });
  if (!stdout.includes('CREATE TABLE admin_audit_events') ||
      !stdout.includes('reject_admin_audit_event_mutation')) {
    throw new Error('Refusing synthetic 022: actual admin audit migration was not available');
  }
  return { name: '022_admin_audit.sql', sql: stdout };
}

function validateDisposableDatabaseUrl(value: string | undefined): string {
  if (!value) throw new Error('LIRL_TEST_DATABASE_URL is required for PostgreSQL integration');
  const parsed = new URL(value);
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  const databaseName = parsed.pathname.replace(/^\//, '');
  if (!localHosts.has(parsed.hostname) || !/(acid|test)/i.test(databaseName)) {
    throw new Error(
      'PostgreSQL integration refuses non-local or non-test databases; use localhost and a database name containing test or acid'
    );
  }
  if (
    process.env.NODE_ENV === 'production' ||
    (process.env.DATABASE_URL && process.env.DATABASE_URL === value)
  ) {
    throw new Error('PostgreSQL integration refuses production or application DATABASE_URL values');
  }
  return value;
}

function schemaName(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function assertDisposableSchema(value: string): void {
  if (!/^lirl_acid_[a-z0-9_]+$/.test(value)) {
    throw new Error(`Refusing destructive schema operation for unexpected name: ${value}`);
  }
}

function databaseUrlForSchema(connectionString: string, schema: string): string {
  const parsed = new URL(connectionString);
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}

async function createSchema(pool: pg.Pool, schema: string): Promise<void> {
  assertDisposableSchema(schema);
  await pool.query(`CREATE SCHEMA ${schema}`);
}

async function dropSchema(pool: pg.Pool, schema: string): Promise<void> {
  assertDisposableSchema(schema);
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
}

async function prepareMigrationDirectory(
  root: string,
  include022: boolean
): Promise<{ directory: string; migration022Name: string }> {
  const directory = path.join(root, 'db', 'migrations');
  await mkdir(directory, { recursive: true });
  const files = (await readdir(repositoryMigrations)).filter(file => file.endsWith('.sql'));
  for (const file of files) {
    if (file.startsWith('022_')) continue;
    await copyFile(path.join(repositoryMigrations, file), path.join(directory, file));
  }
  const actual022 = await actualMigration022();
  const migration022Name = actual022.name;
  if (include022) {
    await writeFile(path.join(directory, migration022Name), actual022.sql, 'utf8');
  }
  return { directory, migration022Name };
}

async function addMigration022(directory: string, migration022Name: string): Promise<void> {
  const actual022 = await actualMigration022();
  if (actual022.name !== migration022Name) throw new Error('Migration 022 name changed during test');
  await writeFile(path.join(directory, migration022Name), actual022.sql, 'utf8');
}

async function schemaFingerprint(pool: pg.Pool, schema: string): Promise<unknown> {
  const [migrations, tables, columns, constraints, indexes, triggers, functions, privileges] = await Promise.all([
    pool.query<{ name: string }>('SELECT name FROM migrations ORDER BY name'),
    pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 ORDER BY table_name`,
      [schema]
    ),
    pool.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
      [schema]
    ),
    pool.query(
      `SELECT constraint_info.conname, constraint_info.contype,
              pg_get_constraintdef(constraint_info.oid, true) AS definition
       FROM pg_constraint AS constraint_info
       JOIN pg_namespace AS namespace ON namespace.oid = constraint_info.connamespace
       WHERE namespace.nspname = $1 ORDER BY constraint_info.conname`,
      [schema]
    ),
    pool.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = $1 ORDER BY indexname`,
      [schema]
    ),
    pool.query(
      `SELECT event_object_table, trigger_name, action_timing, event_manipulation,
              action_statement FROM information_schema.triggers
       WHERE trigger_schema = $1 ORDER BY event_object_table, trigger_name, event_manipulation`, [schema]
    ),
    pool.query(
      `SELECT routine_name, routine_type, data_type, routine_definition
       FROM information_schema.routines WHERE routine_schema = $1 ORDER BY routine_name`, [schema]
    ),
    pool.query(
      `SELECT c.relname, c.relkind, c.relacl::text AS acl
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1
       UNION ALL
       SELECT p.proname, 'f', p.proacl::text
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 ORDER BY 1, 2`, [schema]
    )
  ]);
  const fingerprint = {
    migrations: migrations.rows,
    tables: tables.rows,
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    triggers: triggers.rows,
    functions: functions.rows,
    privileges: privileges.rows
  };
  return JSON.parse(JSON.stringify(fingerprint).replaceAll(schema, '<schema>'));
}

describePostgres('commerce ACID on disposable PostgreSQL', () => {
  let adminPool: pg.Pool;
  let acidPool: pg.Pool;
  let acidSchema: string;
  let baseUrl: string;
  let serviceDatabaseUrl: string;
  let tempRoot: string;
  let imageService: typeof import('../../src/services/imageGenerationLimitService.js');
  let commerceService: typeof import('../../src/services/commerceService.js');
  let letterJobService: typeof import('../../src/services/letterJobService.js');
  let stripeReconciliationService: typeof import('../../src/services/stripeReconciliationService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    acidSchema = schemaName('lirl_acid_runtime');
    await createSchema(adminPool, acidSchema);
    serviceDatabaseUrl = databaseUrlForSchema(baseUrl, acidSchema);
    await migrate({
      connectionString: serviceDatabaseUrl,
      migrationsDirectory: repositoryMigrations
    });
    acidPool = new Pool({ connectionString: serviceDatabaseUrl, max: 8 });
    tempRoot = await mkdtemp(path.join(tmpdir(), 'lirl-acid-migrations-'));

    process.env.DATABASE_URL = serviceDatabaseUrl;
    imageService = await import('../../src/services/imageGenerationLimitService.js');
    commerceService = await import('../../src/services/commerceService.js');
    letterJobService = await import('../../src/services/letterJobService.js');
    stripeReconciliationService = await import('../../src/services/stripeReconciliationService.js');
    closeServicePool = (await import('../../src/db/index.js')).closePool;
  }, 120_000);

  afterAll(async () => {
    await closeServicePool?.();
    await acidPool?.end();
    if (adminPool && acidSchema) await dropSchema(adminPool, acidSchema);
    await adminPool?.end();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it('applies 023 before later 022 and converges with 021→022→023', async () => {
    const schemaA = schemaName('lirl_acid_order_a');
    const schemaB = schemaName('lirl_acid_order_b');
    await createSchema(adminPool, schemaA);
    await createSchema(adminPool, schemaB);
    try {
      const rootA = path.join(tempRoot, 'sequence-a');
      const rootB = path.join(tempRoot, 'sequence-b');
      const sequenceA = await prepareMigrationDirectory(rootA, false);
      const sequenceB = await prepareMigrationDirectory(rootB, true);
      const urlA = databaseUrlForSchema(baseUrl, schemaA);
      const urlB = databaseUrlForSchema(baseUrl, schemaB);

      await migrate({ connectionString: urlA, migrationsDirectory: sequenceA.directory });
      const before022 = new Pool({ connectionString: urlA });
      const initialLedger = await before022.query<{ name: string }>(
        'SELECT name FROM migrations ORDER BY name'
      );
      await before022.end();
      expect(initialLedger.rows.some(row => row.name.startsWith('023_'))).toBe(true);
      expect(initialLedger.rows.some(row => row.name.startsWith('022_'))).toBe(false);

      await addMigration022(sequenceA.directory, sequenceA.migration022Name);
      await migrate({ connectionString: urlA, migrationsDirectory: sequenceA.directory });
      await migrate({ connectionString: urlB, migrationsDirectory: sequenceB.directory });

      const poolA = new Pool({ connectionString: urlA });
      const poolB = new Pool({ connectionString: urlB });
      const [fingerprintA, fingerprintB] = await Promise.all([
        schemaFingerprint(poolA, schemaA),
        schemaFingerprint(poolB, schemaB)
      ]);
      await poolA.end();
      await poolB.end();
      expect(fingerprintA).toEqual(fingerprintB);
    } finally {
      await dropSchema(adminPool, schemaA);
      await dropSchema(adminPool, schemaB);
    }
  }, 120_000);

  it('enforces one active JIT order when concurrent inserts race', async () => {
    await acidPool.query(
      `INSERT INTO users (user_id, email) VALUES ('race-user', 'race@example.test');
       INSERT INTO letter_drafts (
         draft_id, user_id, sender, recipient, body_text, sign_off,
         required_credits, expires_at
       ) VALUES (
         '00000000-0000-0000-0000-000000000101', 'race-user', '{}', '{}',
         'Race', 'Regards', 2, NOW() + INTERVAL '1 day'
       )`
    );
    const insert = (orderId: string) =>
      acidPool.query(
        `INSERT INTO orders (
           order_id, user_id, order_type, draft_id, product_code,
           credits, amount_cents, currency, idempotency_key, status
         ) VALUES ($1, 'race-user', 'jit_mail',
           '00000000-0000-0000-0000-000000000101', 'jit-letter',
           NULL, 499, 'usd', $2, 'checkout_pending')`,
        [orderId, `jit-checkout:${orderId}`]
      );
    const results = await Promise.allSettled([insert('race-order-a'), insert('race-order-b')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const count = await acidPool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM orders
       WHERE draft_id = '00000000-0000-0000-0000-000000000101'
         AND status = 'checkout_pending'`
    );
    expect(count.rows[0].count).toBe('1');
  });

  it('claims one outbox worker with FOR UPDATE SKIP LOCKED', async () => {
    await acidPool.query(
      `INSERT INTO users (user_id, email) VALUES ('outbox-user', 'outbox@example.test');
       INSERT INTO letters (
         letter_id, user_id, content, recipient, credits_cost, status
       ) VALUES ('acid-letter', 'outbox-user', '{}', '{}', 2, 'queued');
       INSERT INTO letter_jobs (
         job_id, letter_id, status, attempts, max_attempts, scheduled_at,
         idempotency_key, next_attempt_at
       ) VALUES ('acid-job', 'acid-letter', 'pending', 0, 5, NOW(),
         'acid-letter', NOW())`
    );
    const claimSql = `WITH candidate AS (
       SELECT job_id FROM letter_jobs
       WHERE attempts < max_attempts AND status = 'pending' AND next_attempt_at <= NOW()
       ORDER BY next_attempt_at, created_at
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE letter_jobs AS jobs
     SET status = 'processing', attempts = attempts + 1, locked_at = NOW()
     FROM candidate WHERE jobs.job_id = candidate.job_id
     RETURNING jobs.job_id`;
    const [first, second] = await Promise.all([acidPool.query(claimSql), acidPool.query(claimSql)]);
    expect([first.rowCount, second.rowCount].sort()).toEqual([0, 1]);
  });

  it('rolls back provider-event claims and atomically persists dispute monitoring', async () => {
    const rollbackClient = await acidPool.connect();
    try {
      await rollbackClient.query('BEGIN');
      await rollbackClient.query(
        `INSERT INTO stripe_webhook_events (event_id, event_type, provider_object_id)
         VALUES ('evt-rollback', 'test.rollback', 'object')`
      );
      await rollbackClient.query('ROLLBACK');
    } finally {
      rollbackClient.release();
    }
    const reclaimed = await acidPool.query(
      `INSERT INTO stripe_webhook_events (event_id, event_type, provider_object_id)
       VALUES ('evt-rollback', 'test.rollback', 'object') RETURNING event_id`
    );
    expect(reclaimed.rowCount).toBe(1);

    const disputeEvent = {
      id: 'evt-dispute-acid',
      type: 'charge.dispute.created',
      data: {
        object: {
          id: 'dp-acid',
          charge: 'ch-acid',
          amount: 499,
          currency: 'usd',
          reason: 'fraudulent',
          status: 'needs_response'
        }
      }
    } as any;
    await expect(commerceService.processStripeWebhookEvent(disputeEvent)).resolves.toEqual({
      duplicate: false
    });
    await expect(commerceService.processStripeWebhookEvent(disputeEvent)).resolves.toEqual({
      duplicate: true
    });
    const durable = await acidPool.query<{ events: string; alerts: string }>(
      `SELECT
         (SELECT COUNT(*) FROM stripe_webhook_events WHERE event_id = 'evt-dispute-acid') AS events,
         (SELECT COUNT(*) FROM commerce_operational_alerts
          WHERE source_event_id = 'evt-dispute-acid') AS alerts`
    );
    expect(durable.rows[0]).toEqual({ events: '1', alerts: '1' });
  });

  it('atomically cancels disputed funded mail and denies admin retry', async () => {
    await acidPool.query(
      `INSERT INTO users (user_id, email) VALUES ('dispute-user', 'dispute@example.test');
       INSERT INTO letter_drafts (
         draft_id, user_id, sender, recipient, body_text, sign_off, required_credits, expires_at
       ) VALUES ('00000000-0000-0000-0000-000000000109', 'dispute-user', '{}', '{}',
         'Dispute', 'Regards', 2, NOW() + INTERVAL '1 day');
       INSERT INTO orders (
         order_id, user_id, order_type, draft_id, product_code, product_snapshot,
         amount_cents, currency, stripe_payment_intent_id, idempotency_key, status
       ) VALUES ('dispute-order', 'dispute-user', 'jit_mail',
         '00000000-0000-0000-0000-000000000109', 'jit-letter', '{}', 499, 'usd',
         'pi-dispute-acid', 'jit-checkout:dispute-order', 'fulfillment_pending');
       INSERT INTO letters (
         letter_id, user_id, content, recipient, credits_cost, status,
         funding_type, funding_order_id
       ) VALUES ('dispute-letter', 'dispute-user', '{}', '{}', 2, 'queued',
         'jit_order', 'dispute-order');
       UPDATE orders SET letter_id = 'dispute-letter' WHERE order_id = 'dispute-order';
       INSERT INTO letter_jobs (
         job_id, letter_id, status, attempts, max_attempts, scheduled_at,
         idempotency_key, next_attempt_at
       ) VALUES ('00000000-0000-4000-8000-000000000109', 'dispute-letter',
         'pending', 0, 5, NOW(), 'dispute-letter', NOW())`
    );
    await commerceService.processStripeWebhookEvent({
      id: 'evt-dispute-funded', type: 'charge.dispute.created', data: { object: {
        id: 'dp-funded', payment_intent: 'pi-dispute-acid', charge: 'ch-funded',
        amount: 499, currency: 'usd', reason: 'fraudulent', status: 'needs_response'
      } }
    } as any);
    const state = await acidPool.query(
      `SELECT orders.status AS order_status, letters.status AS letter_status,
              jobs.status AS job_status
       FROM orders JOIN letters ON letters.letter_id = orders.letter_id
       JOIN letter_jobs jobs ON jobs.letter_id = letters.letter_id
       WHERE orders.order_id = 'dispute-order'`
    );
    expect(state.rows[0]).toEqual({
      order_status: 'disputed', letter_status: 'cancelled', job_status: 'cancelled'
    });
    await expect(letterJobService.retryLetterJobAsAdmin({
      jobId: '00000000-0000-4000-8000-000000000109', expectedUserId: 'dispute-user', actorId: 'admin-acid',
      reason: 'provider confirmed rejection', idempotencyKey: 'admin-retry-dispute-acid'
    })).rejects.toMatchObject({ code: 'invalid_state' });

    await expect(commerceService.processStripeWebhookEvent({
      id: 'evt-dispute-funded-closed', type: 'charge.dispute.closed', data: { object: {
        id: 'dp-funded', payment_intent: 'pi-dispute-acid', charge: 'ch-funded',
        amount: 499, currency: 'usd', reason: 'fraudulent', status: 'won'
      } }
    } as any)).resolves.toEqual({ duplicate: false });
    const resolvedAlert = await acidPool.query<{
      status: string; resolution_code: string; close_alerts: string;
    }>(
      `SELECT created.status, created.resolution_code,
              (SELECT COUNT(*) FROM commerce_operational_alerts
               WHERE source_event_id = 'evt-dispute-funded-closed'
                 AND alert_type = 'stripe_dispute_closed') AS close_alerts
       FROM commerce_operational_alerts AS created
       WHERE created.source_event_id = 'evt-dispute-funded'
         AND created.alert_type = 'stripe_dispute_created'`
    );
    expect(resolvedAlert.rows[0]).toEqual({
      status: 'resolved', resolution_code: 'stripe_dispute_won', close_alerts: '1'
    });
  });

  it('reconciles pack and JIT funding relations and serializes exact pack grant repair', async () => {
    await acidPool.query(
      `INSERT INTO users (user_id, email) VALUES
         ('reconcile-pack-user', 'pack-reconcile@example.test'),
         ('reconcile-jit-user', 'jit-reconcile@example.test'),
         ('repair-pack-user', 'pack-repair@example.test');
       INSERT INTO letter_drafts (
         draft_id, user_id, sender, recipient, body_text, sign_off, required_credits, expires_at
       ) VALUES ('00000000-0000-0000-0000-000000000120', 'reconcile-jit-user', '{}', '{}',
         'Reconcile', 'Regards', 2, NOW() + INTERVAL '1 day');
       INSERT INTO orders (
         order_id, user_id, order_type, product_code, product_snapshot, credits,
         amount_cents, currency, stripe_checkout_session_id, stripe_payment_intent_id,
         idempotency_key, status
       ) VALUES
         ('reconcile-pack-order', 'reconcile-pack-user', 'letter_pack', 'credit-pack-4', '{}', 4,
          500, 'usd', 'cs_acid_pack', 'pi_acid_pack', 'pack-checkout:reconcile-pack', 'fulfilled'),
         ('repair-pack-order', 'repair-pack-user', 'letter_pack', 'credit-pack-4', '{}', 4,
          500, 'usd', 'cs_acid_repair', 'pi_acid_repair', 'pack-checkout:repair-pack', 'fulfilled');
       INSERT INTO orders (
         order_id, user_id, order_type, draft_id, product_code, product_snapshot,
         amount_cents, currency, stripe_checkout_session_id, stripe_payment_intent_id,
         idempotency_key, status
       ) VALUES ('reconcile-jit-order', 'reconcile-jit-user', 'jit_mail',
         '00000000-0000-0000-0000-000000000120', 'jit-letter', '{}', 499, 'usd',
         'cs_acid_jit', 'pi_acid_jit', 'jit-checkout:reconcile-jit', 'fulfillment_pending');
       INSERT INTO credit_ledger (
         user_id, initial_amount, remaining_amount, source_type, source_reference_id,
         activated_at, expiration_policy, status
       ) VALUES ('reconcile-pack-user', 4, 4, 'purchase', 'reconcile-pack-order',
         NOW(), 'days_from_activation', 'active')`
    );
    const created = Math.floor(Date.now() / 1000);
    const stripe = {
      checkout: { sessions: { list: async () => ({ has_more: false, data: [
        { id: 'cs_acid_pack', payment_status: 'paid', amount_total: 500, currency: 'usd', created,
          metadata: { orderId: 'reconcile-pack-order', orderType: 'letter_pack', productCode: 'credit-pack-4' } },
        { id: 'cs_acid_jit', payment_status: 'paid', amount_total: 499, currency: 'usd', created,
          metadata: { orderId: 'reconcile-jit-order', orderType: 'jit_mail', productCode: 'jit-letter' } }
      ] }) } },
      refunds: { list: async () => ({ data: [] }) }
    } as any;
    const reconciliation = await stripeReconciliationService.reconcileStripePayments(1, stripe);
    expect(reconciliation.summary).toMatchObject({ matched: 2, missingInOurSystem: 0 });
    expect(reconciliation.discrepancies).toEqual([]);

    const repair = {
      orderId: 'repair-pack-order', stripeSessionId: 'cs_acid_repair',
      expectedCredits: 4, paidAmountCents: 500, paidCurrency: 'usd'
    };
    const repairs = await Promise.all([
      commerceService.repairFulfilledPackGrant(repair),
      commerceService.repairFulfilledPackGrant(repair)
    ]);
    expect(repairs.sort()).toEqual(['already_granted', 'repaired']);
    const repaired = await acidPool.query<{
      credits: number; ledger_count: string; entitlement_count: string; event_count: string;
    }>(
      `SELECT users.credits,
              (SELECT COUNT(*) FROM credit_ledger WHERE source_type = 'purchase'
               AND source_reference_id = 'repair-pack-order') AS ledger_count,
              (SELECT COUNT(*) FROM image_entitlements WHERE source_type = 'letter_pack'
               AND source_reference_id = 'repair-pack-order') AS entitlement_count,
              (SELECT COUNT(*) FROM commerce_order_events WHERE order_id = 'repair-pack-order'
               AND event_type = 'maintenance.pack_grant_repaired') AS event_count
       FROM users WHERE user_id = 'repair-pack-user'`
    );
    expect(repaired.rows[0]).toEqual({
      credits: 4, ledger_count: '1', entitlement_count: '1', event_count: '1'
    });
  });

  it('replays only the exact audited admin retry decision', async () => {
    await acidPool.query(
      `INSERT INTO users (user_id, email) VALUES ('retry-user', 'retry@example.test');
       INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status)
       VALUES ('retry-letter', 'retry-user', '{}', '{}', 2, 'failed');
       INSERT INTO letter_jobs (
         job_id, letter_id, status, attempts, max_attempts, scheduled_at,
         idempotency_key, next_attempt_at, provider_outcome
       ) VALUES ('00000000-0000-4000-8000-000000000121', 'retry-letter',
         'failed', 1, 5, NOW(), 'retry-letter', NOW(), 'definite_failure')`
    );
    const request = {
      jobId: '00000000-0000-4000-8000-000000000121', expectedUserId: 'retry-user', actorId: 'admin-acid',
      reason: 'provider confirmed rejection', idempotencyKey: 'admin-retry-exact-acid'
    };
    await expect(letterJobService.retryLetterJobAsAdmin(request)).resolves.toMatchObject({ replayed: false });
    await expect(letterJobService.retryLetterJobAsAdmin(request)).resolves.toMatchObject({ replayed: true });
    await expect(letterJobService.retryLetterJobAsAdmin({
      ...request, actorId: 'different-admin'
    })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const state = await acidPool.query<{ job_status: string; letter_status: string; audits: string }>(
      `SELECT jobs.status AS job_status, letters.status AS letter_status,
              (SELECT COUNT(*) FROM commerce_operator_audit_events
               WHERE operation = 'mail_job_retry'
                 AND target_reference_hash = $2) AS audits
       FROM letter_jobs AS jobs JOIN letters ON letters.letter_id = jobs.letter_id
       WHERE jobs.job_id = $1`,
      [request.jobId, createHash('sha256').update(request.jobId).digest('hex')]
    );
    expect(state.rows[0]).toEqual({ job_status: 'pending', letter_status: 'queued', audits: '1' });
  });

  it('terminally resolves rejected ambiguous JIT mail without making it resendable', async () => {
    const jobId = '00000000-0000-4000-8000-000000000122';
    await acidPool.query(
      `INSERT INTO users (user_id, email) VALUES ('mail-resolution-user', 'mail-resolution@example.test');
       INSERT INTO letter_drafts (
         draft_id, user_id, sender, recipient, body_text, sign_off, required_credits, expires_at
       ) VALUES ('00000000-0000-0000-0000-000000000122', 'mail-resolution-user', '{}', '{}',
         'Ambiguous', 'Regards', 2, NOW() + INTERVAL '1 day');
       INSERT INTO orders (
         order_id, user_id, order_type, draft_id, product_code, product_snapshot,
         amount_cents, currency, idempotency_key, status, hold_previous_status,
         held_at, hold_reason
       ) VALUES ('mail-resolution-order', 'mail-resolution-user', 'jit_mail',
         '00000000-0000-0000-0000-000000000122', 'jit-letter', '{}', 499, 'usd',
         'jit-checkout:mail-resolution', 'held', 'fulfillment_pending', NOW(),
         'provider_outcome_ambiguous');
       INSERT INTO letters (
         letter_id, user_id, content, recipient, credits_cost, status,
         funding_type, funding_order_id
       ) VALUES ('mail-resolution-letter', 'mail-resolution-user', '{}', '{}', 2, 'held',
         'jit_order', 'mail-resolution-order');
       UPDATE orders SET letter_id = 'mail-resolution-letter'
         WHERE order_id = 'mail-resolution-order';
       INSERT INTO letter_jobs (
         job_id, letter_id, status, attempts, max_attempts, scheduled_at,
         idempotency_key, next_attempt_at, provider_outcome, held_at, hold_reason
       ) VALUES ('00000000-0000-4000-8000-000000000122', 'mail-resolution-letter', 'held', 1, 5, NOW(),
         'mail-resolution-letter', NOW(), 'ambiguous', NOW(), 'provider_outcome_ambiguous');
       INSERT INTO commerce_operational_alerts (order_id, alert_type, severity, details)
       VALUES ('mail-resolution-order', 'mail_provider_outcome_ambiguous', 'critical',
         jsonb_build_object('jobId', '00000000-0000-4000-8000-000000000122',
           'errorClass', 'provider_error'))`
    );
    const request = {
      jobId,
      expectedUserId: 'mail-resolution-user',
      actorId: 'admin-acid',
      idempotencyKey: 'resolve-mail-rejected-acid',
      decision: 'rejected' as const,
      resolution: 'provider_confirmed_rejected_refund' as const,
      providerName: 'postgrid' as const
    };
    await acidPool.query(
      `CREATE FUNCTION fail_test_mail_resolution_audit() RETURNS TRIGGER AS $$
       BEGIN
         IF NEW.operation = 'mail_fulfillment_resolve' THEN
           RAISE EXCEPTION 'simulated audit persistence failure';
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql;
       CREATE TRIGGER fail_test_mail_resolution_audit
       BEFORE INSERT ON commerce_operator_audit_events
       FOR EACH ROW EXECUTE FUNCTION fail_test_mail_resolution_audit()`
    );
    await expect(letterJobService.resolveAmbiguousLetterJobAsAdmin(request))
      .rejects.toThrow('simulated audit persistence failure');
    const rolledBack = await acidPool.query<{
      order_status: string; letter_status: string; job_status: string; alert_status: string;
    }>(
      `SELECT orders.status AS order_status, letters.status AS letter_status,
              jobs.status AS job_status, alerts.status AS alert_status
       FROM orders JOIN letters ON letters.letter_id = orders.letter_id
       JOIN letter_jobs AS jobs ON jobs.letter_id = letters.letter_id
       JOIN commerce_operational_alerts AS alerts ON alerts.order_id = orders.order_id
       WHERE jobs.job_id = $1`,
      [jobId]
    );
    expect(rolledBack.rows[0]).toEqual({
      order_status: 'held', letter_status: 'held', job_status: 'held', alert_status: 'open'
    });
    await acidPool.query(
      `DROP TRIGGER fail_test_mail_resolution_audit ON commerce_operator_audit_events;
       DROP FUNCTION fail_test_mail_resolution_audit()`
    );
    await expect(letterJobService.resolveAmbiguousLetterJobAsAdmin(request)).resolves.toMatchObject({
      replayed: false, jobStatus: 'failed', letterStatus: 'failed', orderStatus: 'refund_pending'
    });
    await expect(letterJobService.resolveAmbiguousLetterJobAsAdmin(request)).resolves.toMatchObject({
      replayed: true
    });
    await expect(letterJobService.resolveAmbiguousLetterJobAsAdmin({
      ...request, actorId: 'other-admin'
    })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(letterJobService.retryLetterJobAsAdmin({
      jobId, expectedUserId: 'mail-resolution-user', actorId: 'admin-acid', reason: 'try to resend ambiguous mail',
      idempotencyKey: 'retry-resolved-mail-acid'
    })).rejects.toMatchObject({ code: 'invalid_state' });

    const state = await acidPool.query<{
      order_status: string; letter_status: string; job_status: string;
      provider_outcome: string; attempts: number; max_attempts: number;
      operator_resolution: string; alert_status: string; resolution_code: string;
      audit_count: string;
    }>(
      `SELECT orders.status AS order_status, letters.status AS letter_status,
              jobs.status AS job_status, jobs.provider_outcome, jobs.attempts,
              jobs.max_attempts, jobs.operator_resolution,
              alerts.status AS alert_status, alerts.resolution_code,
              (SELECT COUNT(*) FROM commerce_operator_audit_events
               WHERE operation = 'mail_fulfillment_resolve'
                 AND target_reference_hash = $2) AS audit_count
       FROM orders JOIN letters ON letters.letter_id = orders.letter_id
       JOIN letter_jobs AS jobs ON jobs.letter_id = letters.letter_id
       JOIN commerce_operational_alerts AS alerts ON alerts.order_id = orders.order_id
       WHERE jobs.job_id = $1`,
      [jobId, createHash('sha256').update(jobId).digest('hex')]
    );
    expect(state.rows[0]).toEqual({
      order_status: 'refund_pending', letter_status: 'failed', job_status: 'failed',
      provider_outcome: 'definite_failure', attempts: 5, max_attempts: 5,
      operator_resolution: 'provider_confirmed_rejected_refund', alert_status: 'resolved',
      resolution_code: 'provider_confirmed_rejected_refund', audit_count: '1'
    });
  });

  it('resumes held JIT mail only after an audited provider-confirmed rejection', async () => {
    const jobId = '00000000-0000-4000-8000-000000000123';
    await acidPool.query(
      `INSERT INTO users (user_id, email) VALUES ('mail-resume-user', 'mail-resume@example.test');
       INSERT INTO letter_drafts (
         draft_id, user_id, sender, recipient, body_text, sign_off, required_credits, expires_at
       ) VALUES ('00000000-0000-0000-0000-000000000123', 'mail-resume-user', '{}', '{}',
         'Resume', 'Regards', 2, NOW() + INTERVAL '1 day');
       INSERT INTO orders (
         order_id, user_id, order_type, draft_id, product_code, product_snapshot,
         amount_cents, currency, idempotency_key, status, hold_previous_status,
         held_at, hold_reason
       ) VALUES ('mail-resume-order', 'mail-resume-user', 'jit_mail',
         '00000000-0000-0000-0000-000000000123', 'jit-letter', '{}', 499, 'usd',
         'jit-checkout:mail-resume', 'held', 'fulfillment_pending', NOW(),
         'provider_outcome_ambiguous');
       INSERT INTO letters (
         letter_id, user_id, content, recipient, credits_cost, status,
         funding_type, funding_order_id
       ) VALUES ('mail-resume-letter', 'mail-resume-user', '{}', '{}', 2, 'held',
         'jit_order', 'mail-resume-order');
       UPDATE orders SET letter_id = 'mail-resume-letter' WHERE order_id = 'mail-resume-order';
       INSERT INTO letter_jobs (
         job_id, letter_id, status, attempts, max_attempts, scheduled_at,
         idempotency_key, next_attempt_at, provider_outcome, held_at, hold_reason
       ) VALUES ('00000000-0000-4000-8000-000000000123', 'mail-resume-letter', 'held', 5, 5, NOW(),
         'mail-resume-letter', NOW(), 'ambiguous', NOW(), 'provider_outcome_ambiguous');
       INSERT INTO commerce_operational_alerts (order_id, alert_type, severity, details)
       VALUES ('mail-resume-order', 'mail_provider_outcome_ambiguous', 'critical',
         jsonb_build_object('jobId', '00000000-0000-4000-8000-000000000123',
           'errorClass', 'transport_error'))`
    );
    const request = {
      jobId,
      expectedUserId: 'mail-resume-user',
      actorId: 'admin-acid',
      idempotencyKey: 'resolve-mail-retry-acid',
      decision: 'retry' as const,
      resolution: 'provider_confirmed_rejected_retry' as const,
      providerName: 'postgrid' as const
    };

    await expect(letterJobService.resolveAmbiguousLetterJobAsAdmin(request)).resolves.toMatchObject({
      replayed: false,
      jobStatus: 'pending',
      letterStatus: 'queued',
      orderStatus: 'fulfillment_pending'
    });
    await expect(letterJobService.resolveAmbiguousLetterJobAsAdmin(request)).resolves.toMatchObject({
      replayed: true
    });

    const state = await acidPool.query<{
      order_status: string; hold_reason: string | null; letter_status: string;
      job_status: string; provider_outcome: string; attempts: number; max_attempts: number;
      operator_resolution: string; alert_status: string; audit_count: string;
    }>(
      `SELECT orders.status AS order_status, orders.hold_reason,
              letters.status AS letter_status, jobs.status AS job_status,
              jobs.provider_outcome, jobs.attempts, jobs.max_attempts,
              jobs.operator_resolution, alerts.status AS alert_status,
              (SELECT COUNT(*) FROM commerce_operator_audit_events
               WHERE operation = 'mail_fulfillment_resolve'
                 AND target_reference_hash = $2) AS audit_count
       FROM orders JOIN letters ON letters.letter_id = orders.letter_id
       JOIN letter_jobs AS jobs ON jobs.letter_id = letters.letter_id
       JOIN commerce_operational_alerts AS alerts ON alerts.order_id = orders.order_id
       WHERE jobs.job_id = $1`,
      [jobId, createHash('sha256').update(jobId).digest('hex')]
    );
    expect(state.rows[0]).toEqual({
      order_status: 'fulfillment_pending', hold_reason: null, letter_status: 'queued',
      job_status: 'pending', provider_outcome: 'not_dispatched', attempts: 5,
      max_attempts: 6, operator_resolution: 'provider_confirmed_rejected_retry',
      alert_status: 'resolved', audit_count: '1'
    });
  });

  it('leases one refund worker, blocks replay, and releases a rolled-back claim', async () => {
    await acidPool.query(
      `INSERT INTO users (user_id, email) VALUES ('refund-user', 'refund@example.test');
       INSERT INTO letter_drafts (
         draft_id, user_id, sender, recipient, body_text, sign_off,
         required_credits, expires_at
       ) VALUES (
         '00000000-0000-0000-0000-000000000102', 'refund-user', '{}', '{}',
         'Refund', 'Regards', 2, NOW() + INTERVAL '1 day'
       );
       INSERT INTO orders (
         order_id, user_id, order_type, draft_id, product_code, product_snapshot,
         credits, amount_cents, currency, stripe_payment_intent_id,
         idempotency_key, status, refund_pending_at
       ) VALUES (
         'refund-order', 'refund-user', 'jit_mail',
         '00000000-0000-0000-0000-000000000102', 'jit-letter', '{}',
         NULL, 499, 'usd', 'pi-refund', 'jit-checkout:refund-order',
         'refund_pending', NOW()
       )`
    );
    const leaseSql = `WITH candidate AS (
       SELECT order_id, refund_attempts FROM orders
       WHERE order_id = $1 AND status = 'refund_pending'
         AND stripe_payment_intent_id IS NOT NULL
         AND (refund_attempts = 0 OR updated_at <= NOW() - ($4 * INTERVAL '1 second'))
       FOR UPDATE
     )
     UPDATE orders AS refundable
     SET refund_attempts = CASE
           WHEN refundable.stripe_refund_id IS NULL AND candidate.refund_attempts < $3
             THEN candidate.refund_attempts + 1
           ELSE refundable.refund_attempts
         END,
         last_error = $2, updated_at = NOW()
     FROM candidate WHERE refundable.order_id = candidate.order_id
     RETURNING refundable.order_id`;
    const params = ['refund-order', 'test', 5, 30];
    const [first, second] = await Promise.all([
      acidPool.query(leaseSql, params),
      acidPool.query(leaseSql, params)
    ]);
    expect([first.rowCount, second.rowCount].sort()).toEqual([0, 1]);
    expect((await acidPool.query(leaseSql, params)).rowCount).toBe(0);

    await acidPool.query(
      `UPDATE orders SET status = 'cancelled' WHERE order_id = 'refund-order'`
    );
    await acidPool.query(
      `INSERT INTO orders (
         order_id, user_id, order_type, draft_id, product_code, product_snapshot,
         credits, amount_cents, currency, stripe_payment_intent_id,
         idempotency_key, status, refund_pending_at
       ) VALUES (
         'refund-order-rollback', 'refund-user', 'jit_mail',
         '00000000-0000-0000-0000-000000000102', 'jit-letter', '{}',
         NULL, 499, 'usd', 'pi-refund-rollback', 'jit-checkout:refund-order-rollback',
         'refund_pending', NOW()
       )`
    );
    const client = await acidPool.connect();
    try {
      await client.query('BEGIN');
      expect((await client.query(leaseSql, ['refund-order-rollback', 'test', 5, 30])).rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(
      (await acidPool.query(leaseSql, ['refund-order-rollback', 'test', 5, 30])).rowCount
    ).toBe(1);
  });

  it('serializes image quota and reconciles pre-dispatch, definite, successful, and ambiguous outcomes', async () => {
    const seed = async (suffix: string) => {
      const userId = `image-${suffix}`;
      await acidPool.query(
        'INSERT INTO users (user_id, email) VALUES ($1, $2)',
        [userId, `${userId}@example.test`]
      );
      await acidPool.query(
        `INSERT INTO image_entitlements (
           user_id, source_type, source_reference_id, quantity
         ) VALUES ($1, 'integration', $2, 1)`,
        [userId, `source-${suffix}`]
      );
      return userId;
    };

    const concurrentUser = await seed('concurrent');
    const concurrent = await Promise.all([
      imageService.reserveGeneration(concurrentUser),
      imageService.reserveGeneration(concurrentUser)
    ]);
    expect(concurrent.filter(result => result.reserved)).toHaveLength(1);

    const preDispatchUser = await seed('pre-dispatch');
    const preDispatch = await imageService.reserveGeneration(preDispatchUser);
    await acidPool.query(
      `UPDATE image_generation_reservations
       SET lease_expires_at = NOW() - INTERVAL '1 minute'
       WHERE reservation_id = $1`,
      [preDispatch.reservationId]
    );
    const released = await imageService.reconcileGenerationReservations();
    expect(released.releasedBeforeDispatch).toBeGreaterThanOrEqual(1);

    const definiteUser = await seed('definite');
    const definite = await imageService.reserveGeneration(definiteUser);
    expect(
      await imageService.markGenerationDispatched(definiteUser, definite.reservationId!)
    ).toBe(true);
    expect(
      await imageService.releaseGenerationReservation(
        definiteUser,
        definite.reservationId!,
        'provider_definite_failure'
      )
    ).toBe(true);

    const successUser = await seed('success');
    const success = await imageService.reserveGeneration(successUser);
    await imageService.markGenerationDispatched(successUser, success.reservationId!);
    expect(
      await imageService.commitGenerationReservation(success.reservationId!, 'request-success')
    ).toBe(true);

    const ambiguousUser = await seed('ambiguous');
    const ambiguous = await imageService.reserveGeneration(ambiguousUser);
    await imageService.markGenerationDispatched(ambiguousUser, ambiguous.reservationId!);
    await acidPool.query(
      `UPDATE image_generation_reservations
       SET lease_expires_at = NOW() - INTERVAL '1 minute'
       WHERE reservation_id = $1`,
      [ambiguous.reservationId]
    );
    const quarantined = await imageService.reconcileGenerationReservations();
    expect(quarantined.markedAmbiguous).toBeGreaterThanOrEqual(1);
    const ambiguousState = await acidPool.query<{
      status: string;
      consumed_quantity: number;
      image_generations_used: number;
    }>(
      `SELECT reservation.status, entitlement.consumed_quantity, users.image_generations_used
       FROM image_generation_reservations AS reservation
       JOIN image_entitlements AS entitlement
         ON entitlement.entitlement_id = reservation.entitlement_id
       JOIN users ON users.user_id = reservation.user_id
       WHERE reservation.reservation_id = $1`,
      [ambiguous.reservationId]
    );
    expect(ambiguousState.rows[0]).toEqual({
      status: 'ambiguous',
      consumed_quantity: 1,
      image_generations_used: 1
    });
    const releaseRequest = {
      reservationId: ambiguous.reservationId!,
      expectedUserId: ambiguousUser,
      actorId: 'integration-admin',
      idempotencyKey: 'integration-ambiguous-release',
      decision: 'release' as const,
      resolution: 'provider_confirmed_failed' as const
    };
    const concurrentResolutions = await Promise.all([
      imageService.resolveAmbiguousGenerationReservation(releaseRequest),
      imageService.resolveAmbiguousGenerationReservation(releaseRequest)
    ]);
    expect(concurrentResolutions.filter(result => result.replayed)).toHaveLength(1);
    expect(concurrentResolutions.filter(result => !result.replayed)).toHaveLength(1);
    const resolvedState = await acidPool.query<{
      status: string;
      consumed_quantity: number;
      image_generations_used: number;
    }>(
      `SELECT reservation.status, entitlement.consumed_quantity, users.image_generations_used
       FROM image_generation_reservations AS reservation
       JOIN image_entitlements AS entitlement
         ON entitlement.entitlement_id = reservation.entitlement_id
       JOIN users ON users.user_id = reservation.user_id
       WHERE reservation.reservation_id = $1`,
      [ambiguous.reservationId]
    );
    expect(resolvedState.rows[0]).toEqual({
      status: 'released',
      consumed_quantity: 0,
      image_generations_used: 0
    });
    const releaseAuditHash = createHash('sha256')
      .update('integration-ambiguous-release').digest('hex');
    const audit = await acidPool.query<{ audit_event_id: string }>(
      `SELECT audit_event_id FROM commerce_operator_audit_events
       WHERE idempotency_key_hash = $1`, [releaseAuditHash]
    );
    expect(audit.rowCount).toBe(1);
    await expect(acidPool.query(
      `UPDATE commerce_operator_audit_events SET outcome = 'rejected'
       WHERE audit_event_id = $1`, [audit.rows[0].audit_event_id]
    )).rejects.toThrow(/append-only/);
    await acidPool.query('DELETE FROM users WHERE user_id = $1', [ambiguousUser]);
    expect((await acidPool.query(
      'SELECT audit_event_id FROM commerce_operator_audit_events WHERE audit_event_id = $1',
      [audit.rows[0].audit_event_id]
    )).rowCount).toBe(1);

    await expect(imageService.resolveAmbiguousGenerationReservation({
      ...releaseRequest,
      expectedUserId: concurrentUser,
      idempotencyKey: 'integration-cross-user-release'
    })).rejects.toMatchObject({ code: 'not_found' });

    const operatorSuccessUser = await seed('operator-success');
    const operatorSuccess = await imageService.reserveGeneration(operatorSuccessUser);
    await imageService.markGenerationDispatched(
      operatorSuccessUser,
      operatorSuccess.reservationId!
    );
    await imageService.markGenerationReservationAmbiguous(
      operatorSuccessUser,
      operatorSuccess.reservationId!,
      'provider_outcome_unknown',
      'request-operator-success'
    );
    await expect(imageService.resolveAmbiguousGenerationReservation({
      reservationId: operatorSuccess.reservationId!,
      expectedUserId: operatorSuccessUser,
      actorId: 'integration-admin',
      idempotencyKey: 'integration-ambiguous-consume',
      decision: 'consume',
      resolution: 'provider_confirmed_succeeded'
    })).resolves.toMatchObject({
      replayed: false,
      resultingStatus: 'consumed'
    });

    const rollbackUser = await seed('operator-rollback');
    const rollbackReservation = await imageService.reserveGeneration(rollbackUser);
    await imageService.markGenerationDispatched(
      rollbackUser,
      rollbackReservation.reservationId!
    );
    await imageService.markGenerationReservationAmbiguous(
      rollbackUser,
      rollbackReservation.reservationId!,
      'provider_outcome_unknown',
      'request-operator-rollback'
    );
    await acidPool.query(
      'UPDATE users SET image_generations_used = 0 WHERE user_id = $1',
      [rollbackUser]
    );
    await expect(imageService.resolveAmbiguousGenerationReservation({
      reservationId: rollbackReservation.reservationId!,
      expectedUserId: rollbackUser,
      actorId: 'integration-admin',
      idempotencyKey: 'integration-ambiguous-rollback',
      decision: 'release',
      resolution: 'customer_compensation'
    })).rejects.toThrow('user counter is inconsistent');
    const rolledBack = await acidPool.query<{
      status: string;
      consumed_quantity: number;
      audit_count: string;
    }>(
      `SELECT reservation.status, entitlement.consumed_quantity,
              (SELECT COUNT(*) FROM commerce_operator_audit_events
               WHERE idempotency_key_hash = $2) AS audit_count
       FROM image_generation_reservations AS reservation
       JOIN image_entitlements AS entitlement
         ON entitlement.entitlement_id = reservation.entitlement_id
       WHERE reservation.reservation_id = $1`,
      [rollbackReservation.reservationId,
        createHash('sha256')
          .update('integration-ambiguous-rollback').digest('hex')]
    );
    expect(rolledBack.rows[0]).toEqual({
      status: 'ambiguous',
      consumed_quantity: 1,
      audit_count: '0'
    });
  });

  it('atomically restores a JIT definite failure before refund for one audited retry', async () => {
    const jobId = '00000000-0000-4000-8000-000000000177';
    await acidPool.query(
      `INSERT INTO users (user_id, email) VALUES ('jit-retry-user', 'jit-retry@example.test');
       INSERT INTO letter_drafts
         (draft_id, user_id, sender, recipient, body_text, sign_off, required_credits, expires_at)
       VALUES ('00000000-0000-0000-0000-000000000177', 'jit-retry-user', '{}', '{}',
         'Retry', 'Regards', 2, NOW() + INTERVAL '1 day');
       INSERT INTO orders
         (order_id, user_id, order_type, draft_id, product_code, product_snapshot,
          amount_cents, currency, idempotency_key, status, refund_pending_at,
          last_error_code, refund_attempts)
       VALUES ('jit-retry-order', 'jit-retry-user', 'jit_mail',
         '00000000-0000-0000-0000-000000000177', 'jit-letter', '{}', 499, 'usd',
         'jit-retry-order-key', 'refund_pending', NOW(), 'PROVIDER_SUBMISSION_FAILED', 0);
       INSERT INTO letters
         (letter_id, user_id, content, recipient, credits_cost, status, funding_type, funding_order_id)
       VALUES ('jit-retry-letter', 'jit-retry-user', '{}', '{}', 2, 'failed',
         'jit_order', 'jit-retry-order');
       UPDATE orders SET letter_id = 'jit-retry-letter' WHERE order_id = 'jit-retry-order';
       INSERT INTO letter_jobs
         (job_id, letter_id, status, attempts, max_attempts, scheduled_at,
          idempotency_key, next_attempt_at, provider_outcome)
       VALUES ('00000000-0000-4000-8000-000000000177', 'jit-retry-letter', 'failed', 5, 5, NOW(),
         'jit-retry-letter', NOW(), 'definite_failure')`
    );
    const request = { jobId, expectedUserId: 'jit-retry-user', actorId: 'admin-acid',
      reason: 'provider confirmed definite rejection', idempotencyKey: 'jit-retry-positive-acid' };
    await expect(letterJobService.retryLetterJobAsAdmin({
      ...request, expectedUserId: 'different-user'
    })).rejects.toMatchObject({ code: 'not_found' });
    await expect(letterJobService.retryLetterJobAsAdmin(request)).resolves.toEqual({ jobId, replayed: false });
    await expect(letterJobService.retryLetterJobAsAdmin(request)).resolves.toEqual({ jobId, replayed: true });
    const state = await acidPool.query(
      `SELECT orders.status AS order_status, orders.refund_pending_at,
              letters.status AS letter_status, jobs.status AS job_status,
              jobs.provider_outcome, jobs.max_attempts,
              (SELECT COUNT(*) FROM commerce_operator_audit_events
               WHERE operation = 'mail_job_retry' AND target_reference_hash = $2) AS audits
       FROM orders JOIN letters ON letters.letter_id = orders.letter_id
       JOIN letter_jobs jobs ON jobs.letter_id = letters.letter_id
       WHERE jobs.job_id = $1`,
      [jobId, createHash('sha256').update(jobId).digest('hex')]
    );
    expect(state.rows[0]).toMatchObject({ order_status: 'fulfillment_pending',
      refund_pending_at: null, letter_status: 'queued', job_status: 'pending',
      provider_outcome: 'not_dispatched', max_attempts: 6, audits: '1' });

    // The audit must record what the operator actually reversed: the order was
    // in refund recovery before the decision and funded after it. Recording the
    // restored status on both sides would erase the fact that money was on its
    // way back to the customer.
    const audit = await acidPool.query<{
      before_order_status: string; before_job_status: string; before_provider_outcome: string;
      after_order_status: string; after_job_status: string; after_provider_outcome: string;
      reason_code: string; outcome: string;
    }>(
      `SELECT before_state->>'orderStatus' AS before_order_status,
              before_state->>'jobStatus' AS before_job_status,
              before_state->>'providerOutcome' AS before_provider_outcome,
              after_state->>'orderStatus' AS after_order_status,
              after_state->>'jobStatus' AS after_job_status,
              after_state->>'providerOutcome' AS after_provider_outcome,
              reason_code, outcome
       FROM commerce_operator_audit_events
       WHERE operation = 'mail_job_retry' AND target_reference_hash = $1`,
      [createHash('sha256').update(jobId).digest('hex')]
    );
    expect(audit.rows[0]).toEqual({
      before_order_status: 'refund_pending',
      before_job_status: 'failed',
      before_provider_outcome: 'definite_failure',
      after_order_status: 'fulfillment_pending',
      after_job_status: 'pending',
      after_provider_outcome: 'not_dispatched',
      reason_code: 'operator_confirmed_rejection',
      outcome: 'succeeded'
    });
  });

  it('records a paid checkout it cannot bind as durably recoverable unmatched money', async () => {
    await acidPool.query(
      `INSERT INTO users (user_id, email) VALUES ('orphan-pay-user', 'orphan-pay@example.test')`
    );

    // No commerce order, and no legacy metadata the adoption path can use. The
    // customer has still paid, so consuming this event silently would charge
    // them, deliver nothing, and stop Stripe retrying with no record anywhere.
    await expect(commerceService.processStripeWebhookEvent({
      id: 'evt-orphan-paid', type: 'checkout.session.completed', data: { object: {
        id: 'cs-orphan-paid', client_reference_id: null, metadata: {},
        payment_intent: 'pi-orphan-paid', payment_status: 'paid',
        amount_total: 500, currency: 'usd',
        expires_at: Math.floor(Date.now() / 1000) + 3600
      } }
    } as any)).resolves.toEqual({ duplicate: false });

    const recorded = await acidPool.query<{
      processing_status: string; order_id: string | null;
      alert_type: string; alert_status: string; severity: string;
    }>(
      `SELECT events.processing_status, events.order_id,
              alerts.alert_type, alerts.status AS alert_status, alerts.severity
       FROM stripe_webhook_events AS events
       JOIN commerce_operational_alerts AS alerts ON alerts.source_event_id = events.event_id
       WHERE events.event_id = 'evt-orphan-paid'`
    );
    expect(recorded.rows[0]).toEqual({
      processing_status: 'unmatched', order_id: null,
      alert_type: 'stripe_money_event_unmatched', alert_status: 'open', severity: 'critical'
    });

    // An unpaid session that matches nothing is not money and must stay quiet.
    await expect(commerceService.processStripeWebhookEvent({
      id: 'evt-orphan-unpaid', type: 'checkout.session.completed', data: { object: {
        id: 'cs-orphan-unpaid', client_reference_id: null, metadata: {},
        payment_status: 'unpaid', amount_total: 500, currency: 'usd',
        expires_at: Math.floor(Date.now() / 1000) + 3600
      } }
    } as any)).resolves.toEqual({ duplicate: false });
    const quiet = await acidPool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM commerce_operational_alerts
       WHERE source_event_id = 'evt-orphan-unpaid'`
    );
    expect(quiet.rows[0].count).toBe('0');
  });

  it('adopts a paid legacy pack session, pricing it lazily from the catalog seam (#275)', async () => {
    // The regression this pins: the maintenance process never loaded the price
    // catalog, so getPackProductConfig returned amountCents 0 and every legacy
    // adoption was refused - a paid customer booked as unmatched money with no
    // credits (#278 review). The catalog is deliberately NOT pre-loaded here:
    // processCheckoutSessionEvent must ensure it itself, outside its
    // transaction, exactly as the cron path does. The Stripe boundary is
    // substituted through the retriever seam, never a module mock - the same
    // pattern as RefundOperations.
    const priceCatalog = await import('../../src/services/priceCatalog.js');
    const previousStarter = process.env.STRIPE_PRICE_STARTER;
    process.env.STRIPE_PRICE_STARTER = 'price_starter_adoption';
    priceCatalog.resetPriceCatalog();
    priceCatalog.setPriceRetriever(async priceId => ({
      id: priceId,
      active: true,
      unit_amount: 500,
      currency: 'usd',
      product: 'prod_starter'
    }) as never);

    try {
      await acidPool.query(
        `INSERT INTO users (user_id, email) VALUES ('legacy-adopt-user', 'legacy-adopt@example.test')`
      );

      await expect(commerceService.processStripeWebhookEvent({
        id: 'evt-legacy-adopt', type: 'checkout.session.completed', data: { object: {
          id: 'cs-legacy-adopt', client_reference_id: null,
          metadata: { userId: 'legacy-adopt-user', productId: 'credit-pack-4' },
          payment_intent: 'pi-legacy-adopt', payment_status: 'paid',
          amount_total: 500, currency: 'usd',
          expires_at: Math.floor(Date.now() / 1000) + 3600
        } }
      // The success path carries more than the bare duplicate flag; pin only
      // what this test is about.
      } as any)).resolves.toMatchObject({ duplicate: false });

      const order = await acidPool.query<{
        order_id: string; credits: number; amount_cents: number;
        currency: string; status: string;
      }>(
        `SELECT order_id, credits, amount_cents, currency, status
         FROM orders WHERE stripe_checkout_session_id = 'cs-legacy-adopt'`
      );
      // The amount on the authoritative row IS the resolved Stripe figure.
      expect(order.rows[0]).toMatchObject({
        order_id: 'stripe-cs-legacy-adopt',
        credits: 4,
        amount_cents: 500,
        currency: 'usd',
        status: 'fulfilled'
      });

      const event = await acidPool.query<{ processing_status: string; order_id: string }>(
        `SELECT processing_status, order_id FROM stripe_webhook_events
         WHERE event_id = 'evt-legacy-adopt'`
      );
      expect(event.rows[0]).toEqual({
        processing_status: 'processed',
        order_id: 'stripe-cs-legacy-adopt'
      });

      // The customer got what they paid for - the whole point of adoption.
      const credits = await acidPool.query<{ credits: number }>(
        `SELECT credits FROM users WHERE user_id = 'legacy-adopt-user'`
      );
      expect(credits.rows[0].credits).toBe(4);
    } finally {
      priceCatalog.resetPriceCatalog();
      if (previousStarter === undefined) delete process.env.STRIPE_PRICE_STARTER;
      else process.env.STRIPE_PRICE_STARTER = previousStarter;
    }
  });

  it('rolls a transiently-unpriced adoption back so a later retry can still adopt (#278)', async () => {
    // The subtler half of the same regression. The amount used to come from an
    // env var and could never be TRANSIENTLY absent; it now comes from a live
    // Stripe read, so a blip during resolution must not book a paying customer
    // as unmatched money - unmatched does not auto-recover, and a refused
    // adoption leaves no order row for the maintenance sweep to find. The
    // handler throws instead, and this proves the property only a real
    // database can show: the rollback releases the event claim, so the retry
    // Stripe sends is free to adopt.
    const priceCatalog = await import('../../src/services/priceCatalog.js');
    const previousStarter = process.env.STRIPE_PRICE_STARTER;
    process.env.STRIPE_PRICE_STARTER = 'price_starter_transient';
    priceCatalog.resetPriceCatalog();
    priceCatalog.setPriceRetriever(async () => {
      throw new Error('Stripe unreachable');
    });

    const event = {
      id: 'evt-legacy-transient', type: 'checkout.session.completed', data: { object: {
        id: 'cs-legacy-transient', client_reference_id: null,
        metadata: { userId: 'legacy-transient-user', productId: 'credit-pack-4' },
        payment_intent: 'pi-legacy-transient', payment_status: 'paid',
        amount_total: 500, currency: 'usd',
        expires_at: Math.floor(Date.now() / 1000) + 3600
      } }
    };

    try {
      await acidPool.query(
        `INSERT INTO users (user_id, email) VALUES ('legacy-transient-user', 'legacy-transient@example.test')`
      );

      await expect(
        commerceService.processStripeWebhookEvent(event as never)
      ).rejects.toThrow(/retry adoption/);

      // Nothing durable survived the rollback: no order, and crucially no
      // claimed event row. A consumed claim would make the retry a no-op
      // duplicate and strand the money permanently.
      const afterFailure = await acidPool.query(
        `SELECT event_id FROM stripe_webhook_events WHERE event_id = 'evt-legacy-transient'`
      );
      expect(afterFailure.rows).toEqual([]);
      const noOrder = await acidPool.query(
        `SELECT order_id FROM orders WHERE stripe_checkout_session_id = 'cs-legacy-transient'`
      );
      expect(noOrder.rows).toEqual([]);

      // Stripe retries once the blip has cleared. (Resetting stands in for the
      // resolution cooldown expiring; what matters is that the retry is not
      // blocked by leftover state.)
      priceCatalog.resetPriceCatalog();
      priceCatalog.setPriceRetriever(async priceId => ({
        id: priceId, active: true, unit_amount: 500, currency: 'usd', product: 'prod_starter'
      }) as never);

      await expect(
        commerceService.processStripeWebhookEvent(event as never)
      ).resolves.toMatchObject({ duplicate: false });

      const order = await acidPool.query<{ amount_cents: number; status: string }>(
        `SELECT amount_cents, status FROM orders
         WHERE stripe_checkout_session_id = 'cs-legacy-transient'`
      );
      expect(order.rows[0]).toMatchObject({ amount_cents: 500, status: 'fulfilled' });
      const credits = await acidPool.query<{ credits: number }>(
        `SELECT credits FROM users WHERE user_id = 'legacy-transient-user'`
      );
      expect(credits.rows[0].credits).toBe(4);
    } finally {
      priceCatalog.resetPriceCatalog();
      if (previousStarter === undefined) delete process.env.STRIPE_PRICE_STARTER;
      else process.env.STRIPE_PRICE_STARTER = previousStarter;
    }
  });

  it('refuses to re-dispatch mail whose provider outcome is still ambiguous', async () => {
    const jobId = '00000000-0000-4000-8000-000000000210';
    await acidPool.query(
      `INSERT INTO users (user_id, email) VALUES ('ambiguous-retry-user', 'amb-retry@example.test');
       INSERT INTO letter_drafts
         (draft_id, user_id, sender, recipient, body_text, sign_off, required_credits, expires_at)
       VALUES ('00000000-0000-0000-0000-000000000210', 'ambiguous-retry-user', '{}', '{}',
         'Ambiguous', 'Regards', 2, NOW() + INTERVAL '1 day');
       INSERT INTO orders
         (order_id, user_id, order_type, draft_id, product_code, product_snapshot,
          amount_cents, currency, idempotency_key, status, hold_previous_status,
          held_at, hold_reason)
       VALUES ('ambiguous-retry-order', 'ambiguous-retry-user', 'jit_mail',
         '00000000-0000-0000-0000-000000000210', 'jit-letter', '{}', 499, 'usd',
         'jit:ambiguous-retry', 'held', 'fulfillment_pending', NOW(),
         'provider_outcome_ambiguous');
       INSERT INTO letters
         (letter_id, user_id, content, recipient, credits_cost, status, funding_type, funding_order_id)
       VALUES ('ambiguous-retry-letter', 'ambiguous-retry-user', '{}', '{}', 2, 'held',
         'jit_order', 'ambiguous-retry-order');
       UPDATE orders SET letter_id = 'ambiguous-retry-letter'
         WHERE order_id = 'ambiguous-retry-order';
       INSERT INTO letter_jobs
         (job_id, letter_id, status, attempts, max_attempts, scheduled_at, idempotency_key,
          next_attempt_at, provider_outcome, held_at, hold_reason)
       VALUES ('00000000-0000-4000-8000-000000000210', 'ambiguous-retry-letter', 'held', 1, 5,
         NOW(), 'ambiguous-retry-letter', NOW(), 'ambiguous', NOW(),
         'provider_outcome_ambiguous')`
    );

    // An operator may only finish an ambiguous piece through the evidence-based
    // resolution endpoint. The retry path must never put it back on the wire.
    await expect(letterJobService.retryLetterJobAsAdmin({
      jobId, expectedUserId: 'ambiguous-retry-user', actorId: 'admin-acid',
      reason: 'attempt to resend an ambiguous piece',
      idempotencyKey: 'retry-ambiguous-denied-acid'
    })).rejects.toMatchObject({ code: 'invalid_state' });

    const state = await acidPool.query<{
      job_status: string; provider_outcome: string; order_status: string; audits: string;
    }>(
      `SELECT jobs.status AS job_status, jobs.provider_outcome, orders.status AS order_status,
              (SELECT COUNT(*) FROM commerce_operator_audit_events
               WHERE target_reference_hash = $2) AS audits
       FROM letter_jobs AS jobs
       JOIN orders ON orders.letter_id = jobs.letter_id
       WHERE jobs.job_id = $1`,
      [jobId, createHash('sha256').update(jobId).digest('hex')]
    );
    expect(state.rows[0]).toEqual({
      job_status: 'held', provider_outcome: 'ambiguous', order_status: 'held', audits: '0'
    });
  });

  it('durably recovers an unmatched refund before a later checkout can fulfill mail', async () => {
    await acidPool.query(
      `INSERT INTO users (user_id, email) VALUES ('unmatched-user', 'unmatched@example.test');
       INSERT INTO letter_drafts
         (draft_id, user_id, sender, recipient, body_text, sign_off, required_credits, expires_at)
       VALUES ('00000000-0000-0000-0000-000000000188', 'unmatched-user', '{}', '{}',
         'Never mail after refund', 'Regards', 2, NOW() + INTERVAL '1 day');
       INSERT INTO orders
         (order_id, user_id, order_type, draft_id, product_code, product_snapshot,
          amount_cents, currency, idempotency_key, status)
       VALUES ('unmatched-order', 'unmatched-user', 'jit_mail',
         '00000000-0000-0000-0000-000000000188', 'jit-letter',
         '{"mailType":"letter"}', 499, 'usd', 'unmatched-order-key', 'checkout_pending')`
    );
    await expect(commerceService.processStripeWebhookEvent({
      id: 'evt-unmatched-refund', type: 'refund.updated', data: { object: {
        id: 're-unmatched', payment_intent: 'pi-unmatched', charge: 'ch-unmatched',
        amount: 499, status: 'succeeded', metadata: {}
      } }
    } as any)).resolves.toEqual({ duplicate: false });
    await expect(commerceService.processStripeWebhookEvent({
      id: 'evt-unmatched-checkout', type: 'checkout.session.completed', data: { object: {
        id: 'cs-unmatched', client_reference_id: 'unmatched-order',
        metadata: { orderId: 'unmatched-order' }, payment_intent: 'pi-unmatched',
        payment_status: 'paid', amount_total: 499, currency: 'usd',
        expires_at: Math.floor(Date.now() / 1000) + 3600
      } }
    } as any)).resolves.toMatchObject({ status: 'refund_pending' });
    const state = await acidPool.query(
      `SELECT orders.status,
              (SELECT COUNT(*) FROM letters WHERE funding_order_id = orders.order_id) AS letters,
              events.processing_status, alerts.status AS alert_status,
              alerts.resolution_code
       FROM orders
       JOIN stripe_webhook_events events ON events.event_id = 'evt-unmatched-refund'
       JOIN commerce_operational_alerts alerts ON alerts.source_event_id = events.event_id
       WHERE orders.order_id = 'unmatched-order'`
    );
    expect(state.rows[0]).toEqual({ status: 'refund_pending', letters: '0',
      processing_status: 'processed', alert_status: 'resolved',
      resolution_code: 'matched_later_checkout' });
    await expect(commerceService.processStripeWebhookEvent({
      id: 'evt-unmatched-refund', type: 'refund.updated', data: { object: { id: 're-unmatched' } }
    } as any)).resolves.toEqual({ duplicate: true });
  });

  it('serializes provider completion against a refund without deadlock or remailing', async () => {
    const jobId = '00000000-0000-4000-8000-000000000199';
    await acidPool.query(
      `INSERT INTO users (user_id, email) VALUES ('complete-refund-user', 'complete-refund@example.test');
       INSERT INTO letter_drafts
         (draft_id, user_id, sender, recipient, body_text, sign_off, required_credits, expires_at)
       VALUES ('00000000-0000-0000-0000-000000000199', 'complete-refund-user', '{}', '{}',
         'Race', 'Regards', 2, NOW() + INTERVAL '1 day');
       INSERT INTO orders
         (order_id, user_id, order_type, draft_id, product_code, product_snapshot,
          amount_cents, currency, stripe_payment_intent_id, idempotency_key, status)
       VALUES ('complete-refund-order', 'complete-refund-user', 'jit_mail',
         '00000000-0000-0000-0000-000000000199', 'jit-letter', '{}', 499, 'usd',
         'pi-complete-refund', 'complete-refund-key', 'fulfillment_pending');
       INSERT INTO letters
         (letter_id, user_id, content, recipient, credits_cost, status, funding_type, funding_order_id)
       VALUES ('complete-refund-letter', 'complete-refund-user', '{}', '{}', 2, 'processing',
         'jit_order', 'complete-refund-order');
       UPDATE orders SET letter_id = 'complete-refund-letter' WHERE order_id = 'complete-refund-order';
       INSERT INTO letter_jobs
         (job_id, letter_id, status, attempts, max_attempts, scheduled_at, idempotency_key,
          next_attempt_at, provider_outcome, provider_dispatch_started_at)
       VALUES ('00000000-0000-4000-8000-000000000199', 'complete-refund-letter',
         'processing', 1, 5, NOW(), 'complete-refund-letter', NOW(), 'dispatching', NOW())`
    );
    const job = (await acidPool.query('SELECT * FROM letter_jobs WHERE job_id = $1', [jobId])).rows[0];
    const letter = (await acidPool.query("SELECT * FROM letters WHERE letter_id = 'complete-refund-letter'")).rows[0];
    await Promise.race([
      Promise.all([
        letterJobService.completeJob(job, letter, 'postgrid', {
          success: true, trackingId: 'provider-complete-refund'
        }),
        commerceService.processStripeWebhookEvent({
          id: 'evt-complete-refund', type: 'refund.updated', data: { object: {
            id: 're-complete-refund', payment_intent: 'pi-complete-refund',
            charge: 'ch-complete-refund', amount: 499, status: 'succeeded', metadata: {}
          } }
        } as any)
      ]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('complete/refund deadlock')), 3000))
    ]);
    const state = await acidPool.query(
      `SELECT orders.status AS order_status, letters.status AS letter_status,
              jobs.status AS job_status, jobs.provider_outcome,
              (SELECT COUNT(*) FROM commerce_operational_alerts
               WHERE source_event_id = 'evt-complete-refund'
                 AND alert_type = 'refunded_mail_already_dispatched') AS alerts
       FROM orders JOIN letters ON letters.letter_id = orders.letter_id
       JOIN letter_jobs jobs ON jobs.letter_id = letters.letter_id
       WHERE orders.order_id = 'complete-refund-order'`
    );
    expect(state.rows[0]).toEqual({ order_status: 'refunded', letter_status: 'accepted',
      job_status: 'completed', provider_outcome: 'accepted', alerts: '1' });
  });

  it('holds the account row before credit_ledger so refund and send cannot invert', async () => {
    await acidPool.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased)
       VALUES ('lock-credit-user', 'lock-credit@example.test', 10, 10);
       INSERT INTO orders
         (order_id, user_id, order_type, product_code, product_snapshot, credits,
          amount_cents, currency, stripe_payment_intent_id, idempotency_key, status, paid_at)
       VALUES ('lock-credit-order', 'lock-credit-user', 'letter_pack', 'credit-pack-10',
         '{}', 10, 1000, 'usd', 'pi-lock-credit', 'pack:lock-credit', 'fulfilled', NOW());
       INSERT INTO credit_ledger
         (user_id, initial_amount, remaining_amount, source_type, source_reference_id,
          source_order_id, activated_at, expiration_policy, status)
       VALUES ('lock-credit-user', 10, 10, 'purchase', 'lock-credit-order',
         'lock-credit-order', NOW(), 'days_from_activation', 'active');
       INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status)
       VALUES ('lock-letter-a', 'lock-credit-user', '{}', '{}', 1, 'queued'),
              ('lock-letter-b', 'lock-credit-user', '{}', '{}', 1, 'queued')`
    );

    // Drive both directions concurrently: the refund path reverses the ledger
    // while the send path deducts from it. Before the canonical order was
    // enforced these took users/credit_ledger in opposite directions.
    const deducting = (await import('../../src/services/creditLedgerService.js'));
    const contend = async (letterId: string) => {
      const client = await acidPool.connect();
      try {
        await client.query('BEGIN');
        await deducting.deductCreditsFromLedgerWithClient(client, {
          userId: 'lock-credit-user', credits: 1, letterId
        });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };

    const settled = await Promise.race([
      Promise.allSettled([
        contend('lock-letter-a'),
        commerceService.processStripeWebhookEvent({
          id: 'evt-lock-credit-refund', type: 'refund.updated', data: { object: {
            id: 're-lock-credit', payment_intent: 'pi-lock-credit', charge: 'ch-lock-credit',
            amount: 1000, status: 'succeeded', metadata: {}
          } }
        } as any),
        contend('lock-letter-b')
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('users/credit_ledger deadlock')), 5000))
    ]);
    // A deadlock would surface here as SQLSTATE 40P01 rather than a hang.
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        expect(String(outcome.reason?.code ?? '')).not.toBe('40P01');
      }
    }
    expect(
      settled[1].status === 'rejected' ? String(settled[1].reason) : 'fulfilled'
    ).toBe('fulfilled');

    const state = await acidPool.query<{
      order_status: string; credits: number; revoked: string; deadlocks: string;
    }>(
      `SELECT orders.status AS order_status, users.credits,
              (SELECT COUNT(*) FROM credit_ledger
               WHERE user_id = 'lock-credit-user' AND status = 'revoked') AS revoked,
              (SELECT COUNT(*) FROM pg_stat_database
               WHERE datname = current_database() AND deadlocks > 0) AS deadlocks
       FROM orders JOIN users ON users.user_id = orders.user_id
       WHERE orders.order_id = 'lock-credit-order'`
    );
    expect(state.rows[0].order_status).toBe('refunded');
    expect(state.rows[0].deadlocks).toBe('0');
    expect(state.rows[0].credits).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('holds the account row before image_entitlements so reserve and refund cannot invert', async () => {
    await acidPool.query(
      `INSERT INTO users (user_id, email, image_generations_used)
       VALUES ('lock-image-user', 'lock-image@example.test', 0);
       INSERT INTO orders
         (order_id, user_id, order_type, product_code, product_snapshot, credits,
          amount_cents, currency, stripe_payment_intent_id, idempotency_key, status, paid_at)
       VALUES ('lock-image-order', 'lock-image-user', 'letter_pack', 'credit-pack-10',
         '{}', 10, 1000, 'usd', 'pi-lock-image', 'pack:lock-image', 'fulfilled', NOW());
       INSERT INTO image_entitlements
         (user_id, source_type, source_reference_id, source_order_id, quantity,
          consumed_quantity, status)
       VALUES ('lock-image-user', 'letter_pack', 'lock-image-order', 'lock-image-order',
         5, 0, 'active')`
    );

    await Promise.race([
      Promise.allSettled([
        imageService.reserveGeneration('lock-image-user'),
        commerceService.processStripeWebhookEvent({
          id: 'evt-lock-image-refund', type: 'refund.updated', data: { object: {
            id: 're-lock-image', payment_intent: 'pi-lock-image', charge: 'ch-lock-image',
            amount: 1000, status: 'succeeded', metadata: {}
          } }
        } as any),
        imageService.reserveGeneration('lock-image-user')
      ]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('users/image_entitlements deadlock')), 5000))
    ]);

    const state = await acidPool.query<{
      order_status: string; entitlement_status: string; used: number; deadlocks: string;
    }>(
      `SELECT orders.status AS order_status, entitlements.status AS entitlement_status,
              users.image_generations_used AS used,
              (SELECT COUNT(*) FROM pg_stat_database
               WHERE datname = current_database() AND deadlocks > 0) AS deadlocks
       FROM orders
       JOIN users ON users.user_id = orders.user_id
       JOIN image_entitlements entitlements ON entitlements.source_order_id = orders.order_id
       WHERE orders.order_id = 'lock-image-order'`
    );
    expect(state.rows[0].order_status).toBe('refunded');
    expect(state.rows[0].entitlement_status).toBe('revoked');
    expect(state.rows[0].deadlocks).toBe('0');
  }, 30_000);

  it('blocks a replayed pack grant in the database even if a guard is bypassed', async () => {
    await acidPool.query(
      `INSERT INTO users (user_id, email) VALUES ('replay-grant-user', 'replay-grant@example.test');
       INSERT INTO orders
         (order_id, user_id, order_type, product_code, product_snapshot, credits,
          amount_cents, currency, idempotency_key, status)
       VALUES ('replay-grant-order', 'replay-grant-user', 'letter_pack', 'credit-pack-4',
         '{}', 4, 500, 'usd', 'pack:replay-grant', 'fulfilled');
       INSERT INTO credit_ledger
         (user_id, initial_amount, remaining_amount, source_type, source_reference_id,
          source_order_id, activated_at, expiration_policy, status)
       VALUES ('replay-grant-user', 4, 4, 'purchase', 'replay-grant-order',
         'replay-grant-order', NOW(), 'days_from_activation', 'active')`
    );

    await expect(acidPool.query(
      `INSERT INTO credit_ledger
         (user_id, initial_amount, remaining_amount, source_type, source_reference_id,
          source_order_id, activated_at, expiration_policy, status)
       VALUES ('replay-grant-user', 4, 4, 'purchase', 'replay-grant-order',
         'replay-grant-order', NOW(), 'days_from_activation', 'active')`
    )).rejects.toMatchObject({ code: '23505' });

    // A non-purchase reversal for the same order must still be allowed.
    await expect(acidPool.query(
      `INSERT INTO credit_ledger
         (user_id, initial_amount, remaining_amount, source_type, source_reference_id,
          source_order_id, activated_at, expiration_policy, status)
       VALUES ('replay-grant-user', 4, 0, 'refund', 'replay-grant-order',
         'replay-grant-order', NOW(), 'never', 'revoked')`
    )).resolves.toBeTruthy();
  });

  it('mirrors the active JIT status set in the partial unique index predicate', async () => {
    const index = await acidPool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = $1 AND indexname = 'idx_orders_active_jit_draft_unique'`,
      [acidSchema]
    );
    const definition = index.rows[0]?.indexdef;
    expect(definition).toBeTruthy();

    // Every status the service treats as an active JIT order must appear in the
    // database predicate, and the predicate must contain nothing else.
    const predicate = definition!.slice(definition!.toUpperCase().lastIndexOf('WHERE'));
    const indexStatuses = [...predicate.matchAll(/'([a-z_]+)'::/g)]
      .map(match => match[1])
      .filter(value => value !== 'jit_mail')
      .sort();
    expect(indexStatuses).toEqual([...commerceService.ACTIVE_JIT_STATUSES].sort());
  });

  it('marks only unevidenced legacy one-cent orders as unknown revenue', async () => {
    const schema = schemaName('lirl_acid_amount_backfill');
    await createSchema(adminPool, schema);
    const pool = new Pool({ connectionString: databaseUrlForSchema(baseUrl, schema) });
    try {
      const root = path.join(tempRoot, 'amount-backfill');
      const directory = path.join(root, 'db', 'migrations');
      await mkdir(directory, { recursive: true });
      const files = (await readdir(repositoryMigrations)).filter(file => file.endsWith('.sql'));
      // Apply everything up to 021 so migration 023 runs against realistic
      // pre-023 rows rather than an empty schema.
      for (const file of files) {
        if (file.startsWith('022_') || file.startsWith('023_')) continue;
        await copyFile(path.join(repositoryMigrations, file), path.join(directory, file));
      }
      const url = databaseUrlForSchema(baseUrl, schema);
      await migrate({ connectionString: url, migrationsDirectory: directory });

      await pool.query(
        `INSERT INTO users (user_id, email) VALUES ('legacy-amount-user', 'legacy@example.test');
         INSERT INTO orders
           (order_id, user_id, order_type, product_code, product_snapshot, credits,
            amount_cents, currency, idempotency_key, status, paid_at)
         VALUES
           ('legacy-placeholder', 'legacy-amount-user', 'letter_pack', 'legacy-letter-pack',
            '{"name":"Legacy Letter Pack","migrated":true}'::jsonb, 4, 1, 'usd',
            'legacy-ledger:legacy-placeholder', 'fulfilled', NOW()),
           ('legacy-evidenced', 'legacy-amount-user', 'letter_pack', 'legacy-letter-pack',
            '{"name":"Legacy Letter Pack","migrated":true}'::jsonb, 4, 500, 'usd',
            'legacy-ledger:legacy-evidenced', 'fulfilled', NOW()),
           ('modern-one-cent', 'legacy-amount-user', 'letter_pack', 'credit-pack-4',
            '{"name":"Starter"}'::jsonb, 4, 1, 'usd',
            'pack:modern-one-cent', 'fulfilled', NOW());
         INSERT INTO credit_ledger
           (user_id, initial_amount, remaining_amount, source_type, source_reference_id,
            activated_at, expiration_policy, status)
         VALUES
           -- Unambiguous history: exactly one purchase row for one order.
           ('legacy-amount-user', 4, 4, 'purchase', 'legacy-evidenced',
            NOW(), 'days_from_activation', 'active'),
           -- Pre-existing duplicate history must stay NULL rather than break
           -- the migration or be silently collapsed.
           ('legacy-amount-user', 4, 4, 'purchase', 'modern-one-cent',
            NOW(), 'days_from_activation', 'active'),
           ('legacy-amount-user', 4, 0, 'purchase', 'modern-one-cent',
            NOW(), 'days_from_activation', 'depleted'),
           -- A purchase row that points at no order at all.
           ('legacy-amount-user', 4, 4, 'purchase', 'cs_legacy_session',
            NOW(), 'days_from_activation', 'active')`
      );

      await copyFile(
        path.join(repositoryMigrations, '023_jit_recovery_state_machines.sql'),
        path.join(directory, '023_jit_recovery_state_machines.sql')
      );
      await migrate({ connectionString: url, migrationsDirectory: directory });

      const rows = await pool.query<{
        order_id: string; amount_known: boolean; amount_cents: number; treatment: string | null;
      }>(
        `SELECT order_id, amount_known, amount_cents,
                product_snapshot->>'amountTreatment' AS treatment
         FROM orders ORDER BY order_id`
      );
      expect(rows.rows).toEqual([
        // Evidenced legacy amounts stay countable and are never rewritten.
        { order_id: 'legacy-evidenced', amount_known: true, amount_cents: 500, treatment: null },
        // Only the indistinguishable one-cent placeholder is excluded, and its
        // raw value is preserved for audit rather than invented or deleted.
        { order_id: 'legacy-placeholder', amount_known: false, amount_cents: 1,
          treatment: 'unknown_legacy' },
        // A genuine one-cent commerce order is not a migration placeholder.
        { order_id: 'modern-one-cent', amount_known: true, amount_cents: 1, treatment: null }
      ]);

      const revenue = await pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM orders
         WHERE amount_known AND paid_at IS NOT NULL
           AND status NOT IN ('refunded', 'cancelled', 'payment_failed')`
      );
      // 500 + 1, never 502: the placeholder cent is not revenue.
      expect(revenue.rows[0].total).toBe('501');

      // Only unambiguous purchase history is bound to its funding order, so the
      // new unique index can be created over pre-existing rows without failing.
      const ledger = await pool.query<{ source_reference_id: string; source_order_id: string | null }>(
        `SELECT source_reference_id, source_order_id FROM credit_ledger
         ORDER BY source_reference_id, remaining_amount DESC`
      );
      expect(ledger.rows).toEqual([
        { source_reference_id: 'cs_legacy_session', source_order_id: null },
        { source_reference_id: 'legacy-evidenced', source_order_id: 'legacy-evidenced' },
        { source_reference_id: 'modern-one-cent', source_order_id: null },
        { source_reference_id: 'modern-one-cent', source_order_id: null }
      ]);

      const guard = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = $1 AND indexname = 'idx_credit_ledger_purchase_order_unique'`,
        [schema]
      );
      expect(guard.rows[0]?.indexdef).toContain('source_order_id');

      // And the guard is live for anything written after the migration.
      await pool.query(
        `UPDATE credit_ledger SET source_order_id = 'legacy-placeholder'
         WHERE source_reference_id = 'cs_legacy_session'`
      );
      await expect(pool.query(
        `INSERT INTO credit_ledger
           (user_id, initial_amount, remaining_amount, source_type, source_reference_id,
            source_order_id, activated_at, expiration_policy, status)
         VALUES ('legacy-amount-user', 4, 4, 'purchase', 'legacy-placeholder',
           'legacy-placeholder', NOW(), 'days_from_activation', 'active')`
      )).rejects.toMatchObject({ code: '23505' });
    } finally {
      await pool.end();
      await dropSchema(adminPool, schema);
    }
  }, 120_000);
});
