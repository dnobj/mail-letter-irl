/**
 * request_send (#470).
 *
 * The model's only way to send once the send rule is on: it reads the draft and
 * hands back the letterirl.com page where the person sends it themselves. It
 * changes nothing, so every refusal must leave the draft as it was, and none
 * may say whether someone else's draft exists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../../src/contracts/types.js";

vi.mock("../../../src/services/draftService.js", () => ({
  getDraft: vi.fn()
}));

import { getDraft } from "../../../src/services/draftService.js";
import {
  requestSendTool,
  SendConfirmationRefusedError
} from "../../../src/tools/requestSend.js";

const DRAFT_ID = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
const NOW = new Date("2026-09-25T12:00:00Z");

const context = (userId = "auth0|owner"): ToolContext => ({
  user: { userId, creditsRemaining: 0, orders: [] } as any,
  correlationId: "test-correlation-id",
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
  now: () => NOW,
  persist: vi.fn()
});

function draft(overrides: Record<string, unknown> = {}) {
  return {
    draft_id: DRAFT_ID,
    user_id: "auth0|owner",
    mail_type: "letter",
    status: "pending",
    expires_at: new Date("2026-09-26T12:00:00Z"),
    recipient: { name: "Sam Rivera", addressLine1: "1 Main St", city: "Austin", state: "TX", postalCode: "78701" },
    ...overrides
  };
}

async function refusal(input: Record<string, unknown>, ctx = context()) {
  try {
    await requestSendTool.handler(input as any, ctx);
  } catch (error) {
    return error as SendConfirmationRefusedError;
  }
  throw new Error("expected a refusal");
}

describe("request_send", () => {
  beforeEach(() => {
    vi.mocked(getDraft).mockReset();
    vi.stubEnv("LETTER_IRL_WEBSITE_BASE_URL", "https://site.example");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is read-only and says nothing is sent", () => {
    expect(requestSendTool.readOnly).toBe(true);
    expect(requestSendTool.meta.readOnlyHint).toBe(true);
    expect(requestSendTool.description).toMatch(/Nothing is sent by this tool/);
  });

  it("returns the page where the person sends their own draft", async () => {
    vi.mocked(getDraft).mockResolvedValue(draft() as any);

    const result = await requestSendTool.handler({ draftId: ` ${DRAFT_ID} ` }, context());

    expect(getDraft).toHaveBeenCalledWith(DRAFT_ID);
    expect(result).toEqual({
      draftId: DRAFT_ID,
      mailType: "letter",
      confirmationUrl: `https://site.example/confirm/${DRAFT_ID}`,
      expiresAtISO: "2026-09-26T12:00:00.000Z",
      recipientSummary: { name: "Sam Rivera", city: "Austin", state: "TX" }
    });
  });

  it("takes a draft id in upper case, as PostgreSQL's uuid type does", async () => {
    vi.mocked(getDraft).mockResolvedValue(draft() as any);
    await requestSendTool.handler({ draftId: DRAFT_ID.toUpperCase() }, context());
    expect(getDraft).toHaveBeenCalledWith(DRAFT_ID.toUpperCase());
  });

  it("names a postcard as a postcard", async () => {
    vi.mocked(getDraft).mockResolvedValue(draft({ mail_type: "postcard" }) as any);
    const result = await requestSendTool.handler({ draftId: DRAFT_ID }, context());
    expect(result.mailType).toBe("postcard");
  });

  it("refuses someone else's draft in the words it uses for a missing one", async () => {
    vi.mocked(getDraft).mockResolvedValue(draft({ user_id: "auth0|someone-else" }) as any);
    const theirs = await refusal({ draftId: DRAFT_ID });

    vi.mocked(getDraft).mockResolvedValue(null);
    const missing = await refusal({ draftId: DRAFT_ID });

    expect(theirs).toBeInstanceOf(SendConfirmationRefusedError);
    expect(theirs.code).toBe("DRAFT_NOT_FOUND");
    expect(theirs.message).toBe(missing.message);
    expect(theirs.message).not.toContain(DRAFT_ID);
  });

  it.each([undefined, "", "not-a-uuid", `${DRAFT_ID}x`, 42])(
    "never asks the database about a draft id shaped like %j",
    async (draftId) => {
      const error = await refusal({ draftId });
      expect(error.code).toBe("DRAFT_NOT_FOUND");
      expect(getDraft).not.toHaveBeenCalled();
    }
  );

  it("says a sent draft has gone out", async () => {
    vi.mocked(getDraft).mockResolvedValue(draft({ status: "consumed" }) as any);
    const error = await refusal({ draftId: DRAFT_ID });
    expect(error.code).toBe("DRAFT_ALREADY_SENT");
    expect(error.diagnosticClass).toBe("DRAFT_ALREADY_SENT");
  });

  it.each([
    ["expired", { status: "expired" }],
    ["cancelled", { status: "cancelled" }],
    ["past its time", { expires_at: new Date("2026-09-25T11:59:59Z") }],
    ["at its time", { expires_at: NOW }]
  ])("refuses a draft that is %s", async (_label, overrides) => {
    vi.mocked(getDraft).mockResolvedValue(draft(overrides) as any);
    const error = await refusal({ draftId: DRAFT_ID });
    expect(error.code).toBe("DRAFT_EXPIRED");
  });
});
