/**
 * Orders sent as USPS Certified Mail (#625): get_order_status and list_orders
 * give the service, USPS's number and its link once the status sync has stored
 * it, and, for the status, what to tell the person about the number and the
 * electronic return receipt. An ordinary order's answer is unchanged.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LetterStatus, OrderRecord, ToolContext } from '../../../src/contracts/types.js';
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

const LETTER_STATUSES: LetterStatus[] = ['pending', 'scheduled', 'accepted', 'printing', 'in_transit', 'delivered', 'returned', 'failed', 'cancelled'];
const asStatus = (status: string) => status as LetterStatus;

function order(orderId: string, certified?: CertifiedFacts, status: LetterStatus = 'in_transit'): OrderRecord {
  return {
    orderId,
    currentStatus: status,
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
  const NOT_HERE =
    'The USPS tracking number is not here yet: the printer adds it some time after it accepts the letter, so check again later.';
  const RECEIPT =
    'The electronic return receipt is the record USPS keeps of who signed for the letter. Letter IRL does not send it to you: once the letter is delivered, ask USPS for it with the tracking number.';

  it('says the service and that the number is not here yet, while the printer has the letter', () => {
    for (const status of ['accepted', 'printing', 'in_transit', 'delivered'] as LetterStatus[]) {
      expect(certifiedOrderNote(CERTIFIED, status), status).toBe(`Sent as USPS Certified Mail. ${NOT_HERE}`);
    }
  });

  it('gives the number and its link once it is stored', () => {
    expect(certifiedOrderNote(WITH_NUMBER, 'in_transit')).toBe(`Sent as USPS Certified Mail. USPS tracking number ${NUMBER}: ${URL}.`);
  });

  it('says where the return receipt comes from, and that Letter IRL does not send it, without settling more', () => {
    const note = certifiedOrderNote(RECEIPT_WITH_NUMBER, 'delivered');
    expect(note).toContain('Sent as USPS Certified Mail with an electronic return receipt.');
    expect(note).toContain(`USPS tracking number ${NUMBER}: ${URL}.`);
    expect(note).toContain(RECEIPT);
    // Not "does not receive it": where the receipt goes is for the development check to settle.
    expect(note).not.toMatch(/does not receive/i);
  });

  it('says nothing of a return receipt for plain certified mail', () => {
    for (const status of ['in_transit', 'scheduled', 'delivered'] as LetterStatus[]) {
      expect(certifiedOrderNote(WITH_NUMBER, status)).not.toMatch(/receipt/i);
      expect(certifiedOrderNote(CERTIFIED, status)).not.toMatch(/receipt/i);
    }
  });

  it('names a number only with its link, and a link only with its number', () => {
    const notHere = certifiedOrderNote(CERTIFIED, 'in_transit');
    expect(certifiedOrderNote({ mailService: 'certified', carrierTrackingNumber: NUMBER }, 'in_transit')).toBe(notHere);
    expect(certifiedOrderNote({ mailService: 'certified', carrierTrackingUrl: URL }, 'in_transit')).toBe(notHere);
  });

  it('does not tell a letter that did not go out to check again later, or to ask USPS for a receipt', () => {
    expect(certifiedOrderNote(CERTIFIED, 'failed')).toBe('This letter (USPS Certified Mail) did not go out. It has no USPS tracking number.');
    expect(certifiedOrderNote(CERTIFIED, 'cancelled')).toBe('This letter (USPS Certified Mail) was cancelled and not mailed. It has no USPS tracking number.');
    for (const status of ['failed', 'cancelled'] as LetterStatus[]) {
      const note = certifiedOrderNote({ mailService: 'certified_return_receipt' }, status);
      expect(note, status).not.toMatch(/check again|receipt is|ask USPS/i);
      expect(note, status).toContain('with an electronic return receipt');
    }
  });

  it('says mail that has not reached the printer goes as certified mail, and that the number comes after, without saying it has reached it', () => {
    for (const status of ['scheduled', 'pending'] as LetterStatus[]) {
      const note = certifiedOrderNote({ mailService: 'certified_return_receipt' }, status);
      expect(note, status).toBe(
        `Goes as USPS Certified Mail with an electronic return receipt. USPS's tracking number comes some time after the printer accepts it. ${RECEIPT}`
      );
      expect(note, status).not.toMatch(/Sent as|check again|once it is sent/);
    }
  });

  it('says a returned letter was returned, keeps a number it has, and looks for none', () => {
    expect(certifiedOrderNote(CERTIFIED, 'returned')).toBe(
      'Sent as USPS Certified Mail, and returned to the sender. No USPS tracking number was stored for it.'
    );
    expect(certifiedOrderNote(WITH_NUMBER, 'returned')).toBe(
      `Sent as USPS Certified Mail, and returned to the sender. USPS tracking number ${NUMBER}: ${URL}.`
    );
    expect(certifiedOrderNote(RECEIPT_WITH_NUMBER, 'returned')).not.toMatch(/receipt is|ask USPS/);
  });

  it('keeps a stored number for any status', () => {
    for (const status of ['failed', 'cancelled', 'scheduled', 'returned', 'in_transit'] as LetterStatus[]) {
      expect(certifiedOrderNote(WITH_NUMBER, status), status).toContain(`USPS tracking number ${NUMBER}: ${URL}.`);
    }
  });

  it('promises no delivery and no legal effect', () => {
    for (const facts of [CERTIFIED, WITH_NUMBER, RECEIPT_WITH_NUMBER]) {
      for (const status of LETTER_STATUSES) {
        expect(certifiedOrderNote(facts, status)).not.toMatch(/guarantee|legal|proof|will be delivered|binding/i);
      }
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
    expect(result.certifiedNote).toBe(certifiedOrderNote(CERTIFIED, 'in_transit'));
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
      certifiedNote: certifiedOrderNote(RECEIPT_WITH_NUMBER, 'in_transit')
    });
  });

  it('words the note by where the order stands, not as though every certified order went out', async () => {
    for (const status of ['failed', 'cancelled', 'scheduled', 'pending', 'returned', 'delivered'] as LetterStatus[]) {
      const result = await getOrderStatusTool.handler({ orderId: 'c' }, contextWith([order('c', CERTIFIED, status)]));
      expect(result.certifiedNote, status).toBe(certifiedOrderNote(CERTIFIED, status));
    }
    const failed = await getOrderStatusTool.handler({ orderId: 'c' }, contextWith([order('c', CERTIFIED, 'failed')]));
    expect(failed.certifiedNote).not.toMatch(/Sent as|check again/);
  });

  it('words every status the contracts name, and a status it has never heard of as one the printer has', () => {
    for (const status of LETTER_STATUSES) expect(certifiedOrderNote(CERTIFIED, status), status).toMatch(/USPS Certified Mail/);
    expect(certifiedOrderNote(CERTIFIED, asStatus('held_for_review'))).toBe(certifiedOrderNote(CERTIFIED, 'in_transit'));
  });

  it('gives carrier tracking for a stored number, but not to a letter that did not go out', async () => {
    for (const status of LETTER_STATUSES) {
      const result = await getOrderStatusTool.handler({ orderId: 'c' }, contextWith([order('c', WITH_NUMBER, status)]));
      const expected = status === 'failed' || status === 'cancelled' ? 'estimated_only' : 'carrier_tracking';
      expect(result.trackingSupport, status).toBe(expected);
      // The number itself is still given: it is a fact on the row.
      expect(result.carrierTrackingNumber, status).toBe(NUMBER);
    }
  });

  it('answers within its declared output, with no key it does not declare', async () => {
    for (const facts of [undefined, CERTIFIED, WITH_NUMBER, RECEIPT_WITH_NUMBER]) {
      const result = await getOrderStatusTool.handler({ orderId: 'x' }, contextWith([order('x', facts)]));
      expect(getOrderStatusOutputZ.strict().safeParse(result).success).toBe(true);
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
    // And no key an entry does not declare: the entries are where the new fields are.
    const entry = listOrdersOutputZ.shape.orders.element.strict();
    for (const each of result.orders) expect(entry.safeParse(each).success, each.orderId).toBe(true);
  });
});
