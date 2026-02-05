/**
 * Unit tests for creditExpirationWorker
 *
 * Tests the credit expiration worker configuration:
 * - Schedule registration uses correct queue name (pg-boss v10 requirement)
 * - Worker processes jobs correctly
 *
 * Bug Fixed: pg-boss v10 requires schedule name = queue name (foreign key constraint)
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
  schedule: vi.fn().mockImplementation(() => {
    callOrder.push('schedule');
    return Promise.resolve();
  }),
  send: vi.fn().mockResolvedValue('test-job-id'),
};

vi.mock('../../../src/services/jobQueue.js', () => ({
  getJobQueue: vi.fn(() => mockBoss),
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
    callOrder = [];
  });

  afterEach(() => {
    vi.resetModules();
  });

  // ==========================================================================
  // startCreditExpirationWorker Tests
  // ==========================================================================
  describe('startCreditExpirationWorker', () => {
    it('should register schedule with same name as queue (pg-boss v10 requirement)', async () => {
      const { startCreditExpirationWorker } = await import('../../../src/workers/creditExpirationWorker.js');

      await startCreditExpirationWorker();

      // Get the queue name from createQueue call
      const createQueueCall = mockBoss.createQueue.mock.calls[0];
      const queueName = createQueueCall[0];

      // Get the schedule name from schedule call
      const scheduleCall = mockBoss.schedule.mock.calls[0];
      const scheduleName = scheduleCall[0];

      // pg-boss v10 requires these to match (foreign key constraint)
      expect(scheduleName).toBe(queueName);
      expect(scheduleName).toBe('credit-expiration');
    });

    it('should create queue before registering worker', async () => {
      const { startCreditExpirationWorker } = await import('../../../src/workers/creditExpirationWorker.js');

      await startCreditExpirationWorker();

      expect(mockBoss.createQueue).toHaveBeenCalledWith('credit-expiration');
      expect(mockBoss.work).toHaveBeenCalled();

      // Verify createQueue is called before work
      const createQueueIndex = callOrder.indexOf('createQueue');
      const workIndex = callOrder.indexOf('work');
      expect(createQueueIndex).toBeLessThan(workIndex);
    });

    it('should schedule daily job at 3 AM UTC', async () => {
      const { startCreditExpirationWorker } = await import('../../../src/workers/creditExpirationWorker.js');

      await startCreditExpirationWorker();

      expect(mockBoss.schedule).toHaveBeenCalledWith(
        'credit-expiration',
        '0 3 * * *',
        {},
        { tz: 'UTC' }
      );
    });

    it('should handle schedule already exists error gracefully', async () => {
      // Simulate unique_violation error (schedule already exists)
      const uniqueViolationError = new Error('duplicate key value violates unique constraint');
      (uniqueViolationError as any).code = '23505';
      mockBoss.schedule.mockRejectedValueOnce(uniqueViolationError);

      const { startCreditExpirationWorker } = await import('../../../src/workers/creditExpirationWorker.js');

      // Should not throw
      await expect(startCreditExpirationWorker()).resolves.not.toThrow();
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
});
