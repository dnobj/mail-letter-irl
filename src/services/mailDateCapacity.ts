import type pg from 'pg';
import { scheduleDailyCap, scheduleHorizonDays, scheduleLeadDays } from '../config/arriveBy.js';
import {
  describeDate,
  earliestArrival,
  latestArrival,
  mailOnFor,
  nearestOpenArrivals,
  type CalendarDate
} from './deliverySchedule.js';
import type { DraftSchedule } from './types.js';

/**
 * Room on a mail date (#700): at most LETTER_IRL_SCHEDULE_DAILY_CAP letters
 * held to go to the printer on one day, across every account
 * (src/config/arriveBy.ts). Held mail is a letter still `queued` with a
 * `mail_on`, as idx_letters_held_mail_on indexes it (migration 040): a letter
 * leaves the count once the outbox takes it, or once it is cancelled.
 *
 * The preview, set_arrival_date and the Pay & Send checkout read the count;
 * the send counts under a lock on the date, so two sends cannot both take its
 * last place. Drafts hold no place: a date with room at the preview can be
 * full at the send, which then refuses.
 */

/** A transaction's client, or the pool's `query` (src/db/index.ts) as `{ query }`. */
export interface Queryable {
  query<T extends pg.QueryResultRow = any>(text: string, params?: any[]): Promise<pg.QueryResult<T>>;
}

/** A mail date with no room, and the arrival dates nearest the one asked for whose mail dates have some. */
export interface FullMailDate {
  mailOn: CalendarDate;
  openArrivals: CalendarDate[];
}

async function heldOn(db: Queryable, mailOn: CalendarDate): Promise<number> {
  const result = await db.query<{ held: number | string }>(
    `SELECT COUNT(*)::int AS held FROM letters
      WHERE status = 'queued' AND mail_on IS NOT NULL AND mail_on = $1::date`,
    [mailOn]
  );
  return Number(result.rows[0]?.held ?? 0);
}

async function heldBetween(db: Queryable, from: CalendarDate, to: CalendarDate): Promise<Map<string, number>> {
  const result = await db.query<{ mail_on: string; held: number | string }>(
    `SELECT to_char(mail_on, 'YYYY-MM-DD') AS mail_on, COUNT(*)::int AS held FROM letters
      WHERE status = 'queued' AND mail_on IS NOT NULL AND mail_on BETWEEN $1::date AND $2::date
      GROUP BY mail_on`,
    [from, to]
  );
  return new Map(result.rows.map(row => [row.mail_on, Number(row.held)]));
}

/**
 * Null when `schedule`'s mail date has room for one more letter, else the
 * date and the nearest arrival dates on offer at `now` with room. With `lock`,
 * inside the send's transaction, it first takes a transaction-scoped lock on
 * the date, held until the send commits its letter or rolls back.
 */
export async function fullMailDate(
  db: Queryable,
  schedule: DraftSchedule,
  now: Date,
  options: { lock?: boolean } = {}
): Promise<FullMailDate | null> {
  const cap = scheduleDailyCap();
  if (options.lock) {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('letter_irl.mail_on'), hashtext($1))", [schedule.mailOn]);
  }
  if ((await heldOn(db, schedule.mailOn)) < cap) return null;

  const settings = { leadDays: scheduleLeadDays(), horizonDays: scheduleHorizonDays() };
  const earliest = earliestArrival(now, settings.leadDays);
  const latest = latestArrival(now, settings.horizonDays);
  if (earliest > latest) return { mailOn: schedule.mailOn, openArrivals: [] };
  const held = await heldBetween(db, mailOnFor(earliest, settings.leadDays), mailOnFor(latest, settings.leadDays));
  const openArrivals = nearestOpenArrivals(
    schedule.arriveBy,
    now,
    settings,
    mailOn => mailOn !== schedule.mailOn && (held.get(mailOn) ?? 0) < cap
  );
  return { mailOn: schedule.mailOn, openArrivals };
}

/** The open dates in one sentence: with their YYYY-MM-DD for a model, which passes them back. */
export function openArrivalsSentence(openArrivals: readonly CalendarDate[], now: Date, withIso: boolean): string {
  if (openArrivals.length === 0) return 'No other arrival date on offer has room right now.';
  const said = openArrivals.map(date => (withIso ? `${describeDate(date, now)} (${date})` : describeDate(date, now)));
  const list = said.length === 1 ? said[0] : `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]}`;
  return said.length === 1 ? `The nearest arrival date with room is ${list}.` : `The nearest arrival dates with room are ${list}.`;
}

/** The arrival dates a full date's refusal carries (`openArrivals`, set by the send and the checkout), or none. */
export function openArrivalsOf(error: unknown): CalendarDate[] {
  const dates = (error as { openArrivals?: unknown } | null)?.openArrivals;
  return Array.isArray(dates) ? dates.filter((date): date is CalendarDate => typeof date === 'string') : [];
}
