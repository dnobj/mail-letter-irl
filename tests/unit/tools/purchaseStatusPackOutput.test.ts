import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A letter-pack order has no letter, so `orders.letter_id` is NULL, and its
 * product snapshot carries no mail type. The served output schema for
 * `get_purchase_status` declares both optional, which admits undefined and not
 * null. The handler used to copy the columns straight through, so every pack
 * order's status failed the MCP SDK's output validation and ChatGPT reported a
 * "connector output-validation error". Found on the first production refund
 * test, 2026-09-06, while checking the refunded pack.
 *
 * The same call now carries the pack's figures (#323): letters in the pack,
 * letters still on the account, letters returned as cash, the per-letter price
 * paid, and the proportional amount that could still be refunded. They are the
 * numbers an operator needs before touching Stripe and the numbers a customer
 * sees, so they come from one place and are absent, never null, on Pay & Send
 * orders.
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
    stripe_checkout_session_id: 'cs-1',
    updated_at: new Date('2026-09-06T16:21:33Z'),
    ...overrides
  };
}

function issues(result: ReturnType<typeof getPurchaseStatusOutputZ.safeParse>): string {
  return result.success
    ? 'ok'
    : result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

const PACK_FIELDS = [
  'letters',
  'lettersRemaining',
  'lettersRefunded',
  'perLetterCents',
  'refundableAmountCents',
  'amountRefundedCents'
] as const;

describe('get_purchase_status output against the served schema', () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it('a refunded letter-pack order validates and carries its figures', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [orderRow({ order_type: 'letter_pack', letter_id: null, credits: 4 })]
      })
      .mockResolvedValueOnce({ rows: [{ remaining_credits: '0' }] });

    const output = await getPurchaseStatus('user-1', 'order-1');

    expect(issues(getPurchaseStatusOutputZ.safeParse(output))).toBe('ok');
    // Absent, not null: JSON serialisation drops undefined and keeps null.
    expect('letterId' in output && output.letterId === null).toBe(false);
    expect('mailType' in output && output.mailType === null).toBe(false);
    expect(output).toMatchObject({
      purchaseStatus: 'refunded',
      orderStatus: 'refunded',
      letters: 2,
      lettersRemaining: 0,
      lettersRefunded: 0,
      perLetterCents: 250,
      refundableAmountCents: 0,
      // A pack refunded whole, before proportional refunds existed.
      amountRefundedCents: 500
    });
    expect(output.message).toMatch(/refunded/i);
  });

  it('a fulfilled pack with one letter left reports what an operator needs before a refund', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [orderRow({ order_type: 'letter_pack', letter_id: null, credits: 4, status: 'fulfilled' })]
      })
      // Two of four credits still active and unexpired: one letter.
      .mockResolvedValueOnce({ rows: [{ remaining_credits: 2 }] });

    const output = await getPurchaseStatus('user-1', 'order-1');

    expect(issues(getPurchaseStatusOutputZ.safeParse(output))).toBe('ok');
    expect(output).toMatchObject({
      purchaseStatus: 'submitted',
      letters: 2,
      lettersRemaining: 1,
      lettersRefunded: 0,
      perLetterCents: 250,
      refundableAmountCents: 250,
      amountRefundedCents: 0
    });
    // The ledger query attributes lots the way the refund path does and
    // counts only active, unexpired credits.
    const ledgerSql = String(mocks.query.mock.calls[1][0]);
    expect(ledgerSql).toContain("source_type IN ('purchase', 'adjustment')");
    expect(ledgerSql).toContain("source_metadata->>'stripe_session_id' = $3");
    expect(ledgerSql).toContain('expires_at > NOW()');
    expect(mocks.query.mock.calls[1][1]).toEqual(['user-1', 'order-1', 'cs-1']);
    // A pack never touches a printer, and the message never promises money.
    expect(output.message).not.toMatch(/print provider/i);
    expect(output.message).not.toMatch(/will refund|guarantee/i);
    expect(output.message).toContain('1 of 2 letters remaining');
    expect(output.message).toContain('support@letterirl.com');
    expect(output.message).toContain('order id order-1');
  });

  it('a Pay & Send order keeps its letter id and mail type and carries no pack figures', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        orderRow({
          order_type: 'jit_mail',
          letter_id: 'letter-9',
          credits: null,
          product_snapshot: { name: 'Pay & Send One Physical Letter', mailType: 'letter' },
          status: 'fulfilled'
        })
      ]
    });

    const output = await getPurchaseStatus('user-1', 'order-1');

    expect(issues(getPurchaseStatusOutputZ.safeParse(output))).toBe('ok');
    expect(output).toMatchObject({ letterId: 'letter-9', mailType: 'letter', purchaseStatus: 'submitted' });
    for (const field of PACK_FIELDS) {
      expect(field in output).toBe(false);
    }
    // No ledger query for an order that has no lots.
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(output.message).toMatch(/print provider/i);
  });
});
