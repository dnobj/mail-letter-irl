import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn()
}));

vi.mock('../../../src/db/index.js', () => ({
  query: mocks.query,
  transaction: mocks.transaction
}));

import {
  checkGenerationLimit,
  commitGenerationReservation,
  getGenerationQuota,
  grantImageEntitlement,
  releaseGenerationReservation,
  reserveGeneration
} from '../../../src/services/imageGenerationLimitService.js';

describe('imageGenerationLimitService explicit entitlements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async callback => callback({ query: mocks.query }));
  });

  it('computes quota from explicit grants rather than lifetime purchases', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ allowance: '8', used: '3', remaining: '5' }]
    });

    await expect(getGenerationQuota('user-1')).resolves.toEqual({
      allowance: 8,
      used: 3,
      remaining: 5
    });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('FROM image_entitlements'), [
      'user-1'
    ]);
  });

  it('reports generation eligibility from remaining entitlement quantity', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ allowance: '1', used: '1', remaining: '0' }]
    });
    await expect(checkGenerationLimit('user-1')).resolves.toMatchObject({
      allowed: false,
      remaining: 0
    });
  });

  it('grants by a unique source reference so payment replays cannot duplicate it', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ entitlement_id: 'ent-1', quantity: 1 }]
    });
    const grant = await grantImageEntitlement({
      userId: 'user-1',
      sourceType: 'jit_order',
      sourceReferenceId: 'order-1',
      sourceOrderId: 'order-1',
      quantity: 1
    });

    expect(grant).toMatchObject({ entitlement_id: 'ent-1' });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (source_type, source_reference_id) DO NOTHING'),
      ['user-1', 'jit_order', 'order-1', 'order-1', 1, null]
    );
  });

  it('atomically reserves the oldest available entitlement', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ entitlement_id: 'ent-1', quantity: 2, consumed_quantity: 0 }]
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ reservation_id: 'reservation-1' }] })
      .mockResolvedValueOnce({
        rows: [{ allowance: '2', used: '1', remaining: '1' }]
      });

    await expect(reserveGeneration('user-1')).resolves.toEqual({
      reserved: true,
      reservationId: 'reservation-1',
      allowance: 2,
      used: 1,
      remaining: 1
    });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT 1\n       FOR UPDATE'),
      ['user-1']
    );
  });

  it('returns current quota when no entitlement can be reserved', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ allowance: '4', used: '4', remaining: '0' }]
      });

    await expect(reserveGeneration('user-1')).resolves.toEqual({
      reserved: false,
      allowance: 4,
      used: 4,
      remaining: 0
    });
  });

  it('commits a successful reservation', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await commitGenerationReservation('reservation-1');
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'consumed'"), [
      'reservation-1'
    ]);
  });

  it('releases the exact reserved entitlement after provider failure', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            reservation_id: 'reservation-1',
            entitlement_id: 'ent-1',
            status: 'reserved'
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await releaseGenerationReservation('user-1', 'reservation-1');
    expect(mocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('consumed_quantity = GREATEST(consumed_quantity - 1, 0)'),
      ['ent-1']
    );
    expect(mocks.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("SET status = 'released'"),
      ['reservation-1']
    );
  });
});
