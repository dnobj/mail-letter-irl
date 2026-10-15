/**
 * The order page says why an order waits for a person: an amount mismatch the
 * panel can release, or a refund that failed or was cancelled at Stripe, which
 * the sweep will not make again. For the latter, what to do depends on the
 * order's dispute, not its status (#730).
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

const OWED = 'Check its refunds in Stripe first: a new one may still be pending, and the failed one says why.';

describe('the order page', () => {
  it('explains a refund held for a person, and points at its alert', () => {
    const text = page('REFUND_NOT_COMPLETED');
    expect(text).toContain('<code>REFUND_NOT_COMPLETED</code>');
    expect(text).toContain('its refund failed or was cancelled at Stripe, and the sweep will not make another');
    expect(text).toContain(OWED);
    // A card that can no longer take a refund fails again the same way.
    expect(text).toContain('If the card can no longer take a refund (closed or lost), refunding again fails the same way');
    expect(text).toContain('Otherwise refund it again in Stripe.');
    expect(text).toContain('<code>refund_not_completed</code> alert');
    expect(text).not.toContain('quarantined from the automatic refund sweep');
    expect(text).not.toContain('moved no money');
  });

  it.each(['needs_response', 'under_review'])('tells an operator to wait while a chargeback is open (%s), whatever the order says', (dispute) => {
    // A late refund event can put a disputed order back in refund_pending; the dispute still decides.
    for (const status of ['disputed', 'refund_pending']) {
      const text = page('REFUND_NOT_COMPLETED', status, dispute);
      expect(text).toContain(`A chargeback is open on it (<code>${dispute}</code>): Stripe refuses a refund until it closes.`);
      expect(text).toContain('leave its <code>refund_not_completed</code> alert');
      expect(text).not.toContain('refund it again in Stripe');
    }
  });

  it('tells an operator not to refund an order whose chargeback was lost', () => {
    const text = page('REFUND_NOT_COMPLETED', 'disputed', 'lost');
    expect(text).toContain('It lost a chargeback, so the money already went back through the dispute: do not refund it again.');
    expect(text).not.toContain('refund it again in Stripe');
  });

  it.each(['warning_needs_response', 'warning_under_review', 'warning_closed', 'won', 'prevented'])(
    'says the refund is still owed after a dispute that moved no money (%s)',
    (dispute) => {
      const text = page('REFUND_NOT_COMPLETED', 'disputed', dispute);
      expect(text).toContain(`Its dispute (<code>${dispute}</code>) moved no money, so the refund is still owed.`);
      expect(text).toContain(OWED);
      expect(text).toContain('Otherwise refund it again in Stripe.');
      expect(text).not.toContain('A chargeback is open');
    }
  );

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
