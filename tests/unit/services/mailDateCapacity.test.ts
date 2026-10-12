/**
 * Room on a mail date (#700): letters still queued for a mail date, counted
 * against LETTER_IRL_SCHEDULE_DAILY_CAP, and a full date answered with the
 * nearest arrival dates whose mail dates have room. The send's use, under its
 * lock, is in mailSendService.test.ts; against real rows, in
 * tests/integration/arriveBy.postgres.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chooseAgainSentence,
  fullMailDate,
  openArrivalsOf,
  openArrivalsSentence
} from '../../../src/services/mailDateCapacity.js';

// A Thursday, 10:00 in New York: the earliest arrival is Tue Oct 13 (Oct 12 is Columbus Day).
const NOW = new Date('2026-10-01T14:00:00Z');
// Arrives by Fri Oct 16: mails on Tue Oct 6.
const SCHEDULE = { arriveBy: '2026-10-16', mailOn: '2026-10-06' };

function db(heldOnDate: number, window: Array<{ mail_on: string; held: number | string }> = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('GROUP BY mail_on')) return { rows: window };
    if (sql.includes('AS held')) return { rows: [{ held: heldOnDate }] };
    return { rows: [] };
  });
  return { client: { query } as never, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('fullMailDate', () => {
  it('has room below the cap, counting only queued letters with that mail date, and reads nothing more', async () => {
    vi.stubEnv('LETTER_IRL_SCHEDULE_DAILY_CAP', '3');
    const { client, calls } = db(2);

    await expect(fullMailDate(client, SCHEDULE, NOW)).resolves.toBeNull();

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("status = 'queued'");
    expect(calls[0].sql).toContain('mail_on IS NOT NULL');
    expect(calls[0].sql).toContain('mail_on = $1::date');
    expect(calls[0].params).toEqual(['2026-10-06']);
  });

  it('reads a count the driver returns as text', async () => {
    vi.stubEnv('LETTER_IRL_SCHEDULE_DAILY_CAP', '3');
    await expect(fullMailDate(db('3' as never).client, SCHEDULE, NOW)).resolves.not.toBeNull();
    await expect(fullMailDate(db('2' as never).client, SCHEDULE, NOW)).resolves.toBeNull();
  });

  it('is full at the cap, and names the nearest arrival dates whose mail dates have room', async () => {
    vi.stubEnv('LETTER_IRL_SCHEDULE_DAILY_CAP', '3');
    // Oct 1 is full (Tue Oct 13 mails then), and Oct 7 (Mon Oct 19); Oct 5 (Thu Oct 15) is one short.
    const { client, calls } = db(3, [
      { mail_on: '2026-10-01', held: 3 },
      { mail_on: '2026-10-05', held: '2' },
      { mail_on: '2026-10-07', held: 9 }
    ]);

    await expect(fullMailDate(client, SCHEDULE, NOW)).resolves.toEqual({
      mailOn: '2026-10-06',
      openArrivals: ['2026-10-14', '2026-10-15', '2026-10-20']
    });

    // The window on offer: from the earliest arrival's mail date to the latest's (Mon Nov 30 mails on
    // Wed Nov 18, Thanksgiving being no business day).
    expect(calls[1].sql).toContain("status = 'queued'");
    expect(calls[1].sql).toContain('mail_on BETWEEN $1::date AND $2::date');
    expect(calls[1].params).toEqual(['2026-10-01', '2026-11-18']);
  });

  it('never offers the full date itself, even when the window says it has room', async () => {
    vi.stubEnv('LETTER_IRL_SCHEDULE_DAILY_CAP', '3');
    const full = await fullMailDate(db(3, []).client, SCHEDULE, NOW);
    // Tue Oct 13 and Mon Oct 19 are as near: the earlier.
    expect(full?.openArrivals).toEqual(['2026-10-13', '2026-10-14', '2026-10-15']);
  });

  it('is full above the cap too, with the default cap of 200', async () => {
    await expect(fullMailDate(db(199).client, SCHEDULE, NOW)).resolves.toBeNull();
    await expect(fullMailDate(db(200).client, SCHEDULE, NOW)).resolves.toMatchObject({ mailOn: '2026-10-06' });
    await expect(fullMailDate(db(201).client, SCHEDULE, NOW)).resolves.toMatchObject({ mailOn: '2026-10-06' });
  });

  it('names no dates, and reads no window, when none is on offer', async () => {
    vi.stubEnv('LETTER_IRL_SCHEDULE_DAILY_CAP', '1');
    vi.stubEnv('LETTER_IRL_SCHEDULE_HORIZON_DAYS', '2');
    const { client, calls } = db(1);

    await expect(fullMailDate(client, SCHEDULE, NOW)).resolves.toEqual({ mailOn: '2026-10-06', openArrivals: [] });
    expect(calls).toHaveLength(1);
  });

  it('with lock, takes the date lock before it counts', async () => {
    const { client, calls } = db(0);

    await fullMailDate(client, SCHEDULE, NOW, { lock: true });

    expect(calls.map(call => call.params)).toEqual([['2026-10-06'], ['2026-10-06']]);
    expect(calls[0].sql).toBe("SELECT pg_advisory_xact_lock(hashtext('letter_irl.mail_on'), hashtext($1))");
    expect(calls[1].sql).toContain('AS held');
  });

  it('without lock, takes none', async () => {
    const { client, calls } = db(0);
    await fullMailDate(client, SCHEDULE, NOW);
    expect(calls.some(call => call.sql.includes('advisory'))).toBe(false);
  });
});

describe('the words for the open dates', () => {
  it('lists them, with their YYYY-MM-DD for a model', () => {
    expect(openArrivalsSentence(['2026-10-14', '2026-10-15', '2026-10-20'], NOW, true)).toBe(
      'The nearest arrival dates with room are Wed, Oct 14 (2026-10-14), Thu, Oct 15 (2026-10-15) and Tue, Oct 20 (2026-10-20).'
    );
    expect(openArrivalsSentence(['2026-10-14', '2026-10-20'], NOW, false)).toBe(
      'The nearest arrival dates with room are Wed, Oct 14 and Tue, Oct 20.'
    );
    expect(openArrivalsSentence(['2026-10-14'], NOW, false)).toBe('The nearest arrival date with room is Wed, Oct 14.');
    expect(openArrivalsSentence([], NOW, true)).toBe('No other arrival date on offer has room right now.');
  });

  it('says what to do next: another date, or none when no other has room (review round 3)', () => {
    expect(chooseAgainSentence(['2026-10-14'], 'then send it again')).toBe(
      'Choose another arrival date for it, or none to send it as soon as possible, then send it again.'
    );
    expect(chooseAgainSentence([], 'then ask again')).toBe('Choose no arrival date for it, to send it as soon as possible, then ask again.');
    expect(chooseAgainSentence(['2026-10-14'], 'then come back and send it', ' in the chat')).toBe(
      'Choose another arrival date for it in the chat, or none to send it as soon as possible, then come back and send it.'
    );
  });

  it('reads the dates a refusal carries, and none from anything else', () => {
    expect(openArrivalsOf(Object.assign(new Error('full'), { openArrivals: ['2026-10-14', 7, '2026-10-20'] }))).toEqual([
      '2026-10-14',
      '2026-10-20'
    ]);
    expect(openArrivalsOf(new Error('full'))).toEqual([]);
    expect(openArrivalsOf({ openArrivals: '2026-10-14' })).toEqual([]);
    expect(openArrivalsOf(null)).toEqual([]);
  });
});
