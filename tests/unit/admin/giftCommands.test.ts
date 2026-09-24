import { afterEach, describe, expect, it, vi } from "vitest";

import { createGiftCommands } from "../../../src/admin/commands/gifts.js";
import type { AdminSqlClient } from "../../../src/admin/database.js";

/** Operator gift commands (docs/gift-letters.md): seeding and voiding. */

const SEED_ROW = {
  campaign_id: "11111111-1111-4111-8111-111111111111",
  code: "JANE-SMITH",
  name: "Jane",
  description: null,
  credits_amount: 0,
  expiration_policy: "days_from_activation",
  expiration_days: 90,
  fixed_expiration_date: null,
  max_total_redemptions: 200,
  max_per_user: 1,
  current_redemptions: 0,
  starts_at: new Date("2026-09-01T00:00:00Z"),
  ends_at: null,
  requires_new_user: true,
  status: "active",
  gift_generations_remaining: 1,
  created_by: "owner",
  created_at: new Date("2026-09-01T00:00:00Z"),
  updated_at: new Date("2026-09-01T00:00:00Z"),
};

function scripted(overrides: { account?: unknown[]; campaign?: unknown[]; available?: string; code?: unknown[] } = {}) {
  const query = vi.fn(async (text: string, _params?: unknown[]) => {
    if (text.includes("SELECT user_id, updated_at FROM users")) {
      return { rows: overrides.account ?? [{ user_id: "influencer-1", updated_at: new Date("2026-09-17T10:00:00Z") }] };
    }
    if (text.includes("FROM promo_campaigns WHERE code")) return { rows: overrides.campaign ?? [] };
    if (text.includes("COUNT(*) AS count FROM gift_letters")) return { rows: [{ count: overrides.available ?? "0" }] };
    if (text.includes("FROM gift_codes WHERE code")) return { rows: overrides.code ?? [] };
    if (text.includes("UPDATE gift_codes")) return { rows: [{ code: "K7M2QX9A" }] };
    return { rows: [] };
  });
  return { query } as unknown as AdminSqlClient & { query: typeof query };
}

const execution = (client: unknown) => ({
  commandId: "22222222-2222-4222-8222-222222222222",
  idempotencyKey: "admin:22222222-2222-4222-8222-222222222222",
  actorId: "owner@example.com",
  environment: "development" as const,
  reason: "press run",
  client: client as never,
});

afterEach(() => {
  delete process.env.LETTER_IRL_GIFT_OPERATOR_GENERATIONS;
});

describe("gift.grant", () => {
  it("defaults the budget from configuration and refuses out-of-range input", () => {
    const { grant } = createGiftCommands();
    expect(grant.parseInput(new Map([["quantity", "3"]]))).toEqual({ quantity: 3, generationsRemaining: 4, cardCampaignCode: null });
    process.env.LETTER_IRL_GIFT_OPERATOR_GENERATIONS = "2";
    expect(grant.parseInput(new Map([["quantity", "1"]])).generationsRemaining).toBe(2);
    expect(grant.parseInput(new Map([["quantity", "1"], ["generationsRemaining", "0"], ["cardCampaignCode", " jane-smith "]]))).toEqual({
      quantity: 1,
      generationsRemaining: 0,
      cardCampaignCode: "JANE-SMITH",
    });
    for (const fields of [
      [["quantity", "0"]],
      [["quantity", "51"]],
      [["quantity", "1"], ["generationsRemaining", "21"]],
      [["quantity", "1"], ["cardCampaignCode", "no spaces"]],
    ]) {
      expect(() => grant.parseInput(new Map(fields as Array<[string, string]>))).toThrowError(
        expect.objectContaining({ code: "ADMIN_INVALID_REQUEST" }),
      );
    }
  });

  it("states the cost bound in the preview and binds the account version", async () => {
    const { grant } = createGiftCommands();
    const preview = await grant.preview(scripted({ available: "2" }), "influencer-1", { quantity: 5, generationsRemaining: 4, cardCampaignCode: null });
    expect(preview.expectedVersion).toBe("2026-09-17T10:00:00.000Z");
    expect(preview.display).toContainEqual(["Cost bound", "at most 20 further free letters descend from these"]);
    expect(preview.display).toContainEqual(["Gift letters now", "2"]);
  });

  it("only binds a seed campaign, and says the campaign cap is then the bound", async () => {
    const { grant } = createGiftCommands();
    const input = { quantity: 2, generationsRemaining: 0, cardCampaignCode: "JANE-SMITH" };
    await expect(grant.preview(scripted({ campaign: [] }), "influencer-1", input)).rejects.toMatchObject({ code: "ADMIN_INVALID_STATE" });
    await expect(
      grant.preview(scripted({ campaign: [{ ...SEED_ROW, gift_generations_remaining: null }] }), "influencer-1", input),
    ).rejects.toMatchObject({ code: "ADMIN_INVALID_STATE" });
    const preview = await grant.preview(scripted({ campaign: [SEED_ROW] }), "influencer-1", input);
    expect(preview.display).toContainEqual(["Card", "seed code JANE-SMITH"]);
    expect(preview.display).toContainEqual([
      "Cost bound",
      "each letter prints JANE-SMITH, capped by that campaign (200 claims), or its own card while that code does not print (at most 0 further free letters each)",
    ]);
    const uncapped = await grant.preview(scripted({ campaign: [{ ...SEED_ROW, max_total_redemptions: null }] }), "influencer-1", input);
    expect(uncapped.display.find(([label]) => label === "Cost bound")?.[1]).toContain("capped by that campaign (no cap)");
  });

  it("warns before binding letters to a campaign at its cap, which no longer prints its code (#435)", async () => {
    const { grant } = createGiftCommands();
    const atCap = { ...SEED_ROW, max_total_redemptions: 2, current_redemptions: 2 };
    const plain = await grant.preview(scripted({ campaign: [atCap] }), "influencer-1", {
      quantity: 1,
      generationsRemaining: 0,
      cardCampaignCode: "JANE-SMITH",
    });
    const warning = plain.warnings.find((w) => w.includes("claimed as many times as it allows"));
    expect(warning).toBe(
      "JANE-SMITH has been claimed as many times as it allows (2 of 2), so a letter bound to it and sent now prints its own card instead: the plain Letter IRL card.",
    );
    // The Card line agrees with the warning.
    expect(plain.display).toContainEqual(["Card", "seed code JANE-SMITH, not printing now: the plain Letter IRL card instead"]);
    const funded = await grant.preview(scripted({ campaign: [atCap] }), "influencer-1", {
      quantity: 1,
      generationsRemaining: 2,
      cardCampaignCode: "JANE-SMITH",
    });
    expect(funded.warnings.find((w) => w.includes("claimed as many times"))).toContain("a new single-use code");
    expect(funded.display).toContainEqual(["Card", "seed code JANE-SMITH, not printing now: a new single-use code instead"]);

    // Below the cap, and with no cap at all, there is nothing to warn about.
    for (const row of [{ ...SEED_ROW, current_redemptions: 1, max_total_redemptions: 2 }, { ...SEED_ROW, max_total_redemptions: null }]) {
      const preview = await grant.preview(scripted({ campaign: [row] }), "influencer-1", {
        quantity: 1,
        generationsRemaining: 0,
        cardCampaignCode: "JANE-SMITH",
      });
      expect(preview.warnings.some((w) => w.includes("JANE-SMITH"))).toBe(false);
      expect(preview.display).toContainEqual(["Card", "seed code JANE-SMITH"]);
    }
  });

  it("warns the same way for a campaign that is not live, since the send decides by the same rule", async () => {
    const { grant } = createGiftCommands();
    const input = { quantity: 1, generationsRemaining: 0, cardCampaignCode: "JANE-SMITH" };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ status: "paused" }, "JANE-SMITH is paused"],
      [{ status: "draft" }, "JANE-SMITH is still a draft"],
      [{ status: "ended" }, "JANE-SMITH has ended"],
      [{ status: "expired" }, "JANE-SMITH has expired"],
      [{ starts_at: new Date(Date.now() + 86_400_000) }, "JANE-SMITH has not started yet"],
      [{ ends_at: new Date(Date.now() - 1_000) }, "JANE-SMITH is past its end date"],
    ];
    for (const [change, reason] of cases) {
      const preview = await grant.preview(scripted({ campaign: [{ ...SEED_ROW, ...change }] }), "influencer-1", input);
      expect(preview.warnings).toContain(
        `${reason}, so a letter bound to it and sent now prints its own card instead: the plain Letter IRL card.`,
      );
      expect(preview.display).toContainEqual(["Card", "seed code JANE-SMITH, not printing now: the plain Letter IRL card instead"]);
    }
  });

  it("refuses an unknown account", async () => {
    const { grant } = createGiftCommands();
    await expect(grant.preview(scripted({ account: [] }), "nobody", { quantity: 1, generationsRemaining: 1, cardCampaignCode: null })).rejects.toMatchObject({
      code: "ADMIN_NOT_FOUND",
    });
  });

  it("grants as the operator, keyed by the command so a replay grants nothing twice", async () => {
    const grantGiftLettersWithClient = vi.fn(async () => [{ gift_id: "g1" }, { gift_id: "g2" }] as never);
    const { grant } = createGiftCommands({ grantGiftLettersWithClient });
    const client = scripted({ campaign: [SEED_ROW] });
    const input = { quantity: 2, generationsRemaining: 3, cardCampaignCode: "JANE-SMITH" };
    const preview = await grant.preview(client, "influencer-1", input);
    const result = await grant.execute(execution(client), "influencer-1", input, preview);
    expect(result).toEqual({ granted: 2 });
    expect(grantGiftLettersWithClient).toHaveBeenCalledWith(client, {
      userId: "influencer-1",
      quantity: 2,
      generationsRemaining: 3,
      source: "operator",
      sourceReferenceId: "admin:22222222-2222-4222-8222-222222222222",
      cardCampaignId: SEED_ROW.campaign_id,
    });
  });
});

describe("gift.void_code", () => {
  const ISSUED = {
    code: "K7M2QX9A",
    gift_id: "g1",
    letter_id: "letter-1",
    issued_to_user_id: "sender-1",
    grants_generations_remaining: 0,
    status: "issued",
    expires_at: new Date("2026-12-16T00:00:00Z"),
    redeemed_by_user_id: null,
    redeemed_at: null,
    voided_at: null,
    void_reason: null,
    created_at: new Date("2026-09-17T00:00:00Z"),
  };

  it("accepts the code as printed and previews only an issued one", async () => {
    const { voidCode } = createGiftCommands();
    const preview = await voidCode.preview(scripted({ code: [ISSUED] }), "k7m2-qx9a", {});
    expect(preview.targetId).toBe("K7M2QX9A");
    await expect(voidCode.preview(scripted({ code: [{ ...ISSUED, status: "redeemed" }] }), "K7M2QX9A", {})).rejects.toMatchObject({
      code: "ADMIN_INVALID_STATE",
    });
    await expect(voidCode.preview(scripted(), "K7M2QX9A", {})).rejects.toMatchObject({ code: "ADMIN_NOT_FOUND" });
    await expect(voidCode.preview(scripted(), "short", {})).rejects.toMatchObject({ code: "ADMIN_INVALID_REQUEST" });
  });

  it("voids only while still issued, as a class, never prose", async () => {
    const { voidCode } = createGiftCommands();
    const client = scripted({ code: [ISSUED] });
    const preview = await voidCode.preview(client, "K7M2QX9A", {});
    await expect(voidCode.execute(execution(client), "K7M2QX9A", {}, preview)).resolves.toEqual({ code: "K7M2QX9A", status: "void" });
    const update = client.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE gift_codes"));
    expect(String(update?.[0])).toContain("void_reason = 'operator'");
    expect(String(update?.[0])).toContain("AND status = 'issued'");

    const raced = { query: vi.fn(async () => ({ rows: [] })) };
    await expect(voidCode.execute(execution(raced), "K7M2QX9A", {}, preview)).rejects.toMatchObject({ code: "ADMIN_INVALID_STATE" });
  });
});
