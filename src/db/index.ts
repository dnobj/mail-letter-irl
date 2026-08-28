/** Database connection and query utilities. */

import pg from 'pg';

import { isWakeConnectionError } from './wakeRetry.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';

const { Pool } = pg;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function isPooledConnectionString(connectionString?: string): boolean {
  if (!connectionString) return false;
  try {
    const hostname = new URL(connectionString).hostname.toLowerCase();
    return hostname.includes('-pooler') || hostname.startsWith('pooler.');
  } catch {
    return false;
  }
}

if (process.env.NODE_ENV === 'production' && !isPooledConnectionString(process.env.DATABASE_URL)) {
  console.warn('DATABASE_URL does not appear to use a Neon pooled hostname');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // TLS: verify, and never fall back to plaintext.
  //
  // node-postgres merges the parsed connection string OVER this config
  // (Object.assign in pg/lib/connection-parameters.js), so wherever the URL
  // carries an sslmode this key is DISCARDED - with a Neon URL, true, false
  // and undefined all resolve identically to {}, which Node then verifies by
  // default. So for the normal case this line is inert, and the old
  // `rejectUnauthorized: false` was never what production actually did.
  //
  // It is live in exactly one shape: a URL with NO sslmode. There the string
  // sets nothing, this option applies, and it used to say false - the bare
  // fallback URL an operator is most likely to paste was the one connection
  // that skipped verification. Deleting the option outright would be worse
  // still, dropping that case to plaintext. true is the only value that is
  // inert where it is ignored and correct where it is not.
  //
  // It cannot fix sslmode=no-verify, sslmode=disable or uselibpqcompat=true,
  // because those come from the URL and win. databaseTlsPosture() in
  // src/config/deploymentConfig.ts refuses those at boot.
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : undefined,
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: true,
});

pool.on('connect', () => {
  console.log('Database client connected');
});

export function writeDatabaseFailure(event: string, error: unknown): void {
  writeDiagnostic('error', event, {
    errorClass: classifyDiagnosticError(error, 'database_error')
  });
}

pool.on('error', (error) => {
  writeDatabaseFailure('database.pool_error', error);
});

export async function testConnection(): Promise<boolean> {
  try {
    const result = await query<{ now: Date; version: string }>(
      'SELECT NOW() as now, version() as version'
    );
    console.log('Database connected successfully');
    console.log(`   Time: ${result.rows[0].now}`);
    console.log(`   Version: ${result.rows[0].version.split(' ').slice(0, 2).join(' ')}`);
    return true;
  } catch (error) {
    writeDatabaseFailure('database.connection_failed', error);
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
  console.log('Database connection pool closed');
}

/**
 * Retry once only when Neon reports that a suspended compute cannot accept a
 * connection yet. Other failures are not retried because a write may have an
 * ambiguous outcome.
 */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await pool.query<T>(text, params);
      const duration = Date.now() - start;
      if (duration > 100) {
        console.log(`Slow query (${duration}ms)`);
      }
      return result;
    } catch (error) {
      if (attempt === 0 && isWakeConnectionError(error)) {
        await wait(250);
        continue;
      }
      writeDatabaseFailure('database.query_failed', error);
      throw error;
    }
  }
  throw new Error('Database query retry exhausted');
}

async function connectForTransaction(): Promise<pg.PoolClient> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let client: pg.PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      return client;
    } catch (error) {
      client?.release(true);
      if (attempt === 0 && isWakeConnectionError(error)) {
        await wait(250);
        continue;
      }
      throw error;
    }
  }
  throw new Error('Database transaction connection retry exhausted');
}

export async function transaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await connectForTransaction();
  try {
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      writeDatabaseFailure('database.rollback_failed', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

export default pool;
