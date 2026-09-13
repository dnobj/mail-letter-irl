/**
 * Unit tests for list_orders.
 *
 * Issue #365: a customer who had just bought a pack asked for "the status of
 * my most recent pack purchase" and the model could not find it. This tool
 * covered mailed letters only, get_purchase_status needs an order id, and the
 * only place the id appeared was the checkout card, which the model does not
 * see. Pack purchases are now listed alongside, additively.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../src/contracts/types.js';

const mocks = vi.hoisted(() => ({
  listPackPurchases: vi.fn()
}));

vi.mock('../../../src/services/commerceService.js', () => ({
  listPackPurchases: mocks.listPackPurchases
}));

import { listOrdersTool } from '../../../src/tools/listOrders.js';
import { listOrdersOutputZ } from '../../../src/zodSchemas.js';

function mailOrder(orderId: string, sentAt: string) {
  return {
    orderId,
    recipientSummary: { name: 'Recipient', city: 'Town', state: 'ST' },
    currentStatus: 'delivered',
    statusTimeline: [{ status: 'queued', timestampISO: sentAt }]
  };
}

function packPurchase(orderId: string, purchaseStatus: string, createdAt: string) {
  return {
    orderId,
    productDescription: 'Starter Pack - 2 Letters',
    letters: 2,
    purchaseStatus,
    amountCents: 500,
    currency: 'usd',
    displayAmount: '5.00',
    createdAt
  };
}

function contextWith(orders: unknown[] = []) {
  return {
    user: { userId: 'user-1', creditsRemaining: 0, orders },
    correlationId: 'test-correlation',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
    now: () => new Date('2026-09-13T00:00:00Z'),
    persist: vi.fn()
  } as unknown as ToolContext;
}

describe('list_orders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPackPurchases.mockResolvedValue({ purchases: [], total: 0 });
  });

  it('lists letter-pack purchases beside the mail orders, and the result matches the served schema', async () => {
    mocks.listPackPurchases.mockResolvedValue({
      purchases: [
        packPurchase('pack-2', 'submitted', '2026-09-13T00:17:31Z'),
        packPurchase('pack-1', 'cancelled', '2026-09-12T23:11:54Z')
      ],
      total: 2
    });
    const context = contextWith([mailOrder('mail-1', '2026-09-09T10:00:00Z')]);

    const result = await listOrdersTool.handler({}, context);

    expect(result.orders.map(order => order.orderId)).toEqual(['mail-1']);
    expect(result.total).toBe(1);
    expect(result.packPurchases.map(purchase => purchase.orderId)).toEqual(['pack-2', 'pack-1']);
    expect(result.packPurchases[0]).toMatchObject({
      purchaseStatus: 'submitted',
      letters: 2,
      displayAmount: '5.00'
    });
    expect(result.packPurchaseTotal).toBe(2);
    // The served schema is what the MCP layer validates against; a field the
    // tool returns but the schema does not declare would be stripped, and a
    // required field the tool omits would reject every call (#197).
    expect(listOrdersOutputZ.safeParse(result).success).toBe(true);
  });

  it('passes the same limit to both lists', async () => {
    const context = contextWith([
      mailOrder('mail-3', '2026-09-03T10:00:00Z'),
      mailOrder('mail-2', '2026-09-02T10:00:00Z'),
      mailOrder('mail-1', '2026-09-01T10:00:00Z')
    ]);

    const result = await listOrdersTool.handler({ limit: 2 }, context);

    expect(result.orders).toHaveLength(2);
    expect(result.total).toBe(3);
    expect(mocks.listPackPurchases).toHaveBeenCalledWith('user-1', 2);
  });

  it('defaults the limit to ten', async () => {
    await listOrdersTool.handler({}, contextWith());
    expect(mocks.listPackPurchases).toHaveBeenCalledWith('user-1', 10);
  });

  it('fails closed when the pack list cannot be read, instead of answering "no purchases"', async () => {
    // An empty list here is a claim the customer would believe.
    mocks.listPackPurchases.mockRejectedValueOnce(new Error('connection refused to db host'));

    await expect(listOrdersTool.handler({}, contextWith())).rejects.toThrow(
      'Unable to list your orders right now. Please try again.'
    );
  });

  it('tells the model which status tool goes with which id, and never says "credit"', () => {
    expect(listOrdersTool.description).toMatch(/get_order_status/);
    expect(listOrdersTool.description).toMatch(/get_purchase_status/);
    expect(listOrdersTool.description).toMatch(/pack/i);
    expect(listOrdersTool.description).not.toMatch(/credit/i);
  });
});
