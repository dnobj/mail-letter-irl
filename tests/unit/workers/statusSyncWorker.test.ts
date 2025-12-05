/**
 * Unit tests for statusSyncWorker
 *
 * Tests the worker lifecycle including:
 * - Starting the worker (runs immediate sync + sets interval)
 * - Stopping the worker (clears interval)
 * - Manual trigger functionality
 *
 * User Stories Covered:
 * - US-1.7: Letter Status Sync from Providers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the status sync service
vi.mock('../../../src/services/statusSyncService.js', () => {
  return {
    syncLetterStatuses: vi.fn(),
  };
});

// Import after mocking
import { syncLetterStatuses } from '../../../src/services/statusSyncService.js';
import {
  startStatusSyncWorker,
  stopStatusSyncWorker,
  triggerImmediateSync,
} from '../../../src/workers/statusSyncWorker.js';

describe('statusSyncWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Default mock implementation
    vi.mocked(syncLetterStatuses).mockResolvedValue({
      checked: 0,
      updated: 0,
      errors: 0,
      details: [],
    });
  });

  afterEach(() => {
    // Clean up any running worker
    stopStatusSyncWorker();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // startStatusSyncWorker Tests
  // ==========================================================================
  describe('startStatusSyncWorker', () => {
    it('should run sync immediately on start', async () => {
      await startStatusSyncWorker();

      expect(syncLetterStatuses).toHaveBeenCalledTimes(1);
      expect(syncLetterStatuses).toHaveBeenCalledWith(false, 30);
    });

    it('should set up interval for periodic syncs', async () => {
      await startStatusSyncWorker();

      // Clear the initial call count
      vi.mocked(syncLetterStatuses).mockClear();

      // Advance time by 6 hours
      const sixHours = 6 * 60 * 60 * 1000;
      await vi.advanceTimersByTimeAsync(sixHours);

      expect(syncLetterStatuses).toHaveBeenCalledTimes(1);

      // Advance another 6 hours
      await vi.advanceTimersByTimeAsync(sixHours);

      expect(syncLetterStatuses).toHaveBeenCalledTimes(2);
    });

    it('should not run sync before interval elapses', async () => {
      await startStatusSyncWorker();

      // Clear the initial call count
      vi.mocked(syncLetterStatuses).mockClear();

      // Advance time by only 1 hour
      const oneHour = 60 * 60 * 1000;
      await vi.advanceTimersByTimeAsync(oneHour);

      expect(syncLetterStatuses).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // stopStatusSyncWorker Tests
  // ==========================================================================
  describe('stopStatusSyncWorker', () => {
    it('should stop periodic syncs after stopping', async () => {
      await startStatusSyncWorker();

      // Clear the initial call count
      vi.mocked(syncLetterStatuses).mockClear();

      // Stop the worker
      stopStatusSyncWorker();

      // Advance time by 6 hours
      const sixHours = 6 * 60 * 60 * 1000;
      await vi.advanceTimersByTimeAsync(sixHours);

      // Should not have run since we stopped
      expect(syncLetterStatuses).not.toHaveBeenCalled();
    });

    it('should be safe to call multiple times', () => {
      // Should not throw
      expect(() => {
        stopStatusSyncWorker();
        stopStatusSyncWorker();
        stopStatusSyncWorker();
      }).not.toThrow();
    });
  });

  // ==========================================================================
  // triggerImmediateSync Tests
  // ==========================================================================
  describe('triggerImmediateSync', () => {
    it('should call syncLetterStatuses with default parameters', async () => {
      vi.mocked(syncLetterStatuses).mockResolvedValue({
        checked: 5,
        updated: 2,
        errors: 0,
        details: [],
      });

      const result = await triggerImmediateSync();

      expect(syncLetterStatuses).toHaveBeenCalledWith(false, 30);
      expect(result.checked).toBe(5);
      expect(result.updated).toBe(2);
    });

    it('should pass dryRun parameter to syncLetterStatuses', async () => {
      await triggerImmediateSync(true);

      expect(syncLetterStatuses).toHaveBeenCalledWith(true, 30);
    });

    it('should work independently of worker state', async () => {
      // Don't start the worker, but trigger should still work
      await triggerImmediateSync();

      expect(syncLetterStatuses).toHaveBeenCalled();
    });

    it('should return sync result', async () => {
      const mockResult = {
        checked: 10,
        updated: 3,
        errors: 1,
        details: [
          {
            letterId: 'test-letter',
            trackingId: 'test-track',
            oldStatus: 'processing',
            newStatus: 'delivered',
            providerRawStatus: 'Delivered',
          },
        ],
      };

      vi.mocked(syncLetterStatuses).mockResolvedValue(mockResult);

      const result = await triggerImmediateSync();

      expect(result).toEqual(mockResult);
    });
  });
});
