/**
 * get_draft_status (#474).
 *
 * The preview card asks it in a host that keeps no state for the card (MCP
 * Apps): what became of the draft the preview made. It changes nothing, and a
 * draft that is not the caller's reads as not found, so the answer says
 * nothing about whether someone else's draft exists.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../../src/contracts/types.js";

vi.mock("../../../src/services/draftService.js", () => ({
  getDraftState: vi.fn()
}));

import { getDraftState } from "../../../src/services/draftService.js";
import { getDraftStatusTool } from "../../../src/tools/getDraftStatus.js";

const DRAFT_ID = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
const ORDER_ID = "5a6a079a-ee06-41f5-a782-25f3016089f5";
const NOW = new Date("2026-09-27T12:00:00Z");

const context = (userId = "auth0|owner"): ToolContext => ({
  user: { userId, creditsRemaining: 0, orders: [] } as any,
  correlationId: "test-correlation-id",
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
  now: () => NOW,
  persist: vi.fn()
});

function state(overrides: Record<string, unknown> = {}) {
  return {
    draft_id: DRAFT_ID,
    user_id: "auth0|owner",
    status: "pending",
    expires_at: new Date("2026-09-28T12:00:00Z"),
    consumed_letter_id: null,
    ...overrides
  };
}

const ask = (input: Record<string, unknown>, ctx = context()) => getDraftStatusTool.handler(input as any, ctx);

describe("get_draft_status (#474)", () => {
  beforeEach(() => vi.mocked(getDraftState).mockReset());

  it("says a draft waiting to be sent is ready", async () => {
    vi.mocked(getDraftState).mockResolvedValue(state() as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({ draftId: DRAFT_ID, status: "ready" });
    expect(getDraftState).toHaveBeenCalledWith(DRAFT_ID);
  });

  it("says a sent draft was sent, with the order it became", async () => {
    vi.mocked(getDraftState).mockResolvedValue(state({ status: "consumed", consumed_letter_id: ORDER_ID }) as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({ draftId: DRAFT_ID, status: "sent", orderId: ORDER_ID });
  });

  it("says a sent draft was sent even without its order", async () => {
    vi.mocked(getDraftState).mockResolvedValue(state({ status: "consumed" }) as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({ draftId: DRAFT_ID, status: "sent" });
  });

  it.each([
    ["marked expired", { status: "expired" }],
    ["cancelled", { status: "cancelled" }],
    ["past its time though not yet swept", { expires_at: new Date("2026-09-27T11:59:59Z") }],
    ["at its time exactly", { expires_at: NOW }]
  ])("says a draft %s has expired", async (_label, overrides) => {
    vi.mocked(getDraftState).mockResolvedValue(state(overrides) as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({ draftId: DRAFT_ID, status: "expired" });
  });

  it("reads someone else's draft as not found", async () => {
    vi.mocked(getDraftState).mockResolvedValue(state({ status: "consumed", consumed_letter_id: ORDER_ID }) as any);
    await expect(ask({ draftId: DRAFT_ID }, context("auth0|someone-else"))).resolves.toEqual({
      draftId: DRAFT_ID,
      status: "not_found"
    });
  });

  it("reads a missing draft as not found", async () => {
    vi.mocked(getDraftState).mockResolvedValue(null);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({ draftId: DRAFT_ID, status: "not_found" });
  });

  it("does not ask the database about an id that is not a draft id", async () => {
    for (const draftId of ["draft_host_0001", "", "0f1e2d3c'; drop table letters; --"]) {
      await expect(ask({ draftId })).resolves.toEqual({ draftId, status: "not_found" });
    }
    await expect(ask({})).resolves.toEqual({ draftId: "", status: "not_found" });
    expect(getDraftState).not.toHaveBeenCalled();
  });

  it("trims the id it is given", async () => {
    vi.mocked(getDraftState).mockResolvedValue(state() as any);
    await expect(ask({ draftId: ` ${DRAFT_ID} ` })).resolves.toEqual({ draftId: DRAFT_ID, status: "ready" });
  });

  it("says the draft's arrival dates, ready or sent, so the card draws the ones it has now (#535)", async () => {
    const dates = { arrive_by: "2026-10-16", mail_on: "2026-10-06" };
    vi.mocked(getDraftState).mockResolvedValue(state(dates) as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({
      draftId: DRAFT_ID,
      status: "ready",
      schedule: { arriveBy: "2026-10-16", mailOn: "2026-10-06" }
    });

    vi.mocked(getDraftState).mockResolvedValue(state({ ...dates, status: "consumed", consumed_letter_id: ORDER_ID }) as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({
      draftId: DRAFT_ID,
      status: "sent",
      orderId: ORDER_ID,
      schedule: { arriveBy: "2026-10-16", mailOn: "2026-10-06" }
    });

    vi.mocked(getDraftState).mockResolvedValue(state({ ...dates, status: "consumed" }) as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({
      draftId: DRAFT_ID,
      status: "sent",
      schedule: { arriveBy: "2026-10-16", mailOn: "2026-10-06" }
    });
  });

  it("answers without dates it cannot read, rather than refusing (#535)", async () => {
    for (const dates of [
      { arrive_by: "2026-10-16", mail_on: null },
      { arrive_by: new Date("2026-10-16T00:00:00Z"), mail_on: "2026-10-06" },
      { arrive_by: "16/10/2026", mail_on: "2026-10-06" }
    ]) {
      vi.mocked(getDraftState).mockResolvedValue(state(dates) as any);
      await expect(ask({ draftId: DRAFT_ID }), JSON.stringify(dates)).resolves.toEqual({ draftId: DRAFT_ID, status: "ready" });
    }
  });

  it("is read-only and says so", () => {
    expect(getDraftStatusTool.readOnly).toBe(true);
    expect(getDraftStatusTool.meta?.readOnlyHint).toBe(true);
  });
});
