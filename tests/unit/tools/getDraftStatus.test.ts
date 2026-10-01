/**
 * get_draft_status (#474).
 *
 * The preview card asks it in a host that keeps no state for the card (MCP
 * Apps): what became of the draft the preview made. It changes nothing, and a
 * draft that is not the caller's reads as not found, so the answer says
 * nothing about whether someone else's draft exists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../../src/contracts/types.js";

vi.mock("../../../src/services/draftService.js", () => ({
  getDraftState: vi.fn()
}));

import { DELIVERY_ESTIMATE } from "../../../src/content/delivery.js";
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
    arrive_by: null,
    mail_on: null,
    // The letter it became, as the query's LEFT JOIN reads it.
    letter_status: null,
    letter_funding_type: null,
    letter_arrive_by: null,
    letter_mail_on: null,
    ...overrides
  };
}

const READY = { draftId: DRAFT_ID, status: "ready", deliveryEstimate: DELIVERY_ESTIMATE };

const ask = (input: Record<string, unknown>, ctx = context()) => getDraftStatusTool.handler(input as any, ctx);

describe("get_draft_status (#474)", () => {
  beforeEach(() => vi.mocked(getDraftState).mockReset());

  it("says a draft waiting to be sent is ready", async () => {
    vi.mocked(getDraftState).mockResolvedValue(state() as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual(READY);
    expect(getDraftState).toHaveBeenCalledWith(DRAFT_ID);
  });

  it("says a sent draft was sent, with the order it became", async () => {
    vi.mocked(getDraftState).mockResolvedValue(state({ status: "consumed", consumed_letter_id: ORDER_ID }) as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({ draftId: DRAFT_ID, status: "sent", orderId: ORDER_ID });

    // Its letter read: sent, with nothing to cancel.
    vi.mocked(getDraftState).mockResolvedValue(
      state({ status: "consumed", consumed_letter_id: ORDER_ID, letter_status: "accepted", letter_funding_type: "prepaid_balance" }) as any
    );
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({
      draftId: DRAFT_ID,
      status: "sent",
      orderId: ORDER_ID,
      orderStatus: "sent",
      cancellable: false
    });
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
    await expect(ask({ draftId: ` ${DRAFT_ID} ` })).resolves.toEqual(READY);
  });

  it("says a ready draft's arrival dates, and what they mean for delivery, so the card draws the ones it has now (#535)", async () => {
    vi.mocked(getDraftState).mockResolvedValue(state({ arrive_by: "2026-10-16", mail_on: "2026-10-06" }) as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({
      draftId: DRAFT_ID,
      status: "ready",
      schedule: { arriveBy: "2026-10-16", mailOn: "2026-10-06" },
      deliveryEstimate: "Goes to the printer Tue, Oct 6, and aims to arrive by Fri, Oct 16."
    });
  });

  describe("a sent draft's order, from its letter, never the draft's dates (#535)", () => {
    // The draft's dates differ from the letter's, so an answer shows which it read.
    const sent = (letter: Record<string, unknown>) =>
      state({ status: "consumed", consumed_letter_id: ORDER_ID, arrive_by: "2026-10-30", mail_on: "2026-10-20", ...letter });
    const LETTER_DATES = { letter_arrive_by: "2026-10-16", letter_mail_on: "2026-10-06" };
    const SCHEDULE = { arriveBy: "2026-10-16", mailOn: "2026-10-06" };

    it("is scheduled and cancellable while it waits for its mail date", async () => {
      vi.mocked(getDraftState).mockResolvedValue(sent({ letter_status: "queued", letter_funding_type: "prepaid_balance", ...LETTER_DATES }) as any);
      await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({
        draftId: DRAFT_ID,
        status: "sent",
        orderId: ORDER_ID,
        schedule: SCHEDULE,
        orderStatus: "scheduled",
        cancellable: true
      });
      vi.mocked(getDraftState).mockResolvedValue(sent({ letter_status: "queued", letter_funding_type: "gift_letter", ...LETTER_DATES }) as any);
      await expect(ask({ draftId: DRAFT_ID })).resolves.toMatchObject({ orderStatus: "scheduled", cancellable: true });
    });

    it("is scheduled but not cancellable when Pay & Send paid for it", async () => {
      vi.mocked(getDraftState).mockResolvedValue(sent({ letter_status: "queued", letter_funding_type: "jit_order", ...LETTER_DATES }) as any);
      await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({
        draftId: DRAFT_ID,
        status: "sent",
        orderId: ORDER_ID,
        schedule: SCHEDULE,
        orderStatus: "scheduled",
        cancellable: false
      });
    });

    it("is cancelled once cancelled, from here, the chat or the website", async () => {
      vi.mocked(getDraftState).mockResolvedValue(sent({ letter_status: "cancelled", letter_funding_type: "prepaid_balance", ...LETTER_DATES }) as any);
      await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({
        draftId: DRAFT_ID,
        status: "sent",
        orderId: ORDER_ID,
        schedule: SCHEDULE,
        orderStatus: "cancelled",
        cancellable: false
      });
    });

    it.each(["processing", "accepted", "in_transit", "delivered", "failed"])(
      "is sent, with nothing to cancel, once the outbox has taken it (%s)",
      async letterStatus => {
        vi.mocked(getDraftState).mockResolvedValue(sent({ letter_status: letterStatus, letter_funding_type: "prepaid_balance", ...LETTER_DATES }) as any);
        await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({
          draftId: DRAFT_ID,
          status: "sent",
          orderId: ORDER_ID,
          schedule: SCHEDULE,
          orderStatus: "sent",
          cancellable: false
        });
      }
    );

    it("is sent, with no dates, when its letter has none, whatever the draft says", async () => {
      vi.mocked(getDraftState).mockResolvedValue(sent({ letter_status: "queued", letter_funding_type: "prepaid_balance" }) as any);
      await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({
        draftId: DRAFT_ID,
        status: "sent",
        orderId: ORDER_ID,
        orderStatus: "sent",
        cancellable: false
      });
    });

    it("says only that it was sent when its letter cannot be read", async () => {
      vi.mocked(getDraftState).mockResolvedValue(sent({}) as any);
      await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({ draftId: DRAFT_ID, status: "sent", orderId: ORDER_ID });
      vi.mocked(getDraftState).mockResolvedValue(state({ status: "consumed", arrive_by: "2026-10-30", mail_on: "2026-10-20" }) as any);
      await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({ draftId: DRAFT_ID, status: "sent" });
    });
  });

  it("answers without dates it cannot read, rather than refusing (#535)", async () => {
    for (const dates of [
      { arrive_by: "2026-10-16", mail_on: null },
      { arrive_by: new Date("2026-10-16T00:00:00Z"), mail_on: "2026-10-06" },
      { arrive_by: "16/10/2026", mail_on: "2026-10-06" }
    ]) {
      vi.mocked(getDraftState).mockResolvedValue(state(dates) as any);
      await expect(ask({ draftId: DRAFT_ID }), JSON.stringify(dates)).resolves.toEqual(READY);
      vi.mocked(getDraftState).mockResolvedValue(
        state({
          status: "consumed",
          consumed_letter_id: ORDER_ID,
          letter_status: "queued",
          letter_funding_type: "prepaid_balance",
          letter_arrive_by: dates.arrive_by,
          letter_mail_on: dates.mail_on
        }) as any
      );
      await expect(ask({ draftId: DRAFT_ID }), JSON.stringify(dates)).resolves.toEqual({
        draftId: DRAFT_ID,
        status: "sent",
        orderId: ORDER_ID,
        orderStatus: "sent",
        cancellable: false
      });
    }
  });

  it("is read-only and says so", () => {
    expect(getDraftStatusTool.readOnly).toBe(true);
    expect(getDraftStatusTool.meta?.readOnlyHint).toBe(true);
  });
});

describe("get_draft_status names a ready letter's style now (#563, #572)", () => {
  const PAGE = '<!DOCTYPE html><html><body data-renderer="pdf-2"><svg></svg></body></html>';
  const drawn = (overrides: Record<string, unknown> = {}) =>
    state({ mail_type: "letter", renderer_version: "pdf-2", stationery: { theme: "botanical", dateLine: "October 1, 2026" }, preview_html: PAGE, ...overrides });

  beforeEach(() => {
    vi.mocked(getDraftState).mockReset();
    vi.stubEnv("LETTER_IRL_STATIONERY_ENABLED", "true");
    vi.stubEnv("LETTER_IRL_PRINT_RENDERER", "pdf");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("gives a themed draft's stationery, as the print reads it, and its page", async () => {
    vi.mocked(getDraftState).mockResolvedValue(drawn({ stationery: { theme: "botanical", dateLine: "October 1, 2026", colour: "red" } }) as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({
      ...READY,
      stationery: { theme: "botanical", dateLine: "October 1, 2026" },
      previewHtml: PAGE
    });
  });

  it("calls a page our renderer drew without a theme Classic", async () => {
    vi.mocked(getDraftState).mockResolvedValue(drawn({ renderer_version: "pdf-1", stationery: null }) as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({ ...READY, stationery: { theme: "classic" }, previewHtml: PAGE });
  });

  it("says nothing of style for a legacy page, a postcard, or while stationery is not offered", async () => {
    for (const draft of [drawn({ renderer_version: null, stationery: null }), drawn({ mail_type: "postcard", renderer_version: "pdf-1", stationery: null })]) {
      vi.mocked(getDraftState).mockResolvedValue(draft as any);
      await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual(READY);
    }
    for (const [enabled, renderer] of [["", "pdf"], ["true", "html"]]) {
      vi.stubEnv("LETTER_IRL_STATIONERY_ENABLED", enabled);
      vi.stubEnv("LETTER_IRL_PRINT_RENDERER", renderer);
      vi.mocked(getDraftState).mockResolvedValue(drawn() as any);
      await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual(READY);
    }
  });

  it("says nothing of style for a sent or expired draft", async () => {
    vi.mocked(getDraftState).mockResolvedValue(drawn({ status: "consumed", consumed_letter_id: ORDER_ID }) as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.not.toHaveProperty("stationery");
    vi.mocked(getDraftState).mockResolvedValue(drawn({ status: "expired" }) as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({ draftId: DRAFT_ID, status: "expired" });
  });
});
