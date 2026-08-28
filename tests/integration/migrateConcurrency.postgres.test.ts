/**
 * Concurrent-migrator integration test.
 *
 * Reproduces the production failure from PRs #164 and #165: Railway queued two
 * deploys at once, each ran the pre-deploy `npm run db:migrate:prod` against the
 * same Neon database, and the second deploy died because both processes
 * computed the same pending-migration list and raced to apply it.
 *
 * Runs against REAL PostgreSQL only; opt in exactly like commerceAcid.postgres.
 *
 * SCOPE LIMIT, read this before adding cases here: this file connects DIRECTLY
 * to PostgreSQL. It therefore cannot observe anything about connection-pooler
 * behaviour, and production's DATABASE_URL is a Neon `-pooler` endpoint. The
 * properties that only hold (or only break) under PgBouncer transaction
 * pooling — advisory lock scope above all — belong in
 * `migratePooled.postgres.test.ts`.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import {
  MIGRATION_ADVISORY_LOCK_KEY,
  prepareMigrationDirectory,
  readLedgerState,
  validateDisposableDatabaseUrl
} from './support/disposableDatabase.js';

const { Pool, Client } = pg;
const execFileAsync = promisify(execFile);

const enabled = process.env.LIRL_RUN_POSTGRES_INTEGRATION === 'true';
const describePostgres = enabled ? describe : describe.skip;

function schemaName(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function assertDisposableSchema(value: string): void {
  if (!/^lirl_migrate_[a-z0-9_]+$/.test(value)) {
    throw new Error(`Refusing destructive schema operation for unexpected name: ${value}`);
  }
}

async function createSchema(pool: pg.Pool, schema: string): Promise<void> {
  assertDisposableSchema(schema);
  await pool.query(`CREATE SCHEMA ${schema}`);
}

async function dropSchema(pool: pg.Pool, schema: string): Promise<void> {
  assertDisposableSchema(schema);
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
}

function databaseUrlForSchema(connectionString: string, schema: string): string {
  const parsed = new URL(connectionString);
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}

describePostgres('concurrent migrators on disposable PostgreSQL', () => {
  let adminPool: pg.Pool;
  let baseUrl: string;
  let tempRoot: string;
  let compiledMigrator: string;

  beforeAll(async () => {
    baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    tempRoot = await mkdtemp(path.join(tmpdir(), 'lirl-migrate-concurrency-'));

    // Build exactly what production ships so the subprocess cases can run the
    // real `node dist/cli/migrate.js` command Railway invokes pre-deploy.
    await execFileAsync(
      process.execPath,
      [
        path.resolve(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p',
        'tsconfig.json'
      ],
      { cwd: process.cwd(), maxBuffer: 20_000_000 }
    );
    compiledMigrator = path.resolve(process.cwd(), 'dist', 'cli', 'migrate.js');
  }, 300_000);

  afterAll(async () => {
    await adminPool?.end();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it('applies every migration exactly once when two migrators race a fresh database', async () => {
    const schema = schemaName('lirl_migrate_race');
    await createSchema(adminPool, schema);
    try {
      const { directory, expectedNames } = await prepareMigrationDirectory(
        path.join(tempRoot, 'race')
      );
      const url = databaseUrlForSchema(baseUrl, schema);

      // Two independent migrate() calls, each building its own Pool and so its
      // own PostgreSQL sessions and its own transaction — genuine contention on
      // the advisory lock, not two callers sharing one connection.
      const results = await Promise.allSettled([
        migrate({ connectionString: url, migrationsDirectory: directory }),
        migrate({ connectionString: url, migrationsDirectory: directory })
      ]);

      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );
      expect(
        rejected.map(result => String(result.reason?.message ?? result.reason))
      ).toEqual([]);
      expect(results.every(result => result.status === 'fulfilled')).toBe(true);

      const state = await readLedgerState(url);
      expect(state.duplicateNames).toEqual([]);
      expect(state.names).toEqual(expectedNames);
      expect(state.names).toHaveLength(expectedNames.length);
      // The decisive assertion: the probe's INSERT is unconditional, so two
      // rows here would mean a migration body executed twice.
      expect(state.probeRows).toBe(1);
    } finally {
      await dropSchema(adminPool, schema);
    }
  }, 180_000);

  it('is a no-op when a third migrator runs after the race has settled', async () => {
    const schema = schemaName('lirl_migrate_settled');
    await createSchema(adminPool, schema);
    try {
      const { directory, expectedNames } = await prepareMigrationDirectory(
        path.join(tempRoot, 'settled')
      );
      const url = databaseUrlForSchema(baseUrl, schema);

      await Promise.all([
        migrate({ connectionString: url, migrationsDirectory: directory }),
        migrate({ connectionString: url, migrationsDirectory: directory })
      ]);
      await migrate({ connectionString: url, migrationsDirectory: directory });

      const state = await readLedgerState(url);
      expect(state.duplicateNames).toEqual([]);
      expect(state.names).toEqual(expectedNames);
      expect(state.probeRows).toBe(1);
    } finally {
      await dropSchema(adminPool, schema);
    }
  }, 180_000);

  it('rolls the ENTIRE run back when one migration fails, then reruns cleanly', async () => {
    // Replaces an earlier case that claimed to prove the advisory lock was
    // released after a failure. It could not: migrate() ends its pool in the
    // same finally block, and ending the pool drops a session-level lock on its
    // own, so the assertion passed with or without an explicit unlock. Lock
    // SCOPE is only observable through a pooler and is proven in
    // migratePooled.postgres.test.ts.
    //
    // What IS observable here, and what this now pins, is the all-or-nothing
    // semantics of wrapping the run in a single transaction: a failure must
    // leave the database byte-for-byte untouched, not partially migrated.
    const schema = schemaName('lirl_migrate_failure');
    await createSchema(adminPool, schema);
    try {
      const brokenRoot = path.join(tempRoot, 'broken');
      const { directory, expectedNames } = await prepareMigrationDirectory(brokenRoot);
      // Sorts after every real migration but before the 999 probe, so the run
      // dies with ~23 files already applied inside the open transaction.
      const brokenName = '998_deliberately_broken.sql';
      await writeFile(
        path.join(directory, brokenName),
        'SELECT * FROM a_table_that_does_not_exist;\n',
        'utf8'
      );
      const url = databaseUrlForSchema(baseUrl, schema);

      // The original PostgreSQL error is rethrown, annotated in place, so both
      // its own fields and the failing filename survive for the caller.
      await expect(
        migrate({ connectionString: url, migrationsDirectory: directory })
      ).rejects.toMatchObject({ code: '42P01', migrationFile: brokenName });

      // ALL-OR-NOTHING. Under the previous per-file-commit design this schema
      // would now hold a migrations ledger with every file up to 023 in it.
      // Under a single wrapping transaction not even the ledger table survives,
      // because CREATE TABLE IF NOT EXISTS was part of the same transaction.
      const afterFailure = await adminPool.query<{ ledger: string | null }>(
        'SELECT to_regclass($1)::text AS ledger',
        [`${schema}.migrations`]
      );
      expect(afterFailure.rows[0].ledger).toBeNull();

      // ...and the next migrator still runs to completion.
      await rm(path.join(directory, brokenName));
      await migrate({ connectionString: url, migrationsDirectory: directory });

      const state = await readLedgerState(url);
      expect(state.duplicateNames).toEqual([]);
      expect(state.names).toEqual(expectedNames);
      expect(state.probeRows).toBe(1);
    } finally {
      await dropSchema(adminPool, schema);
    }
  }, 180_000);

  it('fails with a bounded lock_timeout instead of hanging when the lock is already held', async () => {
    // Without `SET LOCAL lock_timeout` this case does not fail — it HANGS,
    // until the platform kills the deploy with no diagnostic. That is the
    // failure mode being pinned, so a regression shows up as a test timeout.
    const schema = schemaName('lirl_migrate_locked');
    await createSchema(adminPool, schema);
    const holder = new Client({ connectionString: baseUrl });
    try {
      const { directory } = await prepareMigrationDirectory(path.join(tempRoot, 'locked'));
      const url = databaseUrlForSchema(baseUrl, schema);

      // Hold the lock from an unrelated session. Advisory locks are scoped to
      // the DATABASE, so a different schema does not escape it.
      await holder.connect();
      await holder.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);

      const startedAt = Date.now();
      const failure = await migrate({
        connectionString: url,
        migrationsDirectory: directory
      }).then(
        () => null,
        (error: unknown) => error as { code?: string; migrationLockTimeout?: boolean }
      );
      const elapsedMs = Date.now() - startedAt;

      // 55P03 = lock_not_available, i.e. lock_timeout expired.
      expect(failure?.code).toBe('55P03');
      // Flagged so the CLI reports lock contention rather than sending the
      // operator off to debug a migration file that is perfectly fine.
      expect(failure?.migrationLockTimeout).toBe(true);
      // Bounded: it gave up on its own rather than waiting indefinitely.
      expect(elapsedMs).toBeLessThan(150_000);

      // Nothing was applied while it was blocked.
      const afterTimeout = await adminPool.query<{ ledger: string | null }>(
        'SELECT to_regclass($1)::text AS ledger',
        [`${schema}.migrations`]
      );
      expect(afterTimeout.rows[0].ledger).toBeNull();
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [
        MIGRATION_ADVISORY_LOCK_KEY
      ]).catch(() => undefined);
      await holder.end().catch(() => undefined);
      await dropSchema(adminPool, schema);
    }
  }, 300_000);

  it('survives two real `node dist/cli/migrate.js` processes racing, as Railway runs them', async () => {
    const schema = schemaName('lirl_migrate_subprocess');
    await createSchema(adminPool, schema);
    try {
      const subprocessRoot = path.join(tempRoot, 'subprocess');
      const { expectedNames } = await prepareMigrationDirectory(subprocessRoot);
      const url = databaseUrlForSchema(baseUrl, schema);

      const spawnMigrator = () =>
        execFileAsync(process.execPath, [compiledMigrator], {
          // cwd drives the CLI's default `<cwd>/db/migrations` lookup.
          cwd: subprocessRoot,
          env: {
            ...process.env,
            NODE_ENV: 'test',
            DATABASE_URL: url
          },
          maxBuffer: 20_000_000
        });

      const results = await Promise.allSettled([spawnMigrator(), spawnMigrator()]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => {
          const reason = result.reason as { code?: number; stdout?: string; stderr?: string };
          return `exit=${reason?.code} stdout=${reason?.stdout ?? ''} stderr=${reason?.stderr ?? ''}`;
        });
      expect(failures).toEqual([]);

      const state = await readLedgerState(url);
      expect(state.duplicateNames).toEqual([]);
      expect(state.names).toEqual(expectedNames);
      expect(state.probeRows).toBe(1);
    } finally {
      await dropSchema(adminPool, schema);
    }
  }, 300_000);

  it('exits non-zero and names the failing migration file without leaking the error', async () => {
    const schema = schemaName('lirl_migrate_diagnostic');
    await createSchema(adminPool, schema);
    try {
      const diagnosticRoot = path.join(tempRoot, 'diagnostic');
      const { directory } = await prepareMigrationDirectory(diagnosticRoot);
      const brokenName = '997_diagnostic_broken.sql';
      const sensitive = 'super_secret_column_name_should_not_leak';
      await writeFile(
        path.join(directory, brokenName),
        `SELECT ${sensitive} FROM a_table_that_does_not_exist;\n`,
        'utf8'
      );
      const url = databaseUrlForSchema(baseUrl, schema);

      const failure = await execFileAsync(process.execPath, [compiledMigrator], {
        cwd: diagnosticRoot,
        env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: url },
        maxBuffer: 20_000_000
      }).then(
        () => null,
        (error: { code?: number; stderr?: string }) => error
      );

      // A failed migration must still fail the deploy.
      expect(failure).not.toBeNull();
      expect(failure?.code).toBe(1);

      const stderr = failure?.stderr ?? '';
      // The filename is surfaced so a Railway log identifies WHICH migration died...
      expect(stderr).toContain(`"migrationFile":"${brokenName}"`);
      expect(stderr).toContain('"event":"database.migration_failed"');
      // ...while the underlying PostgreSQL error stays redacted to its class.
      expect(stderr).toContain('"errorClass"');
      expect(stderr).not.toContain(sensitive);
      expect(stderr).not.toContain('does not exist');
    } finally {
      await dropSchema(adminPool, schema);
    }
  }, 180_000);
});
