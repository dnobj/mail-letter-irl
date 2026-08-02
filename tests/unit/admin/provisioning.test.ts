import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseAdminEnvironmentConfig } from "../../../src/admin/config.js";
import { AdminFoundationError } from "../../../src/admin/errors.js";
import {
  ADMIN_FOUNDATION_MIGRATION,
  ADMIN_JIT_PREDECESSOR_MIGRATION,
  buildAdminGrantStatements,
  parseAdminProvisioningArguments,
  validateProvisioningRoles,
} from "../../../src/admin/provisioning.js";
import {
  ADMIN_MIGRATION_SEQUENCE,
  validDevelopmentAdminConfig,
} from "../../fixtures/admin.js";

const config = parseAdminEnvironmentConfig(validDevelopmentAdminConfig);

describe("admin database access provisioning", () => {
  it("explicitly sequences JIT migration 021 before admin migration 022", async () => {
    expect([
      ADMIN_JIT_PREDECESSOR_MIGRATION,
      ADMIN_FOUNDATION_MIGRATION,
    ]).toEqual(ADMIN_MIGRATION_SEQUENCE);

    // Comparing the two source constants against a fixture that hard-codes the
    // same strings cannot notice a renamed migration file. Anchor both names to
    // what is actually on disk.
    const migrationFiles = await readdir(join(process.cwd(), "db", "migrations"));
    expect(migrationFiles).toContain(ADMIN_JIT_PREDECESSOR_MIGRATION);
    expect(migrationFiles).toContain(ADMIN_FOUNDATION_MIGRATION);

    // Exactly one 021 and one 022 must exist, so neither constant can drift
    // onto a stale duplicate left beside a renamed file.
    expect(migrationFiles.filter((file) => file.startsWith("021_"))).toEqual([
      ADMIN_JIT_PREDECESSOR_MIGRATION,
    ]);
    expect(migrationFiles.filter((file) => file.startsWith("022_"))).toEqual([
      ADMIN_FOUNDATION_MIGRATION,
    ]);
  });

  it("requires apply and a separate production confirmation flag", () => {
    expect(() =>
      parseAdminProvisioningArguments([
        "--environment",
        "production",
        "--config",
        "production.json",
        "--apply",
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<AdminFoundationError>>({
        code: "ADMIN_PRODUCTION_CONFIRMATION_REQUIRED",
      }),
    );

    expect(
      parseAdminProvisioningArguments([
        "--environment",
        "production",
        "--config",
        "production.json",
        "--apply",
        "--confirm-production-access",
      ]),
    ).toMatchObject({
      environment: "production",
      confirmProductionAccess: true,
    });
  });

  it("refuses credentials in command arguments", () => {
    expect(() =>
      parseAdminProvisioningArguments([
        "--environment",
        "development",
        "--config",
        "development.json",
        "--apply",
        "--database-url=postgresql://secret.invalid/database",
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<AdminFoundationError>>({
        code: "ADMIN_INVALID_CONFIGURATION",
      }),
    );
  });

  it("builds least-privilege grants without creating roles or credentials", () => {
    const sql = buildAdminGrantStatements(config).join("\n");

    expect(sql).toContain("GRANT SELECT ON TABLE");
    expect(sql).toContain('GRANT INSERT ON TABLE "public".admin_audit_events');
    expect(sql).toContain("REVOKE UPDATE, DELETE, TRUNCATE");
    expect(sql).toContain(
      "GRANT UPDATE (status, started_at, completed_at, sanitized_result_json, error_code)",
    );
    expect(sql).not.toContain("GRANT INSERT, UPDATE");
    expect(sql).not.toMatch(/CREATE\s+ROLE/i);
    expect(sql).not.toMatch(/PASSWORD/i);
    expect(sql).not.toContain("DATABASE_URL");
  });

  it("rejects missing, privileged, or non-login target roles", () => {
    expect(() =>
      validateProvisioningRoles(config, [
        {
          rolname: config.database.readerRole,
          rolcanlogin: true,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolbypassrls: false,
          rolreplication: false,
          ownsObjects: false,
        },
      ]),
    ).toThrow();

    expect(() =>
      validateProvisioningRoles(config, [
        {
          rolname: config.database.readerRole,
          rolcanlogin: true,
          rolsuper: true,
          rolcreatedb: false,
          rolcreaterole: false,
          rolbypassrls: false,
          rolreplication: false,
          ownsObjects: false,
        },
        {
          rolname: config.database.operatorRole,
          rolcanlogin: true,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolbypassrls: false,
          rolreplication: false,
          ownsObjects: false,
        },
      ]),
    ).toThrow();
  });
});
