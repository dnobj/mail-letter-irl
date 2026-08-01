import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db/index.js", () => ({ query: vi.fn() }));

import { query } from "../../../src/db/index.js";
import { submitFeatureRequestTool } from "../../../src/tools/submitFeatureRequest.js";
import { submitFeatureRequestInputZ } from "../../../src/zodSchemas.js";

function context() {
  return {
    user: { userId: "auth0|private", orders: [] },
    correlationId: "correlation",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
    now: () => new Date(),
    persist: vi.fn()
  } as never;
}

describe("feature request safe failures", () => {
  beforeEach(() => vi.clearAllMocks());

  it("aligns zod validation with service length and nonempty limits", () => {
    expect(() => submitFeatureRequestInputZ.parse({ title: " ", description: "valid" })).toThrow();
    expect(() => submitFeatureRequestInputZ.parse({ title: "x".repeat(201), description: "valid" })).toThrow();
    expect(() => submitFeatureRequestInputZ.parse({ title: "valid", description: "x".repeat(2001) })).toThrow();
    expect(() => submitFeatureRequestInputZ.parse({ title: "valid", description: "valid", attemptedAction: "x".repeat(256) })).toThrow();
  });

  it("returns bounded typed validation feedback", async () => {
    const ctx = context();
    await expect(submitFeatureRequestTool.handler({ title: " ", description: "valid" }, ctx))
      .rejects.toThrow("Title is required");
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: "validation_error", errorCode: "title_required" }),
      expect.any(String)
    );
  });

  it("distinguishes rate limits from database failures without echoing DB messages", async () => {
    const rateContext = context();
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ count: "5" }] } as never);
    await expect(submitFeatureRequestTool.handler({ title: "valid", description: "valid" }, rateContext))
      .rejects.toThrow("Limit: 5 requests per 24 hours");
    expect(rateContext.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: "rate_limit_error", errorCode: "rate_limited" }),
      expect.any(String)
    );

    const databaseContext = context();
    const sensitive = "private postgres message with auth0|private";
    vi.mocked(query).mockRejectedValueOnce(new Error(sensitive));
    await expect(submitFeatureRequestTool.handler({ title: "valid", description: "valid" }, databaseContext))
      .rejects.toThrow("Unable to submit feature request");
    expect(JSON.stringify(databaseContext.logger.warn.mock.calls)).not.toContain(sensitive);
    expect(databaseContext.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: "database_error" }),
      expect.any(String)
    );
  });
});
