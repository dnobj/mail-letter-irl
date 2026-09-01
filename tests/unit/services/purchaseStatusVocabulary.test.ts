/**
 * The customer-facing purchase vocabulary (#310).
 *
 * Ten internal order statuses collapse into the handful a customer sees. That
 * collapse was untested and carried two defects, both fixed here and pinned so
 * they cannot return:
 *
 *   - 'sent' fired when the print provider ACCEPTED the job, which is not the
 *     same as the item being in the mail. The message underneath already said
 *     "accepted by the print provider" - the prose was right and the name was
 *     wrong. Now 'submitted'.
 *
 *   - 'disputed' and 'held' were folded into 'refund_pending', whose message
 *     claims the order could not be fulfilled and that we are refunding it.
 *     For a chargeback the customer raised against an order we may have
 *     delivered perfectly, that is wrong in both halves. Now 'on_hold'.
 *
 * Renamed pre-launch on purpose: a served enum value is free to change before
 * there are cached clients and fixed afterwards.
 */

import { describe, expect, it } from 'vitest';
import {
  publicPurchaseStatus,
  purchaseMessage,
  type PurchaseStatusResult
} from '../../../src/services/commerceService.js';
import { getPurchaseStatusOutputZ } from '../../../src/zodSchemas.js';

type PublicStatus = PurchaseStatusResult['purchaseStatus'];

const ORDER_STATUSES = [
  'checkout_pending',
  'paid',
  'fulfillment_pending',
  'fulfilled',
  'payment_failed',
  'refund_pending',
  'refunded',
  'disputed',
  'held',
  'cancelled'
] as const;

describe('purchase status vocabulary', () => {
  it('reports provider acceptance as submitted, not sent', () => {
    // "Sent" told a customer their letter was in the mail when it had only
    // reached the printer - which is up to an hour of queue away from even
    // that, since the outbox drains hourly.
    expect(publicPurchaseStatus('fulfilled')).toBe('submitted');
    expect(purchaseMessage('submitted')).toMatch(/accepted by the print provider/i);
  });

  it.each(['disputed', 'held'] as const)(
    'reports %s as on_hold rather than a refund we are processing',
    orderStatus => {
      expect(publicPurchaseStatus(orderStatus)).toBe('on_hold');
    }
  );

  it('never tells a customer on hold that we failed to fulfil their order', () => {
    // The exact text 'disputed' and 'held' used to inherit.
    const message = purchaseMessage('on_hold');

    expect(message).not.toMatch(/could not be fulfilled/i);
    expect(message).not.toMatch(/refund is being processed/i);
    expect(message).toMatch(/on hold/i);
  });

  it('never names the kind of hold', () => {
    // Whether it is a chargeback or an operational hold is ours to act on, not
    // the customer's, and naming it leaks the same class of internal detail as
    // users.sends_blocked_reason (#278 round 12).
    const message = purchaseMessage('on_hold');

    expect(message).not.toMatch(/disput|chargeback|held|block/i);
  });

  it('maps every order status to a status the served schema declares', () => {
    // The mapping is a switch with no default: an order status added without a
    // customer-facing counterpart returns undefined and ships as a schema
    // violation rather than a compile error.
    const declared = new Set(getPurchaseStatusOutputZ.shape.purchaseStatus.options);

    for (const orderStatus of ORDER_STATUSES) {
      const publicStatus = publicPurchaseStatus(orderStatus);
      expect(declared, `${orderStatus} -> ${publicStatus}`).toContain(publicStatus);
    }
  });

  it('gives every declared status a message', () => {
    const declared = getPurchaseStatusOutputZ.shape.purchaseStatus
      .options as readonly PublicStatus[];

    for (const status of declared) {
      const message = purchaseMessage(status);
      expect(message, `${status} has no message`).toBeTruthy();
    }
  });

  it('no longer serves the old name', () => {
    const declared = new Set<string>(getPurchaseStatusOutputZ.shape.purchaseStatus.options);

    expect(declared.has('sent')).toBe(false);
    expect(declared.has('submitted')).toBe(true);
    expect(declared.has('on_hold')).toBe(true);
  });
});
