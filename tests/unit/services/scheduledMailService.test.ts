/**
 * Cancelling held mail (#535): the transaction's order of checks and locks,
 * what it writes, and what goes back. The SQL itself runs against PostgreSQL
 * in tests/integration/arriveBy.postgres.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/index.js', () => ({ transaction: vi.fn() }));
vi.mock('../../../src/services/creditLedgerService.js', () => ({ returnConsumedCreditsForLetter: vi.fn() }));
vi.mock('../../../src/services/giftLetterService.js', () => ({ returnGiftLetterForFailedSendWithClient: vi.fn() }));

import { transaction } from '../../../src/db/index.js';
import { returnConsumedCreditsForLetter } from '../../../src/services/creditLedgerService.js';
import { returnGiftLetterForFailedSendWithClient } from '../../../src/services/giftLetterService.js';
import {
  CANCELLED_BY_CUSTOMER,
  cancelScheduledMail
} from '../../../src/services/scheduledMailService.js';

const LETTER = 'ltr-1';
const USER = 'auth0|owner';
const HELD = { status: 'queued', funding_type: 'prepaid_balance', arrive_by: '2026-10-16', mail_on: '2026-10-06' };
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
  it("cancels held prepaid mail: locks the caller's letter, then its job without waiting, cancels both, records it and returns the letters", async () => {
    const client = inTransaction({ rows: [HELD] }, { rows: [JOB] });

    await expect(cancel()).resolves.toEqual({
      ok: true,
      cancelled: {
        letterId: LETTER,
        alreadyCancelled: false,
        returned: { kind: 'letters', count: 2 },
        arriveBy: '2026-10-16',
        mailOn: '2026-10-06'
      }
    });

    const [letterLock, jobLock, jobUpdate, letterUpdate, history] = client.query.mock.calls as Array<[string, unknown[]]>;
    expect(letterLock[0]).toMatch(/FROM letters\s+WHERE letter_id = \$1 AND user_id = \$2\s+FOR UPDATE$/);
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

  it('says what went back when nothing could (what paid for it was refunded)', async () => {
    vi.mocked(returnConsumedCreditsForLetter).mockResolvedValue(0);
    inTransaction({ rows: [HELD] }, { rows: [JOB] });
    await expect(cancel()).resolves.toMatchObject({ ok: true, cancelled: { returned: { kind: 'letters', count: 0 } } });
  });

  it('answers a letter already cancelled as cancelled, changing and returning nothing', async () => {
    const client = inTransaction({ rows: [{ ...HELD, status: 'cancelled' }] });

    await expect(cancel()).resolves.toEqual({
      ok: true,
      cancelled: {
        letterId: LETTER,
        alreadyCancelled: true,
        returned: { kind: 'letters', count: 0 },
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
    ['failed', [{ ...HELD, status: 'failed' }], 'too_late']
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
