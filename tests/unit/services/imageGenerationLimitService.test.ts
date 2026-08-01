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
  markGenerationDispatched,
  markGenerationReservationAmbiguous,
  reconcileGenerationReservations,
  releaseGenerationReservation,
  resolveAmbiguousGenerationReservation,
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
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('lease_expires_at'),
      ['ent-1', 'user-1', expect.any(Date)]
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
    mocks.query.mockResolvedValueOnce({ rows: [{ reservation_id: 'reservation-1' }], rowCount: 1 });
    await commitGenerationReservation('reservation-1');
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'consumed'"), [
      'reservation-1',
      null
    ]);
  });

  it('durably marks dispatch before provider I/O', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ reservation_id: 'reservation-1' }] });

    await expect(markGenerationDispatched('user-1', 'reservation-1')).resolves.toBe(true);

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'dispatched'"),
      ['reservation-1', 'user-1', expect.any(Date)]
    );
  });

  it('marks an unknown dispatched outcome ambiguous without restoring quota', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ reservation_id: 'reservation-1' }] });

    await expect(
      markGenerationReservationAmbiguous(
        'user-1',
        'reservation-1',
        'provider_outcome_unknown',
        'request-1'
      )
    ).resolves.toBe(true);

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'ambiguous'"),
      ['reservation-1', 'user-1', 'provider_outcome_unknown', 'request-1']
    );
  });

  it('resolves an ambiguous generation only through an explicit evidence decision', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            reservation_id: 'reservation-1',
            entitlement_id: 'ent-1',
            user_id: 'user-1',
            status: 'ambiguous'
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [{ entitlement_id: 'ent-1' }] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      resolveAmbiguousGenerationReservation(
        'reservation-1',
        'provider_confirmed_failed'
      )
    ).resolves.toBe(true);
    expect(mocks.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("SET status = 'released'"),
      ['reservation-1', 'provider_confirmed_failed', ['ambiguous']]
    );
  });

  it('consumes a provider-confirmed ambiguous success without restoring quota', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            reservation_id: 'reservation-1',
            entitlement_id: 'ent-1',
            user_id: 'user-1',
            status: 'ambiguous'
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      resolveAmbiguousGenerationReservation(
        'reservation-1',
        'provider_confirmed_succeeded'
      )
    ).resolves.toBe(true);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SET status = 'consumed'"),
      ['reservation-1', 'provider_confirmed_succeeded']
    );
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
      .mockResolvedValueOnce({ rows: [{ entitlement_id: 'ent-1' }] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    await releaseGenerationReservation('user-1', 'reservation-1');
    expect(mocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('consumed_quantity = consumed_quantity - 1'),
      ['ent-1']
    );
    expect(mocks.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("SET status = 'released'"),
      ['reservation-1', 'definite_failure', ['reserved', 'dispatched']]
    );
  });

  it('rolls back release when the held entitlement counter is inconsistent', async () => {
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
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      releaseGenerationReservation('user-1', 'reservation-1')
    ).rejects.toThrow('entitlement counter is inconsistent');
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it('releases stale pre-dispatch reservations but quarantines stale dispatches', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            reservation_id: 'reservation-pre',
            entitlement_id: 'ent-1',
            user_id: 'user-1',
            status: 'reserved'
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [{ entitlement_id: 'ent-1' }] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ reservation_id: 'reservation-dispatched' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: '2' }] });

    await expect(reconcileGenerationReservations()).resolves.toEqual({
      releasedBeforeDispatch: 1,
      markedAmbiguous: 1,
      ambiguousTotal: 2
    });

    expect(mocks.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("SET status = 'released'"),
      ['reservation-pre', 'crash_before_provider_dispatch', ['reserved']]
    );
    expect(mocks.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("SET status = 'ambiguous'"),
      [100]
    );
  });
});
