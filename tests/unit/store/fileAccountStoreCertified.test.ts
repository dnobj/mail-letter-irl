/**
 * The orders every tool call loads (src/store/fileAccountStore.ts), for mail
 * sent as USPS Certified Mail (#625): the service, and the carrier's number
 * once the status sync has stored it. get_order_status and list_orders pass
 * these on.
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

function letter(id: string, overrides: Record<string, unknown> = {}) {
  return {
    letter_id: id,
    content: { bodyText: 'Hello' },
    recipient: { name: 'Sam Rivera', city: 'Leeds', state: 'NY' },
    credits_cost: 1,
    status: 'in_transit',
    preview_html: null,
    created_at: new Date('2026-09-23T12:00:00Z'),
    sent_at: new Date('2026-09-23T12:05:00Z'),
    arrive_by: null,
    mail_on: null,
    funding_type: 'jit_order',
    mail_service: 'standard',
    carrier_tracking_number: null,
    ...overrides
  };
}

async function ordersOf(rows: unknown[]) {
  mocks.query.mockImplementation(async (sql: string) => (sql.includes('FROM letters') ? { rows } : { rows: [] }));
  return (await new FileAccountStore().getOrCreate('auth0|user')).orders;
}

describe('certified mail in the orders a tool call loads (#625)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBalance.mockResolvedValue({ credits: 4 });
    mocks.getGenerationQuota.mockResolvedValue({ used: 0, allowance: 3, remaining: 3 });
  });

  it('reads each letter with its service and the carrier\'s number', async () => {
    await ordersOf([]);
    const sql = String(mocks.query.mock.calls.find(([text]) => String(text).includes('FROM letters'))![0]);
    expect(sql).toMatch(/funding_type,\s+mail_service,\s+carrier_tracking_number\s+FROM letters/);
  });

  it('says nothing of certified mail for an ordinary letter', async () => {
    const [order] = await ordersOf([letter('plain')]);
    expect(order).not.toHaveProperty('certified');
  });

  it('gives certified mail its service, with no number before the status sync has stored one', async () => {
    const [order] = await ordersOf([letter('c1', { mail_service: 'certified' })]);
    expect(order.certified).toEqual({ mailService: 'certified' });
  });

  it('gives the number and the USPS page that shows it', async () => {
    const [order] = await ordersOf([
      letter('c2', { mail_service: 'certified_return_receipt', carrier_tracking_number: '9407 1000 0000 0000 0000 00' })
    ]);
    expect(order.certified).toEqual({
      mailService: 'certified_return_receipt',
      carrierTrackingNumber: '9407 1000 0000 0000 0000 00',
      carrierTrackingUrl: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9407100000000000000000'
    });
  });

  it('shows a number only beside a certified service', async () => {
    const [order] = await ordersOf([letter('odd', { carrier_tracking_number: '9407100000000000000000' })]);
    expect(order).not.toHaveProperty('certified');
  });

  it('keeps the held mail fields beside the certified ones', async () => {
    const [order] = await ordersOf([
      letter('held', { mail_service: 'certified', status: 'queued', arrive_by: '2026-10-16', mail_on: '2026-10-06' })
    ]);
    expect(order).toMatchObject({
      currentStatus: 'scheduled',
      schedule: { arriveBy: '2026-10-16', mailOn: '2026-10-06' },
      certified: { mailService: 'certified' }
    });
  });
});
