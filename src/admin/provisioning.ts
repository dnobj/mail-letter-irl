import { z } from "zod";

import type { AdminEnvironmentConfig } from "./config.js";
import { AdminEnvironmentSchema } from "./contracts.js";
import { AdminFoundationError } from "./errors.js";

export const ADMIN_PROVISIONING_DATABASE_URL_ENV =
  "LETTER_IRL_ADMIN_PROVISIONING_DATABASE_URL";
export const ADMIN_JIT_PREDECESSOR_MIGRATION =
  "021_jit_commerce_foundation.sql";
export const ADMIN_FOUNDATION_MIGRATION = "022_admin_audit.sql";
/**
 * The newest migration the grant statements depend on. Provisioning refuses a
 * database that has not reached it, because a GRANT on a table that does not
 * exist yet fails the whole transaction.
 */
export const ADMIN_LATEST_REQUIRED_MIGRATION =
  "029_proportional_pack_refunds.sql";

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

/**
 * Tables both admin roles may read in full. Nothing here carries letter
 * content, a postal address, or a credential.
 */
export const ADMIN_READER_TABLES = [
  "credit_transactions",
  "credit_ledger",
  "credit_consumption",
  "promo_campaigns",
  "promo_redemptions",
  "letter_jobs",
  "letter_status_history",
  "provider_routing",
  "maintenance_tasks",
  "migrations",
  "orders",
  "commerce_order_events",
  "commerce_pack_refunds",
  "commerce_operational_alerts",
  "commerce_operator_audit_events",
  "stripe_webhook_events",
  "stripe_disputes",
  "image_entitlements",
  "image_generation_reservations",
  "admin_environment_marker",
  "admin_audit_events",
  "admin_command_runs",
  "admin_operations",
] as const;

/**
 * Tables the reader may read only column by column. The omitted columns are
 * the ones a privileged page must never be able to select: letter content and
 * recipients, draft bodies and images, return addresses, token hashes, the
 * quarantined content itself, and a customer's contact email on a feature
 * request.
 */
export const ADMIN_READER_COLUMN_GRANTS: Readonly<
  Record<string, readonly string[]>
> = {
  users: [
    "user_id",
    "email",
    "credits",
    "credits_purchased",
    "credits_used",
    "created_at",
    "updated_at",
    "tier",
    "tier_override",
    "tier_calculated_at",
    "return_address_validated_at",
    "image_generations_used",
    "sends_blocked_at",
    "sends_blocked_reason",
  ],
  letters: [
    "letter_id",
    "user_id",
    "credits_cost",
    "status",
    "tracking_id",
    "created_at",
    "sent_at",
    "provider",
    "cost_cents",
    "expected_delivery",
    "updated_at",
    "status_updated_at",
    "provider_raw_status",
    "mail_type",
    "funding_type",
    "funding_order_id",
    "redacted_at",
  ],
  letter_drafts: [
    "draft_id",
    "user_id",
    "required_credits",
    "status",
    "expires_at",
    "consumed_at",
    "consumed_letter_id",
    "created_at",
    "updated_at",
    "mail_type",
    "postcard_size",
    "layout_type",
    "redacted_at",
  ],
  personal_access_tokens: [
    "token_id",
    "user_id",
    "name",
    "token_prefix",
    "status",
    "expires_at",
    "last_used_at",
    "created_at",
    "revoked_at",
  ],
  feature_requests: [
    "request_id",
    "user_id",
    "title",
    "description",
    "category",
    "attempted_action",
    "status",
    "admin_notes",
    "created_at",
    "updated_at",
    "reviewed_at",
    "resolved_at",
    "contact_consent",
  ],
  redacted_content_quarantine: [
    "quarantine_id",
    "source_table",
    "source_id",
    "quarantined_at",
    "purge_after",
  ],
};

/**
 * The operator role is what the domain services run as in full mode, and
 * they select whole rows (`SELECT *`, `RETURNING *`) from these three tables.
 * The panel's own read models still go through the reader role, so the page
 * never sees what the process can.
 */
export const ADMIN_OPERATOR_FULL_SELECT_TABLES = [
  "users",
  "letters",
  "letter_drafts",
] as const;

/**
 * Exactly the writes the enabled commands perform, per table and, where the
 * statements are known, per column. Anything not listed fails at PostgreSQL
 * with `permission denied`, which is the last line of defence behind the
 * route-level mode gate.
 *
 * The column lists were derived by following every command's `execute` into
 * the domain service it calls and collecting the SET and INSERT lists it
 * reaches. `tests/integration/adminCommands.postgres.test.ts` runs the real
 * commands against these grants, so a missing column fails there rather than
 * in production. A table-level entry means the statement shape needs it: the
 * admin queues, the ledger inserts and the audit tables are written whole.
 *
 * PostgreSQL has no column form of DELETE, so `delete` stays a table grant.
 */
export interface AdminOperatorTableWrites {
  insert?: readonly string[] | "table";
  update?: readonly string[] | "table";
  delete?: true;
}

export const ADMIN_OPERATOR_WRITE_GRANTS: Readonly<
  Record<string, AdminOperatorTableWrites>
> = {
  users: {
    // INSERT because the ledger grant upserts the account row, and PostgreSQL
    // needs INSERT for ON CONFLICT DO UPDATE even when the row exists. `email`
    // and `credits_used` appear only in that INSERT list and never in a SET
    // list, so the operator cannot rewrite either on an account that exists.
    insert: ["user_id", "email", "credits", "credits_purchased", "credits_used"],
    update: [
      "credits",
      "credits_purchased",
      "image_generations_used",
      "sends_blocked_at",
      "sends_blocked_reason",
      "tier_override",
      "updated_at",
    ],
  },
  orders: {
    update: [
      "amount_refunded_cents",
      "completed_at",
      "credits_refunded",
      "fulfilled_at",
      "held_at",
      "hold_previous_status",
      "hold_reason",
      "last_error",
      "last_error_code",
      "refund_pending_at",
      "status",
      "updated_at",
    ],
  },
  letters: {
    // Never content, recipient, preview_html or redacted_at: the retention
    // sweep owns those and no command touches them.
    update: [
      "provider",
      "provider_raw_status",
      "sent_at",
      "status",
      "status_updated_at",
      "tracking_id",
      "updated_at",
    ],
  },
  letter_jobs: {
    update: [
      "attempts",
      "completed_at",
      "error_message",
      "held_at",
      "hold_reason",
      "last_error",
      "locked_at",
      "max_attempts",
      "next_attempt_at",
      "operator_resolution",
      "provider_order_id",
      "provider_outcome",
      "resolved_at",
      "scheduled_at",
      "status",
      "updated_at",
    ],
  },
  credit_ledger: { insert: "table", update: "table" },
  credit_transactions: { insert: "table" },
  credit_consumption: { insert: "table" },
  letter_status_history: { insert: "table" },
  commerce_operational_alerts: { insert: "table", update: "table" },
  commerce_operator_audit_events: { insert: "table" },
  commerce_order_events: { insert: "table" },
  commerce_pack_refunds: { insert: "table", update: "table" },
  image_entitlements: { insert: "table", update: "table" },
  image_generation_reservations: { update: "table" },
  promo_campaigns: { insert: "table", update: "table", delete: true },
  provider_routing: { update: "table" },
  admin_operations: { insert: "table" },
  // stripe_webhook_events held a table-level UPDATE until the security review.
  // Every write to it happens inside Stripe webhook processing, which the
  // panel never enters; the panel only reads it, through the reader role. Dead
  // grant surface, so it is gone rather than narrowed.
};

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

const IdentifierPattern = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

function quoteRole(role: string): string {
  return `"${IdentifierPattern.parse(role)}"`;
}

function quoteSchema(schema: string): string {
  return `"${IdentifierPattern.parse(schema)}"`;
}

function quoteColumns(columns: readonly string[]): string {
  return columns.map((column) => IdentifierPattern.parse(column)).join(", ");
}

export function buildAdminGrantStatements(
  config: AdminEnvironmentConfig,
  schema = "public",
): string[] {
  const readerRole = quoteRole(config.database.readerRole);
  const operatorRole = quoteRole(config.database.operatorRole);
  const schemaIdentifier = quoteSchema(schema);
  const roles = `${readerRole}, ${operatorRole}`;
  const table = (name: string) =>
    `${schemaIdentifier}.${IdentifierPattern.parse(name)}`;
  const readerTables = ADMIN_READER_TABLES.map(table).join(", ");

  const statements = [
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schemaIdentifier} FROM ${roles}`,
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schemaIdentifier} FROM ${roles}`,
    `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA ${schemaIdentifier} FROM ${roles}`,
    `REVOKE ALL PRIVILEGES ON SCHEMA ${schemaIdentifier} FROM ${roles}`,
    `GRANT USAGE ON SCHEMA ${schemaIdentifier} TO ${roles}`,
    `GRANT SELECT ON TABLE ${readerTables} TO ${roles}`,
  ];

  // Column-level reads for the tables that also hold content, addresses, or
  // credentials. Both roles get the columns; the operator additionally gets
  // the whole row on the three tables the domain services read in full.
  for (const [name, columns] of Object.entries(ADMIN_READER_COLUMN_GRANTS)) {
    statements.push(
      `GRANT SELECT (${quoteColumns(columns)}) ON TABLE ${table(name)} TO ${roles}`,
    );
  }
  for (const name of ADMIN_OPERATOR_FULL_SELECT_TABLES) {
    statements.push(`GRANT SELECT ON TABLE ${table(name)} TO ${operatorRole}`);
  }

  // Both roles record what they did; only the operator commands and queues.
  statements.push(
    `GRANT INSERT ON TABLE ${table("admin_audit_events")} TO ${roles}`,
    `GRANT INSERT ON TABLE ${table("admin_command_runs")} TO ${operatorRole}`,
    `GRANT UPDATE (status, started_at, completed_at, sanitized_result_json, error_code) ON TABLE ${table("admin_command_runs")} TO ${operatorRole}`,
    `GRANT UPDATE (status, attempts, locked_at, locked_by, completed_at, sanitized_result_json, error_code) ON TABLE ${table("admin_operations")} TO ${operatorRole}`,
  );

  // One statement per privilege so each grant is reviewable on its own line.
  for (const [name, writes] of Object.entries(ADMIN_OPERATOR_WRITE_GRANTS)) {
    for (const privilege of ["INSERT", "UPDATE"] as const) {
      const columns = privilege === "INSERT" ? writes.insert : writes.update;
      if (!columns) continue;
      const scope = columns === "table" ? "" : ` (${quoteColumns(columns)})`;
      statements.push(
        `GRANT ${privilege}${scope} ON TABLE ${table(name)} TO ${operatorRole}`,
      );
    }
    if (writes.delete) {
      // PostgreSQL has no column form of DELETE.
      statements.push(`GRANT DELETE ON TABLE ${table(name)} TO ${operatorRole}`);
    }
  }
  // SERIAL columns (credit_transactions, letter_status_history) need the
  // sequence; sequences hold no data.
  statements.push(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schemaIdentifier} TO ${operatorRole}`,
    `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE ${table("admin_audit_events")} FROM ${roles}`,
    // The revoke above takes EXECUTE from the two roles, but PostgreSQL grants
    // it to PUBLIC by default and both roles inherit that. No SECURITY DEFINER
    // function exists today, so nothing is reachable; this is here so the first
    // one added later is not silently callable by the reader (A-24).
    `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schemaIdentifier} FROM PUBLIC`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schemaIdentifier} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
  );
  return statements;
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
