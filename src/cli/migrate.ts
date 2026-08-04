import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';

const { Pool } = pg;

/**
 * Session-level advisory lock key that serialises the whole migration run.
 *
 * Derived deterministically from a fixed namespace string:
 *
 *   BigInt.asIntN(
 *     64,
 *     BigInt('0x' + createHash('sha256')
 *       .update('letter-irl:db-migrations')
 *       .digest('hex')
 *       .slice(0, 16))
 *   )
 *   // => 7252245186587111069
 *
 * It is written out as a literal constant rather than computed at runtime on
 * purpose. Concurrent migrators come from DIFFERENT deploy images (this is
 * exactly what happened when PRs #164 and #165 merged back to back and Railway
 * ran two pre-deploy `db:migrate:prod` commands against the same Neon
 * database). Every image, old and new, must contend for the SAME key or the
 * lock protects nothing. A hardcoded constant cannot drift; a runtime-computed
 * one silently could if the namespace string were ever edited.
 *
 * Advisory locks are scoped to the DATABASE, not to a schema or search_path.
 * Two migrators targeting different schemas of one database therefore serialise
 * against each other. That is slower but never incorrect, and production runs
 * exactly one schema.
 */
const MIGRATION_ADVISORY_LOCK_KEY = '7252245186587111069';

export interface MigrationOptions {
  connectionString?: string;
  migrationsDirectory?: string;
}

export function writeMigrationFailure(error: unknown, migrationFile?: string): void {
  writeDiagnostic('error', 'database.migration_failed', {
    errorClass: classifyDiagnosticError(error, 'database_error'),
    // The failing migration FILENAME is deliberately not redacted. Filenames are
    // repository-public build inputs and carry no user or secret data, while the
    // redacted error class alone made the #164/#165 Railway failure effectively
    // undiagnosable from the deploy log. See issue #160 for the redaction policy
    // this stays within.
    ...(migrationFile ? { migrationFile } : {})
  });
}

/**
 * Tags a failing migration's error with the filename that produced it.
 *
 * The error is annotated IN PLACE and rethrown rather than wrapped in a new
 * error type. Callers (and tests) inspect PostgreSQL's own fields on it —
 * `code`, `detail`, `constraint` — and wrapping would hide every one of them.
 */
function tagMigrationFile(error: unknown, file: string): unknown {
  if (error && typeof error === 'object' && !('migrationFile' in error)) {
    try {
      (error as { migrationFile?: string }).migrationFile = file;
    } catch {
      // Frozen or exotic error object; the filename is a nice-to-have, never
      // a reason to replace the real failure.
    }
  }
  return error;
}

function readMigrationFile(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'migrationFile' in error) {
    const value = (error as { migrationFile?: unknown }).migrationFile;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

export async function migrate(options: MigrationOptions = {}): Promise<void> {
  const pool = new Pool({
    connectionString: options.connectionString || process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    // At least 2: one connection is pinned for the whole run holding the
    // advisory lock, the rest do the actual migration work. With max: 1 the
    // lock holder would starve every subsequent query and self-deadlock.
    max: 2,
    connectionTimeoutMillis: 5_000,
  });
  const migrationsDirectory =
    options.migrationsDirectory || path.resolve(process.cwd(), 'db', 'migrations');

  let lockClient: pg.PoolClient | undefined;
  try {
    // Take the lock FIRST, before touching the ledger table at all. Concurrent
    // `CREATE TABLE IF NOT EXISTS` is itself racy in PostgreSQL (it can fail on
    // a pg_type/pg_class unique violation), so ledger creation belongs inside
    // the critical section too.
    lockClient = await pool.connect();
    await lockClient.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // THE CORRECTNESS FIX. This read must happen AFTER the lock is held.
    //
    // Previously the executed-migration set was snapshotted before the apply
    // loop with no serialisation at all, so two concurrent processes computed
    // the same pending list and both tried to apply the same files. The lock
    // alone would NOT be enough: a process that queued on the lock and then
    // tested a snapshot taken before it waited would still believe the winner's
    // freshly-committed migrations were pending, and would re-run them.
    // Reading here means the waiter observes the winner's committed work and
    // correctly skips those files.
    const executed = await pool.query<{ name: string }>('SELECT name FROM migrations');
    const executedNames = new Set(executed.rows.map((row) => row.name));
    const files = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (executedNames.has(file)) continue;
      const sql = await readFile(path.join(migrationsDirectory, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        // Belt and braces only. ON CONFLICT DO NOTHING prevents a duplicate
        // ledger ROW, but it would NOT have fixed the original defect: by the
        // time this statement runs the migration SQL body above has already
        // executed a second time. Preventing the duplicate apply is the job of
        // the advisory lock plus the post-lock ledger re-read. This guard just
        // stops a ledger unique-violation from turning an otherwise-survivable
        // race into a failed deploy.
        await client.query(
          'INSERT INTO migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
          [file]
        );
        await client.query('COMMIT');
        console.log(`[Migrate] Applied ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw tagMigrationFile(error, file);
      } finally {
        client.release();
      }
    }
  } finally {
    // Release on every path, including failure. Session-level advisory locks
    // would also be dropped when the connection closes, but an explicit unlock
    // keeps the lock from lingering if the pool were ever changed to reuse
    // sessions.
    if (lockClient) {
      try {
        await lockClient.query('SELECT pg_advisory_unlock($1::bigint)', [
          MIGRATION_ADVISORY_LOCK_KEY
        ]);
      } catch {
        // An unlock failure must not mask the original migration error; the
        // session is torn down by pool.end() below regardless.
      } finally {
        lockClient.release();
      }
    }
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate().catch((error: unknown) => {
    writeMigrationFailure(error, readMigrationFile(error));
    process.exitCode = 1;
  });
}
