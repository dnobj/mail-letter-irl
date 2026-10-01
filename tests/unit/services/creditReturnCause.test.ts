/**
 * A cancelled send's credits (#535) go back under the same exactly-once record
 * as a failed send's (reason 'send_failed'), so the replay guard and the
 * operator's retry guard count it; only failure_code, the descriptions the
 * account's history shows and the log say it was cancelled. The return itself
 * runs against PostgreSQL in failedSendRefund.postgres and arriveBy.postgres.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/accountLock.js', () => ({ lockAccountForBalanceChange: vi.fn() }));
vi.mock('../../../src/utils/diagnosticLog.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/utils/diagnosticLog.js')>()),
  writeDiagnostic: vi.fn()
}));

import { writeDiagnostic } from '../../../src/utils/diagnosticLog.js';
import { returnConsumedCreditsForLetter } from '../../../src/services/creditLedgerService.js';

const LOT = {
  ledger_id: 'lot-1',
  amount: 2,
  expires_at: null,
  expiration_policy: null,
  status: 'active',
  source_reference_id: 'order-1',
  stripe_session_id: null
};

function client() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM credit_consumption')) return { rows: [LOT], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { query };
}

function inserts(c: ReturnType<typeof client>) {
  const calls = c.query.mock.calls as unknown as Array<[string, unknown[]]>;
  return {
    lot: calls.find(([sql]) => sql.includes('INSERT INTO credit_ledger'))!,
    transaction: calls.find(([sql]) => sql.includes('INSERT INTO credit_transactions'))!
  };
}

beforeEach(() => vi.mocked(writeDiagnostic).mockClear());

describe('returnConsumedCreditsForLetter: the cause (#535)', () => {
  it('words a cancel as a cancel, under the failed send record', async () => {
    const c = client();
    await expect(
      returnConsumedCreditsForLetter(c, { letterId: 'ltr-1', userId: 'u-1', failureCode: 'cancelled_by_customer', cause: 'cancelled' })
    ).resolves.toBe(2);

    const { lot, transaction } = inserts(c);
    expect(JSON.parse(lot[1][3] as string)).toMatchObject({
      reason: 'send_failed',
      letter_id: 'ltr-1',
      failure_code: 'cancelled_by_customer'
    });
    expect(lot[1][6]).toBe('Returned after cancelled send ltr-1');
    expect(transaction[1][3]).toBe('Returned after cancelled send ltr-1');
    expect(writeDiagnostic).toHaveBeenCalledWith('info', 'credits.returned_after_cancelled_send', expect.anything());
  });

  it('words a failure as before when no cause is given', async () => {
    const c = client();
    await returnConsumedCreditsForLetter(c, { letterId: 'ltr-1', userId: 'u-1', failureCode: 'provider_definite_rejection' });

    const { lot, transaction } = inserts(c);
    expect(JSON.parse(lot[1][3] as string)).toMatchObject({ reason: 'send_failed', failure_code: 'provider_definite_rejection' });
    expect(lot[1][6]).toBe('Returned after failed send ltr-1');
    expect(transaction[1][3]).toBe('Returned after failed send ltr-1');
    expect(writeDiagnostic).toHaveBeenCalledWith('info', 'credits.returned_after_failed_send', expect.anything());
  });
});
