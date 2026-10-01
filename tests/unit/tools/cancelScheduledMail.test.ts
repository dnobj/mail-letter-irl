/**
 * cancel_scheduled_mail (#535): held mail cancelled free until it goes to the
 * printer, with confirm: true. The service's transaction is tested in
 * scheduledMailService.test.ts and against PostgreSQL in arriveBy.postgres.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/scheduledMailService.js', () => ({ cancelScheduledMail: vi.fn() }));

import { cancelScheduledMail } from '../../../src/services/scheduledMailService.js';
import {
  CANCEL_SCHEDULED_MAIL_TOOL,
  ScheduledMailRefusedError,
  cancelScheduledMailTool
} from '../../../src/tools/cancelScheduledMail.js';
import { cancelScheduledMailInputSchema, cancelScheduledMailOutputSchema } from '../../../src/schemas.js';
import type { ToolContext } from '../../../src/contracts/types.js';

const ORDER = 'ltr-1';

function context(): ToolContext {
  return {
    user: { userId: 'auth0|owner', creditsRemaining: 0, orders: [] } as unknown as ToolContext['user'],
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
    now: () => new Date('2026-10-01T14:00:00Z'),
    persist: vi.fn()
  };
}

const cancelled = (overrides: Record<string, unknown> = {}) => ({
  ok: true as const,
  cancelled: {
    letterId: ORDER,
    alreadyCancelled: false,
    returned: { kind: 'letters' as const, count: 1 },
    shortfall: 'none' as const,
    arriveBy: '2026-10-16',
    mailOn: '2026-10-06',
    ...overrides
  }
});

const run = (input: Record<string, unknown>) => cancelScheduledMailTool.handler(input as never, context());

beforeEach(() => {
  vi.mocked(cancelScheduledMail).mockReset().mockResolvedValue(cancelled());
});

describe('cancel_scheduled_mail (#535)', () => {
  it("cancels the caller's held mail and says the letter is back", async () => {
    await expect(run({ orderId: ` ${ORDER} `, confirm: true })).resolves.toEqual({
      orderId: ORDER,
      status: 'cancelled',
      alreadyCancelled: false,
      returned: { kind: 'letters', count: 1 },
      message: 'Cancelled. The letter it cost is back in the balance.'
    });
    expect(cancelScheduledMail).toHaveBeenCalledWith({ letterId: ORDER, userId: 'auth0|owner' });
  });

  it.each([
    [{ returned: { kind: 'letters', count: 2 } }, 'Cancelled. The 2 letters it cost are back in the balance.'],
    [{ returned: { kind: 'gift_letter', count: 1 } }, 'Cancelled. The gift letter is back in the account, to use again.'],
    [
      { returned: { kind: 'letters', count: 0 }, shortfall: 'refunded' },
      'Cancelled. Nothing went back to the account: what paid for it had already been refunded.'
    ],
    [
      { returned: { kind: 'letters', count: 0 }, shortfall: 'expired' },
      'Cancelled. What paid for it expired while it waited, so nothing came back to the balance.'
    ],
    [
      { returned: { kind: 'letters', count: 0 }, shortfall: 'partial' },
      'Cancelled. Part of what it cost is back in the balance; the rest had been refunded or had expired.'
    ],
    [
      { returned: { kind: 'gift_letter', count: 0 }, shortfall: 'refunded' },
      'Cancelled. Nothing went back to the account: what paid for it had already been refunded.'
    ],
    [{ alreadyCancelled: true, returned: { kind: 'letters', count: 0 } }, 'This order was already cancelled, so nothing changed.']
  ])('says what went back, in letters (%j)', async (overrides, message) => {
    vi.mocked(cancelScheduledMail).mockResolvedValue(cancelled(overrides));
    await expect(run({ orderId: ORDER, confirm: true })).resolves.toMatchObject({ message });
  });

  it.each([[{}], [{ confirm: false }], [{ confirm: 'true' }]])('cancels nothing without confirm: true (%j)', async extra => {
    await expect(run({ orderId: ORDER, ...extra })).rejects.toMatchObject({
      code: 'CONFIRM_REQUIRED',
      message: 'Cancelling cannot be undone: check with the person first, then call again with confirm: true.'
    });
    expect(cancelScheduledMail).not.toHaveBeenCalled();
  });

  it('refuses an empty order id as not found, without asking the service', async () => {
    await expect(run({ orderId: '  ', confirm: true })).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
    expect(cancelScheduledMail).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 'ORDER_NOT_FOUND', "That order wasn't found. list_orders shows the orders on this account."],
    ['not_scheduled', 'ORDER_NOT_SCHEDULED', 'Only mail scheduled to arrive by a date can be cancelled. This order goes to the printer as soon as it can.'],
    [
      'pay_and_send',
      'ORDER_PAY_AND_SEND',
      "A Pay & Send order can't be cancelled here. Email support@letterirl.com from the email on your Letter IRL account, quoting the order id; refunds are decided by a person."
    ],
    ['too_late', 'ORDER_ALREADY_MAILED', "This order has gone to the printer, or did not go out, so it can't be cancelled. get_order_status shows where it is."],
    ['busy', 'ORDER_BEING_SENT', "This order is going to the printer right now, so it can't be cancelled. get_order_status shows where it is."]
  ] as const)('refuses as the service decided (%s)', async (refusal, code, message) => {
    vi.mocked(cancelScheduledMail).mockResolvedValue({ ok: false, refusal });
    const refused = run({ orderId: ORDER, confirm: true });
    await expect(refused).rejects.toBeInstanceOf(ScheduledMailRefusedError);
    await expect(refused).rejects.toMatchObject({ code, diagnosticClass: code, message });
  });

  it('is a destructive write that repeats safely, with orderId and confirm required', () => {
    expect(cancelScheduledMailTool.name).toBe(CANCEL_SCHEDULED_MAIL_TOOL);
    expect(CANCEL_SCHEDULED_MAIL_TOOL).toBe('cancel_scheduled_mail');
    expect(cancelScheduledMailTool.readOnly).toBe(false);
    expect(cancelScheduledMailTool.meta).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(cancelScheduledMailTool.inputSchema).toBe(cancelScheduledMailInputSchema);
    expect(cancelScheduledMailTool.outputSchema).toBe(cancelScheduledMailOutputSchema);
    expect(cancelScheduledMailInputSchema.required).toEqual(['orderId', 'confirm']);
    expect(cancelScheduledMailTool.description).toContain('confirm: true');
  });
});
