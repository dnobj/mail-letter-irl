/**
 * Days USPS does not deliver or collect mail on weekdays: the federal holidays,
 * on the day they are observed (#535). A holiday on a Saturday is observed the
 * Friday before, and one on a Sunday the Monday after, so New Year's Day 2028,
 * a Saturday, closes Friday, December 31, 2027.
 *
 * A list rather than rules, so a one-off closure (a national day of mourning
 * closes post offices) can be added on the day it is announced. A test checks
 * it against the rules, and fails once less than a year of it remains:
 * extend it then. Scheduling never offers a date past its end
 * (deliverySchedule.ts), because it cannot tell a business day there.
 */

export const USPS_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // Martin Luther King Jr. Day
  '2026-02-16', // Washington's Birthday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (Saturday, observed Friday)
  '2026-09-07', // Labor Day
  '2026-10-12', // Columbus Day
  '2026-11-11', // Veterans Day
  '2026-11-26', // Thanksgiving Day
  '2026-12-25', // Christmas Day
  // 2027
  '2027-01-01', // New Year's Day
  '2027-01-18', // Martin Luther King Jr. Day
  '2027-02-15', // Washington's Birthday
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth (Saturday, observed Friday)
  '2027-07-05', // Independence Day (Sunday, observed Monday)
  '2027-09-06', // Labor Day
  '2027-10-11', // Columbus Day
  '2027-11-11', // Veterans Day
  '2027-11-25', // Thanksgiving Day
  '2027-12-24', // Christmas Day (Saturday, observed Friday)
  '2027-12-31' // New Year's Day 2028 (Saturday, observed Friday)
]);

/** The last date the list covers. */
export const USPS_HOLIDAYS_THROUGH = '2027-12-31';
