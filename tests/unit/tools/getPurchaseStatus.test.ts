import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../src/contracts/types.js';

const mocks = vi.hoisted(() => ({ getPurchaseStatus: vi.fn() }));

vi.mock('../../../src/services/commerceService.js', () => ({
  getPurchaseStatus: mocks.getPurchaseStatus
}));

import { getPurchaseStatusTool } from '../../../src/tools/getPurchaseStatus.js';

const context = {
  user: { userId: 'user-private', creditsRemaining: 0, orders: [] },
  correlationId: 'correlation-private',
  logger: {},
  now: () => new Date(),
  persist: vi.fn()
} as unknown as ToolContext;

describe('get_purchase_status privacy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not distinguish a missing purchase from another owner\'s purchase', async () => {
    mocks.getPurchaseStatus.mockRejectedValueOnce(
      Object.assign(new Error('internal detail'), { code: 'PURCHASE_NOT_FOUND' })
    );

    await expect(
      getPurchaseStatusTool.handler({ orderId: 'order-private' }, context)
    ).rejects.toThrow('Purchase not found for your account.');
  });

  it('does not expose arbitrary commerce exceptions', async () => {
    const sensitive = 'private database exception order-private pi-private';
    mocks.getPurchaseStatus.mockRejectedValueOnce(new Error(sensitive));

    await expect(
      getPurchaseStatusTool.handler({ orderId: 'order-private' }, context)
    ).rejects.toThrow('Unable to retrieve purchase status. Please try again.');
  });
});
