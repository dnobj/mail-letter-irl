import pg from 'pg';

/**
 * DATE columns read as the 'YYYY-MM-DD' string PostgreSQL sends (#535).
 *
 * node-postgres turns a DATE into a JavaScript Date at local midnight, an
 * instant that names a different day in any process not running in UTC. Every
 * DATE here is a calendar date: letter_drafts and letters' arrive_by and
 * mail_on (migration 040, in America/New_York, compared as strings by
 * src/services/deliverySchedule.ts), and daily_limit_refusals.utc_day, which
 * its reader casts to text anyway. The services read whole rows (`SELECT *`),
 * so the type parser, not each query, has to be right.
 *
 * pg's parsers are global to the module, so registering once affects every
 * pool in the process; the API and the admin panel each register on load.
 */
export function readDatesAsStrings(): void {
  pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);
}
