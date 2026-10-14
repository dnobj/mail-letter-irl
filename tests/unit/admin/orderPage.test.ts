/**
 * The order page says why an order waits for a person: an amount mismatch the
 * panel can release, or a refund that failed or was cancelled at Stripe, which
 * the sweep will not make again (#730).
 */

import { describe, expect, it } from 'vitest';
import { renderOrder } from '../../../src/admin/pages/orders.js';
import { html } from '../../../src/admin/ui/html.js';

function page(lastErrorCode: string | null): string {
  const detail = {
    order: {
      orderId: 'order-1', orderType: 'letter_pack', productCode: 'starter', status: 'refund_pending',
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
    expect(text).toContain('<code>refund_not_completed</code> alert');
    expect(text).not.toContain('quarantined from the automatic refund sweep');
  });

  it('still explains an amount-mismatch quarantine as before', () => {
    const text = page('PAYMENT_AMOUNT_MISMATCH');
    expect(text).toContain('quarantined from the automatic refund sweep until an operator releases it');
    expect(text).not.toContain('the sweep will not make another');
  });
});
