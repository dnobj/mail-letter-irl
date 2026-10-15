/**
 * The order page says why an order waits for a person: an amount mismatch the
 * panel can release, or a refund that failed or was cancelled at Stripe, which
 * the sweep will not make again (#730).
 */

import { describe, expect, it } from 'vitest';
import { renderOrder } from '../../../src/admin/pages/orders.js';
import { html } from '../../../src/admin/ui/html.js';

function page(lastErrorCode: string | null, status = 'refund_pending'): string {
  const detail = {
    order: {
      orderId: 'order-1', orderType: 'letter_pack', productCode: 'starter', status,
      amountCents: 1999, currency: 'usd', amountRefundedCents: 0, stripePaymentIntentId: 'pi_1',
      stripeCheckoutSessionId: null, letterId: null, refundAttempts: 1, lastErrorCode, holdReason: null,
      stripeDisputeStatus: null, createdAt: new Date('2026-10-01T00:00:00Z'), paidAt: null, fulfilledAt: null,
      refundedAt: null, updatedAt: new Date('2026-10-02T00:00:00Z')
    },
    pack: null, userId: 'auth0|1', emailMasked: 'a***@example.test', amountKnown: true,
    lots: [], letters: [], packRefunds: [], events: [], webhookEvents: [], alerts: [], disputes: [],
    heldAt: null, holdPreviousStatus: null
  };
  return String(renderOrder({ detail: detail as never, actions: html`` }));
}

describe('the order page', () => {
  it('explains a refund held for a person, and points at its alert', () => {
    const text = page('REFUND_NOT_COMPLETED');
    expect(text).toContain('<code>REFUND_NOT_COMPLETED</code>');
    expect(text).toContain('its refund failed or was cancelled at Stripe, and the sweep will not make another');
    expect(text).toContain('Refund it again in Stripe once the cause is fixed');
    expect(text).toContain('<code>refund_not_completed</code> alert');
    expect(text).not.toContain('quarantined from the automatic refund sweep');
  });

  it('does not tell an operator to refund a held order that has since been disputed', () => {
    const text = page('REFUND_NOT_COMPLETED', 'disputed');
    expect(text).toContain('the order has since become <code>disputed</code>, so do not refund it from here');
    expect(text).toContain('<code>refund_not_completed</code> alert');
    expect(text).not.toContain('Refund it again in Stripe');
    expect(text).not.toContain('the sweep will not make another');
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
