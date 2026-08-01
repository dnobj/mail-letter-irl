import { randomUUID } from 'node:crypto';
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
  const repository022 = files.find(file => file.startsWith('022_'));
  for (const file of files) {
    if (file.startsWith('022_')) continue;
    await copyFile(path.join(repositoryMigrations, file), path.join(directory, file));
  }
  const migration022Name = repository022 || '022_sequence_probe.sql';
  if (include022) {
    if (repository022) {
      await copyFile(
        path.join(repositoryMigrations, repository022),
        path.join(directory, repository022)
      );
    } else {
      await writeFile(
        path.join(directory, migration022Name),
        'CREATE TABLE migration_022_sequence_probe (probe_id INTEGER PRIMARY KEY);\n',
        'utf8'
      );
    }
  }
  return { directory, migration022Name };
}

async function addMigration022(directory: string, migration022Name: string): Promise<void> {
  const repository022 = (await readdir(repositoryMigrations)).find(file =>
    file.startsWith('022_')
  );
  if (repository022) {
    await copyFile(
      path.join(repositoryMigrations, repository022),
      path.join(directory, repository022)
    );
    return;
  }
  await writeFile(
    path.join(directory, migration022Name),
    'CREATE TABLE migration_022_sequence_probe (probe_id INTEGER PRIMARY KEY);\n',
    'utf8'
  );
}

async function schemaFingerprint(pool: pg.Pool, schema: string): Promise<unknown> {
  const [migrations, tables, columns, constraints, indexes] = await Promise.all([
    pool.query<{ name: string }>('SELECT name FROM migrations ORDER BY name'),
    pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 ORDER BY table_name`,
      [schema]
    ),
    pool.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
      `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
      [schema]
    ),
    pool.query<{ conname: string; contype: string }>(
      `SELECT constraint_info.conname, constraint_info.contype
       FROM pg_constraint AS constraint_info
       JOIN pg_namespace AS namespace ON namespace.oid = constraint_info.connamespace
       WHERE namespace.nspname = $1 ORDER BY constraint_info.conname`,
      [schema]
    ),
    pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 ORDER BY indexname`,
      [schema]
    )
  ]);
  return {
    migrations: migrations.rows,
    tables: tables.rows,
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows
  };
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
    expect(
      await imageService.resolveAmbiguousGenerationReservation(
        ambiguous.reservationId!,
        'provider_confirmed_failed'
      )
    ).toBe(true);
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
  });
});
