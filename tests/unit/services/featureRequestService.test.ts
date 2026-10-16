import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #393: a feature request is kept for the published period and then
 * deleted, contact email and all.
 *
 * The SQL assertion pins the WHOLE statement after normalising whitespace, as
 * the #282 store test does: a fragment such as "created_at" survives a flipped
 * comparison, a dropped cast or a widened window. What this cannot prove is
 * that PostgreSQL agrees with the predicate at the boundary;
 * tests/integration/featureRequestsSweep.postgres.test.ts does.
 */

const db = vi.hoisted(() => ({
  query: vi.fn()
}));

vi.mock("../../../src/db/index.js", () => ({
  query: db.query
}));

import {
  FEATURE_REQUEST_RETENTION_MONTHS,
  purgeExpiredFeatureRequests
} from "../../../src/services/featureRequestService.js";

const normalise = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("featureRequestService retention (#393)", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("publishes the 12-month period docs/privacy-policy.md states", () => {
    expect(FEATURE_REQUEST_RETENTION_MONTHS).toBe(12);
  });

  describe("purgeExpiredFeatureRequests", () => {
    it("deletes rows 12 months after submission, in one whole statement keyed on created_at", async () => {
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 3 });

      await expect(purgeExpiredFeatureRequests()).resolves.toBe(3);

      expect(db.query).toHaveBeenCalledTimes(1);
      const [sql, params] = db.query.mock.calls[0];
      expect(normalise(sql)).toBe(
        "DELETE FROM feature_requests WHERE created_at < NOW() - make_interval(months => $1::int)"
      );
      expect(params).toEqual([12]);
      // Nothing updates a row after submission, so any other clock would never
      // fire; and no column value may come back to the caller.
      expect(sql).not.toMatch(/updated_at|reviewed_at|resolved_at/);
      expect(sql).not.toMatch(/RETURNING/i);
      expect(sql).not.toMatch(/title|description|contact_email/);
    });

    it("reports zero when the driver gives no row count", async () => {
      db.query.mockResolvedValueOnce({ rows: [], rowCount: null });

      await expect(purgeExpiredFeatureRequests()).resolves.toBe(0);
    });

    it("lets a driver failure through unchanged for the runner to classify", async () => {
      const failure = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      db.query.mockRejectedValueOnce(failure);

      await expect(purgeExpiredFeatureRequests()).rejects.toBe(failure);
    });
  });
});
