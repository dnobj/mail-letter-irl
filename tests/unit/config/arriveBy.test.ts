/**
 * Arrive-by's settings (#535): off unless explicitly on, a lead time that
 * development may lower to 0 and production may not lower below 3, and a
 * horizon; each falls back to its default on anything it cannot honour.
 */

import { describe, expect, it } from 'vitest';
import {
  ARRIVE_BY_DEFAULTS,
  isArriveByEnabled,
  scheduleHorizonDays,
  scheduleLeadDays
} from '../../../src/config/arriveBy.js';

const PRODUCTION = { NODE_ENV: 'production', LETTER_IRL_DEPLOYMENT_ENVIRONMENT: 'production' };
// Deployed development runs NODE_ENV=production too; its identity says which.
const DEVELOPMENT = { NODE_ENV: 'production', LETTER_IRL_DEPLOYMENT_ENVIRONMENT: 'development' };

describe('isArriveByEnabled', () => {
  it('is on only when explicitly on, and off on a typo', () => {
    expect(isArriveByEnabled({})).toBe(false);
    expect(isArriveByEnabled({ LETTER_IRL_ARRIVE_BY_ENABLED: 'true' })).toBe(true);
    expect(isArriveByEnabled({ LETTER_IRL_ARRIVE_BY_ENABLED: ' TRUE ' })).toBe(true);
    expect(isArriveByEnabled({ LETTER_IRL_ARRIVE_BY_ENABLED: 'ture' })).toBe(false);
    expect(isArriveByEnabled({ LETTER_IRL_ARRIVE_BY_ENABLED: 'false' })).toBe(false);
  });
});

describe('scheduleLeadDays', () => {
  it('defaults to 7 business days', () => {
    expect(ARRIVE_BY_DEFAULTS.leadDays).toBe(7);
    expect(scheduleLeadDays({})).toBe(7);
  });

  it('takes 0 to 30 outside production, so development can hold to near dates', () => {
    expect(scheduleLeadDays({ LETTER_IRL_SCHEDULE_LEAD_DAYS: '0' })).toBe(0);
    expect(scheduleLeadDays({ LETTER_IRL_SCHEDULE_LEAD_DAYS: '30' })).toBe(30);
    expect(scheduleLeadDays({ LETTER_IRL_SCHEDULE_LEAD_DAYS: '31' })).toBe(7);
    expect(scheduleLeadDays({ LETTER_IRL_SCHEDULE_LEAD_DAYS: 'seven' })).toBe(7);
    expect(scheduleLeadDays({ LETTER_IRL_SCHEDULE_LEAD_DAYS: '5days' })).toBe(7);
  });

  it('refuses less than 3 in production and keeps the default', () => {
    expect(scheduleLeadDays({ ...PRODUCTION, LETTER_IRL_SCHEDULE_LEAD_DAYS: '0' })).toBe(7);
    expect(scheduleLeadDays({ ...PRODUCTION, LETTER_IRL_SCHEDULE_LEAD_DAYS: '2' })).toBe(7);
    expect(scheduleLeadDays({ ...PRODUCTION, LETTER_IRL_SCHEDULE_LEAD_DAYS: '3' })).toBe(3);
    expect(scheduleLeadDays({ ...PRODUCTION, LETTER_IRL_SCHEDULE_LEAD_DAYS: '9' })).toBe(9);
    // NODE_ENV=production without an identity is treated as production.
    expect(scheduleLeadDays({ NODE_ENV: 'production', LETTER_IRL_SCHEDULE_LEAD_DAYS: '0' })).toBe(7);
  });

  it('lets deployed development, which also runs NODE_ENV=production, go to 0', () => {
    expect(scheduleLeadDays({ ...DEVELOPMENT, LETTER_IRL_SCHEDULE_LEAD_DAYS: '0' })).toBe(0);
  });
});

describe('scheduleHorizonDays', () => {
  it('defaults to 60 days and takes 1 to 365', () => {
    expect(ARRIVE_BY_DEFAULTS.horizonDays).toBe(60);
    expect(scheduleHorizonDays({})).toBe(60);
    expect(scheduleHorizonDays({ LETTER_IRL_SCHEDULE_HORIZON_DAYS: '1' })).toBe(1);
    expect(scheduleHorizonDays({ LETTER_IRL_SCHEDULE_HORIZON_DAYS: '365' })).toBe(365);
    expect(scheduleHorizonDays({ LETTER_IRL_SCHEDULE_HORIZON_DAYS: '0' })).toBe(60);
    expect(scheduleHorizonDays({ LETTER_IRL_SCHEDULE_HORIZON_DAYS: '366' })).toBe(60);
  });
});
