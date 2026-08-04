import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';

const { Pool } = pg;

/**
 * Transaction-scoped advisory lock key that serialises the whole migration run.
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

/**
 * Bounded wait for the advisory lock, in milliseconds.
 *
 * Why bounded at all: without it, a migrator that queues behind a stuck or slow
 * run blocks forever and the deploy dies on the platform's own timeout with no
 * diagnostic — the operator sees a killed deploy and no reason. With it, the
 * loser fails in a known time with `database.migration_lock_timeout`, which
 * says exactly what happened and is safe to retry by redeploying.
 *
 * Why 60s specifically:
 *   - The winning run it waits on is short. A single pending migration commits
 *     in well under a second; a full 23-file bootstrap of this repository takes
 *     a few seconds. 60s is roughly an order of magnitude of headroom over the
 *     realistic worst case, so a legitimate concurrent deploy is waited out
 *     rather than spuriously failed.
 *   - It is far inside any platform deploy window, so WE produce the error and
 *     the log line, not the platform's SIGKILL.
 *
 * Note this is `SET LOCAL`, so it stays in force for the rest of the
 * transaction and therefore also bounds the lock waits of the migration DDL
 * itself. That is deliberate: a migration blocked behind a long-running
 * application query should fail loudly and quickly rather than hold the
 * migration lock open while the deploy hangs. It does mean a migration that
 * genuinely needs to wait more than 60s for a table lock will now fail; see the
 * constraints section of db/migrations/README.md.
 */
const MIGRATION_LOCK_TIMEOUT_MS = 60_000;

/** SQLSTATE PostgreSQL raises when `lock_timeout` expires. */
const LOCK_NOT_AVAILABLE = '55P03';

export interface MigrationOptions {
  connectionString?: string;
  migrationsDirectory?: string;
}

function isLockAcquisitionTimeout(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'migrationLockTimeout' in error &&
    (error as { migrationLockTimeout?: unknown }).migrationLockTimeout === true
  );
}

export function writeMigrationFailure(error: unknown, migrationFile?: string): void {
  // A lock timeout is NOT a broken migration, and reporting it as one sends the
  // operator to read migration SQL that is perfectly fine. It gets its own
  // event so the deploy log distinguishes "another migrator is running" from
  // "a migration is broken".
  if (isLockAcquisitionTimeout(error)) {
    writeDiagnostic('error', 'database.migration_lock_timeout', {
      errorClass: classifyDiagnosticError(error, 'database_error'),
      lockTimeoutMs: MIGRATION_LOCK_TIMEOUT_MS
    });
    return;
  }

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

/**
 * Marks a `lock_timeout` expiry on the advisory lock so the CLI can report it
 * as lock contention rather than as a broken migration. Annotated in place for
 * the same reason as `tagMigrationFile`: PostgreSQL's own fields must survive.
 */
function tagLockAcquisitionFailure(error: unknown): unknown {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === LOCK_NOT_AVAILABLE
  ) {
    try {
      (error as { migrationLockTimeout?: boolean }).migrationLockTimeout = true;
    } catch {
      // Same rationale as tagMigrationFile: annotation is best-effort.
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

/**
 * Rolls the run back without letting the rollback outcome hide the real error.
 *
 * A failing ROLLBACK is not noise — it means the connection is no longer in a
 * state where the protocol is being honoured, and silently swallowing it was a
 * review finding against the previous revision. So it is reported on its own
 * channel and the connection is destroyed rather than handed back to the pool,
 * while the ORIGINAL migration error remains the one that propagates.
 */
async function rollbackRun(client: pg.PoolClient): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return true;
  } catch (rollbackError) {
    writeDiagnostic('error', 'database.migration_rollback_failed', {
      errorClass: classifyDiagnosticError(rollbackError, 'database_error')
    });
    return false;
  }
}

export async function migrate(options: MigrationOptions = {}): Promise<void> {
  const pool = new Pool({
    connectionString: options.connectionString || process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    // One connection is all this needs: the entire run is a single transaction
    // on a single client. (The previous revision needed two because it pinned a
    // separate session to hold a session-level lock. That design is what this
    // revision removes.)
    max: 1,
    connectionTimeoutMillis: 5_000
  });
  const migrationsDirectory =
    options.migrationsDirectory || path.resolve(process.cwd(), 'db', 'migrations');

  // `connect()` is INSIDE the try so that a failure to connect at all still
  // reaches the `pool.end()` below. Acquiring it outside would leave the pool
  // un-ended on that path, which is how a migrator that cannot reach the
  // database ends up hanging instead of exiting non-zero.
  let client: pg.PoolClient | undefined;
  let inTransaction = false;
  let rolledBackCleanly = true;
  try {
    client = await pool.connect();

    // THE WHOLE RUN IS ONE TRANSACTION. Ledger creation, the ledger read, every
    // migration body, and every ledger insert all commit or none of them do.
    await client.query('BEGIN');
    inTransaction = true;

    // SET LOCAL, not SET: transaction-scoped, so it cannot leak onto a pooled
    // server backend that gets handed to somebody else. See the lock comment
    // below for why that distinction governs everything in this function.
    await client.query(`SET LOCAL lock_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);

    // ==================================================================
    // THIS LOCK MUST STAY TRANSACTION-SCOPED. DO NOT "SIMPLIFY" IT TO
    // pg_advisory_lock + pg_advisory_unlock.
    //
    // DATABASE_URL points at Neon's POOLED endpoint (the `-pooler` hostname),
    // which docs/infrastructure.md and docs/deployment.md mandate for both
    // environments. That endpoint is PgBouncer in TRANSACTION pooling mode: a
    // server backend is bound to a client only for the duration of a
    // transaction, then returned to the pool.
    //
    // A session-level `pg_advisory_lock()` issued outside an explicit
    // transaction is its own implicit transaction, so PgBouncer hands the
    // backend away the instant it returns — while that backend still holds the
    // lock. The matching `pg_advisory_unlock()` then lands on whatever backend
    // PgBouncer happens to pick, returns FALSE rather than raising, and the
    // lock is orphaned for the life of the server process. Closing the client
    // pool does not help: it closes the socket to PgBouncer, never the backend
    // holding the lock. Every later deploy then blocks on a lock nothing will
    // ever release, and redeploying does not clear it.
    //
    // `pg_advisory_xact_lock` inside an explicit transaction is immune by
    // construction: PgBouncer pins the backend for the transaction, and the
    // lock is released by COMMIT or ROLLBACK on that same backend. Every other
    // advisory lock in this repository is transaction-scoped for this reason.
    //
    // Regression-guarded by tests/integration/migratePooled.postgres.test.ts,
    // which runs a real PgBouncer in transaction pooling mode and demonstrates
    // the session-scoped lock leaking and the transaction-scoped one not.
    // ==================================================================
    try {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
    } catch (error) {
      throw tagLockAcquisitionFailure(error);
    }

    // Ledger creation belongs inside the critical section: concurrent
    // `CREATE TABLE IF NOT EXISTS` is itself racy in PostgreSQL (it can fail on
    // a pg_type/pg_class unique violation).
    await client.query(`
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
    const executed = await client.query<{ name: string }>('SELECT name FROM migrations');
    const executedNames = new Set(executed.rows.map((row) => row.name));
    const files = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith('.sql'))
      .sort();

    const applied: string[] = [];
    for (const file of files) {
      if (executedNames.has(file)) continue;
      const sql = await readFile(path.join(migrationsDirectory, file), 'utf8');
      try {
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
        applied.push(file);
      } catch (error) {
        throw tagMigrationFile(error, file);
      }
    }

    await client.query('COMMIT');
    inTransaction = false;

    // Logged only after COMMIT. Announcing "Applied X" mid-transaction would be
    // a lie whenever a later file fails, because the run is all-or-nothing and
    // X would be rolled back with everything else.
    for (const file of applied) {
      console.log(`[Migrate] Applied ${file}`);
    }
  } catch (error) {
    if (client && inTransaction) rolledBackCleanly = await rollbackRun(client);
    throw error;
  } finally {
    // A connection whose ROLLBACK failed is in an unknown protocol state;
    // destroy it instead of returning it to the pool.
    client?.release(rolledBackCleanly ? undefined : true);
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate().catch((error: unknown) => {
    writeMigrationFailure(error, readMigrationFile(error));
    process.exitCode = 1;
  });
}
