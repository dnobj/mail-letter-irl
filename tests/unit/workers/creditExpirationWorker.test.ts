/**
 * Unit tests for creditExpirationWorker
 *
 * Tests the credit expiration worker configuration:
 * - Worker processes jobs correctly
 * - Daily scheduling via setInterval (replaces boss.schedule)
 * - Manual triggering
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Track call order for verification
let callOrder: string[] = [];

// Mock pg-boss before importing the worker
const mockBoss = {
  createQueue: vi.fn().mockImplementation(() => {
    callOrder.push('createQueue');
    return Promise.resolve();
  }),
  work: vi.fn().mockImplementation(() => {
    callOrder.push('work');
    return Promise.resolve();
  }),
  send: vi.fn().mockResolvedValue('test-job-id'),
};

const mockRunMaintenance = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../src/services/jobQueue.js', () => ({
  getJobQueue: vi.fn(() => mockBoss),
  runMaintenance: (...args: any[]) => mockRunMaintenance(...args),
}));

// Mock workerEvents
vi.mock('../../../src/workers/workerEvents.js', () => ({
  getPollingIntervalSeconds: vi.fn(() => 2),
}));

// Mock the services that processCreditExpiration calls
vi.mock('../../../src/services/creditLedgerService.js', () => ({
  markExpiredEntries: vi.fn().mockResolvedValue({ count: 0 }),
  reconcileBalances: vi.fn().mockResolvedValue({ checked: 0, fixed: 0, mismatches: [] }),
  getUsersWithExpiringCredits: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/services/draftService.js', () => ({
  markExpiredDrafts: vi.fn().mockResolvedValue(0),
  cleanupOldDrafts: vi.fn().mockResolvedValue(0),
  getDraftStats: vi.fn().mockResolvedValue({ pending: 0, consumed: 0, expired: 0, cancelled: 0, expiringSoon: 0 }),
}));

vi.mock('../../../src/services/stripeReconciliationService.js', () => ({
  reconcileStripePayments: vi.fn().mockResolvedValue({ summary: { matched: 0, missingInOurSystem: 0, unprocessedRefunds: 0 }, discrepancies: [] }),
}));

vi.mock('../../../src/services/tierService.js', () => ({
  updateAllUserTiers: vi.fn().mockResolvedValue({ checked: 0, upgraded: 0, downgraded: 0, skippedOverride: 0, details: [] }),
  clearTierCache: vi.fn(),
}));

describe('creditExpirationWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    callOrder = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  // ==========================================================================
  // startCreditExpirationWorker Tests
  // ==========================================================================
  describe('startCreditExpirationWorker', () => {
    it('should create queue before registering worker', async () => {
      // Set time to 2 AM UTC so daily check doesn't trigger boss.send
      vi.setSystemTime(new Date('2026-01-15T02:00:00Z'));

      const { startCreditExpirationWorker, stopCreditExpirationWorker } = await import('../../../src/workers/creditExpirationWorker.js');

      await startCreditExpirationWorker();

      expect(mockBoss.createQueue).toHaveBeenCalledWith('credit-expiration');
      expect(mockBoss.work).toHaveBeenCalled();

      // Verify createQueue is called before work
      const createQueueIndex = callOrder.indexOf('createQueue');
      const workIndex = callOrder.indexOf('work');
      expect(createQueueIndex).toBeLessThan(workIndex);

      stopCreditExpirationWorker();
    });

    it('should not call boss.schedule (Timekeeper is disabled)', async () => {
      vi.setSystemTime(new Date('2026-01-15T02:00:00Z'));

      const { startCreditExpirationWorker, stopCreditExpirationWorker } = await import('../../../src/workers/creditExpirationWorker.js');

      await startCreditExpirationWorker();

      // boss.schedule should not exist on mock (we removed it from the mock)
      // and should not be called
      expect((mockBoss as any).schedule).toBeUndefined();

      stopCreditExpirationWorker();
    });

    it('should queue daily job on startup if after 3 AM UTC', async () => {
      vi.setSystemTime(new Date('2026-01-15T04:00:00Z'));

      const { startCreditExpirationWorker, stopCreditExpirationWorker } = await import('../../../src/workers/creditExpirationWorker.js');

      await startCreditExpirationWorker();

      // Should have sent a scheduled job
      expect(mockBoss.send).toHaveBeenCalledWith(
        'credit-expiration',
        expect.objectContaining({ scheduled: true })
      );

      // Should have run maintenance
      expect(mockRunMaintenance).toHaveBeenCalled();

      stopCreditExpirationWorker();
    });

    it('should not queue daily job on startup if before 3 AM UTC', async () => {
      vi.setSystemTime(new Date('2026-01-15T02:00:00Z'));

      const { startCreditExpirationWorker, stopCreditExpirationWorker } = await import('../../../src/workers/creditExpirationWorker.js');

      await startCreditExpirationWorker();

      // Should NOT have sent a scheduled job (too early)
      expect(mockBoss.send).not.toHaveBeenCalled();
      expect(mockRunMaintenance).not.toHaveBeenCalled();

      stopCreditExpirationWorker();
    });
  });

  // ==========================================================================
  // triggerCreditExpiration Tests
  // ==========================================================================
  describe('triggerCreditExpiration', () => {
    it('should send job to credit-expiration queue', async () => {
      const { triggerCreditExpiration } = await import('../../../src/workers/creditExpirationWorker.js');

      const jobId = await triggerCreditExpiration();

      expect(mockBoss.send).toHaveBeenCalledWith(
        'credit-expiration',
        expect.objectContaining({
          triggeredAt: expect.any(String),
          manual: true,
        })
      );
      expect(jobId).toBe('test-job-id');
    });
  });

  // ==========================================================================
  // stopCreditExpirationWorker Tests
  // ==========================================================================
  describe('stopCreditExpirationWorker', () => {
    it('should clear the schedule timer', async () => {
      vi.setSystemTime(new Date('2026-01-15T02:00:00Z'));

      const { startCreditExpirationWorker, stopCreditExpirationWorker } = await import('../../../src/workers/creditExpirationWorker.js');

      await startCreditExpirationWorker();
      stopCreditExpirationWorker();

      // After stopping, no more intervals should fire
      // (we can't easily assert the timer is cleared, but no errors should occur)
    });
  });
});
