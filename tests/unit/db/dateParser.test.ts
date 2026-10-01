/**
 * DATE columns read as calendar dates (#535): node-postgres would otherwise
 * make an instant at local midnight, which names another day in a process
 * not running in UTC.
 */

import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { readDatesAsStrings } from '../../../src/db/dateParser.js';

const DATE = pg.types.builtins.DATE;
const parseDate = () => pg.types.getTypeParser(DATE, 'text');
/** node-postgres's own behaviour, put back before each check that loading a module registers ours. */
const resetToDates = () => pg.types.setTypeParser(DATE, (value: string) => new Date(`${value}T00:00:00`));

describe('readDatesAsStrings', () => {
  it('hands back a DATE exactly as PostgreSQL sends it, and leaves timestamps alone', () => {
    resetToDates();
    readDatesAsStrings();
    expect(parseDate()('2026-10-06')).toBe('2026-10-06');
    expect(parseDate()('2027-12-31')).toBe('2027-12-31');
    expect(pg.types.getTypeParser(pg.types.builtins.TIMESTAMPTZ, 'text')('2026-10-06 13:00:00+00')).toBeInstanceOf(Date);
  });

  it('is registered by loading the API database module, which the services read whole rows through', async () => {
    resetToDates();
    expect(parseDate()('2026-10-06')).toBeInstanceOf(Date);
    await import('../../../src/db/index.js');
    expect(parseDate()('2026-10-06')).toBe('2026-10-06');
  });

  it("is registered by loading the admin panel's database module too", async () => {
    resetToDates();
    await import('../../../src/admin/db.js');
    expect(parseDate()('2026-10-06')).toBe('2026-10-06');
  });
});
