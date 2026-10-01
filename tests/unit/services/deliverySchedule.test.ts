/**
 * The arrive-by schedule (#535): the New York calendar, business days and
 * USPS holidays, the lead time worked back from an arrival date, the earliest
 * and latest dates on offer, and when held mail is released.
 */

import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  checkArrival,
  dispatchAt,
  earliestArrival,
  earliestMailOn,
  isBusinessDay,
  latestArrival,
  mailOnFor,
  newYorkDate,
  newYorkTime,
  parseCalendarDate
} from '../../../src/services/deliverySchedule.js';
import { USPS_HOLIDAYS, USPS_HOLIDAYS_THROUGH } from '../../../src/content/uspsHolidays.js';

const SETTINGS = { leadDays: 7, horizonDays: 60 };
const DAY_MS = 86_400_000;
const iso = (date: Date) => date.toISOString().slice(0, 10);
const utcDay = (date: string) => Date.parse(`${date}T00:00:00Z`);
/** Every calendar date from `first` to `last`, both included. */
const datesBetween = (first: string, last: string) =>
  Array.from({ length: (utcDay(last) - utcDay(first)) / DAY_MS + 1 }, (_, index) => addCalendarDays(first, index));
/** The New York wall clock at an instant, read independently of the module. */
const newYorkClock = (instant: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);

describe('the New York calendar', () => {
  it('reads the date in New York, not UTC, either side of midnight in summer and in winter', () => {
    expect(newYorkDate(new Date('2026-10-02T03:59:00Z'))).toBe('2026-10-01'); // 23:59 EDT
    expect(newYorkDate(new Date('2026-10-02T04:00:00Z'))).toBe('2026-10-02');
    expect(newYorkDate(new Date('2026-12-02T04:59:00Z'))).toBe('2026-12-01'); // 23:59 EST
    expect(newYorkDate(new Date('2026-12-02T05:00:00Z'))).toBe('2026-12-02');
  });

  it('finds 09:00 New York time on either side of both clock changes, and on the days themselves', () => {
    expect(newYorkTime('2026-10-30', 9).toISOString()).toBe('2026-10-30T13:00:00.000Z'); // EDT
    expect(newYorkTime('2026-11-01', 9).toISOString()).toBe('2026-11-01T14:00:00.000Z'); // EST from 02:00 that day
    expect(newYorkTime('2026-11-02', 9).toISOString()).toBe('2026-11-02T14:00:00.000Z');
    expect(newYorkTime('2027-03-13', 9).toISOString()).toBe('2027-03-13T14:00:00.000Z');
    expect(newYorkTime('2027-03-14', 9).toISOString()).toBe('2027-03-14T13:00:00.000Z'); // EDT from 02:00 that day
    expect(newYorkTime('2027-03-15', 9).toISOString()).toBe('2027-03-15T13:00:00.000Z');
    // Every day of the list's span reads back as 09:00 on that day.
    for (const date of datesBetween('2026-01-01', USPS_HOLIDAYS_THROUGH)) {
      const instant = newYorkTime(date, 9);
      expect([newYorkDate(instant), newYorkClock(instant)], date).toEqual([date, '09:00']);
    }
  });

  it('takes only a whole hour from 0 to 23', () => {
    for (const hour of [9.25, 9.5, -1, 24, Number.NaN]) {
      expect(() => newYorkTime('2026-10-06', hour), String(hour)).toThrow(RangeError);
    }
    expect(() => newYorkTime('2026-10-06', 9.5)).toThrow('hour must be a whole hour from 0 to 23, not 9.5');
    expect(newYorkTime('2026-10-06', 0).toISOString()).toBe('2026-10-06T04:00:00.000Z');
    expect(newYorkTime('2026-10-06', 23).toISOString()).toBe('2026-10-07T03:00:00.000Z');
  });

  it('finds any hour that exists, including the first after the clocks go forward', () => {
    // 02:00 does not exist on 2027-03-14; 03:00 EDT is 07:00 UTC, which a
    // single reading of the offset (taken at the EST side) misses by an hour.
    expect(newYorkTime('2027-03-14', 3).toISOString()).toBe('2027-03-14T07:00:00.000Z');
    expect(newYorkTime('2026-11-01', 3).toISOString()).toBe('2026-11-01T08:00:00.000Z');
    for (const date of datesBetween('2026-10-25', '2026-11-08').concat(datesBetween('2027-03-07', '2027-03-21'))) {
      for (const hour of [0, 3, 12, 23]) {
        const instant = newYorkTime(date, hour);
        expect([newYorkDate(instant), newYorkClock(instant)], `${date} ${hour}`).toEqual([date, `${String(hour).padStart(2, '0')}:00`]);
      }
    }
  });

  it('accepts only real dates written YYYY-MM-DD', () => {
    expect(parseCalendarDate('2026-10-16')).toBe('2026-10-16');
    expect(parseCalendarDate('2028-02-29')).toBe('2028-02-29');
    // A year as written: 0099 is not read as 1999, and 0100 is no leap year while 0400 is.
    expect(parseCalendarDate('0099-01-01')).toBe('0099-01-01');
    expect(parseCalendarDate('0400-02-29')).toBe('0400-02-29');
    for (const value of ['2027-02-29', '0100-02-29', '2026-02-30', '2026-13-01', '2026-00-10', '2026-10-32', '2026-1-5', '10/16/2026', '2026-10-16T09:00', ' 2026-10-16', '2026-10-16\n', '', 'tomorrow']) {
      expect(parseCalendarDate(value), value).toBeNull();
    }
  });

  it('refuses anything but a calendar date loudly, rather than miscounting', () => {
    for (const call of [
      () => isBusinessDay('2026-1-5'),
      () => mailOnFor('next Friday', 7),
      () => addCalendarDays('', 1),
      // Well formed, but no such day: not rolled over into March.
      () => isBusinessDay('2026-02-30'),
      () => addCalendarDays('2026-02-30', 0),
      () => mailOnFor('2026-02-30', 7),
      () => dispatchAt('2026-02-30')
    ]) {
      expect(call).toThrow(RangeError);
    }
    expect(() => mailOnFor('next Friday', 7)).toThrow('Not a calendar date (YYYY-MM-DD): next Friday');
  });
});

describe('business days', () => {
  it('counts weekdays, and not weekends or USPS holidays', () => {
    expect(isBusinessDay('2026-10-01')).toBe(true); // a Thursday
    expect(isBusinessDay('2026-10-02')).toBe(true); // a Friday
    expect(isBusinessDay('2026-10-03')).toBe(false); // a Saturday
    expect(isBusinessDay('2026-10-04')).toBe(false); // a Sunday
    expect(isBusinessDay('2026-10-05')).toBe(true); // a Monday
    for (const holiday of USPS_HOLIDAYS) expect(isBusinessDay(holiday), holiday).toBe(false);
  });

  it('lists every federal holiday as USPS observes it, and no other day', () => {
    const at = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day));
    /** The nth `weekday` (0 is Sunday) of a month. */
    const nth = (year: number, month: number, weekday: number, n: number) => {
      const first = at(year, month, 1).getUTCDay();
      return iso(at(year, month, 1 + ((weekday - first + 7) % 7) + 7 * (n - 1)));
    };
    const lastMonday = (year: number, month: number) => {
      const last = at(year, month + 1, 0);
      return iso(new Date(last.getTime() - ((last.getUTCDay() + 6) % 7) * DAY_MS));
    };
    /** A fixed-date holiday moves to Friday from a Saturday, and to Monday from a Sunday. */
    const observed = (year: number, month: number, day: number) => {
      const date = at(year, month, day);
      const shift = date.getUTCDay() === 6 ? -1 : date.getUTCDay() === 0 ? 1 : 0;
      return iso(new Date(date.getTime() + shift * DAY_MS));
    };
    const ruled = [2026, 2027].flatMap(year => [
      observed(year, 1, 1),
      nth(year, 1, 1, 3), // Martin Luther King Jr. Day
      nth(year, 2, 1, 3), // Washington's Birthday
      lastMonday(year, 5), // Memorial Day
      observed(year, 6, 19),
      observed(year, 7, 4),
      nth(year, 9, 1, 1), // Labor Day
      nth(year, 10, 1, 2), // Columbus Day
      observed(year, 11, 11),
      nth(year, 11, 4, 4), // Thanksgiving Day
      observed(year, 12, 25)
    ]);
    // New Year's Day 2028 is a Saturday, observed in 2027.
    ruled.push(observed(2028, 1, 1));
    expect([...USPS_HOLIDAYS].sort()).toEqual([...new Set(ruled)].filter(date => date <= USPS_HOLIDAYS_THROUGH).sort());
  });

  it('has at least a year of the holiday list left: extend it when this fails', () => {
    const today = newYorkDate(new Date());
    expect((utcDay(USPS_HOLIDAYS_THROUGH) - utcDay(today)) / DAY_MS).toBeGreaterThanOrEqual(365);
  });
});

describe('the mail date for an arrival date', () => {
  it('works back the lead time in business days, past weekends and holidays', () => {
    expect(mailOnFor('2026-10-16', 7)).toBe('2026-10-06'); // past Columbus Day
    expect(mailOnFor('2026-10-19', 7)).toBe('2026-10-07');
    expect(mailOnFor('2026-12-01', 7)).toBe('2026-11-19'); // past Thanksgiving
    expect(mailOnFor('2027-01-04', 7)).toBe('2026-12-22'); // past Christmas and New Year's Day
  });

  it('counts from the last business day on or before a weekend or holiday arrival', () => {
    expect(mailOnFor('2026-10-17', 7)).toBe('2026-10-06'); // a Saturday: as for the Friday
    expect(mailOnFor('2026-10-18', 7)).toBe('2026-10-06'); // a Sunday
    expect(mailOnFor('2026-10-12', 7)).toBe(mailOnFor('2026-10-09', 7)); // Columbus Day: as for the Friday
    expect(mailOnFor('2026-10-13', 0)).toBe('2026-10-13');
    expect(mailOnFor('2026-10-12', 0)).toBe('2026-10-09');
    expect(mailOnFor('2026-10-17', 0)).toBe('2026-10-16');
  });

  it('is a business day with exactly the lead time of business days after it, up to the arrival date', () => {
    for (const leadDays of [0, 1, 3, 7, 10]) {
      for (const arriveBy of datesBetween('2026-10-01', '2027-03-31')) {
        const mailOn = mailOnFor(arriveBy, leadDays);
        expect(isBusinessDay(mailOn), `${arriveBy} ${leadDays}`).toBe(true);
        const between = datesBetween(mailOn, arriveBy).slice(1).filter(isBusinessDay);
        expect(between.length, `${arriveBy} ${leadDays}`).toBe(leadDays);
      }
    }
  });
});

describe('the dates on offer', () => {
  // A Thursday, 10:00 EDT.
  const THURSDAY_MORNING = new Date('2026-10-01T14:00:00Z');

  it('mails today until noon in New York on a business day, and on the next business day after', () => {
    expect(earliestMailOn(THURSDAY_MORNING)).toBe('2026-10-01');
    expect(earliestMailOn(new Date('2026-10-01T15:59:59Z'))).toBe('2026-10-01'); // 11:59:59 EDT
    expect(earliestMailOn(new Date('2026-10-01T16:00:00Z'))).toBe('2026-10-02'); // 12:00 EDT
    // 08:30 EDT is 12:30 UTC: the cutoff is New York's noon, not UTC's.
    expect(earliestMailOn(new Date('2026-10-01T12:30:00Z'))).toBe('2026-10-01');
    expect(earliestMailOn(new Date('2026-12-01T16:30:00Z'))).toBe('2026-12-01'); // 11:30 EST
    expect(earliestMailOn(new Date('2026-12-01T17:00:00Z'))).toBe('2026-12-02'); // 12:00 EST
    expect(earliestMailOn(new Date('2026-10-03T14:00:00Z'))).toBe('2026-10-05'); // a Saturday
    expect(earliestMailOn(new Date('2026-10-09T17:00:00Z'))).toBe('2026-10-13'); // Friday afternoon, then Columbus Day
    expect(earliestMailOn(new Date('2026-10-12T14:00:00Z'))).toBe('2026-10-13'); // Columbus Day morning
  });

  it('offers the lead time of business days after the first mail date as the earliest arrival', () => {
    expect(earliestArrival(THURSDAY_MORNING, 7)).toBe('2026-10-13');
    expect(earliestArrival(new Date('2026-10-01T16:00:00Z'), 7)).toBe('2026-10-14');
    expect(earliestArrival(new Date('2026-10-03T14:00:00Z'), 7)).toBe('2026-10-15');
    expect(earliestArrival(THURSDAY_MORNING, 0)).toBe('2026-10-01');
    // The earliest arrival mails on the first mail date, never before it.
    for (const now of datesBetween('2026-10-01', '2027-02-28').map(date => new Date(`${date}T14:00:00Z`))) {
      expect(mailOnFor(earliestArrival(now, 7), 7), now.toISOString()).toBe(earliestMailOn(now));
    }
  });

  it('offers dates up to the horizon from New York today, never past the holiday list', () => {
    expect(latestArrival(THURSDAY_MORNING, 60)).toBe('2026-11-30');
    expect(latestArrival(new Date('2026-10-02T03:00:00Z'), 60)).toBe('2026-11-30'); // still Oct 1 in New York
    expect(latestArrival(new Date('2027-12-01T14:00:00Z'), 60)).toBe(USPS_HOLIDAYS_THROUGH);
  });
});

describe('releasing held mail', () => {
  it('releases it at 09:00 New York time on its mail date', () => {
    expect(dispatchAt('2026-10-06').toISOString()).toBe('2026-10-06T13:00:00.000Z');
    expect(dispatchAt('2026-12-01').toISOString()).toBe('2026-12-01T14:00:00.000Z');
  });
});

describe('checking an arrival date', () => {
  const NOW = new Date('2026-10-01T14:00:00Z');

  it('gives the mail date and the release time for a date it can meet', () => {
    expect(checkArrival('2026-10-16', NOW, SETTINGS)).toEqual({
      ok: true,
      arriveBy: '2026-10-16',
      mailOn: '2026-10-06',
      dispatchAt: new Date('2026-10-06T13:00:00Z'),
      earliestArrival: '2026-10-13',
      latestArrival: '2026-11-30'
    });
  });

  it('accepts the earliest and the latest dates, and refuses the days either side with both', () => {
    expect(checkArrival('2026-10-13', NOW, SETTINGS)).toMatchObject({ ok: true, mailOn: '2026-10-01' });
    expect(checkArrival('2026-11-30', NOW, SETTINGS)).toMatchObject({ ok: true, mailOn: '2026-11-18' });
    const range = { earliestArrival: '2026-10-13', latestArrival: '2026-11-30' };
    expect(checkArrival('2026-10-12', NOW, SETTINGS)).toEqual({ ok: false, reason: 'too_soon', ...range });
    expect(checkArrival('2026-12-01', NOW, SETTINGS)).toEqual({ ok: false, reason: 'too_late', ...range });
    expect(checkArrival('2026-09-30', NOW, SETTINGS)).toEqual({ ok: false, reason: 'too_soon', ...range });
  });

  it('refuses what is not a date, with the dates it can offer', () => {
    for (const value of ['2026-02-30', '10/16/2026', 'next Friday', '']) {
      expect(checkArrival(value, NOW, SETTINGS), value).toEqual({
        ok: false,
        reason: 'invalid_date',
        earliestArrival: '2026-10-13',
        latestArrival: '2026-11-30'
      });
    }
  });

  it('refuses a lead time or horizon that is not a whole number of days from 0 to 1000', () => {
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, 1001]) {
      expect(() => mailOnFor('2026-10-16', bad), String(bad)).toThrow(RangeError);
      expect(() => earliestArrival(NOW, bad), String(bad)).toThrow(RangeError);
      expect(() => latestArrival(NOW, bad), String(bad)).toThrow(RangeError);
      expect(() => checkArrival('2026-10-16', NOW, { leadDays: bad, horizonDays: 60 }), String(bad)).toThrow(RangeError);
      expect(() => checkArrival('2026-10-16', NOW, { leadDays: 7, horizonDays: bad }), String(bad)).toThrow(RangeError);
    }
    expect(() => mailOnFor('2026-10-16', Number.NaN)).toThrow('leadDays must be a whole number of days from 0 to 1000, not NaN');
    expect(() => latestArrival(NOW, -1)).toThrow('horizonDays must be a whole number of days from 0 to 1000, not -1');
    // The bounds themselves are fine.
    expect(mailOnFor('2026-10-16', 0)).toBe('2026-10-16');
    expect(latestArrival(NOW, 0)).toBe('2026-10-01');
    expect(() => earliestArrival(NOW, 1000)).not.toThrow();
  });

  it('says nothing can be scheduled when the earliest date is past the latest, not that one is too soon', () => {
    // Ten days before the holiday list ends: the lead time runs past it.
    expect(checkArrival('2027-12-31', new Date('2027-12-21T14:00:00Z'), SETTINGS)).toEqual({
      ok: false,
      reason: 'unavailable',
      earliestArrival: '2028-01-03',
      latestArrival: '2027-12-31'
    });
    // A horizon shorter than the lead time.
    expect(checkArrival('2026-10-13', NOW, { leadDays: 7, horizonDays: 5 })).toMatchObject({ ok: false, reason: 'unavailable' });
    // Equal is still a date on offer.
    expect(checkArrival('2026-10-13', NOW, { leadDays: 7, horizonDays: 12 })).toMatchObject({ ok: true, mailOn: '2026-10-01' });
    // A date that is not one is still named as such, and a date past the
    // latest is unavailable too, not too late.
    expect(checkArrival('soon', NOW, { leadDays: 7, horizonDays: 5 })).toMatchObject({ ok: false, reason: 'invalid_date' });
    expect(checkArrival('2028-01-10', new Date('2027-12-21T14:00:00Z'), SETTINGS)).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('uses the lead time and the horizon it is given', () => {
    expect(checkArrival('2026-10-02', NOW, { leadDays: 1, horizonDays: 60 })).toMatchObject({ ok: true, mailOn: '2026-10-01' });
    expect(checkArrival('2026-10-20', NOW, { leadDays: 7, horizonDays: 15 })).toMatchObject({ ok: false, reason: 'too_late', latestArrival: '2026-10-16' });
  });
});
