/**
 * Which of a payment's refunds is an order's full refund (#730): the one the
 * app made for it, or one made in the Stripe dashboard for at least the whole
 * known amount; and whether such a refund failed or was cancelled.
 */

import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { classifyOrderRefunds } from '../../../src/services/stripeService.js';

function refund(id: string, status: string, amount: number, metadata: Record<string, string> = {}): Stripe.Refund {
  return { id, object: 'refund', status, amount, metadata } as unknown as Stripe.Refund;
}

describe('classifyOrderRefunds', () => {
  it('adopts the refund the app made for this order', () => {
    const ours = refund('re_ours', 'succeeded', 1999, { orderId: 'order_1' });
    expect(classifyOrderRefunds([ours], 'order_1', 1999)).toEqual({ live: ours, ended: null });
  });

  it('adopts a dashboard refund, which names nothing, for at least the whole known amount', () => {
    const dashboard = refund('re_dash', 'pending', 1999);
    expect(classifyOrderRefunds([dashboard], 'order_1', 1999).live).toBe(dashboard);
  });

  it('never takes a dashboard partial for the whole, nor any untagged refund when the amount is unknown', () => {
    expect(classifyOrderRefunds([refund('re_part', 'succeeded', 1998)], 'order_1', 1999)).toEqual({ live: null, ended: null });
    expect(classifyOrderRefunds([refund('re_dash', 'succeeded', 1999)], 'order_1', null)).toEqual({ live: null, ended: null });
    expect(classifyOrderRefunds([refund('re_dash', 'succeeded', 1999)], 'order_1', 0)).toEqual({ live: null, ended: null });
  });

  it('ignores a proportional refund and one naming another order', () => {
    const proportional = refund('re_prop', 'succeeded', 1999, { orderId: 'order_1', packRefundId: 'cmd_1' });
    const another = refund('re_other', 'succeeded', 1999, { orderId: 'order_2' });
    expect(classifyOrderRefunds([proportional, another], 'order_1', 1999)).toEqual({ live: null, ended: null });
  });

  it.each(['failed', 'canceled'])('reports a %s refund as ended, not live', status => {
    const ended = refund('re_end', status, 1999, { orderId: 'order_1' });
    expect(classifyOrderRefunds([ended], 'order_1', 1999)).toEqual({ live: null, ended });
    const dashboardEnded = refund('re_dash_end', status, 1999);
    expect(classifyOrderRefunds([dashboardEnded], 'order_1', 1999)).toEqual({ live: null, ended: dashboardEnded });
  });

  it('prefers a live refund, and still reports the ended one beside it', () => {
    const ended = refund('re_end', 'canceled', 1999, { orderId: 'order_1' });
    const live = refund('re_live', 'succeeded', 1999);
    expect(classifyOrderRefunds([ended, live], 'order_1', 1999)).toEqual({ live, ended });
  });
});
