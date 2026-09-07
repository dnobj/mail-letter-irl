import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseAdminEnvironmentConfig } from "../../../src/admin/config.js";
import {
  ADMIN_LATEST_REQUIRED_MIGRATION,
  ADMIN_OPERATOR_WRITE_GRANTS,
  ADMIN_READER_COLUMN_GRANTS,
  ADMIN_READER_TABLES,
  buildAdminGrantStatements,
} from "../../../src/admin/provisioning.js";
import { validDevelopmentAdminConfig } from "../../fixtures/admin.js";

const config = parseAdminEnvironmentConfig(validDevelopmentAdminConfig);

/**
 * The reader role is what the read-only panel connects as, in production
 * first. These pin the columns it can never select, because the page that
 * runs as it is privileged and must not be able to render content or
 * addresses even by mistake.
 */
describe("admin grant statements", () => {
  const statements = buildAdminGrantStatements(config);
  const sql = statements.join("\n");

  it("never grants the reader whole-row access to a table with content or addresses", () => {
    for (const restricted of [
      "users",
      "letters",
      "letter_drafts",
      "personal_access_tokens",
      "feature_requests",
      "redacted_content_quarantine",
      "credit_transactions",
      "credit_ledger",
    ]) {
      expect(ADMIN_READER_TABLES).not.toContain(restricted);
      expect(ADMIN_READER_COLUMN_GRANTS).toHaveProperty(restricted);
      expect(sql).not.toMatch(
        new RegExp(
          `GRANT SELECT ON TABLE "public"\\.${restricted} TO "letter_irl_admin_reader_development"`,
        ),
      );
    }
  });

  it("omits content, recipients, return addresses, token hashes and quarantined content", () => {
    expect(ADMIN_READER_COLUMN_GRANTS.letters).not.toContain("content");
    expect(ADMIN_READER_COLUMN_GRANTS.letters).not.toContain("recipient");
    expect(ADMIN_READER_COLUMN_GRANTS.letters).not.toContain("preview_html");
    expect(ADMIN_READER_COLUMN_GRANTS.users).not.toContain("return_address");
    expect(ADMIN_READER_COLUMN_GRANTS.letter_drafts).not.toContain(
      "body_text",
    );
    expect(ADMIN_READER_COLUMN_GRANTS.letter_drafts).not.toContain("sender");
    expect(ADMIN_READER_COLUMN_GRANTS.letter_drafts).not.toContain(
      "recipient",
    );
    expect(ADMIN_READER_COLUMN_GRANTS.personal_access_tokens).not.toContain(
      "token_hash",
    );
    expect(ADMIN_READER_COLUMN_GRANTS.feature_requests).not.toContain(
      "contact_email",
    );
    expect(
      ADMIN_READER_COLUMN_GRANTS.redacted_content_quarantine,
    ).not.toContain("content");
    expect(sql).toContain("GRANT SELECT (letter_id, user_id, credits_cost");
  });

  it("omits the free-text ledger descriptions, which carried recipient names and operator reasons", () => {
    expect(ADMIN_READER_COLUMN_GRANTS.credit_transactions).not.toContain(
      "description",
    );
    expect(ADMIN_READER_COLUMN_GRANTS.credit_ledger).not.toContain(
      "description",
    );
    // The columns the panel does read are still granted, so this is a narrow
    // grant rather than a table the reader lost entirely.
    expect(ADMIN_READER_COLUMN_GRANTS.credit_transactions).toContain("amount");
    expect(ADMIN_READER_COLUMN_GRANTS.credit_ledger).toContain(
      "remaining_amount",
    );
    // Both roles share the grant statement, so the operator loses the column
    // too; the credit paths it reaches name their RETURNING columns for that
    // reason.
    expect(sql).not.toMatch(/GRANT SELECT \([^)]*description[^)]*\) ON TABLE "public"\.credit_/);
  });

  it("gives the operator whole rows only where domain services select them, plus explicit writes", () => {
    expect(sql).toContain(
      'GRANT SELECT ON TABLE "public".users TO "letter_irl_admin_operator_development"',
    );
    expect(sql).not.toContain(
      'GRANT SELECT ON TABLE "public".personal_access_tokens TO "letter_irl_admin_operator_development"',
    );
    expect(sql).toContain(
      'GRANT UPDATE ON TABLE "public".commerce_operational_alerts TO "letter_irl_admin_operator_development"',
    );
    expect(sql).toContain(
      'GRANT INSERT ON TABLE "public".commerce_operator_audit_events TO "letter_irl_admin_operator_development"',
    );
    // The reader writes nothing but its own audit rows.
    for (const line of statements) {
      if (
        /^GRANT (INSERT|UPDATE|DELETE)/.test(line) &&
        line.includes("reader")
      ) {
        expect(line).toContain("admin_audit_events");
      }
    }
    // No table gets DELETE except promo campaigns (refused with redemptions
    // by the service), and the audit table is never mutable.
    for (const [name, privileges] of Object.entries(
      ADMIN_OPERATOR_WRITE_GRANTS,
    )) {
      if (privileges.includes("DELETE")) expect(name).toBe("promo_campaigns");
    }
    expect(ADMIN_OPERATOR_WRITE_GRANTS).not.toHaveProperty(
      "admin_audit_events",
    );
    expect(sql).toContain("REVOKE UPDATE, DELETE, TRUNCATE");
  });

  it("names a latest required migration that exists on disk", async () => {
    const files = await readdir(join(process.cwd(), "db", "migrations"));
    expect(files).toContain(ADMIN_LATEST_REQUIRED_MIGRATION);
    // The newest migration must be the one named here, so a new migration
    // that adds a table the grants need cannot be forgotten silently.
    const newest = files
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .at(-1);
    expect(newest).toBe(ADMIN_LATEST_REQUIRED_MIGRATION);
  });
});
