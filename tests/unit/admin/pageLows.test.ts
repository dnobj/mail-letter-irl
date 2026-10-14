import { describe, expect, it } from "vitest";

import { renderCommandPreview } from "../../../src/admin/pages/commands.js";
import { accountGiftPanel, renderGifts } from "../../../src/admin/pages/gifts.js";
import type { GiftCodeView } from "../../../src/admin/queries/gifts.js";

/**
 * Two admin page Lows (#730): a preview shows every value its link carries
 * into the confirmation, and an issued gift code is never on a page in full.
 */

function preview(hiddenFields: Array<[string, string]>) {
  return String(
    renderCommandPreview({
      title: "Adjust balance",
      commandName: "account.adjust_balance",
      targetId: "auth0|user1",
      preview: { targetId: "auth0|user1", summary: {}, display: [["Account", "auth0|user1"]], warnings: [], expectedVersion: "v1" } as never,
      previewDigest: "d".repeat(64),
      idempotencyKey: "admin:1",
      phrase: "CONFIRM auth0|user1",
      hiddenFields,
      csrfToken: "t".repeat(64),
      mode: "full",
      elevated: true,
      environment: "development",
      backHref: "/accounts/auth0%7Cuser1",
    }),
  );
}

describe("a command preview", () => {
  it("shows every value its link carries, not only the hidden field", () => {
    const page = preview([["amount", "999"], ["note", "from a link"]]);
    expect(page).toContain("Values sent with this command");
    // Shown as text, once in the list and once in the form's hidden field.
    expect(page.match(/999/g)?.length).toBe(2);
    expect(page).toMatch(/<dt>amount<\/dt>\s*<dd>999<\/dd>/);
    expect(page).toMatch(/<dt>note<\/dt>\s*<dd>from a link<\/dd>/);
  });

  it("shows a carried value as text, never as markup", () => {
    const page = preview([["note", '<script>alert("x")</script>']]);
    expect(page).not.toContain("<script>");
    expect(page).toContain("&lt;script&gt;");
  });

  it("adds nothing when the link carries no values", () => {
    expect(preview([])).not.toContain("Values sent with this command");
  });
});

const CODE: GiftCodeView = {
  code: "K7M2QX9A",
  giftId: "g1",
  letterId: "letter-1",
  issuedToUserId: "sender-1",
  grantsGenerationsRemaining: 0,
  status: "issued",
  expiresAt: new Date("2026-12-16T00:00:00Z"),
  redeemedByUserId: null,
  redeemedAt: null,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date("2026-09-17T00:00:00Z"),
} as GiftCodeView;

describe("gift codes on the panel", () => {
  it("masks an issued code, and names its letter on the void button", () => {
    const page = String(renderGifts({ totals: { available: 0, sentToday: 0, codesIssued: 1, codesRedeemed: 0 }, codes: [CODE], mode: "full" }));
    expect(page).not.toContain("K7M2");
    expect(page).toContain("••••-••9A");
    expect(page).toContain('name="target" value="letter:letter-1"');
  });

  it("masks it on an account's page too", () => {
    const page = String(accountGiftPanel({ userId: "sender-1", letters: [], codes: [CODE], defaultGenerations: 2, mode: "full" }));
    expect(page).not.toContain("K7M2");
    expect(page).toContain('name="target" value="letter:letter-1"');
  });

  it("shows a redeemed or void code in full: it is spent", () => {
    for (const status of ["redeemed", "void"]) {
      const page = String(renderGifts({ totals: { available: 0, sentToday: 0, codesIssued: 0, codesRedeemed: 1 }, codes: [{ ...CODE, status } as GiftCodeView], mode: "full" }));
      expect(page, status).toContain("K7M2-QX9A");
    }
  });
});
