import { describe, expect, it, vi } from "vitest";

import { createOpsCommands } from "../../../src/admin/commands/ops.js";
import type { AdminSqlClient } from "../../../src/admin/database.js";

const TIER_ROW = {
  user_id: "auth0|u1",
  tier: "standard",
  tier_override: null,
  updated_at: new Date("2026-09-06T10:00:00.000Z"),
};
const ROUTING_ROWS = [
  { id: 4, mail_type: "postcard", provider: "postgrid", enabled: true, updated_at: new Date("2026-09-06T10:00:00.000Z"), updated_by: null },
];

function scripted(overrides: Partial<Record<"tier" | "routing", unknown[]>> = {}): AdminSqlClient {
  return {
    query: vi.fn(async (text: string) => {
      if (text.includes("FROM users WHERE user_id")) return { rows: overrides.tier ?? [TIER_ROW] };
      if (text.includes("FROM provider_routing")) return { rows: overrides.routing ?? ROUTING_ROWS };
      return { rows: [] };
    }),
  } as unknown as AdminSqlClient;
}

const execution = (client: unknown = {}, environment: "development" | "production" = "development") => ({
  commandId: "22222222-2222-4222-8222-222222222222",
  idempotencyKey: "admin:22222222-2222-4222-8222-222222222222",
  actorId: "owner@example.com",
  environment,
  reason: "support ticket 42",
  client: client as never,
});

describe("tier override command", () => {
  it("accepts the two tiers or clear, refuses a no-op, and writes through the seam", async () => {
    const setTierOverride = vi.fn(async () => undefined);
    const { setTier } = createOpsCommands({ setTierOverride });
    expect(setTier.parseInput(new Map([["tier", "trusted"]]))).toEqual({ tier: "trusted" });
    expect(setTier.parseInput(new Map([["tier", "clear"]]))).toEqual({ tier: "clear" });
    expect(() => setTier.parseInput(new Map([["tier", "vip"]]))).toThrowError(expect.objectContaining({ code: "ADMIN_INVALID_REQUEST" }));
    expect(setTier.verb({ tier: "trusted" })).toBe("SET-TIER-TRUSTED");
    expect(setTier.verb({ tier: "clear" })).toBe("CLEAR-TIER");

    const preview = await setTier.preview(scripted(), "auth0|u1", { tier: "trusted" });
    expect(preview.summary).toEqual({ calculatedTier: "standard", overrideBefore: null, overrideAfter: "trusted" });
    expect(preview.expectedVersion).toBe("2026-09-06T10:00:00.000Z");
    await expect(setTier.preview(scripted(), "auth0|u1", { tier: "clear" })).rejects.toMatchObject({ code: "ADMIN_INVALID_STATE" });
    await expect(setTier.preview(scripted({ tier: [] }), "auth0|x", { tier: "trusted" })).rejects.toMatchObject({ code: "ADMIN_NOT_FOUND" });

    expect(await setTier.execute(execution({}), "auth0|u1", { tier: "trusted" }, preview)).toEqual({ tierOverride: "trusted" });
    expect(setTierOverride).toHaveBeenCalledWith(expect.anything(), "auth0|u1", "trusted");
    expect(await setTier.execute(execution({}), "auth0|u1", { tier: "clear" }, preview)).toEqual({ tierOverride: null });
    expect(setTierOverride).toHaveBeenLastCalledWith(expect.anything(), "auth0|u1", null);
  });
});

describe("routing command", () => {
  it("validates the provider against the registry, refuses no-ops and unknown mail types", async () => {
    const { routing } = createOpsCommands({ listProviders: () => ["postgrid", "dummy", "diy"] });
    expect(routing.parseInput(new Map([["provider", " Dummy "], ["enabled", "on"]]))).toEqual({ provider: "dummy", enabled: true });
    expect(routing.parseInput(new Map([["provider", "diy"]]))).toEqual({ provider: "diy", enabled: false });
    expect(() => routing.parseInput(new Map([["provider", "lob!"]]))).toThrowError(expect.objectContaining({ code: "ADMIN_INVALID_REQUEST" }));

    const preview = await routing.preview(scripted(), "postcard", { provider: "dummy", enabled: true });
    expect(preview.summary).toEqual({ providerBefore: "postgrid", enabledBefore: true, providerAfter: "dummy", enabledAfter: true });
    await expect(routing.preview(scripted(), "postcard", { provider: "lob", enabled: true })).rejects.toMatchObject({ code: "ADMIN_INVALID_REQUEST" });
    await expect(routing.preview(scripted(), "postcard", { provider: "postgrid", enabled: true })).rejects.toMatchObject({ code: "ADMIN_INVALID_STATE" });
    await expect(routing.preview(scripted(), "carrier_pigeon", { provider: "dummy", enabled: true })).rejects.toMatchObject({ code: "ADMIN_NOT_FOUND" });
  });

  it("updates the row against its version and never routes production to the dummy provider", async () => {
    const { routing } = createOpsCommands({ listProviders: () => ["postgrid", "dummy"] });
    const preview = await routing.preview(scripted(), "postcard", { provider: "dummy", enabled: true });
    const client = { query: vi.fn(async () => ({ rowCount: 1, rows: [{ mail_type: "postcard" }] })) };
    expect(await routing.execute(execution(client), "postcard", { provider: "dummy", enabled: true }, preview)).toEqual({ provider: "dummy", enabled: true });
    expect(client.query.mock.calls[0][1]).toEqual(["dummy", true, "owner@example.com", "postcard", "2026-09-06T10:00:00.000Z"]);

    const stale = { query: vi.fn(async () => ({ rowCount: 0, rows: [] })) };
    await expect(routing.execute(execution(stale), "postcard", { provider: "dummy", enabled: true }, preview)).rejects.toMatchObject({ code: "ADMIN_STALE_PREVIEW" });
    await expect(routing.execute(execution(client, "production"), "postcard", { provider: "dummy", enabled: true }, preview)).rejects.toMatchObject({
      code: "ADMIN_INVALID_REQUEST",
    });
  });
});

describe("status sync command", () => {
  it("defaults to a dry run, bounds the window, and summarises the service result", async () => {
    const syncLetterStatuses = vi.fn(async () => ({
      checked: 3,
      updated: 1,
      errors: 0,
      details: [{ letterId: "letter_1", trackingId: "trk", oldStatus: "accepted", newStatus: "in_transit", providerRawStatus: "in_transit" }],
    }));
    const { statusSync } = createOpsCommands({ syncLetterStatuses });
    expect(statusSync.parseInput(new Map())).toEqual({ dryRun: true, days: 30 });
    expect(statusSync.parseInput(new Map([["dryRun", "off"], ["days", "7"]]))).toEqual({ dryRun: false, days: 7 });
    expect(() => statusSync.parseInput(new Map([["days", "91"]]))).toThrowError(expect.objectContaining({ code: "ADMIN_INVALID_REQUEST" }));
    const preview = await statusSync.preview(scripted(), "letters", { dryRun: false, days: 7 });
    expect(preview.display[1][1]).toContain("apply");
    await expect(statusSync.preview(scripted(), "other", { dryRun: true, days: 7 })).rejects.toMatchObject({ code: "ADMIN_NOT_FOUND" });
    const result = await statusSync.execute(execution(null), "letters", { dryRun: false, days: 7 }, preview);
    expect(syncLetterStatuses).toHaveBeenCalledWith(false, 7);
    expect(result).toEqual({
      dryRun: false,
      checked: 3,
      updated: 1,
      errors: 0,
      changes: [{ letterId: "letter_1", from: "accepted", to: "in_transit", error: null }],
    });
  });
});
