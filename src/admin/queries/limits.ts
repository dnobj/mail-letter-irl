import type { AdminSqlClient } from "../database.js";
import { DAILY_LIMIT_KEYS, isDailyLimitKey, type DailyLimitKey } from "../../services/dailyLimits.js";

/**
 * The daily limits as the panel shows them (migration 038): what the API
 * runs with, what an operator has set, what is in force, today's use and
 * today's refusals. Reads only, through the reader role.
 */

export interface LimitOverrideView {
  overrideId: string;
  limitKey: DailyLimitKey;
  /** Null for everyone. */
  userId: string | null;
  value: number;
  /** Null until cleared. */
  expiresAt: Date | null;
  /** True once expires_at has passed: kept, but no longer in force. */
  expired: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface OverrideRow {
  override_id: string;
  limit_key: string;
  user_id: string | null;
  value: number | string;
  expires_at: Date | null;
  expired: boolean;
  created_at: Date;
  updated_at: Date;
}

const OVERRIDE_COLUMNS = `
  override_id, limit_key, user_id, value, expires_at,
  (expires_at IS NOT NULL AND expires_at <= NOW()) AS expired,
  created_at, updated_at
`;

function toOverrideView(row: OverrideRow): LimitOverrideView | null {
  if (!isDailyLimitKey(row.limit_key)) return null;
  return {
    overrideId: row.override_id,
    limitKey: row.limit_key,
    userId: row.user_id,
    value: Number(row.value),
    expiresAt: row.expires_at,
    expired: row.expired === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Every uncleared override, in force or expired, the panel's own view first. */
export async function listUnclearedOverrides(client: AdminSqlClient): Promise<LimitOverrideView[]> {
  const result = await client.query<OverrideRow>(
    `SELECT ${OVERRIDE_COLUMNS} FROM daily_limit_overrides
      WHERE cleared_at IS NULL
      ORDER BY limit_key, user_id NULLS FIRST, created_at`,
  );
  return result.rows.map(toOverrideView).filter((view): view is LimitOverrideView => view !== null);
}

/** The uncleared override for one limit and account (null: everyone), if any. */
export async function readUnclearedOverride(
  client: AdminSqlClient,
  limitKey: DailyLimitKey,
  userId: string | null,
): Promise<LimitOverrideView | null> {
  const result = await client.query<OverrideRow>(
    `SELECT ${OVERRIDE_COLUMNS} FROM daily_limit_overrides
      WHERE cleared_at IS NULL AND limit_key = $1::text AND COALESCE(user_id, '') = COALESCE($2::text, '')`,
    [limitKey, userId],
  );
  return result.rows[0] ? toOverrideView(result.rows[0]) : null;
}

/** One override by id, cleared or not; null when there is none. */
export async function readOverrideById(
  client: AdminSqlClient,
  overrideId: string,
): Promise<(LimitOverrideView & { cleared: boolean }) | null> {
  const result = await client.query<OverrideRow & { cleared: boolean }>(
    `SELECT ${OVERRIDE_COLUMNS}, (cleared_at IS NOT NULL) AS cleared
       FROM daily_limit_overrides WHERE override_id = $1::uuid`,
    [overrideId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const view = toOverrideView(row);
  return view ? { ...view, cleared: row.cleared === true } : null;
}

export interface LimitDefaultView {
  value: number;
  reportedAt: Date;
}

/** What the API process last reported running with, per limit. */
export async function readLimitDefaults(client: AdminSqlClient): Promise<Map<DailyLimitKey, LimitDefaultView>> {
  const result = await client.query<{ limit_key: string; value: number | string; reported_at: Date }>(
    `SELECT limit_key, value, reported_at FROM daily_limit_defaults`,
  );
  const defaults = new Map<DailyLimitKey, LimitDefaultView>();
  for (const row of result.rows) {
    if (isDailyLimitKey(row.limit_key)) {
      defaults.set(row.limit_key, { value: Number(row.value), reportedAt: row.reported_at });
    }
  }
  return defaults;
}

export interface LimitRefusalsView {
  refusals: number;
  firstRefusedAt: Date;
  lastRefusedAt: Date;
}

/** Today's (UTC) refusals per limit. */
export async function readTodayRefusals(client: AdminSqlClient): Promise<Map<DailyLimitKey, LimitRefusalsView>> {
  const result = await client.query<{
    limit_key: string;
    refusals: number | string;
    first_refused_at: Date;
    last_refused_at: Date;
  }>(
    `SELECT limit_key, refusals, first_refused_at, last_refused_at FROM daily_limit_refusals
      WHERE utc_day = (NOW() AT TIME ZONE 'UTC')::date`,
  );
  const refusals = new Map<DailyLimitKey, LimitRefusalsView>();
  for (const row of result.rows) {
    if (isDailyLimitKey(row.limit_key)) {
      refusals.set(row.limit_key, {
        refusals: Number(row.refusals),
        firstRefusedAt: row.first_refused_at,
        lastRefusedAt: row.last_refused_at,
      });
    }
  }
  return refusals;
}

/**
 * Today's use of the two limits that apply to everyone, counted the way the
 * checks count them (src/services/betaSpendLimits.ts): every letters row
 * created since midnight UTC, whatever its status.
 */
export async function readTodayUse(client: AdminSqlClient): Promise<{ letters: number; giftLetters: number }> {
  const result = await client.query<{ letters: string; gift_letters: string }>(
    `SELECT COUNT(*) AS letters,
            COUNT(*) FILTER (WHERE funding_type = 'gift_letter') AS gift_letters
       FROM letters
      WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
  );
  const row = result.rows[0];
  return { letters: Number(row?.letters ?? 0), giftLetters: Number(row?.gift_letters ?? 0) };
}

/** One account's use today of the two per-account limits. */
export async function readAccountUseToday(
  client: AdminSqlClient,
  userId: string,
): Promise<{ letters: number; chargeCents: number }> {
  const result = await client.query<{ letters: string; charge_cents: string }>(
    `SELECT
       (SELECT COUNT(*) FROM letters
         WHERE user_id = $1::text AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')) AS letters,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM orders
         WHERE user_id = $1::text AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')) AS charge_cents`,
    [userId],
  );
  const row = result.rows[0];
  return { letters: Number(row?.letters ?? 0), chargeCents: Number(row?.charge_cents ?? 0) };
}

/** Whether an account exists, for a per-account override. */
export async function accountExists(client: AdminSqlClient, userId: string): Promise<boolean> {
  const result = await client.query<{ found: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM users WHERE user_id = $1::text) AS found`,
    [userId],
  );
  return result.rows[0]?.found === true;
}

export { DAILY_LIMIT_KEYS };
