import { USPS_HOLIDAYS, USPS_HOLIDAYS_THROUGH } from '../content/uspsHolidays.js';

/**
 * When scheduled mail goes to the printer so that it arrives by a date (#535).
 *
 * Pure: every function is given the moment it is asked at. A date is a plain
 * calendar date, 'YYYY-MM-DD', in America/New_York, the time zone the schedule
 * keeps; an instant is a Date.
 *
 * USPS does not guarantee First-Class dates, so the schedule works back from
 * the date the mail should arrive by a lead time counted in business days
 * (PostGrid prints the day after the order, transit takes one to five, and one
 * more is buffer), and the person is told it aims to arrive by then. The send
 * will hold scheduled mail in our outbox until dispatchAt, 09:00 New York time
 * on its mail date, when the hourly maintenance run sends it to PostGrid as an
 * ordinary order (#535's later PRs wire this).
 */

/**
 * 'YYYY-MM-DD'. A plain string: a date from outside (a tool's input, a
 * request) must pass parseCalendarDate first, and every other function here
 * throws a RangeError on anything that is not one.
 */
export type CalendarDate = string;

/** The time zone every date here is a day in. */
export const SCHEDULE_TIME_ZONE = 'America/New_York';
/** Held mail is released to the hourly run from this hour on its mail date. */
export const DISPATCH_HOUR = 9;
/**
 * From this hour today is no longer a mail date, so the earliest arrival moves
 * a business day on. Mail sent before it still reaches PostGrid that day.
 */
export const MAIL_CUTOFF_HOUR = 12;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Midnight UTC on a day. Date.UTC would read years 0-99 as 1900-1999;
 * setUTCFullYear takes the year as written.
 */
function utcMidnight(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

/** The day number (days since 1970-01-01) of a calendar date. */
function dayNumber(date: CalendarDate): number {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw new RangeError(`Not a calendar date (YYYY-MM-DD): ${date}`);
  return utcMidnight(Number(match[1]), Number(match[2]), Number(match[3])).getTime() / DAY_MS;
}

function fromDayNumber(day: number): CalendarDate {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** `value` as a calendar date if it is a real one written 'YYYY-MM-DD', or null. */
export function parseCalendarDate(value: string): CalendarDate | null {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = utcMidnight(year, month, day);
  // A day past the month's end rolls over (2026-02-30 becomes March 2): only a
  // date that survives the round trip is real.
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? match[0]
    : null;
}

export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  return fromDayNumber(dayNumber(date) + days);
}

/** A weekday that is not a USPS holiday. */
export function isBusinessDay(date: CalendarDate): boolean {
  const weekday = new Date(dayNumber(date) * DAY_MS).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !USPS_HOLIDAYS.has(date);
}

/**
 * A lead time or a horizon: a whole number of days from 0 to 1000. Anything
 * else is a caller's bug, refused loudly: NaN would read as 0, a negative lead
 * would mail after the arrival date, and Infinity would never finish.
 */
function dayCount(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 1000) {
    throw new RangeError(`${name} must be a whole number of days from 0 to 1000, not ${value}`);
  }
  return value;
}

/** The business day `count` business days after (positive) or before (negative) `date`. */
function stepBusinessDays(date: CalendarDate, count: number): CalendarDate {
  const step = count < 0 ? -1 : 1;
  let day = dayNumber(date);
  for (let remaining = Math.abs(count); remaining > 0;) {
    day += step;
    if (isBusinessDay(fromDayNumber(day))) remaining -= 1;
  }
  return fromDayNumber(day);
}

/** `date` if it is a business day, or the last business day before it. */
function businessDayOnOrBefore(date: CalendarDate): CalendarDate {
  return isBusinessDay(date) ? date : stepBusinessDays(date, -1);
}

const NEW_YORK = new Intl.DateTimeFormat('en-US', {
  timeZone: SCHEDULE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23'
});

/** The New York calendar date and hour at an instant. */
function newYorkClock(instant: Date): { date: CalendarDate; hour: number } {
  const parts = Object.fromEntries(NEW_YORK.formatToParts(instant).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** The New York calendar date at an instant. */
export function newYorkDate(instant: Date): CalendarDate {
  return newYorkClock(instant).date;
}

/**
 * The instant it is `hour`:00, a whole hour, in New York on `date`, in
 * daylight saving time or not. The hour the clocks skip (02:00 on a spring
 * change) gives 01:00 standard time, and the hour that repeats (01:00 on an
 * autumn change) its first, daylight-saving instance; DISPATCH_HOUR is neither.
 */
export function newYorkTime(date: CalendarDate, hour: number): Date {
  // The wall-clock time written as if it were UTC, then moved by New York's
  // offset; the offset is read again at the answer, in case the first guess
  // fell on the other side of a clock change. New York's offset is a whole
  // number of hours, so every instant read here falls on the hour.
  const wall = dayNumber(date) * DAY_MS + hour * HOUR_MS;
  const offset = (instant: number) => {
    const clock = newYorkClock(new Date(instant));
    return dayNumber(clock.date) * DAY_MS + clock.hour * HOUR_MS - instant;
  };
  const guess = wall - offset(wall);
  return new Date(wall - offset(guess));
}

/**
 * The date mail must go to the printer to arrive by `arriveBy`: `leadDays`
 * business days before it, or before the last business day before it when
 * it falls on a weekend or holiday. Always a business day.
 */
export function mailOnFor(arriveBy: CalendarDate, leadDays: number): CalendarDate {
  return stepBusinessDays(businessDayOnOrBefore(arriveBy), -dayCount('leadDays', leadDays));
}

/** The first date mail can go to the printer: today until the cutoff on a business day, else the next one. */
export function earliestMailOn(now: Date): CalendarDate {
  const { date: today, hour } = newYorkClock(now);
  return isBusinessDay(today) && hour < MAIL_CUTOFF_HOUR ? today : stepBusinessDays(today, 1);
}

/** The first date mail can be scheduled to arrive by. */
export function earliestArrival(now: Date, leadDays: number): CalendarDate {
  return stepBusinessDays(earliestMailOn(now), dayCount('leadDays', leadDays));
}

/**
 * The last date mail can be scheduled to arrive by: `horizonDays` after today,
 * and never past the end of the holiday list, where business days are unknown.
 */
export function latestArrival(now: Date, horizonDays: number): CalendarDate {
  const latest = addCalendarDays(newYorkDate(now), dayCount('horizonDays', horizonDays));
  return latest < USPS_HOLIDAYS_THROUGH ? latest : USPS_HOLIDAYS_THROUGH;
}

/** When held mail is released to the hourly run: 09:00 New York time on its mail date. */
export function dispatchAt(mailOn: CalendarDate): Date {
  return newYorkTime(mailOn, DISPATCH_HOUR);
}

export interface ScheduleSettings {
  /** Business days from the mail date to the arrival date. */
  leadDays: number;
  /** Calendar days ahead an arrival date may be. */
  horizonDays: number;
}

export type ArrivalCheck =
  | {
      ok: true;
      arriveBy: CalendarDate;
      mailOn: CalendarDate;
      dispatchAt: Date;
      earliestArrival: CalendarDate;
      latestArrival: CalendarDate;
    }
  | {
      ok: false;
      /**
       * `unavailable`: no date can be scheduled now, because the earliest
       * arrival is past the latest (a horizon shorter than the lead time, or
       * the end of the holiday list); the two dates then mean nothing.
       */
      reason: 'invalid_date' | 'unavailable' | 'too_soon' | 'too_late';
      earliestArrival: CalendarDate;
      latestArrival: CalendarDate;
    };

/**
 * Whether mail can be scheduled to arrive by `arriveBy`, asked at `now`, and
 * when it would then mail. A refusal carries the earliest and latest dates,
 * so the person or the model can choose again.
 */
export function checkArrival(arriveBy: string, now: Date, settings: ScheduleSettings): ArrivalCheck {
  const earliest = earliestArrival(now, settings.leadDays);
  const latest = latestArrival(now, settings.horizonDays);
  const date = parseCalendarDate(arriveBy);
  if (!date) return { ok: false, reason: 'invalid_date', earliestArrival: earliest, latestArrival: latest };
  if (earliest > latest) return { ok: false, reason: 'unavailable', earliestArrival: earliest, latestArrival: latest };
  if (date < earliest) return { ok: false, reason: 'too_soon', earliestArrival: earliest, latestArrival: latest };
  if (date > latest) return { ok: false, reason: 'too_late', earliestArrival: earliest, latestArrival: latest };
  const mailOn = mailOnFor(date, settings.leadDays);
  return { ok: true, arriveBy: date, mailOn, dispatchAt: dispatchAt(mailOn), earliestArrival: earliest, latestArrival: latest };
}
