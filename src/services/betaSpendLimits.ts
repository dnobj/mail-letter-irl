import type pg from 'pg';
import { query } from '../db/index.js';
import {
  accountDailyChargeCents,
  accountDailyMailCap,
  globalDailyMailCeiling,
  isMailSendingEnabled
} from '../auth/betaAccess.js';

/**
 * Daily spend ceilings for the limited beta (#179).
 *
 * Nothing capped outbound mail or money before this. The only ceiling in the
 * codebase was LETTER_IRL_IMAGE_DAILY_CEILING, and that one FAILS OPEN on
 * purpose - correct there, because generation degrades to a free redirect
 * card. Everything here fails CLOSED. A counting error means we cannot prove
 * we are under a ceiling on a path that mails paper and charges cards, and
 * "we could not check" must never resolve to "go ahead".
 *
 * So: no try/catch. A query failure propagates and rolls the transaction back.
 * Do not copy imageGenerationLimitService's catch into this file.
 *
 * ---------------------------------------------------------------------------
 * THE DAY WINDOW
 *
 * letters.created_at and orders.created_at are TIMESTAMP - no time zone -
 * while image_generation_reservations.created_at is TIMESTAMPTZ. So
 * countGenerationsToday's `created_at >= date_trunc('day', NOW())` cannot be
 * copied here: NOW() is timestamptz, and comparing it against a TIMESTAMP
 * column converts through the session time zone, which silently moves the day
 * boundary.
 *
 * `NOW() AT TIME ZONE 'UTC'` yields a plain timestamp holding UTC wall time,
 * so both sides of the comparison are the same type and no conversion
 * happens. The column is left untouched, so the existing btree indexes still
 * turn this into a range scan.
 *
 * The assumption this rests on: rows are written by `DEFAULT NOW()` into a
 * TIMESTAMP column, which stores the session time zone's wall clock. That
 * equals UTC wall time when the database session is UTC, which is the default
 * for the Neon and Railway containers this runs on. If that ever stops being
 * true, these windows shift by the offset - so it is asserted here rather than
 * left implicit.
 *
 * ---------------------------------------------------------------------------
 * NO NEW INDEX
 *
 * The plan called for a migration adding (user_id, created_at) on letters.
 * It is not needed: 001_initial_schema.sql already creates
 * idx_letters_created_at ON letters(created_at DESC) and idx_letters_user_id,
 * and neither is dropped by any later migration. The day window range-scans
 * the first, and the per-account filter then runs over at most one day of rows
 * - a set the global ceiling itself bounds. Exactly the argument migration 025
 * makes for the image ceiling's status filter being "cheap on the small
 * remainder". A fourth index on a write path, buying nothing at 25 letters a
 * day, is not worth a permanent forward-only migration.
 */

/**
 * The single query shape this module needs.
 *
 * Deliberately NOT Pick<pg.PoolClient, 'query'>: that picks up PoolClient's
 * whole overload set, so the plain exported query() function - which is what
 * the checkout path has, having no transaction - is not assignable to it. A
 * narrow structural type accepts both a real transaction client and { query }.
 */
export interface SpendLimitQueryable {
  query<T extends pg.QueryResultRow = any>(
    text: string,
    params?: any[]
  ): Promise<pg.QueryResult<T>>;
}

/** Both sides plain timestamps, so no session-time-zone conversion occurs. */
const UTC_DAY_START = "date_trunc('day', NOW() AT TIME ZONE 'UTC')";

export class SpendLimitError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SpendLimitError';
    this.code = code;
  }
}

function countOf(rows: Array<{ count: string }> | undefined): number {
  const raw = rows?.[0]?.count;
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) {
    // Fail closed. A COUNT() that did not come back as a number means we
    // cannot prove we are under the ceiling.
    throw new SpendLimitError(
      'SPEND_LIMIT_UNVERIFIABLE',
      'Unable to verify the daily sending limit. Please try again shortly.'
    );
  }
  return parsed;
}

/**
 * Mail ceilings, checked with the transaction's client so they see the letter
 * row this transaction has already inserted.
 *
 * `inFlight` is how many items this request is about to add, and it is an
 * explicit parameter because the two call sites sit on opposite sides of the
 * INSERT:
 *
 *   mailSendService  inFlight = 0  - the letters row already exists, so the
 *                                    count includes it.
 *   createJitCheckout inFlight = 1 - the row is not created until fulfilment,
 *                                    so the count does not.
 *
 * Making it a parameter rather than baking the offset into each caller is what
 * stops the two drifting into different off-by-ones. `count + inFlight > cap`
 * is then one rule for both.
 *
 * A cap of 0 is a KILL SWITCH: with inFlight of at least 1, `0 + 1 > 0`
 * refuses everything.
 *
 *
 * No status filter. Cancelled and failed rows still count, because a cap that
 * forgives failures is one an error loop walks straight through.
 */
export async function assertMailWithinDailyCaps(
  client: SpendLimitQueryable,
  userId: string,
  inFlight: number
): Promise<void> {
  if (!isMailSendingEnabled()) {
    throw new SpendLimitError(
      'MAIL_SENDING_DISABLED',
      'Sending is temporarily paused. Please try again later.'
    );
  }

  const perAccount = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM letters
     WHERE user_id = $1 AND created_at >= ${UTC_DAY_START}`,
    [userId]
  );
  const accountCap = accountDailyMailCap();
  if (countOf(perAccount.rows) + inFlight > accountCap) {
    throw new SpendLimitError(
      'ACCOUNT_DAILY_MAIL_CAP',
      `This account has reached its daily limit of ${accountCap} items. Please try again tomorrow.`
    );
  }

  const global = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM letters WHERE created_at >= ${UTC_DAY_START}`
  );
  if (countOf(global.rows) + inFlight > globalDailyMailCeiling()) {
    // Deliberately does NOT name the global number: it is our operating
    // posture, not the customer's business, and they cannot act on it.
    throw new SpendLimitError(
      'GLOBAL_DAILY_MAIL_CEILING',
      'Letter IRL has reached its sending limit for today. Please try again tomorrow.'
    );
  }
}

/**
 * The per-account charge ceiling, checked BEFORE any order row or Stripe
 * session exists.
 *
 * Unlike the mail counts this runs before the row is created, so the charge in
 * flight is added explicitly and the comparison is `>`.
 *
 * Every order created today counts, whatever its status. An abandoned checkout
 * still represents an intent to charge, and excluding them would let a retry
 * loop walk past the ceiling.
 *
 * There is deliberately NO global charge cap. Charging a customer is not a
 * loss, and refusing a paying customer for reasons unrelated to them is worse
 * than the risk it avoids. The global MAIL ceiling already bounds the cost we
 * actually incur.
 */
export async function assertChargeWithinDailyCap(
  userId: string,
  additionalCents: number
): Promise<void> {
  const cap = accountDailyChargeCents();
  const result = await query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM orders
     WHERE user_id = $1 AND created_at >= ${UTC_DAY_START}`,
    [userId]
  );
  const spent = Number.parseInt(result.rows[0]?.total ?? '', 10);
  if (!Number.isFinite(spent)) {
    throw new SpendLimitError(
      'SPEND_LIMIT_UNVERIFIABLE',
      'Unable to verify the daily purchase limit. Please try again shortly.'
    );
  }
  if (spent + additionalCents > cap) {
    throw new SpendLimitError(
      'ACCOUNT_DAILY_CHARGE_CAP',
      'This account has reached its daily purchase limit. Please try again tomorrow.'
    );
  }
}
