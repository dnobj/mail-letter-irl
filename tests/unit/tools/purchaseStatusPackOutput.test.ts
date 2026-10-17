import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
 * The schema under test is the SERVED one (zodSchemas.ts), which registerTools
 * serves and /manifest.json is generated from (#688).
 */

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../../../src/db/index.js', () => ({
  query: mocks.query,
  transaction: mocks.transaction,
  pool: {}
}));

import { getPurchaseStatus, ourCheckoutUrl } from '../../../src/services/commerceService.js';
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
    }).mockResolvedValueOnce({ rows: [] });

    const output = await getPurchaseStatus('user-1', 'order-1');

    expect(issues(getPurchaseStatusOutputZ.safeParse(output))).toBe('ok');
    expect(output).toMatchObject({ letterId: 'letter-9', mailType: 'letter', purchaseStatus: 'submitted' });
    for (const field of PACK_FIELDS) {
      expect(field in output).toBe(false);
    }
    // No ledger query for an order that has no lots: only the one for a missed mail date (#700).
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(String(mocks.query.mock.calls[1][0])).toContain('commerce_order_events');
    expect(output.message).toBe('The physical mail item was accepted by the print provider.');
  });
});

describe('a Pay & Send order whose mail date passed before it was paid (#700)', () => {
  // A Thursday in October 2026, so the date needs no year.
  beforeEach(() => {
    mocks.query.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T14:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const payAndSend = (status: string, event: Record<string, unknown> | null) => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [orderRow({ order_type: 'jit_mail', letter_id: 'letter-9', credits: null, product_snapshot: { name: 'Pay & Send One Physical Letter', mailType: 'letter' }, status })]
      })
      .mockResolvedValueOnce({ rows: event ? [event] : [] });
    return getPurchaseStatus('user-1', 'order-1');
  };

  it('says, while it is prepared, that it goes to the printer as soon as it can and may arrive after its date', async () => {
    const output = await payAndSend('fulfillment_pending', { arrive_by: '2026-10-16', mail_on: '2026-10-06' });

    expect(output.message).toBe(
      'Payment is confirmed and the mail item is being prepared. ' +
        'Its payment was confirmed too late for it to go to the printer in time to arrive by Fri, Oct 16, so it goes to the printer as soon as it can instead, and may arrive after that date.'
    );
    expect(issues(getPurchaseStatusOutputZ.safeParse(output))).toBe('ok');
    const [sql, params] = mocks.query.mock.calls[1];
    expect(sql).toContain('FROM commerce_order_events');
    expect(sql).toContain('event_type = $2');
    expect(params).toEqual(['order-1', 'jit.schedule_missed']);
  });

  it('says it in the past once it is with the printer', async () => {
    const output = await payAndSend('fulfilled', { arrive_by: '2026-10-16', mail_on: '2026-10-06' });
    expect(output.message).toBe(
      'The physical mail item was accepted by the print provider. ' +
        'Its payment was confirmed too late for it to go to the printer in time to arrive by Fri, Oct 16, so it went to the printer as soon as it could instead, and may arrive after that date.'
    );
  });

  it.each(['refund_pending', 'refunded', 'held', 'disputed'])('says nothing of it once the order is %s', async status => {
    const output = await payAndSend(status, { arrive_by: '2026-10-16', mail_on: '2026-10-06' });
    expect(output.message).not.toContain('confirmed too late');
  });

  describe('an unpaid order whose mail date has passed (#726)', () => {
    const pending = (draft: Record<string, unknown> | null, status = 'checkout_pending') => {
      mocks.query
        .mockResolvedValueOnce({
          rows: [orderRow({ order_type: 'jit_mail', letter_id: null, draft_id: 'draft-1', credits: null, product_snapshot: { name: 'Pay & Send One Physical Letter', mailType: 'letter' }, status })]
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: draft ? [draft] : [] });
      return getPurchaseStatus('user-1', 'order-1');
    };

    it('says so before payment, and gives the card the dates', async () => {
      // Thursday Oct 8: Tue Oct 6 has passed.
      const output = await pending({ arrive_by: '2026-10-16', mail_on: '2026-10-06' });
      expect(output.scheduleMissed).toEqual({ arriveBy: '2026-10-16', mailOn: '2026-10-06' });
      expect(output.message).toContain(
        'Its day to go to the printer, Tue, Oct 6, has passed: if it is paid now, it goes to the printer as soon as it can and may arrive after Fri, Oct 16. Tell the person before they pay.'
      );
      expect(issues(getPurchaseStatusOutputZ.safeParse(output))).toBe('ok');
      const [sql, params] = mocks.query.mock.calls[2];
      expect(sql).toBe('SELECT arrive_by, mail_on FROM letter_drafts WHERE draft_id = $1');
      expect(params).toEqual(['draft-1']);
    });

    it('says nothing for a date still ahead, a draft without dates or with dates it cannot read, or one gone', async () => {
      for (const draft of [{ arrive_by: '2026-10-23', mail_on: '2026-10-13' }, { arrive_by: null, mail_on: null }, { arrive_by: null, mail_on: '2026-10-06' }, null]) {
        const output = await pending(draft);
        expect(output, JSON.stringify(draft)).not.toHaveProperty('scheduleMissed');
        expect(output.message).not.toContain('has passed');
      }
    });

    it('never asks once the order is paid or closed', async () => {
      for (const status of ['paid', 'fulfillment_pending', 'cancelled', 'expired']) {
        mocks.query.mockReset();
        const output = await pending({ arrive_by: '2026-10-16', mail_on: '2026-10-06' }, status);
        expect(output, status).not.toHaveProperty('scheduleMissed');
        expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('FROM letter_drafts')), status).toBe(false);
      }
    });
  });

  it('says nothing of it without the event, or with dates it cannot read', async () => {
    expect((await payAndSend('fulfillment_pending', null)).message).toBe('Payment is confirmed and the mail item is being prepared.');
    expect((await payAndSend('fulfillment_pending', { arrive_by: null, mail_on: '2026-10-06' })).message).toBe(
      'Payment is confirmed and the mail item is being prepared.'
    );
  });

  it('never asks about it for a letter pack', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [orderRow({ order_type: 'letter_pack', credits: 8, status: 'fulfilled' })] })
      .mockResolvedValueOnce({ rows: [{ remaining_credits: 8 }] });
    await getPurchaseStatus('user-1', 'order-1');
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('commerce_order_events'))).toBe(false);
  });
});

describe('ourCheckoutUrl (#730)', () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it('reads the checkout address our order recorded for the session, by its indexed id', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_ours' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ checkout_url: null }], rowCount: 1 });
    await expect(ourCheckoutUrl('cs_test_ours')).resolves.toBe('https://checkout.stripe.com/c/pay/cs_test_ours');
    await expect(ourCheckoutUrl('cs_test_theirs')).resolves.toBeNull();
    await expect(ourCheckoutUrl('cs_test_unrecorded')).resolves.toBeNull();
    expect(mocks.query.mock.calls[0]).toEqual([
      'SELECT checkout_url FROM orders WHERE stripe_checkout_session_id = $1 LIMIT 1',
      ['cs_test_ours']
    ]);
  });
});
