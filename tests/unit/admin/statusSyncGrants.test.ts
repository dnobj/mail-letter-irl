import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ADMIN_OPERATOR_WRITE_GRANTS } from "../../../src/admin/provisioning.js";

/**
 * The admin panel's "Provider status sync" runs the sync as the operator
 * database role (full mode, which production uses), whose letters UPDATE grant
 * is a column list. A column the sync starts to set that the list lacks fails
 * with "permission denied" there and nowhere else: not in the maintenance
 * cron, which connects as the schema owner, and not in the integration suites
 * (#625 review: carrier_tracking_number). This reads the sync's own UPDATE
 * statements and holds the grant list to them.
 */

const SYNC = fileURLToPath(new URL("../../../src/services/statusSyncService.ts", import.meta.url));

/** The columns each `UPDATE letters SET ... WHERE` in the sync assigns. */
function assignedColumns(): string[][] {
  const source = readFileSync(SYNC, "utf8");
  return [...source.matchAll(/UPDATE\s+letters\s+SET\s+([\s\S]*?)\s+WHERE/gi)].map(match =>
    [...match[1].matchAll(/(?:^|,)\s*([a-z_]+)\s*=/gi)].map(assignment => assignment[1]),
  );
}

describe("the operator role may write what the status sync writes", () => {
  const granted = ADMIN_OPERATOR_WRITE_GRANTS.letters.update;

  it("finds the statements it guards", () => {
    const statements = assignedColumns();
    // The status update and the carrier number's (#625).
    expect(statements.length).toBeGreaterThanOrEqual(2);
    expect(statements.flat()).toContain("status");
    expect(statements.flat()).toContain("carrier_tracking_number");
  });

  it("has every column of every UPDATE letters in its grant list", () => {
    expect(Array.isArray(granted)).toBe(true);
    for (const columns of assignedColumns()) {
      for (const column of columns) {
        expect(granted, `the status sync sets letters.${column}, which the operator role cannot update`).toContain(column);
      }
    }
  });

  it("still keeps content, recipient and the service out of the operator's writes", () => {
    for (const column of ["content", "recipient", "preview_html", "redacted_at", "mail_service", "mail_type", "funding_type"]) {
      expect(granted).not.toContain(column);
    }
  });
});
