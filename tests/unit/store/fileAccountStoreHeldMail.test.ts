/**
 * The orders every tool call loads (src/store/fileAccountStore.ts), for mail
 * sent with an arrival date (#535): scheduled while it waits for its mail
 * date, with its dates, and cancellable free unless Pay & Send bought it.
 * get_order_status and list_orders pass these on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBalance: vi.fn(),
  getGenerationQuota: vi.fn(),
  query: vi.fn()
}));

vi.mock('../../../src/services/creditService.js', () => ({ getBalance: mocks.getBalance }));
vi.mock('../../../src/services/imageGenerationLimitService.js', () => ({
  getGenerationQuota: mocks.getGenerationQuota
}));
vi.mock('../../../src/db/index.js', () => ({ query: mocks.query }));

import { FileAccountStore } from '../../../src/store/fileAccountStore.js';

const CREATED = new Date('2026-09-23T12:00:00Z');
const MAILED = new Date('2026-10-06T14:00:00Z');

function letter(id: string, overrides: Record<string, unknown> = {}) {
  return {
    letter_id: id,
    content: { bodyText: 'Hello' },
    recipient: { name: 'Sam Rivera', city: 'Leeds', state: 'NY' },
    credits_cost: 2,
    status: 'queued',
    preview_html: null,
    created_at: CREATED,
    sent_at: null,
    arrive_by: '2026-10-16',
    mail_on: '2026-10-06',
    funding_type: 'prepaid_balance',
    ...overrides
  };
}

async function ordersOf(rows: unknown[]) {
  mocks.query.mockImplementation(async (sql: string) => (sql.includes('FROM letters') ? { rows } : { rows: [] }));
  return (await new FileAccountStore().getOrCreate('auth0|user')).orders;
}

describe('held mail in the orders a tool call loads (#535)', () => {
  const DATES = { arriveBy: '2026-10-16', mailOn: '2026-10-06' };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBalance.mockResolvedValue({ credits: 4 });
    mocks.getGenerationQuota.mockResolvedValue({ used: 0, allowance: 3, remaining: 3 });
  });

  it('reads each letter with its dates and how it was paid for', async () => {
    await ordersOf([]);
    const sql = String(mocks.query.mock.calls.find(([text]) => String(text).includes('FROM letters'))![0]);
    expect(sql).toMatch(/arrive_by,\s+mail_on,\s+funding_type/);
  });

  it('calls a letter waiting for its mail date scheduled, cancellable, with a line in its timeline', async () => {
    const [order] = await ordersOf([letter('held')]);

    expect(order.currentStatus).toBe('scheduled');
    expect(order.schedule).toEqual(DATES);
    expect(order.cancellable).toBe(true);
    expect(order.statusTimeline.map(entry => entry.statusText)).toEqual([
      'Order placed',
      expect.stringMatching(/^Scheduled: Goes to the printer Tue, Oct 6(, 2026)?, and aims to arrive by Fri, Oct 16(, 2026)?\.$/)
    ]);
    expect(order.statusTimeline[1].timestampISO).toBe(CREATED.toISOString());
  });

  it('leaves Pay & Send held mail scheduled but not cancellable here', async () => {
    const [order] = await ordersOf([letter('paid', { funding_type: 'jit_order' })]);
    expect(order).toMatchObject({ currentStatus: 'scheduled', schedule: DATES, cancellable: false });
  });

  it('keeps the dates of mail that has gone, without a cancel', async () => {
    const [order] = await ordersOf([letter('mailed', { status: 'accepted', sent_at: MAILED })]);
    expect(order).toMatchObject({ currentStatus: 'accepted', schedule: DATES, cancellable: false });
    expect(order.statusTimeline.at(-1)!.statusText).toBe('Accepted by print facility');
  });

  it('says nothing of dates it cannot read, nor of mail sent without them', async () => {
    const orders = await ordersOf([
      letter('none', { arrive_by: null, mail_on: null }),
      letter('unreadable', { arrive_by: '16/10/2026' }),
      letter('half', { mail_on: null })
    ]);
    for (const order of orders) {
      expect(order.currentStatus, order.orderId).toBe('pending');
      expect(order, order.orderId).not.toHaveProperty('schedule');
      expect(order, order.orderId).not.toHaveProperty('cancellable');
    }
  });
});
