import {
  ACCOUNT_DAILY_LIMIT_KEYS,
  DAILY_LIMIT_LABELS,
  isDailyLimitKey,
  type DailyLimitKey,
} from "../../services/dailyLimits.js";
import { AdminFoundationError } from "../errors.js";
import {
  accountExists,
  readAccountUseToday,
  readLimitDefaults,
  readOverrideById,
  readTodayUse,
  readUnclearedOverride,
  type LimitOverrideView,
} from "../queries/limits.js";
import type { CommandDefinition } from "./runner.js";

/**
 * The daily limits' operator control (migration 038): set a limit's value in
 * force, for everyone or one account, for the rest of the UTC day or until
 * cleared; and clear such a value. The API reads the table on every check,
 * so a change takes effect on the next send or checkout, with no redeploy.
 */

export type LimitDuration = "today" | "until_cleared";

export interface SetLimitInput {
  /** In the limit's own unit as the operator typed it: letters, or whole dollars. */
  amount: number;
  /** Null for everyone. */
  userId: string | null;
  duration: LimitDuration;
}

/** Letters and gift letters; for the money limit, whole dollars. */
const MAX_AMOUNT = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMoney(key: DailyLimitKey): boolean {
  return key === "account_daily_charge_cents";
}

/** The stored value: cents for the money limit, letters otherwise. */
export function storedValue(key: DailyLimitKey, amount: number): number {
  return isMoney(key) ? amount * 100 : amount;
}

export function formatLimitValue(key: DailyLimitKey, value: number): string {
  if (isMoney(key)) return `$${(value / 100).toFixed(2)}`;
  return `${value} ${value === 1 ? "letter" : "letters"}`;
}

function describeScope(userId: string | null): string {
  return userId === null ? "Everyone" : `Account ${userId}`;
}

function describeUntil(override: Pick<LimitOverrideView, "expiresAt" | "expired"> | null): string {
  if (!override) return "—";
  if (!override.expiresAt) return "until cleared";
  return `${override.expired ? "expired" : "until"} ${override.expiresAt.toISOString()}`;
}

function parseAmount(raw: string | undefined): number {
  const text = (raw ?? "").trim();
  if (!/^\d{1,7}$/.test(text)) throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
  const amount = Number(text);
  if (amount > MAX_AMOUNT) throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
  return amount;
}

function targetKey(targetId: string): DailyLimitKey {
  if (!isDailyLimitKey(targetId)) throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
  return targetId;
}

function overrideSummary(override: LimitOverrideView | null) {
  return override
    ? {
        overrideId: override.overrideId,
        value: override.value,
        expiresAt: override.expiresAt ? override.expiresAt.toISOString() : null,
      }
    : null;
}

export function createLimitCommands() {
  const set: CommandDefinition<SetLimitInput> = {
    name: "limit.set",
    title: "Set a daily limit",
    action: "limit.set",
    targetType: "daily_limit",
    transactional: true,
    verb: () => "SET-LIMIT",
    // The form names the limit in `limit`; the confirmation carries it as
    // the target.
    targetFromFields: (fields) => (fields.get("limit") ?? "").trim(),
    parseInput(fields) {
      const amount = parseAmount(fields.get("amount"));
      const account = (fields.get("account") ?? "").trim();
      if (account.length > 255) throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
      const duration = fields.get("duration");
      if (duration !== "today" && duration !== "until_cleared") {
        throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
      }
      return { amount, userId: account === "" ? null : account, duration };
    },
    async preview(client, targetId, input) {
      const key = targetKey(targetId);
      if (input.userId !== null) {
        // Only the per-account limits can be set for one account.
        if (!ACCOUNT_DAILY_LIMIT_KEYS.has(key)) throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
        if (!(await accountExists(client, input.userId))) throw new AdminFoundationError("ADMIN_NOT_FOUND");
      }
      const value = storedValue(key, input.amount);
      const current = await readUnclearedOverride(client, key, input.userId);
      const defaults = await readLimitDefaults(client);
      const configured = defaults.get(key)?.value ?? null;

      // Today's use is shown but not signed: it moves with every send, and a
      // signed figure would make every busy preview stale.
      let usedToday: number;
      if (input.userId !== null) {
        const use = await readAccountUseToday(client, input.userId);
        usedToday = key === "account_daily_mail" ? use.letters : use.chargeCents;
      } else if (ACCOUNT_DAILY_LIMIT_KEYS.has(key)) {
        usedToday = -1;
      } else {
        const use = await readTodayUse(client);
        usedToday = key === "gift_daily_send" ? use.giftLetters : use.letters;
      }

      const warnings: string[] = [];
      if (current) {
        warnings.push(
          `This replaces the value set before: ${formatLimitValue(key, current.value)}, ${describeUntil(current)}.`,
        );
      }
      if (value === 0) {
        warnings.push("0 refuses everything this limit covers, from the next send or checkout.");
      } else if (usedToday >= 0 && usedToday >= value) {
        warnings.push(
          `Today's use (${formatLimitValue(key, usedToday)}) already meets the new value, so the next send or checkout it covers is refused.`,
        );
      }
      if (configured !== null && configured > 0 && value > configured * 10) {
        warnings.push(`This is more than ten times the value the API is configured with (${formatLimitValue(key, configured)}).`);
      }
      if (input.duration === "today") {
        warnings.push("It lapses at midnight UTC, and the limit returns to the value set for everyone or configured.");
      }

      return {
        targetId: key,
        summary: {
          limitKey: key,
          scope: input.userId ?? "everyone",
          value,
          duration: input.duration,
          current: overrideSummary(current),
          configured,
        },
        ...(current ? { expectedVersion: current.updatedAt.toISOString() } : {}),
        display: [
          ["Limit", DAILY_LIMIT_LABELS[key]],
          ["For", describeScope(input.userId)],
          ["Configured on the API", configured === null ? "not reported yet" : formatLimitValue(key, configured)],
          ["Set before", current ? `${formatLimitValue(key, current.value)}, ${describeUntil(current)}` : "—"],
          ["New value", formatLimitValue(key, value)],
          ["Until", input.duration === "today" ? "midnight UTC tonight" : "cleared by an operator"],
          ["Used today", usedToday >= 0 ? formatLimitValue(key, usedToday) : "per account; name an account to see its use"],
        ],
        warnings,
      };
    },
    async execute(execution, targetId, input, preview) {
      if (!execution.client) throw new AdminFoundationError("ADMIN_INTERNAL_ERROR");
      const key = targetKey(targetId);
      const signedCurrent = (preview.summary.current as { overrideId?: unknown } | null)?.overrideId ?? null;
      const cleared = await execution.client.query<{ override_id: string }>(
        `UPDATE daily_limit_overrides
            SET cleared_at = NOW(), cleared_by_command_id = $3::text
          WHERE limit_key = $1::text AND COALESCE(user_id, '') = COALESCE($2::text, '') AND cleared_at IS NULL
          RETURNING override_id`,
        [key, input.userId, execution.commandId],
      );
      // What the operator replaced must be what they saw.
      if ((cleared.rows[0]?.override_id ?? null) !== signedCurrent) {
        throw new AdminFoundationError("ADMIN_STALE_PREVIEW");
      }
      const inserted = await execution.client.query<{ override_id: string; expires_at: Date | null }>(
        `INSERT INTO daily_limit_overrides (limit_key, user_id, value, expires_at, created_by_command_id)
         VALUES ($1::text, $2::text, $3::int,
                 CASE WHEN $4::text = 'today'
                      THEN (date_trunc('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day') AT TIME ZONE 'UTC'
                 END,
                 $5::text)
         RETURNING override_id, expires_at`,
        [key, input.userId, storedValue(key, input.amount), input.duration, execution.commandId],
      );
      const row = inserted.rows[0];
      if (!row) throw new AdminFoundationError("ADMIN_INTERNAL_ERROR");
      return {
        overrideId: row.override_id,
        limitKey: key,
        value: storedValue(key, input.amount),
        expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
      };
    },
  };

  const clear: CommandDefinition<Record<string, never>> = {
    name: "limit.clear",
    title: "Clear a daily limit's value",
    action: "limit.clear",
    targetType: "daily_limit",
    transactional: true,
    verb: () => "CLEAR-LIMIT",
    parseInput: () => ({}),
    async preview(client, targetId) {
      if (!UUID.test(targetId)) throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
      const override = await readOverrideById(client, targetId);
      if (!override) throw new AdminFoundationError("ADMIN_NOT_FOUND");
      if (override.cleared) throw new AdminFoundationError("ADMIN_INVALID_STATE");
      const key = override.limitKey;
      return {
        targetId: override.overrideId,
        summary: {
          overrideId: override.overrideId,
          limitKey: key,
          scope: override.userId ?? "everyone",
          value: override.value,
          expiresAt: override.expiresAt ? override.expiresAt.toISOString() : null,
        },
        expectedVersion: override.updatedAt.toISOString(),
        display: [
          ["Limit", DAILY_LIMIT_LABELS[key]],
          ["For", describeScope(override.userId)],
          ["Value", formatLimitValue(key, override.value)],
          ["Until", describeUntil(override)],
        ],
        warnings: [
          override.userId === null
            ? "The limit returns to the value the API is configured with, from the next send or checkout."
            : "This account returns to the value set for everyone, or the configured one, from its next send or checkout.",
        ],
      };
    },
    async execute(execution, targetId) {
      if (!execution.client) throw new AdminFoundationError("ADMIN_INTERNAL_ERROR");
      const result = await execution.client.query<{ override_id: string }>(
        `UPDATE daily_limit_overrides
            SET cleared_at = NOW(), cleared_by_command_id = $2::text
          WHERE override_id = $1::uuid AND cleared_at IS NULL
          RETURNING override_id`,
        [targetId, execution.commandId],
      );
      if (!result.rows[0]) throw new AdminFoundationError("ADMIN_INVALID_STATE");
      return { overrideId: targetId, cleared: true };
    },
  };

  return { set, clear };
}
