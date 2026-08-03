#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";

import pg from "pg";

import {
  loadAdminEnvironmentConfig,
  validateAdminCredentialEnvironment,
} from "../src/admin/config.js";
import { AdminFoundationError } from "../src/admin/errors.js";
import {
  ADMIN_FOUNDATION_MIGRATION,
  ADMIN_JIT_PREDECESSOR_MIGRATION,
  ADMIN_PROVISIONING_DATABASE_URL_ENV,
  buildAdminGrantStatements,
  parseAdminProvisioningArguments,
  validateProvisioningConfig,
  validateProvisioningConnectionUrl,
  validateProvisioningRoles,
  type AdminProvisioningRole,
} from "../src/admin/provisioning.js";

const { Pool } = pg;

interface DatabaseContextRow {
  databaseName: string;
  roleName: string;
}

interface MigrationRow {
  name: string;
}

interface MarkerRow {
  environment: "development" | "production";
}

function usesLocalPostgres(connectionString: string): boolean {
  const hostname = new URL(connectionString).hostname.toLowerCase();
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

export async function provisionAdminDatabaseAccess(
  arguments_: string[],
): Promise<void> {
  const provisioning = parseAdminProvisioningArguments(arguments_);
  const config = await loadAdminEnvironmentConfig(provisioning.configPath);
  validateProvisioningConfig(provisioning, config);
  validateAdminCredentialEnvironment(provisioning.environment, process.env);

  const connectionString = process.env[ADMIN_PROVISIONING_DATABASE_URL_ENV];
  if (!connectionString) {
    throw new AdminFoundationError("ADMIN_INVALID_CONFIGURATION");
  }
  validateProvisioningConnectionUrl(config, connectionString);

  const pool = new Pool({
    connectionString,
    max: 1,
    ssl: usesLocalPostgres(connectionString)
      ? undefined
      : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 5_000,
    allowExitOnIdle: true,
  });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");

    const context = await client.query<DatabaseContextRow>(`
      SELECT current_database() AS "databaseName", current_user AS "roleName"
    `);
    if (context.rows[0]?.databaseName !== config.database.name) {
      throw new AdminFoundationError("ADMIN_DATABASE_NAME_MISMATCH");
    }
    if (
      context.rows[0]?.roleName === config.database.readerRole ||
      context.rows[0]?.roleName === config.database.operatorRole
    ) {
      throw new AdminFoundationError("ADMIN_DATABASE_ROLE_MISMATCH");
    }

    const migrations = await client.query<MigrationRow>(
      `
        SELECT name
        FROM migrations
        WHERE name = ANY($1::text[])
      `,
      [[ADMIN_JIT_PREDECESSOR_MIGRATION, ADMIN_FOUNDATION_MIGRATION]],
    );
    const appliedMigrations = new Set(migrations.rows.map((row) => row.name));
    if (
      !appliedMigrations.has(ADMIN_JIT_PREDECESSOR_MIGRATION) ||
      !appliedMigrations.has(ADMIN_FOUNDATION_MIGRATION)
    ) {
      throw new AdminFoundationError("ADMIN_INVALID_CONFIGURATION");
    }

    const markerResult = await client.query<MarkerRow>(
      "SELECT environment FROM admin_environment_marker",
    );
    if (markerResult.rows.length === 0) {
      await client.query(
        `
          INSERT INTO admin_environment_marker (environment, configured_by)
          VALUES ($1, current_user)
        `,
        [config.environment],
      );
    } else if (
      markerResult.rows.length !== 1 ||
      markerResult.rows[0].environment !== config.environment
    ) {
      throw new AdminFoundationError("ADMIN_ENVIRONMENT_MISMATCH");
    }

    const roles = await client.query<AdminProvisioningRole>(
      `
        SELECT
          rolname,
          rolcanlogin,
          rolsuper,
          rolcreatedb,
          rolcreaterole,
          rolbypassrls,
          rolreplication,
          EXISTS (
            SELECT 1 FROM pg_class WHERE relowner = candidate_role.oid
            UNION ALL
            SELECT 1 FROM pg_namespace WHERE nspowner = candidate_role.oid
            UNION ALL
            SELECT 1 FROM pg_proc WHERE proowner = candidate_role.oid
            UNION ALL
            SELECT 1 FROM pg_database WHERE datdba = candidate_role.oid
          ) AS "ownsObjects"
        FROM pg_roles AS candidate_role
        WHERE rolname = ANY($1::text[])
      `,
      [[config.database.readerRole, config.database.operatorRole]],
    );
    validateProvisioningRoles(config, roles.rows);

    for (const statement of buildAdminGrantStatements(config)) {
      await client.query(statement);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  console.log(
    `Provisioned ${config.environment} admin table grants for ${config.database.name}; no roles or credentials were created.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  provisionAdminDatabaseAccess(process.argv.slice(2)).catch((error) => {
    const code =
      error instanceof AdminFoundationError
        ? error.code
        : "ADMIN_INTERNAL_ERROR";
    console.error(`Admin access provisioning stopped safely (${code}).`);
    process.exitCode = 1;
  });
}
