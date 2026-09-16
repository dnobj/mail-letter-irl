import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #394. The ledger description of an operator adjustment is a fixed
 * label inside the service, never the operator's typed reason: the customer
 * reads it back through the credits API (A-13). The command layer used to
 * pass the label in; now nothing outside the service can put text there.
 */

const ledger = vi.hoisted(() => ({
  addCreditsToLedgerWithClient: vi.fn()
}));

vi.mock('../../../src/db/index.js', () => ({
  query: vi.fn(),
  transaction: vi.fn()
}));
vi.mock('../../../src/services/creditLedgerService.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/services/creditLedgerService.js')>();
  return { ...actual, addCreditsToLedgerWithClient: ledger.addCreditsToLedgerWithClient };
});

import { OPERATOR_ADJUSTMENT_LABEL, adjustCreditsWithClient } from '../../../src/services/creditService.js';

describe('adjustCreditsWithClient description (#394)', () => {
  beforeEach(() => {
    ledger.addCreditsToLedgerWithClient.mockReset();
  });

  it('names the fixed label', () => {
    expect(OPERATOR_ADJUSTMENT_LABEL).toBe('Operator adjustment');
  });

  it('adds credits with the fixed label as the lot description', async () => {
    ledger.addCreditsToLedgerWithClient.mockResolvedValueOnce({
      user: { credits: 6 },
      transaction: { transaction_id: 7 }
    });
    const client = { query: vi.fn() };

    await expect(adjustCreditsWithClient(client as never, 'auth0|u1', 2)).resolves.toEqual({
      user: { credits: 6 },
      transaction: { transaction_id: 7 }
    });

    expect(ledger.addCreditsToLedgerWithClient).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ userId: 'auth0|u1', credits: 2, sourceType: 'adjustment', description: 'Operator adjustment' })
    );
  });

  it('removes credits with the fixed label on the transaction row', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('UPDATE users')) return { rows: [{ user_id: 'auth0|u1', credits: 6 }] };
        if (sql.includes('SELECT ledger_id, remaining_amount FROM credit_ledger')) {
          return { rows: [{ ledger_id: 'lot-1', remaining_amount: 10 }] };
        }
        if (sql.includes('INSERT INTO credit_transactions')) return { rows: [{ transaction_id: 8 }] };
        return { rows: [], rowCount: 1 };
      })
    };

    const result = await adjustCreditsWithClient(client as never, 'auth0|u1', -4);

    expect(result.transaction).toEqual({ transaction_id: 8 });
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO credit_transactions'));
    expect(insert).toBeDefined();
    expect((insert![1] as unknown[])[6]).toBe('Operator adjustment');
    expect(ledger.addCreditsToLedgerWithClient).not.toHaveBeenCalled();
  });

  it('refuses a zero or fractional amount before touching the database', async () => {
    const client = { query: vi.fn() };

    await expect(adjustCreditsWithClient(client as never, 'auth0|u1', 0)).rejects.toThrow('non-zero integer');
    await expect(adjustCreditsWithClient(client as never, 'auth0|u1', 1.5)).rejects.toThrow('non-zero integer');
    expect(client.query).not.toHaveBeenCalled();
  });
});
