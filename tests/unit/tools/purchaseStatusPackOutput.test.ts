import { describe, expect, it, vi } from 'vitest';

/**
 * A letter-pack order has no letter, so `orders.letter_id` is NULL, and its
 * product snapshot carries no mail type. The served output schema for
 * `get_purchase_status` declares both optional, which admits undefined and not
 * null. The handler used to copy the columns straight through, so every pack
 * order's status failed the MCP SDK's output validation and ChatGPT reported a
 * "connector output-validation error". Found on the first production refund
 * test, 2026-09-06, while checking the refunded pack.
 *
 * The schema under test is the SERVED one (zodSchemas.ts), not the tool
 * definition's copy in schemas.ts; registerTools serves the former.
 */

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../../../src/db/index.js', () => ({
  query: mocks.query,
  transaction: mocks.transaction,
  pool: {}
}));

import { getPurchaseStatus } from '../../../src/services/commerceService.js';
import { getPurchaseStatusOutputZ } from '../../../src/zodSchemas.js';

function orderRow(overrides: Record<string, unknown>) {
  return {
    order_id: 'order-1',
    user_id: 'user-1',
    product_code: 'starter',
    product_snapshot: { name: 'Starter Pack' },
    amount_cents: 500,
    currency: 'usd',
    status: 'refunded',
    checkout_expires_at: null,
    updated_at: new Date('2026-09-06T16:21:33Z'),
    ...overrides
  };
}

function issues(result: ReturnType<typeof getPurchaseStatusOutputZ.safeParse>): string {
  return result.success
    ? 'ok'
    : result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

describe('get_purchase_status output against the served schema', () => {
  it('a letter-pack order, which has no letter, validates', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [orderRow({ order_type: 'letter_pack', letter_id: null })]
    });

    const output = await getPurchaseStatus('user-1', 'order-1');

    expect(issues(getPurchaseStatusOutputZ.safeParse(output))).toBe('ok');
    // Absent, not null: JSON serialisation drops undefined and keeps null.
    expect('letterId' in output && output.letterId === null).toBe(false);
    expect('mailType' in output && output.mailType === null).toBe(false);
    expect(output).toMatchObject({ purchaseStatus: 'refunded', orderStatus: 'refunded' });
  });

  it('a Pay & Send order keeps its letter id and mail type', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        orderRow({
          order_type: 'jit_mail',
          letter_id: 'letter-9',
          product_snapshot: { name: 'Pay & Send One Physical Letter', mailType: 'letter' },
          status: 'fulfilled'
        })
      ]
    });

    const output = await getPurchaseStatus('user-1', 'order-1');

    expect(issues(getPurchaseStatusOutputZ.safeParse(output))).toBe('ok');
    expect(output).toMatchObject({ letterId: 'letter-9', mailType: 'letter', purchaseStatus: 'submitted' });
  });
});
