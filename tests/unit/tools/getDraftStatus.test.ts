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
import { wordsVersionOf } from "../../../src/tools/letterHelpers.js";

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

  it("names a ready letter's pages when it has more than one, as set_stationery may have changed them (#586)", async () => {
    vi.mocked(getDraftState).mockResolvedValue(state({ mail_type: "letter", pages: 2 }) as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({ ...READY, pages: 2 });
    for (const overrides of [{ mail_type: "letter", pages: 1 }, { mail_type: "letter" }, { mail_type: "postcard", pages: 2 }]) {
      vi.mocked(getDraftState).mockResolvedValue(state(overrides) as any);
      await expect(ask({ draftId: DRAFT_ID }), JSON.stringify(overrides)).resolves.toEqual(READY);
    }
  });

  it("says what a ready letter costs now while room to write is offered, as a restyle may have changed it (#586)", async () => {
    const ready = state({ mail_type: "letter", renderer_version: "pdf-1", pages: 2, required_credits: 2, is_gift_send: false, body_text: "Dear Sam,", sign_off: "Pat" });
    vi.mocked(getDraftState).mockResolvedValue(ready as any);
    // Not offered: the pages alone, as before.
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({ ...READY, pages: 2 });

    vi.stubEnv("LETTER_IRL_ROOM_TO_WRITE_ENABLED", "true");
    vi.stubEnv("LETTER_IRL_PRINT_RENDERER", "pdf");
    vi.stubEnv("JIT_PURCHASE_ENABLED", "true");
    try {
      const answer = await ask({ draftId: DRAFT_ID }, { ...context(), user: { userId: "auth0|owner", creditsRemaining: 10, orders: [] } as any });
      expect(answer).toMatchObject({ ...READY, pages: 2, canSendNow: false });
      // And its words now, with their version, for the card's Words tab (#593 review round 1).
      expect(answer).toMatchObject({ bodyText: ready.body_text, signOff: ready.sign_off, wordsVersion: wordsVersionOf(ready.body_text, ready.sign_off) });
      expect(answer.reasonCannotSend).toMatch(/paid with Pay & Send/);
      expect(answer.sendEligibility).toMatchObject({ packPays: false });

      // One page, which the balance pays.
      vi.mocked(getDraftState).mockResolvedValue({ ...ready, pages: 1 } as any);
      const one = await ask({ draftId: DRAFT_ID }, { ...context(), user: { userId: "auth0|owner", creditsRemaining: 10, orders: [] } as any });
      expect(one).toMatchObject({ canSendNow: true });
      expect(one).not.toHaveProperty("pages");

      // A gift letter, which its gift pays for whatever the balance (#579).
      vi.mocked(getDraftState).mockResolvedValue({ ...ready, pages: 1, is_gift_send: true } as any);
      const gift = await ask({ draftId: DRAFT_ID }, { ...context(), user: { userId: "auth0|owner", creditsRemaining: 0, orders: [] } as any });
      expect(gift).toMatchObject({ canSendNow: true });
      // The preview's own terms for a gift (giftSendEligibility): nothing to pay.
      expect(gift.sendEligibility).toMatchObject({ payAndSend: { available: false, unavailableReason: "This uses a gift letter, so there is nothing to pay." } });

      // The draft's own credits, not a guess: more than the balance holds.
      vi.mocked(getDraftState).mockResolvedValue({ ...ready, pages: 1, required_credits: 12 } as any);
      const short = await ask({ draftId: DRAFT_ID }, { ...context(), user: { userId: "auth0|owner", creditsRemaining: 10, orders: [] } as any });
      expect(short).toMatchObject({ canSendNow: false });

      // A postcard, or a letter the legacy HTML drew, says nothing of it.
      for (const overrides of [{ mail_type: "postcard" }, { renderer_version: null }]) {
        vi.mocked(getDraftState).mockResolvedValue({ ...ready, ...overrides } as any);
        expect(await ask({ draftId: DRAFT_ID }), JSON.stringify(overrides)).not.toHaveProperty("canSendNow");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps a ready certified letter's terms whether or not room to write is offered, and no pack pays for it (#625)", async () => {
    const certified = state({
      mail_type: "letter", renderer_version: "pdf-1", pages: 1, mail_service: "certified",
      required_credits: 2, is_gift_send: false, body_text: "Dear Sam,", sign_off: "Pat"
    });
    const rich = { ...context(), user: { userId: "auth0|owner", creditsRemaining: 10, orders: [] } as any };
    vi.stubEnv("JIT_PURCHASE_ENABLED", "true");
    try {
      // Room to write is not offered, and a standard letter then says nothing of its terms.
      vi.mocked(getDraftState).mockResolvedValue({ ...certified, mail_service: "standard" } as any);
      expect(await ask({ draftId: DRAFT_ID }, rich)).not.toHaveProperty("canSendNow");

      // A certified one is paid per send, whatever the balance.
      for (const service of ["certified", "certified_return_receipt"]) {
        vi.mocked(getDraftState).mockResolvedValue({ ...certified, mail_service: service } as any);
        const answer = await ask({ draftId: DRAFT_ID }, rich);
        expect(answer, service).toMatchObject({ ...READY, canSendNow: false, reasonCannotSend: "Certified mail is paid with Pay & Send." });
        expect(answer.sendEligibility, service).toMatchObject({ packPays: false });
        // Its words are not offered with it: they are room to write's.
        expect(answer, service).not.toHaveProperty("wordsVersion");
      }

      // And a service this code does not know prices as no standard letter: nothing a pack pays for.
      vi.mocked(getDraftState).mockResolvedValue({ ...certified, mail_service: "express" } as any);
      expect(await ask({ draftId: DRAFT_ID }, rich)).toMatchObject({ canSendNow: false });

      // A gift letter, a postcard and a letter the legacy HTML drew are as they were.
      for (const overrides of [{ mail_type: "postcard" }, { renderer_version: null }]) {
        vi.mocked(getDraftState).mockResolvedValue({ ...certified, ...overrides } as any);
        expect(await ask({ draftId: DRAFT_ID }, rich), JSON.stringify(overrides)).not.toHaveProperty("canSendNow");
      }
    } finally {
      vi.unstubAllEnvs();
    }
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

describe("get_draft_status says whether a ready letter is signed now (#608 part 4)", () => {
  const PAGE = '<!DOCTYPE html><html><body data-renderer="pdf-4"><svg></svg></body></html>';
  const drawn = (overrides: Record<string, unknown> = {}) =>
    state({ mail_type: "letter", renderer_version: "pdf-4", stationery: null, preview_html: PAGE, signed: true, ...overrides });

  beforeEach(() => {
    vi.mocked(getDraftState).mockReset();
    vi.stubEnv("LETTER_IRL_SIGNATURES_ENABLED", "true");
    vi.stubEnv("LETTER_IRL_PRINT_RENDERER", "pdf");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("says a signed letter is signed and an unsigned one is not, with its page, never the picture", async () => {
    vi.mocked(getDraftState).mockResolvedValue(drawn() as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({ ...READY, signature: true, previewHtml: PAGE });
    vi.mocked(getDraftState).mockResolvedValue(drawn({ renderer_version: "pdf-1", signed: false }) as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({ ...READY, signature: false, previewHtml: PAGE });
  });

  it("says it beside the stationery while both are offered", async () => {
    vi.stubEnv("LETTER_IRL_STATIONERY_ENABLED", "true");
    vi.mocked(getDraftState).mockResolvedValue(drawn({ stationery: { theme: "botanical", dateLine: "October 3, 2026" } }) as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual({
      ...READY,
      stationery: { theme: "botanical", dateLine: "October 3, 2026" },
      signature: true,
      previewHtml: PAGE
    });
  });

  it("says nothing of it for a legacy page, a postcard, a sent draft, or while signatures are not offered", async () => {
    for (const draft of [drawn({ renderer_version: null, signed: false }), drawn({ mail_type: "postcard", renderer_version: "pdf-1", signed: false })]) {
      vi.mocked(getDraftState).mockResolvedValue(draft as any);
      await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual(READY);
    }
    vi.mocked(getDraftState).mockResolvedValue(drawn({ status: "consumed", consumed_letter_id: ORDER_ID }) as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.not.toHaveProperty("signature");
    for (const [enabled, renderer] of [["", "pdf"], ["true", "html"]]) {
      vi.stubEnv("LETTER_IRL_SIGNATURES_ENABLED", enabled);
      vi.stubEnv("LETTER_IRL_PRINT_RENDERER", renderer);
      vi.mocked(getDraftState).mockResolvedValue(drawn() as any);
      await expect(ask({ draftId: DRAFT_ID })).resolves.toEqual(READY);
    }
  });
});

describe("a ready postcard's size and front (#594)", () => {
  const PAGE = '<!DOCTYPE html><html><body data-renderer="pdf-1"><svg></svg><svg></svg></body></html>';
  const postcard = (overrides: Record<string, unknown> = {}) =>
    state({
      mail_type: "postcard",
      renderer_version: "pdf-3",
      postcard_size: "6x11",
      postcard_front: { layout: "border", caption: "Cape Cod" },
      preview_html: PAGE,
      required_credits: 2,
      is_gift_send: false,
      ...overrides
    });
  const withBalance = () => ({ ...context(), user: { userId: "auth0|owner", creditsRemaining: 10, orders: [] } as any });
  const offer = (flag: string) => {
    vi.stubEnv("LETTER_IRL_PRINT_RENDERER", "pdf");
    vi.stubEnv("JIT_PURCHASE_ENABLED", "true");
    vi.stubEnv("LETTER_IRL_POSTCARD_SIZES_ENABLED", "");
    vi.stubEnv("LETTER_IRL_POSTCARD_LAYOUTS_ENABLED", "");
    vi.stubEnv(flag, "true");
  };

  beforeEach(() => vi.mocked(getDraftState).mockReset());
  afterEach(() => vi.unstubAllEnvs());

  it("says them, with its page and what it costs now, while the sizes or the layouts are offered", async () => {
    vi.mocked(getDraftState).mockResolvedValue(postcard() as any);
    // Not offered: nothing of it, as before.
    await expect(ask({ draftId: DRAFT_ID }, withBalance())).resolves.toEqual(READY);

    for (const flag of ["LETTER_IRL_POSTCARD_SIZES_ENABLED", "LETTER_IRL_POSTCARD_LAYOUTS_ENABLED"]) {
      offer(flag);
      const answer = await ask({ draftId: DRAFT_ID }, withBalance());
      expect(answer, flag).toMatchObject({ ...READY, size: "6x11", layout: "border", caption: "Cape Cod", previewHtml: PAGE, canSendNow: false });
      expect(answer.reasonCannotSend).toMatch(/paid with Pay & Send/);
      expect(answer).not.toHaveProperty("place");
    }
  });

  it("says a greeting's place, full bleed as full bleed, and who pays a 6x9", async () => {
    offer("LETTER_IRL_POSTCARD_LAYOUTS_ENABLED");
    vi.mocked(getDraftState).mockResolvedValue(postcard({ postcard_size: "6x9", postcard_front: { layout: "greetings", place: "Rye" } }) as any);
    const greeted = await ask({ draftId: DRAFT_ID }, withBalance());
    expect(greeted).toMatchObject({ size: "6x9", layout: "greetings", place: "Rye", canSendNow: true });
    expect(greeted).not.toHaveProperty("caption");
    expect(greeted).not.toHaveProperty("reasonCannotSend");

    vi.mocked(getDraftState).mockResolvedValue(postcard({ renderer_version: "pdf-1", postcard_size: "6x9", postcard_front: null }) as any);
    const plain = await ask({ draftId: DRAFT_ID }, withBalance());
    expect(plain).toMatchObject({ size: "6x9", layout: "full_bleed", canSendNow: true });

    // A gift postcard is paid by its gift, whatever the balance.
    vi.mocked(getDraftState).mockResolvedValue(postcard({ postcard_size: "6x9", is_gift_send: true }) as any);
    await expect(ask({ draftId: DRAFT_ID })).resolves.toMatchObject({ canSendNow: true });
  });

  it("says nothing of a postcard the legacy HTML drew, of a front the print cannot read, or of a letter", async () => {
    offer("LETTER_IRL_POSTCARD_SIZES_ENABLED");
    for (const overrides of [
      { renderer_version: null, preview_html: null },
      { postcard_front: { layout: "collage" } },
      { mail_type: "letter", renderer_version: "pdf-1", postcard_size: null, postcard_front: null }
    ]) {
      vi.mocked(getDraftState).mockResolvedValue(postcard(overrides) as any);
      const answer = await ask({ draftId: DRAFT_ID }, withBalance());
      for (const key of ["size", "layout", "previewHtml", "canSendNow"]) {
        expect(answer, `${JSON.stringify(overrides)} ${key}`).not.toHaveProperty(key);
      }
    }
  });
});
