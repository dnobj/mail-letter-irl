import { describe, expect, it, vi } from "vitest";

import { createLimitCommands, formatLimitValue, storedValue } from "../../../src/admin/commands/limits.js";
import type { AdminSqlClient } from "../../../src/admin/database.js";
import { AdminFoundationError } from "../../../src/admin/errors.js";
import { renderLimits } from "../../../src/admin/pages/limits.js";

/**
 * The daily limits' operator control (migration 038): limit.set and
 * limit.clear, and the Limits page. The real grants and rows are exercised by
 * tests/integration/adminCommands.postgres.test.ts.
 */

const OVERRIDE_ID = "33333333-3333-4333-8333-333333333333";
const UPDATED = new Date("2026-09-28T10:00:00.123Z");

interface Script {
  account?: boolean;
  current?: unknown[];
  byId?: unknown[];
  defaults?: unknown[];
  use?: { letters: string; gift_letters: string };
  accountUse?: { letters: string; charge_cents: string };
  cleared?: unknown[];
  inserted?: unknown[];
}

function scripted(script: Script = {}) {
  const query = vi.fn(async (text: string, _params?: unknown[]) => {
    if (text.includes("FROM users WHERE user_id")) return { rows: [{ found: script.account ?? true }] };
    if (text.includes("FROM daily_limit_overrides") && text.includes("override_id = $1::uuid")) return { rows: script.byId ?? [] };
    if (text.includes("FROM daily_limit_overrides")) return { rows: script.current ?? [] };
    if (text.includes("FROM daily_limit_defaults")) return { rows: script.defaults ?? [] };
    if (text.includes("FILTER (WHERE funding_type")) return { rows: [script.use ?? { letters: "0", gift_letters: "0" }] };
    if (text.includes("charge_cents")) return { rows: [script.accountUse ?? { letters: "0", charge_cents: "0" }] };
    if (text.startsWith("UPDATE daily_limit_overrides") || text.includes("UPDATE daily_limit_overrides")) {
      return { rows: script.cleared ?? [] };
    }
    if (text.includes("INSERT INTO daily_limit_overrides")) {
      return { rows: script.inserted ?? [{ override_id: OVERRIDE_ID, expires_at: null }] };
    }
    return { rows: [] };
  });
  return { query } as unknown as AdminSqlClient & { query: typeof query };
}

const execution = (client: unknown) => ({
  commandId: "22222222-2222-4222-8222-222222222222",
  idempotencyKey: "admin:22222222-2222-4222-8222-222222222222",
  actorId: "owner@example.com",
  environment: "development" as const,
  reason: "raising for the launch",
  client: client as never,
});

const fields = (entries: Record<string, string>) => new Map(Object.entries(entries));

function currentRow(overrides: Record<string, unknown> = {}) {
  return {
    override_id: OVERRIDE_ID,
    limit_key: "account_daily_mail",
    user_id: null,
    value: 40,
    expires_at: null,
    expired: false,
    created_at: new Date("2026-09-28T09:00:00Z"),
    updated_at: UPDATED,
    ...overrides,
  };
}

async function refused(promise: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    expect(error).toBeInstanceOf(AdminFoundationError);
    expect((error as AdminFoundationError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("limit.set input", () => {
  const { set } = createLimitCommands();

  it("reads the amount, the account and the duration", () => {
    expect(set.parseInput(fields({ amount: "40", account: "", duration: "today" }))).toEqual({
      amount: 40,
      userId: null,
      duration: "today",
    });
    expect(set.parseInput(fields({ amount: "0", account: " auth0|u1 ", duration: "until_cleared" }))).toEqual({
      amount: 0,
      userId: "auth0|u1",
      duration: "until_cleared",
    });
  });

  it("refuses an amount that is not a whole number in range, and an unknown duration", async () => {
    for (const bad of ["", "-1", "1.5", "1e3", "abc", "1000001", "99999999"]) {
      await refused(() => set.parseInput(fields({ amount: bad, duration: "today" })), "ADMIN_INVALID_REQUEST");
    }
    await refused(() => set.parseInput(fields({ amount: "5", duration: "forever" })), "ADMIN_INVALID_REQUEST");
    await refused(() => set.parseInput(fields({ amount: "5", account: "x".repeat(256), duration: "today" })), "ADMIN_INVALID_REQUEST");
  });

  it("takes the limit from the form's own field", () => {
    expect(set.targetFromFields!(fields({ limit: " global_daily_mail " }))).toBe("global_daily_mail");
  });

  it("stores dollars as cents, and letters as they are", () => {
    expect(storedValue("account_daily_charge_cents", 200)).toBe(20000);
    expect(storedValue("account_daily_mail", 25)).toBe(25);
    expect(formatLimitValue("account_daily_charge_cents", 20000)).toBe("$200.00");
    expect(formatLimitValue("global_daily_mail", 1)).toBe("1 letter");
  });
});

describe("limit.set preview", () => {
  const { set } = createLimitCommands();

  it("refuses an unknown limit, an account on a limit for everyone, and an unknown account", async () => {
    const input = { amount: 5, userId: null, duration: "today" as const };
    await refused(set.preview(scripted(), "mystery", input), "ADMIN_INVALID_REQUEST");
    await refused(set.preview(scripted(), "global_daily_mail", { ...input, userId: "auth0|u1" }), "ADMIN_INVALID_REQUEST");
    await refused(set.preview(scripted({ account: false }), "account_daily_mail", { ...input, userId: "auth0|nobody" }), "ADMIN_NOT_FOUND");
  });

  it("signs the change and what it replaces, not today's moving use", async () => {
    const client = scripted({
      current: [currentRow()],
      defaults: [{ limit_key: "account_daily_mail", value: 25, reported_at: new Date("2026-09-28T08:00:00Z") }],
    });
    const preview = await set.preview(client, "account_daily_mail", { amount: 60, userId: null, duration: "until_cleared" });
    expect(preview.targetId).toBe("account_daily_mail");
    expect(preview.summary).toEqual({
      limitKey: "account_daily_mail",
      scope: "everyone",
      value: 60,
      duration: "until_cleared",
      current: { overrideId: OVERRIDE_ID, value: 40, expiresAt: null },
      configured: 25,
    });
    expect(preview.expectedVersion).toBe(UPDATED.toISOString());
    expect(preview.warnings.join(" ")).toContain("This replaces the value set before: 40 letters, until cleared.");
  });

  it("shows an account's use, and warns when the new value is already met", async () => {
    const client = scripted({ accountUse: { letters: "0", charge_cents: "15000" } });
    const preview = await set.preview(client, "account_daily_charge_cents", { amount: 100, userId: "auth0|u1", duration: "today" });
    expect(preview.summary.value).toBe(10000);
    expect(preview.summary.scope).toBe("auth0|u1");
    expect(preview.display).toContainEqual(["Used today", "$150.00"]);
    expect(preview.warnings.join(" ")).toContain("already meets the new value");
    expect(preview.warnings.join(" ")).toContain("lapses at midnight UTC");
    expect(preview.expectedVersion).toBeUndefined();
  });

  it("warns that 0 stops everything the limit covers, and about a tenfold raise", async () => {
    const zero = await set.preview(scripted(), "global_daily_mail", { amount: 0, userId: null, duration: "today" });
    expect(zero.warnings.join(" ")).toContain("0 refuses everything");
    const big = await set.preview(
      scripted({ defaults: [{ limit_key: "global_daily_mail", value: 100, reported_at: new Date() }] }),
      "global_daily_mail",
      { amount: 1001, userId: null, duration: "until_cleared" },
    );
    expect(big.warnings.join(" ")).toContain("more than ten times");
  });

  it("counts gift letters for the gift limit, and says a per-account limit needs an account for its use", async () => {
    const gifts = await set.preview(scripted({ use: { letters: "50", gift_letters: "7" } }), "gift_daily_send", {
      amount: 30,
      userId: null,
      duration: "today",
    });
    expect(gifts.display).toContainEqual(["Used today", "7 letters"]);
    const perAccount = await set.preview(scripted(), "account_daily_mail", { amount: 30, userId: null, duration: "today" });
    expect(perAccount.display).toContainEqual(["Used today", "per account; name an account to see its use"]);
  });
});

describe("limit.set execute", () => {
  const { set } = createLimitCommands();
  const input = { amount: 60, userId: null, duration: "today" as const };

  it("clears the value it replaces, then writes the new one, lapsing at midnight UTC", async () => {
    const client = scripted({ cleared: [{ override_id: OVERRIDE_ID }] });
    const preview = { summary: { current: { overrideId: OVERRIDE_ID } } } as never;
    const result = await set.execute(execution(client), "account_daily_mail", input, preview);
    expect(result).toMatchObject({ overrideId: OVERRIDE_ID, limitKey: "account_daily_mail", value: 60 });
    const [update, insert] = client.query.mock.calls;
    expect(String(update[0])).toContain("SET cleared_at = NOW(), cleared_by_command_id = $3::text");
    expect(update[1]).toEqual(["account_daily_mail", null, "22222222-2222-4222-8222-222222222222"]);
    expect(String(insert[0])).toContain("(date_trunc('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day') AT TIME ZONE 'UTC'");
    expect(insert[1]).toEqual(["account_daily_mail", null, 60, "today", "22222222-2222-4222-8222-222222222222"]);
  });

  it("refuses as stale when the value it would replace is not the one previewed", async () => {
    const preview = { summary: { current: null } } as never;
    await refused(
      set.execute(execution(scripted({ cleared: [{ override_id: OVERRIDE_ID }] })), "account_daily_mail", input, preview),
      "ADMIN_STALE_PREVIEW",
    );
    const previewed = { summary: { current: { overrideId: OVERRIDE_ID } } } as never;
    await refused(set.execute(execution(scripted({ cleared: [] })), "account_daily_mail", input, previewed), "ADMIN_STALE_PREVIEW");
  });

  it("stores the money limit in cents", async () => {
    const client = scripted();
    await set.execute(execution(client), "account_daily_charge_cents", { amount: 250, userId: "auth0|u1", duration: "until_cleared" }, {
      summary: { current: null },
    } as never);
    const insert = client.query.mock.calls.find((call) => String(call[0]).includes("INSERT INTO daily_limit_overrides"));
    expect(insert![1]).toEqual(["account_daily_charge_cents", "auth0|u1", 25000, "until_cleared", "22222222-2222-4222-8222-222222222222"]);
  });

  it("needs the operator's transaction", async () => {
    await refused(set.execute(execution(null), "account_daily_mail", input, { summary: { current: null } } as never), "ADMIN_INTERNAL_ERROR");
  });
});

describe("limit.clear", () => {
  const { clear } = createLimitCommands();

  it("refuses a target that is not an id, one that does not exist, and one already cleared", async () => {
    await refused(clear.preview(scripted(), "not-a-uuid", {}), "ADMIN_INVALID_REQUEST");
    await refused(clear.preview(scripted({ byId: [] }), OVERRIDE_ID, {}), "ADMIN_NOT_FOUND");
    await refused(clear.preview(scripted({ byId: [{ ...currentRow(), cleared: true }] }), OVERRIDE_ID, {}), "ADMIN_INVALID_STATE");
  });

  it("signs the value being cleared and its version", async () => {
    const preview = await clear.preview(scripted({ byId: [{ ...currentRow({ user_id: "auth0|u1" }), cleared: false }] }), OVERRIDE_ID, {});
    expect(preview.summary).toEqual({
      overrideId: OVERRIDE_ID,
      limitKey: "account_daily_mail",
      scope: "auth0|u1",
      value: 40,
      expiresAt: null,
    });
    expect(preview.expectedVersion).toBe(UPDATED.toISOString());
    expect(preview.warnings.join(" ")).toContain("This account returns to the value set for everyone");
  });

  it("stamps the row cleared, and refuses one cleared meanwhile", async () => {
    const client = scripted({ cleared: [{ override_id: OVERRIDE_ID }] });
    expect(await clear.execute(execution(client), OVERRIDE_ID, {}, {} as never)).toEqual({ overrideId: OVERRIDE_ID, cleared: true });
    expect(client.query.mock.calls[0][1]).toEqual([OVERRIDE_ID, "22222222-2222-4222-8222-222222222222"]);
    await refused(clear.execute(execution(scripted({ cleared: [] })), OVERRIDE_ID, {}, {} as never), "ADMIN_INVALID_STATE");
  });
});

describe("the Limits page", () => {
  const baseData = {
    defaults: new Map([["global_daily_mail" as const, { value: 100, reportedAt: new Date("2026-09-28T08:00:00Z") }]]),
    overrides: [],
    refusals: new Map(),
    use: { letters: 12, giftLetters: 2 },
    mode: "full",
  };

  it("names every limit and its variable, with a set form whose fields limit.set reads", () => {
    const page = String(renderLimits(baseData));
    for (const variable of [
      "LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING",
      "LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP",
      "LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS",
      "LETTER_IRL_GIFT_DAILY_SEND_CAP",
    ]) {
      expect(page).toContain(variable);
    }
    expect(page).toContain('action="/commands/limit.set/preview"');
    for (const name of ['name="limit"', 'name="amount"', 'name="account"', 'name="duration"']) expect(page).toContain(name);
    expect(page).toContain("12 letters");
    expect(page).toContain("not reported yet");
  });

  it("shows a value set for everyone as in force, an account's with a link, and a clear button for each", () => {
    const page = String(
      renderLimits({
        ...baseData,
        overrides: [
          {
            overrideId: OVERRIDE_ID,
            limitKey: "global_daily_mail",
            userId: null,
            value: 200,
            expiresAt: null,
            expired: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            overrideId: "44444444-4444-4444-8444-444444444444",
            limitKey: "account_daily_charge_cents",
            userId: "auth0|<b>u1</b>",
            value: 50000,
            expiresAt: new Date("2026-09-29T00:00:00Z"),
            expired: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        refusals: new Map([["global_daily_mail", { refusals: 3, firstRefusedAt: new Date(), lastRefusedAt: new Date() }]]),
      }),
    );
    expect(page).toContain("<strong>200 letters</strong>");
    expect(page).toContain("$500.00");
    expect(page).toContain(`value="${OVERRIDE_ID}"`);
    expect(page).toContain('action="/commands/limit.clear/preview"');
    expect(page).toContain("<strong>3</strong>");
    // An account id is data, never markup.
    expect(page).not.toContain("<b>u1</b>");
  });
});
