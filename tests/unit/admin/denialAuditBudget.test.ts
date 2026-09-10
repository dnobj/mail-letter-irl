import { describe, expect, it } from "vitest";

import { DenialAuditBudget, denialBurstEvent, type DenialBurstSummary } from "../../../src/admin/http/denialAuditBudget.js";

function harness(limit = 3) {
  let clock = Date.parse("2026-09-08T12:00:00Z");
  const bursts: DenialBurstSummary[] = [];
  const budget = new DenialAuditBudget({ limit, windowMs: 60_000, now: () => clock });
  budget.setSink(async (summary) => {
    bursts.push(summary);
  });
  return { budget, bursts, advance: (ms: number) => (clock += ms) };
}

describe("DenialAuditBudget", () => {
  it("admits up to the limit, then counts instead of dropping", async () => {
    const { budget, bursts } = harness();
    expect(await budget.admit("a@example.com", "ADMIN_FORBIDDEN")).toBe(true);
    expect(await budget.admit("a@example.com", "ADMIN_FORBIDDEN")).toBe(true);
    expect(await budget.admit("b@example.com", "ADMIN_UNAUTHENTICATED")).toBe(true);
    expect(await budget.admit("b@example.com", "ADMIN_UNAUTHENTICATED")).toBe(false);
    expect(await budget.admit("c@example.com", "ADMIN_FORBIDDEN")).toBe(false);
    expect(bursts).toHaveLength(0);

    await budget.flush();
    expect(bursts).toEqual([
      {
        windowStartedAt: "2026-09-08T12:00:00.000Z",
        windowMs: 60_000,
        limit: 3,
        written: 3,
        suppressed: 2,
        byCode: { ADMIN_UNAUTHENTICATED: 1, ADMIN_FORBIDDEN: 1 },
        distinctActors: 2,
      },
    ]);
    // Nothing pending twice.
    await budget.flush();
    expect(bursts).toHaveLength(1);
  });

  it("writes the previous window's burst at the first denial of the next window, and restarts the budget", async () => {
    const { budget, bursts, advance } = harness(1);
    await budget.admit("a@example.com", "ADMIN_FORBIDDEN");
    await budget.admit("a@example.com", "ADMIN_FORBIDDEN");
    await budget.admit("a@example.com", "ADMIN_FORBIDDEN");
    expect(bursts).toHaveLength(0);
    advance(60_000);
    expect(await budget.admit("a@example.com", "ADMIN_FORBIDDEN")).toBe(true);
    expect(bursts).toHaveLength(1);
    expect(bursts[0]).toMatchObject({ written: 1, suppressed: 2 });
  });

  it("counts a denial another limiter refused without spending the budget", async () => {
    const { budget, bursts } = harness(2);
    await budget.suppress("a@example.com", "ADMIN_FORBIDDEN");
    expect(await budget.admit("b@example.com", "ADMIN_FORBIDDEN")).toBe(true);
    expect(await budget.admit("b@example.com", "ADMIN_FORBIDDEN")).toBe(true);
    await budget.flush();
    expect(bursts[0]).toMatchObject({ written: 2, suppressed: 1, distinctActors: 1 });
  });

  it("stays quiet when nothing was suppressed", async () => {
    const { budget, bursts, advance } = harness();
    await budget.admit("a@example.com", "ADMIN_FORBIDDEN");
    advance(60_000);
    await budget.admit("a@example.com", "ADMIN_FORBIDDEN");
    await budget.flush();
    expect(bursts).toHaveLength(0);
  });

  it("builds an audit row that names the window and passes the contract's actor shape", () => {
    const event = denialBurstEvent({
      windowStartedAt: "2026-09-08T12:00:00.000Z",
      windowMs: 60_000,
      limit: 60,
      written: 60,
      suppressed: 140,
      byCode: { ADMIN_FORBIDDEN: 140 },
      distinctActors: 3,
    });
    expect(event).toMatchObject({
      actor: { id: "aggregate@admin-panel" },
      action: "admin.request_denied_burst",
      targetType: "process",
      outcome: "denied",
      errorCode: "ADMIN_DENIAL_BURST",
      inputSummary: { suppressed: 140, distinctActors: 3 },
    });
    expect(event.sessionIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(event.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
