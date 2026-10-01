/**
 * Cancelling held mail (#535): the transaction's order of checks and locks,
 * what it writes, and what goes back. The SQL itself runs against PostgreSQL
 * in tests/integration/arriveBy.postgres.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/index.js', () => ({ transaction: vi.fn(), query: vi.fn() }));
vi.mock('../../../src/services/creditLedgerService.js', () => ({ returnConsumedCreditsForLetter: vi.fn() }));
vi.mock('../../../src/services/giftLetterService.js', () => ({ returnGiftLetterForFailedSendWithClient: vi.fn() }));

import { query, transaction } from '../../../src/db/index.js';
import { returnConsumedCreditsForLetter } from '../../../src/services/creditLedgerService.js';
import { returnGiftLetterForFailedSendWithClient } from '../../../src/services/giftLetterService.js';
import {
  CANCELLED_BY_CUSTOMER,
  MISSED_MAIL_DAY_ALERT,
  cancelScheduledMail,
  raiseMissedMailDayAlerts
} from '../../../src/services/scheduledMailService.js';

const LETTER = 'ltr-1';
const USER = 'auth0|owner';
const HELD = { status: 'queued', funding_type: 'prepaid_balance', credits_cost: 2, arrive_by: '2026-10-16', mail_on: '2026-10-06' };
const JOB = { job_id: 'job-1', status: 'pending', provider_outcome: 'not_dispatched' };

/** A transaction whose statements answer in turn; the client is returned to read its calls. */
function inTransaction(...answers: Array<{ rows: unknown[] } | Error>) {
  const client = { query: vi.fn() };
  for (const answer of answers) {
    if (answer instanceof Error) client.query.mockRejectedValueOnce(answer);
    else client.query.mockResolvedValueOnce(answer);
  }
  client.query.mockResolvedValue({ rows: [], rowCount: 1 });
  vi.mocked(transaction).mockImplementation(async callback => callback(client as never));
  return client;
}

const cancel = () => cancelScheduledMail({ letterId: LETTER, userId: USER });
const sql = (client: { query: ReturnType<typeof vi.fn> }) => client.query.mock.calls.map(call => String(call[0]));

beforeEach(() => {
  vi.mocked(transaction).mockReset();
  vi.mocked(returnConsumedCreditsForLetter).mockReset().mockResolvedValue(2);
  vi.mocked(returnGiftLetterForFailedSendWithClient).mockReset().mockResolvedValue(1);
});

describe('cancelScheduledMail (#535)', () => {
  it("cancels held prepaid mail: locks the caller's letter, then its job without waiting, cancels both, records it and returns the letter", async () => {
    const client = inTransaction({ rows: [HELD] }, { rows: [JOB] });

    // The return gives back 2 credits: one letter (CREDITS_PER_LETTER), not two.
    await expect(cancel()).resolves.toEqual({
      ok: true,
      cancelled: {
        letterId: LETTER,
        alreadyCancelled: false,
        returned: { kind: 'letters', count: 1 },
        shortfall: 'none',
        arriveBy: '2026-10-16',
        mailOn: '2026-10-06'
      }
    });

    const [letterLock, jobLock, jobUpdate, letterUpdate, history] = client.query.mock.calls as Array<[string, unknown[]]>;
    expect(letterLock[0]).toMatch(/SELECT status, funding_type, credits_cost, arrive_by, mail_on FROM letters\s+WHERE letter_id = \$1 AND user_id = \$2\s+FOR UPDATE$/);
    expect(letterLock[1]).toEqual([LETTER, USER]);
    expect(jobLock[0]).toMatch(/FROM letter_jobs\s+WHERE letter_id = \$1\s+FOR UPDATE NOWAIT$/);
    expect(jobUpdate[0]).toMatch(/UPDATE letter_jobs\s+SET status = 'cancelled', locked_at = NULL, completed_at = NOW\(\),\s+last_error = \$2/);
    expect(jobUpdate[1]).toEqual(['job-1', CANCELLED_BY_CUSTOMER]);
    expect(letterUpdate[0]).toMatch(/UPDATE letters\s+SET status = 'cancelled', status_updated_at = NOW\(\)/);
    expect(letterUpdate[1]).toEqual([LETTER]);
    expect(history[0]).toMatch(/INSERT INTO letter_status_history[\s\S]*'queued', 'cancelled', 'customer'/);
    expect(returnConsumedCreditsForLetter).toHaveBeenCalledWith(client, {
      letterId: LETTER,
      userId: USER,
      failureCode: 'cancelled_by_customer',
      cause: 'cancelled'
    });
    expect(returnGiftLetterForFailedSendWithClient).not.toHaveBeenCalled();
  });

  it('returns a gift letter for held gift mail', async () => {
    const client = inTransaction({ rows: [{ ...HELD, funding_type: 'gift_letter' }] }, { rows: [JOB] });

    await expect(cancel()).resolves.toMatchObject({ ok: true, cancelled: { returned: { kind: 'gift_letter', count: 1 } } });
    expect(returnGiftLetterForFailedSendWithClient).toHaveBeenCalledWith(client, {
      letterId: LETTER,
      userId: USER,
      failureCode: 'cancelled_by_customer',
      cause: 'cancelled'
    });
    expect(returnConsumedCreditsForLetter).not.toHaveBeenCalled();
  });

  it('counts as refunded what the return could not give back, asking nothing more', async () => {
    vi.mocked(returnConsumedCreditsForLetter).mockResolvedValue(0);
    const client = inTransaction({ rows: [HELD] }, { rows: [JOB] });
    await expect(cancel()).resolves.toMatchObject({
      ok: true,
      cancelled: { returned: { kind: 'letters', count: 0 }, shortfall: 'refunded' }
    });
    expect(client.query).toHaveBeenCalledTimes(5);
  });

  it("does not count credits that came back already expired: their lot ran out while the mail was held", async () => {
    const client = inTransaction({ rows: [HELD] }, { rows: [JOB] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [{ expired: 2 }] });

    await expect(cancel()).resolves.toMatchObject({
      ok: true,
      cancelled: { returned: { kind: 'letters', count: 0 }, shortfall: 'expired' }
    });
    const [expiredSql, expiredParams] = client.query.mock.calls[5] as [string, unknown[]];
    expect(expiredSql).toMatch(/SUM\(initial_amount\)[\s\S]*source_metadata->>'letter_id' = \$2[\s\S]*source_metadata->>'reason' = 'send_failed'[\s\S]*expires_at <= NOW\(\)/);
    expect(expiredParams).toEqual([USER, LETTER]);
  });

  it('calls part of it back a partial return: a credit refunded or expired', async () => {
    vi.mocked(returnConsumedCreditsForLetter).mockResolvedValue(1);
    inTransaction({ rows: [HELD] }, { rows: [JOB] });
    await expect(cancel()).resolves.toMatchObject({
      ok: true,
      cancelled: { returned: { kind: 'letters', count: 0 }, shortfall: 'partial' }
    });
  });

  it('counts a gift that could not come back as refunded', async () => {
    vi.mocked(returnGiftLetterForFailedSendWithClient).mockResolvedValue(0);
    inTransaction({ rows: [{ ...HELD, funding_type: 'gift_letter' }] }, { rows: [JOB] });
    await expect(cancel()).resolves.toMatchObject({
      ok: true,
      cancelled: { returned: { kind: 'gift_letter', count: 0 }, shortfall: 'refunded' }
    });
  });

  it('answers a letter already cancelled as cancelled, changing and returning nothing', async () => {
    const client = inTransaction({ rows: [{ ...HELD, status: 'cancelled' }] });

    await expect(cancel()).resolves.toEqual({
      ok: true,
      cancelled: {
        letterId: LETTER,
        alreadyCancelled: true,
        returned: { kind: 'letters', count: 0 },
        shortfall: 'none',
        arriveBy: '2026-10-16',
        mailOn: '2026-10-06'
      }
    });
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(returnConsumedCreditsForLetter).not.toHaveBeenCalled();
  });

  it.each([
    ["missing, or someone else's", [], 'not_found'],
    ['Pay & Send', [{ ...HELD, funding_type: 'jit_order' }], 'pay_and_send'],
    ['sent with no arrival date', [{ ...HELD, arrive_by: null, mail_on: null }], 'not_scheduled'],
    ['at the printer', [{ ...HELD, status: 'accepted' }], 'too_late'],
    ['failed', [{ ...HELD, status: 'failed' }], 'too_late'],
    // Where it is comes first: printed mail is too late whatever paid for it.
    ['Pay & Send, already printed', [{ ...HELD, funding_type: 'jit_order', status: 'accepted' }], 'too_late'],
    ['sent with no date, already printed', [{ ...HELD, arrive_by: null, mail_on: null, status: 'accepted' }], 'too_late']
  ])('refuses a letter that is %s, reading nothing more', async (_label, rows, refusal) => {
    const client = inTransaction({ rows });

    await expect(cancel()).resolves.toEqual({ ok: false, refusal });
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(returnConsumedCreditsForLetter).not.toHaveBeenCalled();
  });

  it.each([
    ['taken by the outbox', [{ ...JOB, status: 'processing' }]],
    ['dispatched', [{ ...JOB, provider_outcome: 'dispatching' }]],
    ['held after an ambiguous dispatch', [{ ...JOB, status: 'held', provider_outcome: 'ambiguous' }]],
    ['missing', []]
  ])('refuses as too late a held letter whose job is %s, writing nothing', async (_label, rows) => {
    const client = inTransaction({ rows: [HELD] }, { rows });

    await expect(cancel()).resolves.toEqual({ ok: false, refusal: 'too_late' });
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(returnConsumedCreditsForLetter).not.toHaveBeenCalled();
  });

  it.each([
    ['Pay & Send cancelled by a refund', { funding_type: 'jit_order' }],
    ['sent with no date, cancelled by a refund', { arrive_by: null, mail_on: null }]
  ])('answers a letter that is %s as already cancelled', async (_label, overrides) => {
    inTransaction({ rows: [{ ...HELD, ...overrides, status: 'cancelled' }] });
    await expect(cancel()).resolves.toMatchObject({ ok: true, cancelled: { alreadyCancelled: true } });
  });

  it("answers 'busy' when the outbox holds the job's lock, rather than waiting", async () => {
    // The job's NOWAIT raises lock_not_available; transaction() rolls back and
    // rethrows it, as src/db/index.ts does.
    const client = inTransaction({ rows: [HELD] }, Object.assign(new Error('could not obtain lock on row'), { code: '55P03' }));

    await expect(cancel()).resolves.toEqual({ ok: false, refusal: 'busy' });
    expect(sql(client)).toHaveLength(2);
    expect(returnConsumedCreditsForLetter).not.toHaveBeenCalled();
  });

  it('lets any other failure through', async () => {
    vi.mocked(transaction).mockRejectedValue(Object.assign(new Error('connection reset'), { code: '08006' }));
    await expect(cancel()).rejects.toThrow('connection reset');
  });
});

describe('raiseMissedMailDayAlerts (#535)', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('raises one alert per held letter not at the printer by 18:00 New York time on its mail date', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [{}, {}], rowCount: 2 } as never);

    await expect(raiseMissedMailDayAlerts()).resolves.toBe(2);

    const [sql, params] = vi.mocked(query).mock.calls[0] as unknown as [string, unknown[]];
    const flat = sql.replace(/\s+/g, ' ');
    expect(MISSED_MAIL_DAY_ALERT).toBe('schedule_missed_mail_day');
    expect(params).toEqual([MISSED_MAIL_DAY_ALERT]);
    expect(flat).toContain('INSERT INTO commerce_operational_alerts (order_id, alert_type, severity, details)');
    expect(flat).toContain("SELECT held.funding_order_id, $1::varchar, 'warning'");
    expect(flat).toContain("jsonb_build_object('letterId', held.letter_id, 'mailOn', held.mail_on::text)");
    expect(flat).toContain('held.mail_on IS NOT NULL');
    // Failed too: its retries ran out, or the provider refused it.
    expect(flat).toContain("held.status IN ('queued', 'processing', 'failed')");
    expect(flat).toContain("(held.mail_on + TIME '18:00') AT TIME ZONE 'America/New_York' < NOW()");
    // Once per letter, ever, even when two runs overlap (041's unique index).
    expect(flat).toContain("NOT EXISTS ( SELECT 1 FROM commerce_operational_alerts seen WHERE seen.alert_type = $1::varchar AND seen.details->>'letterId' = held.letter_id )");
    expect(flat).toContain('LIMIT 100 ON CONFLICT DO NOTHING RETURNING alert_id');
  });

  it('raises nothing quietly when nothing is late', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
    await expect(raiseMissedMailDayAlerts()).resolves.toBe(0);
  });

  it('never throws: a failed check is logged and the hourly run goes on', async () => {
    vi.mocked(query).mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    await expect(raiseMissedMailDayAlerts()).resolves.toBe(0);
  });
});
