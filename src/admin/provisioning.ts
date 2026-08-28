import { z } from "zod";

import type { AdminEnvironmentConfig } from "./config.js";
import { AdminEnvironmentSchema } from "./contracts.js";
import { AdminFoundationError } from "./errors.js";

export const ADMIN_PROVISIONING_DATABASE_URL_ENV =
  "LETTER_IRL_ADMIN_PROVISIONING_DATABASE_URL";
export const ADMIN_JIT_PREDECESSOR_MIGRATION =
  "021_jit_commerce_foundation.sql";
export const ADMIN_FOUNDATION_MIGRATION = "022_admin_audit.sql";

export interface AdminProvisioningArguments {
  environment: "development" | "production";
  configPath: string;
  apply: boolean;
  confirmProductionAccess: boolean;
}

export interface AdminProvisioningRole {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolbypassrls: boolean;
  rolreplication: boolean;
  ownsObjects: boolean;
}

const ADMIN_READER_TABLES = [
  "users",
  "credit_transactions",
  "credit_ledger",
  "credit_consumption",
  "promo_campaigns",
  "promo_redemptions",
  "letters",
  "letter_jobs",
  "letter_status_history",
  "provider_routing",
  "maintenance_tasks",
  "admin_environment_marker",
  "admin_audit_events",
  "admin_command_runs",
  "admin_operations",
] as const;

function invalidProvisioningConfiguration(
  cause?: unknown,
): AdminFoundationError {
  void cause;
  return new AdminFoundationError("ADMIN_INVALID_CONFIGURATION");
}

function readArgumentValue(arguments_: string[], index: number): string {
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw invalidProvisioningConfiguration();
  }
  return value;
}

export function parseAdminProvisioningArguments(
  arguments_: string[],
): AdminProvisioningArguments {
  let environment: AdminProvisioningArguments["environment"] | undefined;
  let configPath: string | undefined;
  let apply = false;
  let confirmProductionAccess = false;

  try {
    for (let index = 0; index < arguments_.length; index += 1) {
      const argument = arguments_[index];
      if (argument === "--environment") {
        environment = AdminEnvironmentSchema.parse(
          readArgumentValue(arguments_, index),
        );
        index += 1;
        continue;
      }
      if (argument === "--config") {
        configPath = readArgumentValue(arguments_, index);
        index += 1;
        continue;
      }
      if (argument === "--apply") {
        apply = true;
        continue;
      }
      if (argument === "--confirm-production-access") {
        confirmProductionAccess = true;
        continue;
      }
      if (
        argument === "--database-url" ||
        argument.startsWith("--database-url=")
      ) {
        throw invalidProvisioningConfiguration();
      }
      throw invalidProvisioningConfiguration();
    }
  } catch (error) {
    if (error instanceof AdminFoundationError) {
      throw error;
    }
    throw invalidProvisioningConfiguration(error);
  }

  if (!environment || !configPath || !apply) {
    throw invalidProvisioningConfiguration();
  }
  if (environment === "production" && !confirmProductionAccess) {
    throw new AdminFoundationError("ADMIN_PRODUCTION_CONFIRMATION_REQUIRED");
  }

  return { environment, configPath, apply, confirmProductionAccess };
}

export function validateProvisioningConfig(
  arguments_: AdminProvisioningArguments,
  config: AdminEnvironmentConfig,
): void {
  if (arguments_.environment !== config.environment) {
    throw new AdminFoundationError("ADMIN_ENVIRONMENT_MISMATCH");
  }
}

export function validateProvisioningConnectionUrl(
  config: AdminEnvironmentConfig,
  connectionString: string,
): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw invalidProvisioningConfiguration();
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw invalidProvisioningConfiguration();
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (url.hostname.toLowerCase() !== config.database.hostname) {
    throw new AdminFoundationError("ADMIN_DATABASE_HOST_MISMATCH");
  }
  if (databaseName !== config.database.name) {
    throw new AdminFoundationError("ADMIN_DATABASE_NAME_MISMATCH");
  }
}

function quoteRole(role: string): string {
  const parsed = z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,62}$/)
    .parse(role);
  return `"${parsed}"`;
}

function quoteSchema(schema: string): string {
  const parsed = z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,62}$/)
    .parse(schema);
  return `"${parsed}"`;
}

export function buildAdminGrantStatements(
  config: AdminEnvironmentConfig,
  schema = "public",
): string[] {
  const readerRole = quoteRole(config.database.readerRole);
  const operatorRole = quoteRole(config.database.operatorRole);
  const schemaIdentifier = quoteSchema(schema);
  const roles = `${readerRole}, ${operatorRole}`;
  const readerTables = ADMIN_READER_TABLES.map(
    (table) => `${schemaIdentifier}.${table}`,
  ).join(", ");

  return [
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schemaIdentifier} FROM ${roles}`,
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schemaIdentifier} FROM ${roles}`,
    `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA ${schemaIdentifier} FROM ${roles}`,
    `REVOKE ALL PRIVILEGES ON SCHEMA ${schemaIdentifier} FROM ${roles}`,
    `GRANT USAGE ON SCHEMA ${schemaIdentifier} TO ${roles}`,
    `GRANT SELECT ON TABLE ${readerTables} TO ${roles}`,
    `GRANT INSERT ON TABLE ${schemaIdentifier}.admin_audit_events TO ${roles}`,
    `GRANT INSERT ON TABLE ${schemaIdentifier}.admin_command_runs TO ${operatorRole}`,
    `GRANT UPDATE (status, started_at, completed_at, sanitized_result_json, error_code) ON TABLE ${schemaIdentifier}.admin_command_runs TO ${operatorRole}`,
    `GRANT INSERT ON TABLE ${schemaIdentifier}.admin_operations TO ${operatorRole}`,
    `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE ${schemaIdentifier}.admin_audit_events FROM ${roles}`,
  ];
}

export function validateProvisioningRoles(
  config: AdminEnvironmentConfig,
  roles: AdminProvisioningRole[],
): void {
  const expectedRoles = new Set([
    config.database.readerRole,
    config.database.operatorRole,
  ]);
  if (roles.length !== expectedRoles.size) {
    throw invalidProvisioningConfiguration();
  }
  for (const role of roles) {
    if (
      !expectedRoles.has(role.rolname) ||
      !role.rolcanlogin ||
      role.rolsuper ||
      role.rolcreatedb ||
      role.rolcreaterole ||
      role.rolbypassrls ||
      role.rolreplication ||
      role.ownsObjects
    ) {
      throw invalidProvisioningConfiguration();
    }
  }
}
