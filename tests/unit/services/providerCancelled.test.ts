/**
 * failProviderCancelledLetter (#566): a letter the provider cancelled after
 * accepting it, which PostGrid allows only before printing. Under the
 * outbox's lock order the letter fails, what paid for it comes back through
 * the definite rejection's returns, and one alert says so; a Pay & Send order
 * is left for a person. Against real PostgreSQL: failedSendRefund.postgres.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  returnConsumedCreditsForLetter: vi.fn(),
  returnGiftLetterForFailedSendWithClient: vi.fn()
}));

vi.mock('../../../src/db/index.js', () => ({ query: mocks.query, transaction: mocks.transaction }));
vi.mock('../../../src/services/providers/index.js', () => ({ getProviderForMailType: vi.fn() }));
vi.mock('../../../src/services/creditLedgerService.js', () => ({
  isLetterAlreadyCompensated: vi.fn(),
  returnConsumedCreditsForLetter: mocks.returnConsumedCreditsForLetter
}));
vi.mock('../../../src/services/giftLetterService.js', () => ({
  returnGiftLetterForFailedSendWithClient: mocks.returnGiftLetterForFailedSendWithClient
}));

import { failProviderCancelledLetter, PROVIDER_CANCELLED_ALERT } from '../../../src/services/letterJobService.js';

const RAW = 'Letter was canceled before sending';

interface Row {
  status: string;
  user_id: string;
  funding_type: string | null;
  funding_order_id: string | null;
}

/** A client answering the reads as the letter stands; it records every call. */
function client(letter: Row | null, lockedLetter: Row | null = letter) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: flat, params });
    if (flat === 'SELECT funding_order_id FROM letters WHERE letter_id = $1') {
      return { rows: letter ? [{ funding_order_id: letter.funding_order_id }] : [] };
    }
    if (flat.startsWith('SELECT status, user_id, funding_type, funding_order_id FROM letters')) {
      return { rows: lockedLetter ? [lockedLetter] : [] };
    }
    if (flat === 'SELECT user_id, funding_type FROM letters WHERE letter_id = $1') {
      return { rows: letter ? [{ user_id: letter.user_id, funding_type: letter.funding_type }] : [] };
    }
    return { rows: [] };
  });
  mocks.transaction.mockImplementation(async (callback: (c: { query: typeof query }) => Promise<unknown>) => callback({ query }));
  return calls;
}

const writes = (calls: Array<{ sql: string }>) =>
  calls.filter(call => /^(UPDATE|INSERT|DELETE)/.test(call.sql)).map(call => call.sql.split(' ').slice(0, 3).join(' '));
const index = (calls: Array<{ sql: string }>, start: string) => calls.findIndex(call => call.sql.startsWith(start));

const prepaid: Row = { status: 'accepted', user_id: 'user-1', funding_type: 'prepaid_balance', funding_order_id: null };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('failProviderCancelledLetter (#566)', () => {
  it('fails a prepaid letter with a history row, gives its credits back, and raises a warning', async () => {
    const calls = client(prepaid);

    await expect(failProviderCancelledLetter({ letterId: 'letter-1', providerRawStatus: RAW })).resolves.toBe('failed');

    expect(writes(calls)).toEqual(['UPDATE letters SET', 'INSERT INTO letter_status_history', 'INSERT INTO commerce_operational_alerts']);
    const update = calls.find(call => call.sql.startsWith('UPDATE letters'))!;
    expect(update.sql).toContain("SET status = 'failed', status_updated_at = NOW(), provider_raw_status = $2");
    expect(update.params).toEqual(['letter-1', RAW]);
    const history = calls.find(call => call.sql.startsWith('INSERT INTO letter_status_history'))!;
    expect(history.sql).toContain("VALUES ($1, $2, 'failed', $3, 'sync')");
    expect(history.params).toEqual(['letter-1', 'accepted', RAW]);
    expect(mocks.returnConsumedCreditsForLetter).toHaveBeenCalledWith(expect.anything(), {
      letterId: 'letter-1',
      userId: 'user-1',
      failureCode: 'provider_cancelled'
    });
    expect(mocks.returnGiftLetterForFailedSendWithClient).not.toHaveBeenCalled();
    const alert = calls.find(call => call.sql.startsWith('INSERT INTO commerce_operational_alerts'))!;
    expect(alert.sql).toContain('ON CONFLICT DO NOTHING');
    expect(alert.params).toEqual([null, PROVIDER_CANCELLED_ALERT, 'warning', 'letter-1', 'user-1', 'prepaid_balance', false]);
    expect(PROVIDER_CANCELLED_ALERT).toBe('provider_cancelled_mail');
  });

  it('gives a gift letter back, through the gift return', async () => {
    client({ ...prepaid, funding_type: 'gift_letter' });

    await expect(failProviderCancelledLetter({ letterId: 'letter-1', providerRawStatus: RAW })).resolves.toBe('failed');

    expect(mocks.returnGiftLetterForFailedSendWithClient).toHaveBeenCalledWith(expect.anything(), {
      letterId: 'letter-1',
      userId: 'user-1',
      failureCode: 'provider_cancelled'
    });
    expect(mocks.returnConsumedCreditsForLetter).not.toHaveBeenCalled();
  });

  it('locks a Pay & Send order first, returns nothing, and asks a person to decide the refund', async () => {
    const calls = client({ ...prepaid, funding_type: 'jit_order', funding_order_id: 'order-9' });

    await expect(failProviderCancelledLetter({ letterId: 'letter-1', providerRawStatus: RAW })).resolves.toBe('failed');

    const order = index(calls, 'SELECT order_id FROM orders WHERE order_id = $1 FOR UPDATE');
    const letterLock = index(calls, 'SELECT status, user_id, funding_type, funding_order_id FROM letters');
    const jobs = index(calls, 'SELECT job_id FROM letter_jobs WHERE letter_id = $1 ORDER BY job_id FOR UPDATE');
    expect(order).toBeGreaterThan(-1);
    expect(order).toBeLessThan(letterLock);
    expect(letterLock).toBeLessThan(jobs);
    expect(calls[order].params).toEqual(['order-9']);
    expect(mocks.returnConsumedCreditsForLetter).not.toHaveBeenCalled();
    expect(mocks.returnGiftLetterForFailedSendWithClient).not.toHaveBeenCalled();
    // Nothing moves the order.
    expect(writes(calls)).toEqual(['UPDATE letters SET', 'INSERT INTO letter_status_history', 'INSERT INTO commerce_operational_alerts']);
    const alert = calls.find(call => call.sql.startsWith('INSERT INTO commerce_operational_alerts'))!;
    expect(alert.params).toEqual(['order-9', PROVIDER_CANCELLED_ALERT, 'critical', 'letter-1', 'user-1', 'jit_order', true]);
  });

  it.each(['delivered', 'returned', 'failed', 'cancelled'])('leaves a letter already %s as it is', async status => {
    const calls = client({ ...prepaid, status });

    await expect(failProviderCancelledLetter({ letterId: 'letter-1', providerRawStatus: RAW })).resolves.toBe('unchanged');

    expect(writes(calls)).toEqual([]);
    expect(mocks.returnConsumedCreditsForLetter).not.toHaveBeenCalled();
  });

  it('leaves a letter that does not exist alone', async () => {
    const calls = client(null);

    await expect(failProviderCancelledLetter({ letterId: 'missing', providerRawStatus: RAW })).resolves.toBe('unchanged');

    expect(calls).toHaveLength(1);
  });

  it('refuses when the funding graph changes while the locks are taken', async () => {
    const calls = client(prepaid, { ...prepaid, funding_order_id: 'order-appeared' });

    await expect(failProviderCancelledLetter({ letterId: 'letter-1', providerRawStatus: RAW })).rejects.toThrow(
      'Funding graph changed while acquiring canonical locks'
    );

    expect(writes(calls)).toEqual([]);
  });
});
