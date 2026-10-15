/**
 * The order page says why an order waits for a person: an amount mismatch the
 * panel can release, or a refund that failed or was cancelled at Stripe, which
 * the sweep will not make again. For the latter it says what to check in
 * Stripe, the same for every such order: what is still owed depends on
 * Stripe's current view of its refunds and disputes (#730).
 */

import { describe, expect, it } from 'vitest';
import { renderOrder } from '../../../src/admin/pages/orders.js';
import { html } from '../../../src/admin/ui/html.js';

function page(lastErrorCode: string | null, status = 'refund_pending', stripeDisputeStatus: string | null = null): string {
  const detail = {
    order: {
      orderId: 'order-1', orderType: 'letter_pack', productCode: 'starter', status,
      amountCents: 1999, currency: 'usd', amountRefundedCents: 0, stripePaymentIntentId: 'pi_1',
      stripeCheckoutSessionId: null, letterId: null, refundAttempts: 1, lastErrorCode, holdReason: null,
      stripeDisputeStatus, createdAt: new Date('2026-10-01T00:00:00Z'), paidAt: null, fulfilledAt: null,
      refundedAt: null, updatedAt: new Date('2026-10-02T00:00:00Z')
    },
    pack: null, userId: 'auth0|1', emailMasked: 'a***@example.test', amountKnown: true,
    lots: [], letters: [], packRefunds: [], events: [], webhookEvents: [], alerts: [], disputes: [],
    heldAt: null, holdPreviousStatus: null
  };
  return String(renderOrder({ detail: detail as never, actions: html`` }));
}

/** The note's words, from its error code to its alert. */
function note(text: string): string {
  return text.slice(text.indexOf('<code>REFUND_NOT_COMPLETED</code>'), text.indexOf('(docs/deployment.md)'));
}

describe('the order page', () => {
  it('explains a refund held for a person: what to check in Stripe, and its alert', () => {
    const text = page('REFUND_NOT_COMPLETED');
    expect(text).toContain('<code>REFUND_NOT_COMPLETED</code>');
    expect(text).toContain('its refund failed or was cancelled at Stripe, and the sweep will not make another.');
    expect(text).toContain('Before refunding again, check in Stripe its refunds (a new one may still be pending, and the failed one says why)');
    expect(text).toContain('and any dispute on the payment (Stripe refuses a refund while a chargeback is open, and a lost one has already returned the disputed amount)');
    expect(text).toContain('Refund only what is still owed; if the card can no longer take a refund (closed or lost), it must go back another way and the order be settled by hand.');
    expect(text).toContain('<code>refund_not_completed</code> alert');
    expect(text).not.toContain('quarantined from the automatic refund sweep');
  });

  it("says the same whatever the order's status or stored dispute, which Stripe may have moved past", () => {
    const plain = note(page('REFUND_NOT_COMPLETED'));
    for (const [status, dispute] of [
      ['disputed', 'needs_response'],
      ['disputed', 'lost'],
      ['refund_pending', 'under_review'],
      ['disputed', 'warning_closed'],
      ['disputed', 'a_status_from_the_future'],
    ]) {
      expect(note(page('REFUND_NOT_COMPLETED', status, dispute)), `${status} ${dispute}`).toBe(plain);
    }
  });

  it('shows no error box when the order has no error', () => {
    const text = page(null);
    expect(text).not.toContain('Last error code');
  });

  it('still explains an amount-mismatch quarantine as before', () => {
    const text = page('PAYMENT_AMOUNT_MISMATCH');
    expect(text).toContain('quarantined from the automatic refund sweep until an operator releases it');
    expect(text).not.toContain('the sweep will not make another');
  });
});
