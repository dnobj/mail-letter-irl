import { describe, expect, it, vi } from 'vitest';

/**
 * Issue #394. Releasing a PAYMENT_AMOUNT_MISMATCH quarantine used to copy the
 * operator's typed reason into the order event's metadata, a column the admin
 * reader role can select. The reason belongs to admin_audit_events alone; the
 * event carries only the code that was cleared.
 */

vi.mock('../../../src/db/index.js', () => ({
  query: vi.fn(),
  transaction: vi.fn()
}));

import { releaseAmountMismatchQuarantine } from '../../../src/services/operatorAccountService.js';

function fakeClient(row: { status: string; last_error_code: string | null } | undefined) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FOR UPDATE')) return { rows: row ? [row] : [] };
    return { rows: [], rowCount: 1 };
  });
  return { query };
}

describe('releaseAmountMismatchQuarantine (#394)', () => {
  it('clears the code and records an event that carries only the cleared code', async () => {
    const client = fakeClient({ status: 'refund_pending', last_error_code: 'PAYMENT_AMOUNT_MISMATCH' });

    await expect(releaseAmountMismatchQuarantine(client as never, 'order_1')).resolves.toBe('released');

    const clear = client.query.mock.calls.find(([sql]) => String(sql).includes('SET last_error_code = NULL'));
    expect(clear).toBeDefined();
    expect(String(clear![0])).toContain('last_error = NULL');
    expect(clear![1]).toEqual(['order_1']);

    const event = client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO commerce_order_events'));
    expect(event).toBeDefined();
    expect(String(event![0])).toContain("'operator.quarantine_released'");
    expect(String(event![0])).toContain('$3::jsonb');
    expect(event![1]).toEqual(['order_1', 'refund_pending', JSON.stringify({ clearedCode: 'PAYMENT_AMOUNT_MISMATCH' })]);
    expect(JSON.stringify(client.query.mock.calls)).not.toContain('reason');
  });

  it('leaves an order alone when it carries a different code, or none', async () => {
    for (const code of ['UNMATCHED_MONEY_EVENT_RECOVERED', null]) {
      const client = fakeClient({ status: 'refund_pending', last_error_code: code });

      await expect(releaseAmountMismatchQuarantine(client as never, 'order_1')).resolves.toBe('not_quarantined');

      expect(client.query).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses an unknown order', async () => {
    const client = fakeClient(undefined);

    await expect(releaseAmountMismatchQuarantine(client as never, 'order_missing')).rejects.toThrow('not_found');
  });
});
