/**
 * Orders sent as USPS Certified Mail (#625): get_order_status and list_orders
 * give the service, USPS's number and its link once the status sync has stored
 * it, and, for the status, what to tell the person about the number and the
 * electronic return receipt. An ordinary order's answer is unchanged.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderRecord, ToolContext } from '../../../src/contracts/types.js';
import type { CertifiedFacts } from '../../../src/config/certifiedMail.js';

const mocks = vi.hoisted(() => ({
  listPackPurchases: vi.fn()
}));

vi.mock('../../../src/services/commerceService.js', () => ({
  listPackPurchases: mocks.listPackPurchases
}));

import { getOrderStatusTool } from '../../../src/tools/getOrderStatus.js';
import { listOrdersTool } from '../../../src/tools/listOrders.js';
import { certifiedOrderNote } from '../../../src/tools/certifiedOrder.js';
import { getOrderStatusOutputZ, listOrdersOutputZ } from '../../../src/zodSchemas.js';

const NUMBER = '9407 1000 0000 0000 0000 00';
const URL = 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9407100000000000000000';
const CERTIFIED: CertifiedFacts = { mailService: 'certified' };
const WITH_NUMBER: CertifiedFacts = { mailService: 'certified', carrierTrackingNumber: NUMBER, carrierTrackingUrl: URL };
const RECEIPT_WITH_NUMBER: CertifiedFacts = { ...WITH_NUMBER, mailService: 'certified_return_receipt' };

function order(orderId: string, certified?: CertifiedFacts): OrderRecord {
  return {
    orderId,
    currentStatus: 'in_transit',
    statusTimeline: [{ timestampISO: '2026-10-01T10:00:00Z', statusText: 'Order placed' }],
    recipientSummary: { name: 'Sam Rivera', city: 'Leeds', state: 'NY' },
    ...(certified ? { certified } : {})
  } as OrderRecord;
}

function contextWith(orders: OrderRecord[]) {
  return {
    user: { userId: 'user-1', creditsRemaining: 0, orders },
    correlationId: 'test-correlation',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
    now: () => new Date('2026-10-02T00:00:00Z'),
    persist: vi.fn()
  } as unknown as ToolContext;
}

describe('the words about a certified order (#625)', () => {
  it('says the service and that the number is not here yet, until it is stored', () => {
    expect(certifiedOrderNote(CERTIFIED)).toBe(
      'Sent as USPS Certified Mail. The USPS tracking number is not here yet: the printer adds it some time after it accepts the letter, so check again later.'
    );
  });

  it('gives the number and its link once it is stored', () => {
    expect(certifiedOrderNote(WITH_NUMBER)).toBe(`Sent as USPS Certified Mail. USPS tracking number ${NUMBER}: ${URL}.`);
  });

  it('says where the return receipt comes from, and that Letter IRL does not receive it', () => {
    const note = certifiedOrderNote(RECEIPT_WITH_NUMBER);
    expect(note).toContain('Sent as USPS Certified Mail with an electronic return receipt.');
    expect(note).toContain(`USPS tracking number ${NUMBER}: ${URL}.`);
    expect(note).toContain('Letter IRL does not receive it: ask USPS for it with the tracking number once the letter is delivered.');
  });

  it('says nothing of a return receipt for plain certified mail', () => {
    expect(certifiedOrderNote(WITH_NUMBER)).not.toMatch(/receipt/i);
    expect(certifiedOrderNote(CERTIFIED)).not.toMatch(/receipt/i);
  });

  it('names a number only with its link, and a link only with its number', () => {
    const notHere = certifiedOrderNote(CERTIFIED);
    expect(certifiedOrderNote({ mailService: 'certified', carrierTrackingNumber: NUMBER })).toBe(notHere);
    expect(certifiedOrderNote({ mailService: 'certified', carrierTrackingUrl: URL })).toBe(notHere);
  });

  it('promises no delivery and no legal effect', () => {
    for (const facts of [CERTIFIED, WITH_NUMBER, RECEIPT_WITH_NUMBER]) {
      expect(certifiedOrderNote(facts)).not.toMatch(/guarantee|legal|proof|will be delivered|binding/i);
    }
  });
});

describe('get_order_status for certified mail (#625)', () => {
  it('leaves an ordinary order\'s answer as it was', async () => {
    const result = await getOrderStatusTool.handler({ orderId: 'plain' }, contextWith([order('plain')]));
    expect(result.trackingSupport).toBe('estimated_only');
    for (const key of ['mailService', 'carrierTrackingNumber', 'carrierTrackingUrl', 'certifiedNote']) {
      expect(result).not.toHaveProperty(key);
    }
  });

  it('names the service and says the number is not here yet, still estimated', async () => {
    const result = await getOrderStatusTool.handler({ orderId: 'c' }, contextWith([order('c', CERTIFIED)]));
    expect(result).toMatchObject({ mailService: 'certified', trackingSupport: 'estimated_only' });
    expect(result.certifiedNote).toBe(certifiedOrderNote(CERTIFIED));
    expect(result).not.toHaveProperty('carrierTrackingNumber');
    expect(result).not.toHaveProperty('carrierTrackingUrl');
  });

  it('gives USPS\'s number and link, and carrier tracking, once it is stored', async () => {
    const result = await getOrderStatusTool.handler({ orderId: 'c' }, contextWith([order('c', RECEIPT_WITH_NUMBER)]));
    expect(result).toMatchObject({
      mailService: 'certified_return_receipt',
      carrierTrackingNumber: NUMBER,
      carrierTrackingUrl: URL,
      trackingSupport: 'carrier_tracking',
      certifiedNote: certifiedOrderNote(RECEIPT_WITH_NUMBER)
    });
  });

  it('answers within its declared output', async () => {
    for (const facts of [undefined, CERTIFIED, WITH_NUMBER, RECEIPT_WITH_NUMBER]) {
      const result = await getOrderStatusTool.handler({ orderId: 'x' }, contextWith([order('x', facts)]));
      expect(getOrderStatusOutputZ.safeParse(result).success).toBe(true);
    }
  });
});

describe('list_orders for certified mail (#625)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPackPurchases.mockResolvedValue({ purchases: [], total: 0 });
  });

  it('leaves an ordinary order\'s entry as it was', async () => {
    const result = await listOrdersTool.handler({}, contextWith([order('plain')]));
    expect(result.orders[0]).not.toHaveProperty('mailService');
    expect(result.orders[0]).not.toHaveProperty('carrierTrackingNumber');
    expect(result.orders[0]).not.toHaveProperty('carrierTrackingUrl');
  });

  it('gives each certified entry its service, and its number and link once stored', async () => {
    const result = await listOrdersTool.handler(
      {},
      contextWith([order('a', CERTIFIED), order('b', WITH_NUMBER), order('c', RECEIPT_WITH_NUMBER)])
    );
    const byId = Object.fromEntries(result.orders.map(entry => [entry.orderId, entry]));
    expect(byId.a).toMatchObject({ mailService: 'certified' });
    expect(byId.a).not.toHaveProperty('carrierTrackingNumber');
    expect(byId.b).toMatchObject({ mailService: 'certified', carrierTrackingNumber: NUMBER, carrierTrackingUrl: URL });
    expect(byId.c).toMatchObject({ mailService: 'certified_return_receipt', carrierTrackingNumber: NUMBER, carrierTrackingUrl: URL });
  });

  it('answers within its declared output', async () => {
    const result = await listOrdersTool.handler({}, contextWith([order('a', CERTIFIED), order('b', WITH_NUMBER), order('p')]));
    expect(listOrdersOutputZ.safeParse(result).success).toBe(true);
  });
});
