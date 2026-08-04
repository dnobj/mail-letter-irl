/**
 * Concurrent-migrator integration test.
 *
 * Reproduces the production failure from PRs #164 and #165: Railway queued two
 * deploys at once, each ran the pre-deploy `npm run db:migrate:prod` against the
 * same Neon database, and the second deploy died because both processes
 * computed the same pending-migration list and raced to apply it.
 *
 * Runs against REAL PostgreSQL only; opt in exactly like commerceAcid.postgres.
 */

import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';

const { Pool } = pg;
const execFileAsync = promisify(execFile);

const enabled = process.env.LIRL_RUN_POSTGRES_INTEGRATION === 'true';
const describePostgres = enabled ? describe : describe.skip;
const repositoryMigrations = path.resolve(process.cwd(), 'db', 'migrations');

/**
 * A test-only migration appended after the real repository set.
 *
 * It is deliberately written so that a SECOND execution does NOT raise: the
 * table creation is guarded with IF NOT EXISTS, but the INSERT is
 * unconditional. So if a migration SQL body is ever applied twice, this table
 * silently ends up with two rows instead of one. That makes it a positive
 * detector for double-application rather than relying only on the real
 * migrations happening to collide.
 */
const PROBE_MIGRATION_NAME = '999_concurrency_probe.sql';
const PROBE_MIGRATION_SQL = `-- Test-only probe. Never added to db/migrations.
CREATE TABLE IF NOT EXISTS migration_concurrency_probe (
  id SERIAL PRIMARY KEY,
  marker TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO migration_concurrency_probe (marker) VALUES ('probe');
`;

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

/**
 * Copies the real repository migrations into a scratch directory and appends
 * the double-application probe. The real files are used unmodified so the test
 * exercises genuine DDL (bare CREATE TABLE, which collides hard if applied
 * twice), and db/migrations itself is never written to.
 */
async function prepareMigrationDirectory(root: string): Promise<{
  directory: string;
  expectedNames: string[];
}> {
  const directory = path.join(root, 'db', 'migrations');
  await mkdir(directory, { recursive: true });
  const files = (await readdir(repositoryMigrations)).filter(file => file.endsWith('.sql'));
  for (const file of files) {
    await copyFile(path.join(repositoryMigrations, file), path.join(directory, file));
  }
  await writeFile(path.join(directory, PROBE_MIGRATION_NAME), PROBE_MIGRATION_SQL, 'utf8');
  return { directory, expectedNames: [...files, PROBE_MIGRATION_NAME].sort() };
}

interface LedgerState {
  names: string[];
  duplicateNames: string[];
  probeRows: number;
}

async function readLedgerState(connectionString: string): Promise<LedgerState> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const ledger = await pool.query<{ name: string; occurrences: string }>(
      'SELECT name, COUNT(*)::text AS occurrences FROM migrations GROUP BY name ORDER BY name'
    );
    const probe = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM migration_concurrency_probe'
    );
    return {
      names: ledger.rows.map(row => row.name),
      duplicateNames: ledger.rows.filter(row => row.occurrences !== '1').map(row => row.name),
      probeRows: Number(probe.rows[0].count)
    };
  } finally {
    await pool.end();
  }
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
      // own PostgreSQL sessions — the advisory lock is session-scoped, so this
      // is genuine contention, not two callers sharing one connection.
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

  it('releases the advisory lock after a failure so the next migrator still runs', async () => {
    const schema = schemaName('lirl_migrate_failure');
    await createSchema(adminPool, schema);
    try {
      const brokenRoot = path.join(tempRoot, 'broken');
      const { directory, expectedNames } = await prepareMigrationDirectory(brokenRoot);
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

      // If the failure path leaked the session-level lock, this second call
      // would block until the pool's connectionTimeoutMillis and fail.
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
