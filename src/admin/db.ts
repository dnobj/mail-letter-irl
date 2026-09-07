import pg from "pg";

import type { AdminSqlClient } from "./database.js";
import { AdminFoundationError } from "./errors.js";
import { readAdminDatabaseIdentity } from "./queries/environment.js";
import type { AdminEnvironment, AdminMode } from "./runtimeConfig.js";

const { Pool } = pg;

/**
 * Two pools, two roles. Reads always go through the reader role, so the page
 * can never select what the reader cannot. The operator pool exists only in
 * full mode and is used by the command runner for its own rows; domain
 * services run through the global pool (src/db/index.ts), which the same
 * DATABASE_URL points at the operator role in full mode and at the reader
 * role in read-only mode, where any write fails at PostgreSQL.
 */
export interface AdminPools {
  reader: pg.Pool;
  operator: pg.Pool | null;
}

export interface AdminPoolConfig {
  readerDatabaseUrl: string;
  operatorDatabaseUrl: string | null;
  mode: AdminMode;
}

function poolOptions(connectionString: string, max: number): pg.PoolConfig {
  return {
    connectionString,
    // Mirrors src/db/index.ts: inert where the URL carries sslmode, and the
    // verifying default where it does not.
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: true }
        : undefined,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
    allowExitOnIdle: true,
  };
}

export function createAdminPools(config: AdminPoolConfig): AdminPools {
  const reader = new Pool(poolOptions(config.readerDatabaseUrl, 4));
  reader.on("error", () => {
    // Idle-client errors are logged by the caller's health checks; nothing
    // here may print a connection string.
    console.error('{"event":"admin.reader_pool_error"}');
  });
  const operator =
    config.mode === "full" && config.operatorDatabaseUrl
      ? new Pool(poolOptions(config.operatorDatabaseUrl, 2))
      : null;
  operator?.on("error", () => {
    console.error('{"event":"admin.operator_pool_error"}');
  });
  return { reader, operator };
}

export interface VerifiedDatabaseIdentity {
  databaseName: string;
  roleName: string;
  marker: AdminEnvironment;
}

/**
 * The connected role must be the one this mode expects and the database's
 * marker must be this environment. Either mismatch is a boot failure; the
 * codes map to 503 so a health probe says "misconfigured", not "up".
 */
export async function verifyDatabaseIdentity(
  pool: pg.Pool,
  expected: { role: string; environment: AdminEnvironment },
): Promise<VerifiedDatabaseIdentity> {
  const identity = await readAdminDatabaseIdentity(pool);
  if (identity.roleName !== expected.role) {
    throw new AdminFoundationError("ADMIN_DATABASE_ROLE_MISMATCH");
  }
  if (identity.marker === null) {
    throw new AdminFoundationError("ADMIN_DATABASE_MARKER_MISSING");
  }
  if (identity.marker !== expected.environment) {
    throw new AdminFoundationError("ADMIN_ENVIRONMENT_MISMATCH");
  }
  return {
    databaseName: identity.databaseName,
    roleName: identity.roleName,
    marker: identity.marker,
  };
}

/** Every read model runs inside a READ ONLY transaction on the reader pool. */
export async function withReadOnlyTransaction<T>(
  pool: pg.Pool,
  callback: (client: AdminSqlClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is being released anyway.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(
  pool: pg.Pool,
  callback: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Released below.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function closeAdminPools(pools: AdminPools): Promise<void> {
  await Promise.allSettled([pools.reader.end(), pools.operator?.end()]);
}
