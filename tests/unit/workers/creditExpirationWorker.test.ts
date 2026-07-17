import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/creditLedgerService.js', () => ({
  markExpiredEntries: vi.fn().mockResolvedValue({ count: 2 }),
  reconcileBalances: vi.fn().mockResolvedValue({ checked: 3, fixed: 1, mismatches: [] }),
  getUsersWithExpiringCredits: vi.fn().mockResolvedValue([{ userId: 'user-1' }]),
}));
vi.mock('../../../src/services/draftService.js', () => ({
  markExpiredDrafts: vi.fn().mockResolvedValue(4),
  cleanupOldDrafts: vi.fn().mockResolvedValue(5),
  getDraftStats: vi.fn().mockResolvedValue({
    pending: 6,
    consumed: 0,
    expired: 0,
    cancelled: 0,
    expiringSoon: 0,
  }),
}));
vi.mock('../../../src/services/stripeReconciliationService.js', () => ({
  reconcileStripePayments: vi.fn().mockResolvedValue({
    summary: { matched: 0, missingInOurSystem: 0, unprocessedRefunds: 0 },
    discrepancies: [],
  }),
}));
vi.mock('../../../src/services/tierService.js', () => ({
  updateAllUserTiers: vi.fn().mockResolvedValue({
    checked: 0,
    upgraded: 0,
    downgraded: 0,
    skippedOverride: 0,
    details: [],
  }),
  clearTierCache: vi.fn(),
}));

import {
  runDailyMaintenance,
  startCreditExpirationWorker,
  stopCreditExpirationWorker,
  triggerCreditExpiration,
} from '../../../src/workers/creditExpirationWorker.js';

describe('creditExpirationWorker one-shot behavior', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs all daily maintenance steps and returns a summary', async () => {
    await expect(runDailyMaintenance()).resolves.toEqual({
      expiredCredits: 2,
      balanceMismatchesFixed: 1,
      usersWithExpiringCredits: 1,
      expiredDrafts: 4,
      cleanedDrafts: 5,
      pendingDrafts: 6,
    });
  });

  it('runs the manual trigger inline', async () => {
    await expect(triggerCreditExpiration()).resolves.toBe('completed-inline');
  });

  it('disables the former in-process scheduler', async () => {
    await expect(startCreditExpirationWorker()).rejects.toThrow('In-process credit workers are disabled');
    expect(() => stopCreditExpirationWorker()).not.toThrow();
  });
});
