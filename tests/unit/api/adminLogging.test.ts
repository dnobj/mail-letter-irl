import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../../src/db/index.js", () => ({ query, transaction: vi.fn() }));

vi.mock("../../../src/api/middleware/adminAuth.js", () => ({
  authenticateAdmin: vi.fn().mockResolvedValue({ userId: "auth0|private-admin" })
}));
vi.mock("../../../src/services/stripeReconciliationService.js", () => ({
  reconcileStripePayments: vi.fn(),
  autoFixMissingCredits: vi.fn()
}));

import { reconcileStripePayments } from "../../../src/services/stripeReconciliationService.js";
import { handleAdminApiRequest } from "../../../src/api/adminApiHandler.js";

describe("admin runtime logging privacy", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("returns explicit operator-only references without logging them", async () => {
    const accountId = "auth0|operator-target";
    const paymentSessionId = "cs_operator_payment";
    vi.mocked(reconcileStripePayments).mockResolvedValue({
      period: { start: new Date("2026-01-01"), end: new Date("2026-01-02") },
      summary: { stripePayments: 1, ourCredits: 0, matched: 0, missingInOurSystem: 1, missingInStripe: 0, amountMismatches: 0, unprocessedRefunds: 0 },
      discrepancies: [{
        type: "missing_credit", severity: "critical", userId: accountId,
        stripeSessionId: paymentSessionId, expectedCredits: 10,
        message: "A completed payment has no corresponding credit entry",
        suggestedAction: "Review the missing credit in the Stripe dashboard"
      }],
      recommendations: []
    } as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const req = { method: "GET", url: "/api/admin/stripe/reconcile", headers: { host: "localhost" } };
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };

    await handleAdminApiRequest(req as never, res as never, "/api/admin/stripe/reconcile");

    const body = JSON.parse(String(res.end.mock.calls[0][0]));
    expect(body.discrepancies[0].operatorReference).toEqual({ accountId, paymentSessionId });
    expect(body.discrepancies[0]).toMatchObject({ type: "missing_credit", suggestedAction: expect.any(String) });
    expect(log.mock.calls.flat().map(String).join("\n")).not.toContain(accountId);
    expect(log.mock.calls.flat().map(String).join("\n")).not.toContain(paymentSessionId);
  });

  it("does not log or return arbitrary reconciliation errors", async () => {
    const sensitive = "cs_private auth0|private-user private provider body";
    vi.mocked(reconcileStripePayments).mockRejectedValue(new Error(sensitive));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const req = {
      method: "GET",
      url: "/api/admin/stripe/reconcile",
      headers: { host: "localhost" }
    };
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };

    await handleAdminApiRequest(req as never, res as never, "/api/admin/stripe/reconcile");

    const logged = error.mock.calls.flat().map(String).join("\n");
    const body = String(res.end.mock.calls[0][0]);
    expect(logged).toContain('"event":"credits.reconciliation_failed"');
    expect(logged).not.toContain(sensitive);
    expect(body).toContain("Unable to reconcile payments");
    expect(body).not.toContain(sensitive);
  });

  it("does not log or return arbitrary routing persistence errors", async () => {
    const sensitive = "private database detail auth0|private-admin";
    query.mockRejectedValue(new Error(sensitive));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const req = Object.assign(new EventEmitter(), {
      method: "PUT",
      url: "/api/admin/routing/postcard",
      headers: { host: "localhost" }
    });
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    const handled = handleAdminApiRequest(req as never, res as never, "/api/admin/routing/postcard");
    queueMicrotask(() => {
      req.emit("data", Buffer.from(JSON.stringify({ provider: "dummy" })));
      req.emit("end");
    });
    await handled;

    const logged = error.mock.calls.flat().map(String).join("\n");
    const body = String(res.end.mock.calls[0][0]);
    expect(logged).toContain('"event":"admin.routing_update_failed"');
    expect(logged).not.toContain(sensitive);
    expect(body).toContain("Unable to update routing");
    expect(body).not.toContain(sensitive);
  });
});
