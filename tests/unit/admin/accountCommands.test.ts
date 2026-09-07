import { describe, expect, it, vi } from "vitest";

import { createAccountCommands } from "../../../src/admin/commands/accounts.js";
import { createImageCommands } from "../../../src/admin/commands/images.js";
import { createPromoCommands } from "../../../src/admin/commands/promos.js";
import type { AdminSqlClient } from "../../../src/admin/database.js";

/**
 * The slice-4 commands over scripted clients: what they validate, what the
 * previews refuse, and what they hand the services. The PostgreSQL suite
 * proves the services themselves.
 */

const ACCOUNT_ROW = {
  user_id: "auth0|u1",
  credits: 4,
  credits_purchased: 6,
  sends_blocked_at: new Date("2026-09-01T00:00:00.000Z"),
  sends_blocked_reason: "payment_disputed",
  updated_at: new Date("2026-09-06T10:00:00.000Z"),
  ledger_available: 4,
};
const QUOTA_ROW = { allowance: "3", used: "1", remaining: "2", active: "1" };
const ORDER_ROW = {
  order_id: "order_1",
  user_id: "auth0|u1",
  order_type: "letter_pack",
  status: "refund_pending",
  credits: 4,
  amount_cents: 1999,
  amount_known: true,
  currency: "usd",
  stripe_checkout_session_id: "cs_test_1",
  stripe_payment_intent_id: "pi_test_1",
  last_error_code: "PAYMENT_AMOUNT_MISMATCH",
  updated_at: new Date("2026-09-06T10:00:00.000Z"),
};
const CAMPAIGN_ROW = {
  campaign_id: "33333333-3333-4333-8333-333333333333",
  code: "WELCOME10",
  name: "Welcome",
  description: null,
  credits_amount: 2,
  expiration_policy: "days_from_activation",
  expiration_days: 90,
  fixed_expiration_date: null,
  max_total_redemptions: null,
  max_per_user: 1,
  current_redemptions: 0,
  starts_at: new Date("2026-09-01T00:00:00.000Z"),
  ends_at: null,
  requires_new_user: false,
  status: "draft",
  created_by: null,
  created_at: new Date("2026-09-01T00:00:00.000Z"),
  updated_at: new Date("2026-09-06T10:00:00.000Z"),
};

function scripted(overrides: Partial<Record<"account" | "quota" | "order" | "campaign" | "campaignByCode" | "reservation", unknown[]>> = {}): AdminSqlClient {
  const query = vi.fn(async (text: string) => {
    if (text.includes("FROM users u WHERE u.user_id")) return { rows: overrides.account ?? [ACCOUNT_ROW] };
    if (text.includes("FROM image_entitlements WHERE user_id")) return { rows: overrides.quota ?? [QUOTA_ROW] };
    if (text.includes("FROM orders WHERE order_id")) return { rows: overrides.order ?? [ORDER_ROW] };
    if (text.includes("FROM promo_campaigns WHERE code")) return { rows: overrides.campaignByCode ?? [] };
    if (text.includes("FROM promo_campaigns WHERE campaign_id")) return { rows: overrides.campaign ?? [CAMPAIGN_ROW] };
    if (text.includes("FROM image_generation_reservations WHERE reservation_id")) return { rows: overrides.reservation ?? [] };
    return { rows: [] };
  });
  return { query } as unknown as AdminSqlClient;
}

const execution = (client: unknown = {}) => ({
  commandId: "22222222-2222-4222-8222-222222222222",
  idempotencyKey: "admin:22222222-2222-4222-8222-222222222222",
  actorId: "owner@example.com",
  environment: "development" as const,
  reason: "support ticket 42",
  client: client as never,
});

describe("account commands", () => {
  function harness() {
    const calls: Record<string, unknown[]> = { lift: [], release: [], adjust: [], grant: [] };
    const seams = {
      liftSendBlock: vi.fn(async (_client: unknown, userId: string) => {
        calls.lift.push(userId);
        return "lifted" as const;
      }),
      countStandingDisputes: vi.fn(async () => 0),
      releaseAmountMismatchQuarantine: vi.fn(async (_client: unknown, orderId: string, reason: string) => {
        calls.release.push([orderId, reason]);
        return "released" as const;
      }),
      adjustCreditsWithClient: vi.fn(async (_client: unknown, userId: string, amount: number, reason: string) => {
        calls.adjust.push([userId, amount, reason]);
        return { user: { credits: 4 + amount } as never, transaction: { transaction_id: 7 } as never };
      }),
      grantOperatorImageEntitlement: vi.fn(async (_client: unknown, params: unknown) => {
        calls.grant.push(params);
        return { entitlement_id: "ent-1" } as never;
      }),
    };
    return { calls, seams, commands: createAccountCommands(seams) };
  }

  it("previews lifting a block with the standing-dispute warning and refuses an unblocked account", async () => {
    const { seams, commands } = harness();
    seams.countStandingDisputes.mockResolvedValueOnce(1);
    const preview = await commands.unblockSends.preview(scripted(), "auth0|u1", {});
    expect(preview.summary).toMatchObject({ sendsBlockedReason: "payment_disputed", standingDisputes: 1 });
    expect(preview.warnings[0]).toContain("will refuse");
    await expect(
      commands.unblockSends.preview(scripted({ account: [{ ...ACCOUNT_ROW, sends_blocked_at: null }] }), "auth0|u1", {}),
    ).rejects.toMatchObject({ code: "ADMIN_INVALID_STATE" });
    await expect(commands.unblockSends.preview(scripted({ account: [] }), "auth0|x", {})).rejects.toMatchObject({ code: "ADMIN_NOT_FOUND" });
  });

  it("turns a refused lift into an invalid-state error and requires the operator client", async () => {
    const { seams, commands } = harness();
    seams.liftSendBlock.mockResolvedValueOnce("dispute_standing");
    await expect(commands.unblockSends.execute(execution({}), "auth0|u1", {}, { targetId: "auth0|u1", summary: {}, display: [], warnings: [] })).rejects.toMatchObject({
      code: "ADMIN_INVALID_STATE",
    });
    await expect(commands.unblockSends.execute(execution(null), "auth0|u1", {}, { targetId: "auth0|u1", summary: {}, display: [], warnings: [] })).rejects.toMatchObject({
      code: "ADMIN_INTERNAL_ERROR",
    });
  });

  it("adjusts in letters, refuses removing more than the ledger holds, and prefixes the reason", async () => {
    const { calls, commands } = harness();
    expect(commands.adjustBalance.parseInput(new Map([["letters", "2"], ["direction", "add"]]))).toEqual({ letters: 2, direction: "add" });
    expect(() => commands.adjustBalance.parseInput(new Map([["letters", "0"], ["direction", "add"]]))).toThrowError(expect.objectContaining({ code: "ADMIN_INVALID_REQUEST" }));
    expect(() => commands.adjustBalance.parseInput(new Map([["letters", "2"], ["direction", "steal"]]))).toThrowError(expect.objectContaining({ code: "ADMIN_INVALID_REQUEST" }));

    const preview = await commands.adjustBalance.preview(scripted(), "auth0|u1", { letters: 2, direction: "remove" });
    expect(preview.summary).toMatchObject({ credits: 4, creditsBefore: 4, creditsAfter: 0 });
    await expect(commands.adjustBalance.preview(scripted(), "auth0|u1", { letters: 3, direction: "remove" })).rejects.toMatchObject({ code: "ADMIN_INVALID_STATE" });
    await expect(
      commands.adjustBalance.preview(scripted({ account: [{ ...ACCOUNT_ROW, ledger_available: 0 }] }), "auth0|u1", { letters: 1, direction: "remove" }),
    ).rejects.toMatchObject({ code: "ADMIN_INVALID_STATE" });

    const result = await commands.adjustBalance.execute(execution({}), "auth0|u1", { letters: 2, direction: "remove" }, preview);
    expect(result).toEqual({ creditsAfter: 0, transactionId: 7 });
    expect(calls.adjust).toEqual([["auth0|u1", -4, "Operator adjustment: support ticket 42"]]);
    expect(commands.adjustBalance.verb({ letters: 1, direction: "add" })).toBe("ADD-LETTERS");
  });

  it("grants images against the command id so a replay cannot grant twice", async () => {
    const { calls, commands } = harness();
    const preview = await commands.grantImages.preview(scripted(), "auth0|u1", { quantity: 3 });
    expect(preview.summary).toMatchObject({ quantity: 3, allowanceBefore: 3, remainingBefore: 2 });
    const result = await commands.grantImages.execute(execution({}), "auth0|u1", { quantity: 3 }, preview);
    expect(result).toEqual({ entitlementId: "ent-1", granted: true });
    expect(calls.grant).toEqual([{ userId: "auth0|u1", quantity: 3, reference: "admin:22222222-2222-4222-8222-222222222222" }]);
    expect(() => commands.grantImages.parseInput(new Map([["quantity", "51"]]))).toThrowError(expect.objectContaining({ code: "ADMIN_INVALID_REQUEST" }));
  });

  it("releases a quarantine only while the order carries the mismatch code", async () => {
    const { calls, commands } = harness();
    const preview = await commands.releaseQuarantine.preview(scripted(), "order_1", {});
    expect(preview.summary).toMatchObject({ status: "refund_pending", lastErrorCode: "PAYMENT_AMOUNT_MISMATCH" });
    await expect(
      commands.releaseQuarantine.preview(scripted({ order: [{ ...ORDER_ROW, last_error_code: null }] }), "order_1", {}),
    ).rejects.toMatchObject({ code: "ADMIN_INVALID_STATE" });
    await commands.releaseQuarantine.execute(execution({}), "order_1", {}, preview);
    expect(calls.release).toEqual([["order_1", "support ticket 42"]]);
  });
});

describe("promo commands", () => {
  function harness() {
    const seams = {
      createCampaignWithClient: vi.fn(async (_client: unknown, params: { code: string }) => ({ campaign_id: "new-id", code: params.code, status: "draft" }) as never),
      transitionCampaignStatusWithClient: vi.fn(async (_client: unknown, params: { status: string }) => ({ status: params.status }) as never),
      deleteCampaignWithClient: vi.fn(async () => undefined),
    };
    return { seams, commands: createPromoCommands(seams) };
  }

  it("normalises and validates a new campaign, and refuses an existing code", async () => {
    const { seams, commands } = harness();
    const input = commands.create.parseInput(
      new Map([
        ["code", " welcome10 "],
        ["name", "Welcome"],
        ["creditsAmount", "2"],
        ["expirationDays", ""],
        ["maxTotalRedemptions", ""],
        ["maxPerUser", ""],
        ["requiresNewUser", "on"],
        ["endsAt", "2026-12-31"],
      ]),
    );
    expect(input).toEqual({
      code: "WELCOME10",
      name: "Welcome",
      description: null,
      creditsAmount: 2,
      expirationDays: 90,
      maxTotalRedemptions: null,
      maxPerUser: 1,
      requiresNewUser: true,
      endsAt: "2026-12-31",
    });
    expect(() => commands.create.parseInput(new Map([["code", "no spaces here"], ["name", "x"], ["creditsAmount", "2"]]))).toThrowError(
      expect.objectContaining({ code: "ADMIN_INVALID_REQUEST" }),
    );
    expect(() => commands.create.parseInput(new Map([["code", "OK"], ["name", "x"], ["creditsAmount", "2"], ["endsAt", "not-a-date"]]))).toThrowError(
      expect.objectContaining({ code: "ADMIN_INVALID_REQUEST" }),
    );
    await expect(commands.create.preview(scripted({ campaignByCode: [CAMPAIGN_ROW] }), "WELCOME10", input)).rejects.toMatchObject({ code: "ADMIN_INVALID_STATE" });
    await expect(commands.create.preview(scripted(), "OTHER", input)).rejects.toMatchObject({ code: "ADMIN_INVALID_REQUEST" });
    const preview = await commands.create.preview(scripted(), "WELCOME10", input);
    expect(preview.expectedVersion).toBeUndefined();
    await commands.create.execute(execution({}), "WELCOME10", input, preview);
    expect(seams.createCampaignWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "WELCOME10", createdBy: "owner@example.com", requiresNewUser: true }));
  });

  it("allows only the documented status transitions and binds the campaign version", async () => {
    const { seams, commands } = harness();
    expect(() => commands.transition.parseInput(new Map([["status", "expired"]]))).toThrowError(expect.objectContaining({ code: "ADMIN_INVALID_REQUEST" }));
    const preview = await commands.transition.preview(scripted(), CAMPAIGN_ROW.campaign_id, { status: "active" });
    expect(preview.expectedVersion).toBe("2026-09-06T10:00:00.000Z");
    await expect(commands.transition.preview(scripted(), CAMPAIGN_ROW.campaign_id, { status: "paused" })).rejects.toMatchObject({ code: "ADMIN_INVALID_STATE" });
    await commands.transition.execute(execution({}), CAMPAIGN_ROW.campaign_id, { status: "active" }, preview);
    expect(seams.transitionCampaignStatusWithClient).toHaveBeenCalledWith(expect.anything(), {
      campaignId: CAMPAIGN_ROW.campaign_id,
      status: "active",
      expectedUpdatedAt: "2026-09-06T10:00:00.000Z",
    });
    seams.transitionCampaignStatusWithClient.mockRejectedValueOnce(new Error("stale"));
    await expect(commands.transition.execute(execution({}), CAMPAIGN_ROW.campaign_id, { status: "active" }, preview)).rejects.toMatchObject({ code: "ADMIN_STALE_PREVIEW" });
  });

  it("refuses to delete a redeemed campaign at preview time", async () => {
    const { commands } = harness();
    await expect(
      commands.remove.preview(scripted({ campaign: [{ ...CAMPAIGN_ROW, current_redemptions: 2 }] }), CAMPAIGN_ROW.campaign_id, {}),
    ).rejects.toMatchObject({ code: "ADMIN_INVALID_STATE" });
    const preview = await commands.remove.preview(scripted(), CAMPAIGN_ROW.campaign_id, {});
    expect(preview.summary).toMatchObject({ code: "WELCOME10", redemptions: 0 });
  });
});

describe("image reservation command", () => {
  it("accepts only the documented decision and resolution pairs and forwards the service's verdict", async () => {
    const resolve = vi.fn(async () => ({ resultingStatus: "released" as const, replayed: false }) as never);
    const { resolve: command } = createImageCommands({ resolveAmbiguousGenerationReservation: resolve });
    expect(command.parseInput(new Map([["decision", "consume"], ["resolution", "provider_confirmed_succeeded"]]))).toEqual({
      decision: "consume",
      resolution: "provider_confirmed_succeeded",
    });
    expect(() => command.parseInput(new Map([["decision", "consume"], ["resolution", "customer_compensation"]]))).toThrowError(
      expect.objectContaining({ code: "ADMIN_INVALID_REQUEST" }),
    );
    const reservation = {
      reservation_id: "44444444-4444-4444-8444-444444444444",
      entitlement_id: "55555555-5555-4555-8555-555555555555",
      user_id: "auth0|u1",
      status: "ambiguous",
      has_provider_request_id: true,
      resolution_reason: "ambiguous_after_dispatch",
      dispatch_started_at: new Date("2026-09-06T09:00:00.000Z"),
      provider_completed_at: null,
      lease_expires_at: null,
      completed_at: null,
      created_at: new Date("2026-09-06T09:00:00.000Z"),
      updated_at: new Date("2026-09-06T09:30:00.000Z"),
    };
    const input = { decision: "release" as const, resolution: "customer_compensation" as const };
    const preview = await command.preview(scripted({ reservation: [reservation] }), reservation.reservation_id, input);
    expect(preview.summary).toMatchObject({ userId: "auth0|u1", decision: "release", resolution: "customer_compensation" });
    await expect(
      command.preview(scripted({ reservation: [{ ...reservation, status: "consumed" }] }), reservation.reservation_id, input),
    ).rejects.toMatchObject({ code: "ADMIN_INVALID_STATE" });
    const result = await command.execute(execution(null), reservation.reservation_id, input, preview);
    expect(result).toEqual({ resultingStatus: "released", domainReplayed: false });
    expect(resolve).toHaveBeenCalledWith({
      reservationId: reservation.reservation_id,
      expectedUserId: "auth0|u1",
      actorId: "owner@example.com",
      idempotencyKey: "admin:22222222-2222-4222-8222-222222222222",
      decision: "release",
      resolution: "customer_compensation",
    });
  });
});
