/**
 * Shared fixtures for the migrator integration suites.
 *
 * Extracted from `migrateConcurrency.postgres.test.ts` so the pooled-topology
 * suite reuses the SAME fail-closed URL gate and the SAME double-application
 * probe. A safety gate that exists in two hand-maintained copies is a gate that
 * eventually differs between them.
 */

import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

export const repositoryMigrations = path.resolve(process.cwd(), 'db', 'migrations');

/**
 * The migration advisory lock key, duplicated from `src/cli/migrate.ts` on
 * purpose. The production constant is load-bearing for cross-deploy mutual
 * exclusion (every deploy image must contend for the same value), so a silent
 * edit to it should break a test rather than quietly stop serialising old
 * images against new ones.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = '7252245186587111069';

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
export const PROBE_MIGRATION_NAME = '999_concurrency_probe.sql';
export const PROBE_MIGRATION_SQL = `-- Test-only probe. Never added to db/migrations.
CREATE TABLE IF NOT EXISTS migration_concurrency_probe (
  id SERIAL PRIMARY KEY,
  marker TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO migration_concurrency_probe (marker) VALUES ('probe');
`;

export function validateDisposableDatabaseUrl(value: string | undefined): string {
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

/**
 * Copies the real repository migrations into a scratch directory and appends
 * the double-application probe. The real files are used unmodified so the test
 * exercises genuine DDL (bare CREATE TABLE, which collides hard if applied
 * twice), and db/migrations itself is never written to.
 */
export async function prepareMigrationDirectory(root: string): Promise<{
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

export interface LedgerState {
  names: string[];
  duplicateNames: string[];
  probeRows: number;
}

export async function readLedgerState(connectionString: string): Promise<LedgerState> {
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
