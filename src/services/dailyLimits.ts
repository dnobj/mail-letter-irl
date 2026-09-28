import type pg from 'pg';

// The pool is reached lazily: this module is imported by the limit checks
// everywhere, and a caller that never records a refusal never touches it.
import * as db from '../db/index.js';
import { accountDailyChargeCents, accountDailyMailCap, globalDailyMailCeiling } from '../auth/betaAccess.js';
import { giftDailySendCap } from '../config/giftLetters.js';
import { operatorAlertUrl, operatorAlertUrlInvalid } from '../config/operatorAlerts.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';

/**
 * The daily limits as values in force: the environment's, unless an operator
 * has set another in the admin panel (migration 038).
 *
 * Each limit has an environment value, read on every check as before
 * (src/auth/betaAccess.ts, src/config/giftLetters.ts). An operator may set a
 * different value, for everyone or, for the two per-account limits, for one
 * account, for the rest of the UTC day or until cleared. The value in force is
 * the account's own, then the one for everyone, then the environment's.
 *
 * When a limit refuses someone, the first refusal of the UTC day opens an
 * operational alert and tells the operator at LETTER_IRL_OPERATOR_ALERT_URL
 * (reportDailyLimitReached, below), so a limit that bites is seen the same
 * day, not when a customer writes in.
 */

export type DailyLimitKey =
  | 'global_daily_mail'
  | 'account_daily_mail'
  | 'account_daily_charge_cents'
  | 'gift_daily_send';

export const DAILY_LIMIT_KEYS: readonly DailyLimitKey[] = [
  'global_daily_mail',
  'account_daily_mail',
  'account_daily_charge_cents',
  'gift_daily_send'
];

/** The limits that apply to each account separately, so may be set for one. */
export const ACCOUNT_DAILY_LIMIT_KEYS: ReadonlySet<DailyLimitKey> = new Set([
  'account_daily_mail',
  'account_daily_charge_cents'
]);

/** How the panel and the operator's notice name each limit. */
export const DAILY_LIMIT_LABELS: Readonly<Record<DailyLimitKey, string>> = {
  global_daily_mail: 'letters per day, all accounts',
  account_daily_mail: 'letters per account per day',
  account_daily_charge_cents: 'spending per account per day',
  gift_daily_send: 'gift letters per day, all accounts'
};

/** The environment variable behind each limit, for the panel and the docs. */
export const DAILY_LIMIT_VARIABLES: Readonly<Record<DailyLimitKey, string>> = {
  global_daily_mail: 'LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING',
  account_daily_mail: 'LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP',
  account_daily_charge_cents: 'LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS',
  gift_daily_send: 'LETTER_IRL_GIFT_DAILY_SEND_CAP'
};

export function isDailyLimitKey(value: unknown): value is DailyLimitKey {
  return typeof value === 'string' && (DAILY_LIMIT_KEYS as readonly string[]).includes(value);
}

/** A limit's value in this process's environment. */
export function configuredDailyLimit(key: DailyLimitKey, env: NodeJS.ProcessEnv = process.env): number {
  switch (key) {
    case 'global_daily_mail':
      return globalDailyMailCeiling(env);
    case 'account_daily_mail':
      return accountDailyMailCap(env);
    case 'account_daily_charge_cents':
      return accountDailyChargeCents(env);
    case 'gift_daily_send':
      return giftDailySendCap(env);
  }
}

/** The one query shape needed: a transaction's client, or { query }. */
export interface DailyLimitQueryable {
  query<T extends pg.QueryResultRow = any>(text: string, params?: any[]): Promise<pg.QueryResult<T>>;
}

/**
 * The values in force for the given limits, for one account (or none).
 *
 * Read with the caller's client, so a check inside a send transaction sees
 * one answer. There is no try/catch, as in betaSpendLimits: a read that fails
 * propagates and refuses, because "we could not check" is never "go ahead".
 */
export async function effectiveDailyLimits(
  client: DailyLimitQueryable,
  keys: readonly DailyLimitKey[],
  userId: string | null,
  env: NodeJS.ProcessEnv = process.env
): Promise<Record<DailyLimitKey, number>> {
  const values = {} as Record<DailyLimitKey, number>;
  for (const key of keys) values[key] = configuredDailyLimit(key, env);

  const result = await client.query<{ limit_key: string; user_id: string | null; value: number | string }>(
    `SELECT limit_key, user_id, value FROM daily_limit_overrides
      WHERE cleared_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
        AND limit_key = ANY($1::text[])
        AND (user_id IS NULL OR user_id = $2::text)`,
    [keys, userId]
  );

  // The account's own value wins over the one for everyone, whatever order
  // the rows arrive in.
  const accountWide = new Set<DailyLimitKey>();
  for (const row of result.rows) {
    const key = row.limit_key;
    if (!isDailyLimitKey(key) || !keys.includes(key)) continue;
    const value = Number(row.value);
    if (!Number.isInteger(value) || value < 0) continue;
    const forThisAccount = row.user_id !== null && row.user_id !== undefined;
    if (forThisAccount) {
      if (!ACCOUNT_DAILY_LIMIT_KEYS.has(key) || row.user_id !== userId) continue;
      values[key] = value;
      accountWide.add(key);
    } else if (!accountWide.has(key)) {
      values[key] = value;
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// When a limit refuses someone

const OPERATOR_ALERT_TIMEOUT_MS = 10_000;
const INTEGER_MAX = 2_147_483_647;

function environmentName(env: NodeJS.ProcessEnv): string {
  return (env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || '').trim().slice(0, 40);
}

function describeValue(key: DailyLimitKey, value: number): string {
  return key === 'account_daily_charge_cents' ? `$${(value / 100).toFixed(2)}` : String(value);
}

/** The line the operator reads. No customer detail: the panel has that. */
export function dailyLimitNotice(key: DailyLimitKey, value: number, env: NodeJS.ProcessEnv = process.env): string {
  const where = environmentName(env);
  return (
    `Letter IRL${where ? ` (${where})` : ''}: the daily limit on ${DAILY_LIMIT_LABELS[key]} ` +
    `(${describeValue(key, value)}) refused a customer for the first time today (UTC). ` +
    `Review it, or raise it, on the admin panel's Limits page.`
  );
}

export type OperatorNoticeOutcome = 'sent' | 'skipped' | 'invalid' | 'failed';

/**
 * Posts the notice as plain text: a healthchecks.io check's `/fail` URL
 * emails it, and push services such as ntfy show it on a phone. Never throws.
 */
export async function notifyOperatorOfLimit(
  key: DailyLimitKey,
  value: number,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = OPERATOR_ALERT_TIMEOUT_MS
): Promise<OperatorNoticeOutcome> {
  if (operatorAlertUrlInvalid(env)) {
    writeDiagnostic('warn', 'limits.operator_alert_url_invalid');
    return 'invalid';
  }
  const url = operatorAlertUrl(env);
  if (!url) return 'skipped';
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: dailyLimitNotice(key, value, env),
      signal: AbortSignal.timeout(timeoutMs)
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      writeDiagnostic('warn', 'limits.operator_alert_failed', { status: response.status });
      return 'failed';
    }
    return 'sent';
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    const errorClass =
      name === 'TimeoutError' || name === 'AbortError'
        ? 'ETIMEDOUT'
        : classifyDiagnosticError((error as { cause?: unknown } | null)?.cause ?? error, 'provider_error');
    writeDiagnostic('warn', 'limits.operator_alert_failed', { errorClass });
    return 'failed';
  }
}

export interface RefusalRecorderDeps {
  transaction: typeof db.transaction;
  notify: (key: DailyLimitKey, value: number) => Promise<OperatorNoticeOutcome>;
}

const DEFAULT_RECORDER_DEPS: RefusalRecorderDeps = {
  transaction: (callback) => db.transaction(callback),
  notify: (key, value) => notifyOperatorOfLimit(key, value)
};

/**
 * Counts one refusal, and on the first of the UTC day for this limit opens
 * the day's alert and tells the operator.
 *
 * Runs in its own transaction on the pool. It must: the mail checks run
 * inside the send's transaction, which the refusal rolls back, and an alert
 * written there would vanish with it. The counter row is the gate, so two
 * refusals at once still open one alert: the second waits on the first's row
 * and only adds to its count.
 */
export async function recordDailyLimitRefusal(
  key: DailyLimitKey,
  userId: string | null,
  value: number,
  deps: RefusalRecorderDeps = DEFAULT_RECORDER_DEPS
): Promise<{ opened: boolean }> {
  const opened = await deps.transaction(async (client) => {
    const counted = await client.query<{ opened: boolean; utc_day: string }>(
      `INSERT INTO daily_limit_refusals (limit_key, utc_day)
       VALUES ($1::text, (NOW() AT TIME ZONE 'UTC')::date)
       ON CONFLICT (limit_key, utc_day)
       DO UPDATE SET refusals = daily_limit_refusals.refusals + 1, last_refused_at = NOW()
       RETURNING refusals = 1 AS opened, utc_day::text AS utc_day`,
      [key]
    );
    const row = counted.rows[0];
    if (!row?.opened) return false;
    // The first account is named for the per-account limits, so the alert
    // links to it; a limit for everyone names nobody.
    await client.query(
      `INSERT INTO commerce_operational_alerts (alert_type, severity, details)
       VALUES ('daily_limit_reached', 'warning',
               jsonb_strip_nulls(jsonb_build_object(
                 'limitKey', $1::text, 'utcDay', $2::text, 'value', $3::int, 'userId', $4::text)))`,
      [key, row.utc_day, Math.min(Math.max(0, Math.trunc(value)), INTEGER_MAX), ACCOUNT_DAILY_LIMIT_KEYS.has(key) ? userId : null]
    );
    return true;
  });
  writeDiagnostic(opened ? 'warn' : 'info', 'limits.daily_limit_reached', { limit: key, firstToday: opened });
  if (opened) await deps.notify(key, value);
  return { opened };
}

/**
 * Called where a daily limit refuses. Never waits and never throws: the
 * refusal stands whatever becomes of the record, and a failure to record it
 * is logged by class.
 */
export function reportDailyLimitReached(key: DailyLimitKey, userId: string | null, value: number): void {
  void recordDailyLimitRefusal(key, userId, value).catch((error) => {
    writeDiagnostic('error', 'limits.refusal_record_failed', {
      limit: key,
      errorClass: classifyDiagnosticError(error, 'database_error')
    });
  });
}

/**
 * Writes the environment's values, so the admin panel, which runs with its
 * own environment, can show what the API runs with. Called when the API
 * starts; never throws.
 */
export async function reportDailyLimitDefaults(
  env: NodeJS.ProcessEnv = process.env,
  target: DailyLimitQueryable = { query: (text, params) => db.query(text, params) }
): Promise<boolean> {
  try {
    const keys = [...DAILY_LIMIT_KEYS];
    const values = keys.map((key) => Math.min(configuredDailyLimit(key, env), INTEGER_MAX));
    await target.query(
      `INSERT INTO daily_limit_defaults (limit_key, value, reported_at)
       SELECT key, value, NOW() FROM UNNEST($1::text[], $2::int[]) AS reported(key, value)
       ON CONFLICT (limit_key) DO UPDATE SET value = EXCLUDED.value, reported_at = EXCLUDED.reported_at`,
      [keys, values]
    );
    return true;
  } catch (error) {
    writeDiagnostic('warn', 'limits.defaults_report_failed', {
      errorClass: classifyDiagnosticError(error, 'database_error')
    });
    return false;
  }
}
