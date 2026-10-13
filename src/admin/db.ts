import pg from "pg";

import { readDatesAsStrings } from "../db/dateParser.js";
import type { AdminSqlClient } from "./database.js";
import { AdminFoundationError } from "./errors.js";
import { readAdminDatabaseIdentity } from "./queries/environment.js";
import type { AdminEnvironment, AdminMode } from "./runtimeConfig.js";

const { Pool } = pg;

// Calendar dates as 'YYYY-MM-DD' strings, as the API reads them (#535).
readDatesAsStrings();

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

/** What `verifyReaderSeparation` found, each true one a way past the column grants. */
export interface ReaderSeparation {
  readsLetterContent: boolean;
  readsLetterRecipient: boolean;
  readsDraftBody: boolean;
  readsReturnAddress: boolean;
  readsTokenHash: boolean;
  unrestricted: boolean;
  privilegedMember: boolean;
  ownerMember: boolean;
}

/**
 * The reader role reads letters, drafts, users and tokens column by column,
 * never content, recipients, return addresses or token hashes
 * (ADMIN_READER_COLUMN_GRANTS). A table-wide grant by mistake, a superuser or
 * BYPASSRLS role, or membership of any role that can read letter content
 * (pg_read_all_data, neon_superuser, the tables' owner, the operator role),
 * even a membership without INHERIT, which SET ROLE can still use, reads them
 * anyway, and the grants say nothing (#730). Asked of the database itself, by
 * role name, so the panel checks the role it connected as at boot and
 * provisioning checks the role it is about to grant to. The tables resolve on
 * the caller's search_path, as every read model's do. One name parameter, one
 * type throughout.
 */
export async function readReaderSeparation(
  client: Pick<pg.Pool, "query">,
  role: string,
): Promise<ReaderSeparation | null> {
  const result = await client.query<{
    letters_content: boolean;
    letters_recipient: boolean;
    draft_body: boolean;
    return_address: boolean;
    token_hash: boolean;
    unrestricted: boolean;
    privileged_member: boolean;
    owner_member: boolean;
  }>(
    `SELECT
       has_column_privilege(r.oid, 'letters', 'content', 'SELECT') AS letters_content,
       has_column_privilege(r.oid, 'letters', 'recipient', 'SELECT') AS letters_recipient,
       has_column_privilege(r.oid, 'letter_drafts', 'body_text', 'SELECT') AS draft_body,
       has_column_privilege(r.oid, 'users', 'return_address', 'SELECT') AS return_address,
       has_column_privilege(r.oid, 'personal_access_tokens', 'token_hash', 'SELECT') AS token_hash,
       (r.rolsuper OR r.rolbypassrls) AS unrestricted,
       EXISTS (
         SELECT 1 FROM pg_roles AS member_of
          WHERE member_of.oid <> r.oid
            AND pg_has_role(r.oid, member_of.oid, 'MEMBER')
            AND (
              member_of.rolname IN ('pg_read_all_data', 'neon_superuser')
              OR member_of.rolsuper
              OR member_of.rolbypassrls
              OR has_column_privilege(member_of.oid, 'letters', 'content', 'SELECT')
            )
       ) AS privileged_member,
       pg_has_role(r.oid, (SELECT relowner FROM pg_class WHERE oid = 'letters'::regclass), 'MEMBER') AS owner_member
     FROM pg_roles AS r
     WHERE r.rolname = $1::name`,
    [role],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    readsLetterContent: row.letters_content,
    readsLetterRecipient: row.letters_recipient,
    readsDraftBody: row.draft_body,
    readsReturnAddress: row.return_address,
    readsTokenHash: row.token_hash,
    unrestricted: row.unrestricted,
    privilegedMember: row.privileged_member,
    ownerMember: row.owner_member,
  };
}

/** Refuses a reader role that can read past its column grants (#730). */
export async function verifyReaderSeparation(client: Pick<pg.Pool, "query">, role: string): Promise<void> {
  const separation = await readReaderSeparation(client, role);
  if (!separation || Object.values(separation).some(Boolean)) {
    throw new AdminFoundationError("ADMIN_READER_ROLE_TOO_WIDE");
  }
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
