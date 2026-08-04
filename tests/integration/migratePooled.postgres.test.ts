/**
 * Migrator integration tests through a REAL PgBouncer in transaction pooling
 * mode — i.e. production's actual topology.
 *
 * WHY THIS FILE EXISTS
 *
 * `migrateConcurrency.postgres.test.ts` connects straight to PostgreSQL, and
 * its URL gate restricts it to localhost. That suite therefore cannot observe
 * connection-pooler behaviour at all — and production's DATABASE_URL is a Neon
 * `-pooler` endpoint, which docs/infrastructure.md and docs/deployment.md
 * mandate for both environments. A previous revision of the migrator was fully
 * green on that suite while being broken in production for exactly this reason:
 * it took a SESSION-level `pg_advisory_lock` on a dedicated connection.
 *
 * Neon's `-pooler` is PgBouncer in TRANSACTION pooling mode. A server backend
 * belongs to a client only for the duration of a transaction. A bare
 * `SELECT pg_advisory_lock(...)` outside an explicit transaction is its own
 * implicit transaction, so the backend is returned to the pool the instant it
 * completes — still holding the lock. The paired `pg_advisory_unlock()` then
 * runs on whatever backend the pooler hands out next, returns FALSE rather than
 * raising, and the lock is orphaned until that server process dies. Ending the
 * client pool does not help: it closes the socket to PgBouncer, not the backend.
 *
 * The first test below demonstrates precisely that, and demonstrates that the
 * transaction-scoped lock the migrator now uses does not have the property. The
 * rest run the real migrator through the pooler.
 *
 * Opt in with all three of:
 *   LIRL_RUN_POSTGRES_INTEGRATION=true
 *   LIRL_TEST_DATABASE_URL=...      (DIRECT PostgreSQL, used to administer)
 *   LIRL_TEST_PGBOUNCER_URL=...     (through PgBouncer, pool_mode=transaction)
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import {
  MIGRATION_ADVISORY_LOCK_KEY,
  prepareMigrationDirectory,
  readLedgerState,
  validateDisposableDatabaseUrl
} from './support/disposableDatabase.js';

const { Client, Pool } = pg;

const enabled =
  process.env.LIRL_RUN_POSTGRES_INTEGRATION === 'true' &&
  Boolean(process.env.LIRL_TEST_PGBOUNCER_URL);
const describePooled = enabled ? describe : describe.skip;

/** Counts advisory locks HELD (not merely waited on) in the current database. */
const HELD_ADVISORY_LOCKS = `
  SELECT pid
  FROM pg_locks
  WHERE locktype = 'advisory'
    AND granted
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
`;

function databaseName(): string {
  return `lirl_pooled_${randomUUID().replaceAll('-', '')}_test`;
}

function assertDisposableDatabase(value: string): void {
  if (!/^lirl_pooled_[a-z0-9]+_test$/.test(value)) {
    throw new Error(`Refusing destructive database operation for unexpected name: ${value}`);
  }
}

function urlForDatabase(connectionString: string, database: string): string {
  const parsed = new URL(connectionString);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function waitForNoHeldAdvisoryLock(client: pg.Client): Promise<number> {
  // pg_terminate_backend is asynchronous; the backend releases its locks as it
  // exits. Poll briefly rather than sleeping a guessed constant.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const held = await client.query(HELD_ADVISORY_LOCKS);
    if (held.rowCount === 0) return attempt;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const stuck = await client.query(HELD_ADVISORY_LOCKS);
  throw new Error(`advisory lock never released; still held by ${stuck.rowCount} backend(s)`);
}

describePooled('migrator through PgBouncer transaction pooling', () => {
  let directBase: string;
  let pooledBase: string;
  let adminPool: pg.Pool;
  let tempRoot: string;
  const created: string[] = [];

  beforeAll(async () => {
    directBase = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    pooledBase = validateDisposableDatabaseUrl(process.env.LIRL_TEST_PGBOUNCER_URL);
    if (new URL(directBase).port === new URL(pooledBase).port) {
      throw new Error(
        'LIRL_TEST_PGBOUNCER_URL must point at PgBouncer, not at PostgreSQL directly'
      );
    }
    adminPool = new Pool({ connectionString: directBase });
    tempRoot = await mkdtemp(path.join(tmpdir(), 'lirl-migrate-pooled-'));
  }, 120_000);

  afterAll(async () => {
    for (const name of created) {
      assertDisposableDatabase(name);
      // WITH (FORCE) evicts the server connections PgBouncer is still caching
      // for this database; a plain DROP fails while the pooler holds them.
      await adminPool
        ?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        .catch(() => undefined);
    }
    await adminPool?.end();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  }, 120_000);

  async function freshDatabase(): Promise<{ direct: string; pooled: string }> {
    const name = databaseName();
    assertDisposableDatabase(name);
    await adminPool.query(`CREATE DATABASE ${name}`);
    created.push(name);
    return { direct: urlForDatabase(directBase, name), pooled: urlForDatabase(pooledBase, name) };
  }

  it('orphans a SESSION-scoped advisory lock through the pooler, but never a transaction-scoped one', async () => {
    const { direct, pooled } = await freshDatabase();
    const observer = new Client({ connectionString: direct });
    await observer.connect();

    try {
      // ---------- PART 1: session scope. The production bug. ----------
      const leaker = new Pool({ connectionString: pooled, max: 1 });
      // No explicit BEGIN, exactly like the previous revision of the migrator.
      // PgBouncer sees a complete implicit transaction and returns the backend
      // to its pool while the lock is still held on it.
      await leaker.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
      await leaker.end();

      // The client is GONE and the lock is still held. That is the orphan.
      const orphaned = await observer.query<{ pid: number }>(HELD_ADVISORY_LOCKS);
      expect(orphaned.rowCount).toBe(1);
      const orphanPid = orphaned.rows[0].pid;
      expect(orphanPid).not.toBe((await observer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid);

      // And it really does block the next migrator, which is why every
      // subsequent deploy would hang rather than fail.
      await observer.query('BEGIN');
      await observer.query('SET LOCAL lock_timeout = 2000');
      const blocked = await observer
        .query('SELECT pg_advisory_xact_lock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY])
        .then(
          () => null,
          (error: unknown) => error as { code?: string }
        );
      await observer.query('ROLLBACK');
      // 55P03 = lock_not_available. Without the bounded wait this would hang.
      expect(blocked?.code).toBe('55P03');

      // Clean the orphan up the only way there is: kill the backend holding it.
      await observer.query('SELECT pg_terminate_backend($1)', [orphanPid]);
      await waitForNoHeldAdvisoryLock(observer);

      // ---------- PART 2: transaction scope, through the SAME pooler. ----------
      const clean = new Pool({ connectionString: pooled, max: 1 });
      const client = await clean.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
      await client.query('ROLLBACK');
      client.release();
      await clean.end();

      // Released by ROLLBACK, on the same backend that took it. Nothing leaked.
      const afterXact = await observer.query(HELD_ADVISORY_LOCKS);
      expect(afterXact.rowCount).toBe(0);

      // And the next contender takes it immediately rather than timing out.
      await observer.query('BEGIN');
      await observer.query('SET LOCAL lock_timeout = 2000');
      await expect(
        observer.query('SELECT pg_advisory_xact_lock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY])
      ).resolves.toBeDefined();
      await observer.query('ROLLBACK');
    } finally {
      await observer.end().catch(() => undefined);
    }
  }, 180_000);

  it('applies every migration exactly once when two migrators race through the pooler', async () => {
    const { direct, pooled } = await freshDatabase();
    const { directory, expectedNames } = await prepareMigrationDirectory(
      path.join(tempRoot, 'pooled-race')
    );

    const results = await Promise.allSettled([
      migrate({ connectionString: pooled, migrationsDirectory: directory }),
      migrate({ connectionString: pooled, migrationsDirectory: directory })
    ]);

    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    expect(rejected.map(result => String(result.reason?.message ?? result.reason))).toEqual([]);

    const state = await readLedgerState(pooled);
    expect(state.duplicateNames).toEqual([]);
    expect(state.names).toEqual(expectedNames);
    expect(state.probeRows).toBe(1);

    // THE REGRESSION GUARD. If the migrator ever goes back to a session-level
    // lock, this is non-zero and every later deploy against this database hangs.
    const observer = new Client({ connectionString: direct });
    await observer.connect();
    try {
      const held = await observer.query(HELD_ADVISORY_LOCKS);
      expect(held.rowCount).toBe(0);
    } finally {
      await observer.end();
    }
  }, 300_000);

  it('leaves no lock behind after a FAILED run through the pooler, so the retry succeeds', async () => {
    const { direct, pooled } = await freshDatabase();
    const { directory, expectedNames } = await prepareMigrationDirectory(
      path.join(tempRoot, 'pooled-failure')
    );
    const brokenName = '998_deliberately_broken.sql';
    await writeFile(
      path.join(directory, brokenName),
      'SELECT * FROM a_table_that_does_not_exist;\n',
      'utf8'
    );

    await expect(
      migrate({ connectionString: pooled, migrationsDirectory: directory })
    ).rejects.toMatchObject({ code: '42P01', migrationFile: brokenName });

    const observer = new Client({ connectionString: direct });
    await observer.connect();
    try {
      // The failure path is where a session-scoped lock leaks most damagingly,
      // because the run never reaches a tidy shutdown. ROLLBACK released it.
      const held = await observer.query(HELD_ADVISORY_LOCKS);
      expect(held.rowCount).toBe(0);
      // All-or-nothing holds through the pooler too.
      const ledger = await observer.query<{ ledger: string | null }>(
        "SELECT to_regclass('migrations')::text AS ledger"
      );
      expect(ledger.rows[0].ledger).toBeNull();
    } finally {
      await observer.end();
    }

    // The retry a human would run next actually works.
    await rm(path.join(directory, brokenName));
    await migrate({ connectionString: pooled, migrationsDirectory: directory });
    const state = await readLedgerState(pooled);
    expect(state.names).toEqual(expectedNames);
    expect(state.probeRows).toBe(1);
  }, 300_000);
});
