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
    for (const [name, writes] of Object.entries(ADMIN_OPERATOR_WRITE_GRANTS)) {
      if (writes.delete) expect(name).toBe("promo_campaigns");
    }
    expect(ADMIN_OPERATOR_WRITE_GRANTS).not.toHaveProperty(
      "admin_audit_events",
    );
    expect(sql).toContain("REVOKE UPDATE, DELETE, TRUNCATE");
  });

  it("scopes the operator's writes to columns on the four tables holding customer data", () => {
    // The design promised "exactly the writes the enabled commands perform".
    // That held per table, not per column, so the role could rewrite an email,
    // a return address or a letter's content although no command does.
    const updateGrantFor = (table: string) =>
      statements.find(
        (line) =>
          line.startsWith("GRANT UPDATE (") &&
          line.includes(`ON TABLE "public".${table} `),
      );
    for (const table of ["users", "orders", "letters", "letter_jobs"]) {
      expect(updateGrantFor(table), `${table} column grant`).toBeDefined();
      expect(sql).not.toContain(
        `GRANT UPDATE ON TABLE "public".${table} TO "letter_irl_admin_operator_development"`,
      );
    }
    const forbidden: Array<[string, string]> = [
      ["users", "email"],
      ["users", "return_address"],
      ["users", "credits_used"],
      ["users", "tier"],
      ["letters", "content"],
      ["letters", "recipient"],
      ["letters", "preview_html"],
      ["letters", "redacted_at"],
      ["orders", "stripe_refund_id"],
      ["orders", "amount_cents"],
      ["letter_jobs", "idempotency_key"],
    ];
    for (const [table, column] of forbidden) {
      const grant = updateGrantFor(table)!;
      const columnList = grant.slice(grant.indexOf("(") + 1, grant.indexOf(") ON TABLE"));
      expect(columnList.split(", "), `${table}.${column}`).not.toContain(column);
    }
    // users keeps an INSERT for the ledger upsert, and email is in that list
    // because an upsert needs INSERT on every column it names. It is absent
    // from the UPDATE list, so an existing account's email cannot be rewritten.
    expect(sql).toContain(
      'GRANT INSERT (user_id, email, credits, credits_purchased, credits_used) ON TABLE "public".users',
    );
  });

  it("holds no write grant on stripe_webhook_events, which no command touches", () => {
    // Every write to that table happens inside Stripe webhook processing,
    // which the panel never enters; the panel only reads it.
    expect(ADMIN_OPERATOR_WRITE_GRANTS).not.toHaveProperty("stripe_webhook_events");
    for (const line of statements) {
      if (/^GRANT (INSERT|UPDATE|DELETE)/.test(line)) {
        expect(line).not.toContain("stripe_webhook_events");
      }
    }
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
