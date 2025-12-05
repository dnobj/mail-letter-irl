/**
 * Unit tests for statusSyncService
 *
 * Tests the status sync business logic including:
 * - Fetching letters that need status updates
 * - Calling provider getStatus() for each letter
 * - Updating database when status changes
 * - Dry run mode (no updates)
 * - Error handling for provider failures
 *
 * User Stories Covered:
 * - US-1.7: Letter Status Sync from Providers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createLetterRowForSync,
  createStatusSyncTestLetters,
} from '../../fixtures/letters.js';

// Mock the database module before importing the service
vi.mock('../../../src/db/index.js', () => {
  return {
    query: vi.fn(),
  };
});

// Mock the provider module
vi.mock('../../../src/services/providers/index.js', () => {
  return {
    getLetterProvider: vi.fn(),
  };
});

// Import after mocking
import * as db from '../../../src/db/index.js';
import { getLetterProvider } from '../../../src/services/providers/index.js';
import {
  syncLetterStatuses,
  getStuckLetters,
} from '../../../src/services/statusSyncService.js';

describe('statusSyncService', () => {
  // Mock provider instance
  const mockProvider = {
    config: { displayName: 'MockProvider' },
    getStatus: vi.fn(),
    sendLetter: vi.fn(),
    validateAddress: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getLetterProvider).mockReturnValue(mockProvider as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // syncLetterStatuses Tests
  // ==========================================================================
  describe('syncLetterStatuses', () => {
    it('should return empty result when no letters need syncing', async () => {
      // Mock empty result from database
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as any);

      const result = await syncLetterStatuses(false, 30);

      expect(result.checked).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.details).toHaveLength(0);
    });

    it('should check letters and update status when changed', async () => {
      const testLetters = createStatusSyncTestLetters();

      // Mock database query returning letters
      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: testLetters } as any)
        // Mock UPDATE queries for status changes
        .mockResolvedValue({ rows: [], rowCount: 1 } as any);

      // Mock provider returning new statuses
      mockProvider.getStatus
        .mockResolvedValueOnce({ status: 'in_transit', statusMessage: 'In transit to recipient' })
        .mockResolvedValueOnce({ status: 'delivered', statusMessage: 'Delivered to mailbox' })
        .mockResolvedValueOnce({ status: 'queued', statusMessage: 'Queued for processing' });

      const result = await syncLetterStatuses(false, 30);

      expect(result.checked).toBe(3);
      expect(result.updated).toBe(2); // First two changed, third stayed same (queued → queued)
      expect(result.errors).toBe(0);

      // Verify provider was called for each letter
      expect(mockProvider.getStatus).toHaveBeenCalledTimes(3);
      expect(mockProvider.getStatus).toHaveBeenCalledWith('track-1');
      expect(mockProvider.getStatus).toHaveBeenCalledWith('track-2');
      expect(mockProvider.getStatus).toHaveBeenCalledWith('track-3');

      // Verify UPDATE was called for changed statuses
      const updateCalls = vi.mocked(db.query).mock.calls.filter(
        call => (call[0] as string).includes('UPDATE')
      );
      expect(updateCalls).toHaveLength(2);
    });

    it('should not update database in dry run mode', async () => {
      const testLetters = [createLetterRowForSync({
        letterId: 'letter-dry-run',
        trackingId: 'track-dry',
        status: 'processing',
      })];

      vi.mocked(db.query).mockResolvedValueOnce({ rows: testLetters } as any);

      mockProvider.getStatus.mockResolvedValueOnce({
        status: 'delivered',
        statusMessage: 'Delivered',
      });

      const result = await syncLetterStatuses(true, 30); // dryRun = true

      expect(result.checked).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.errors).toBe(0);

      // Verify only SELECT was called, no UPDATE
      const updateCalls = vi.mocked(db.query).mock.calls.filter(
        call => (call[0] as string).includes('UPDATE')
      );
      expect(updateCalls).toHaveLength(0);
    });

    it('should handle provider errors gracefully', async () => {
      const testLetters = [
        createLetterRowForSync({
          letterId: 'letter-ok',
          trackingId: 'track-ok',
          status: 'processing',
        }),
        createLetterRowForSync({
          letterId: 'letter-error',
          trackingId: 'track-error',
          status: 'processing',
        }),
      ];

      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: testLetters } as any)
        .mockResolvedValue({ rows: [], rowCount: 1 } as any);

      mockProvider.getStatus
        .mockResolvedValueOnce({ status: 'delivered', statusMessage: 'Delivered' })
        .mockRejectedValueOnce(new Error('Provider API error'));

      const result = await syncLetterStatuses(false, 30);

      expect(result.checked).toBe(2);
      expect(result.updated).toBe(1);
      expect(result.errors).toBe(1);

      // Find the error detail
      const errorDetail = result.details.find(d => d.error);
      expect(errorDetail).toBeDefined();
      expect(errorDetail?.letterId).toBe('letter-error');
      expect(errorDetail?.error).toBe('Provider API error');
    });

    it('should not count letters with same status as updated', async () => {
      const testLetters = [createLetterRowForSync({
        letterId: 'letter-same',
        trackingId: 'track-same',
        status: 'processing',
      })];

      vi.mocked(db.query).mockResolvedValueOnce({ rows: testLetters } as any);

      // Provider returns same status
      mockProvider.getStatus.mockResolvedValueOnce({
        status: 'processing',
        statusMessage: 'Still processing',
      });

      const result = await syncLetterStatuses(false, 30);

      expect(result.checked).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.details).toHaveLength(0);
    });

    it('should include status change details in result', async () => {
      const testLetters = [createLetterRowForSync({
        letterId: 'letter-detail',
        trackingId: 'track-detail',
        status: 'in_transit',
      })];

      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: testLetters } as any)
        .mockResolvedValue({ rows: [], rowCount: 1 } as any);

      mockProvider.getStatus.mockResolvedValueOnce({
        status: 'delivered',
        statusMessage: 'Delivered to mailbox at 2:30 PM',
      });

      const result = await syncLetterStatuses(false, 30);

      expect(result.details).toHaveLength(1);
      expect(result.details[0]).toEqual({
        letterId: 'letter-detail',
        trackingId: 'track-detail',
        oldStatus: 'in_transit',
        newStatus: 'delivered',
        providerRawStatus: 'Delivered to mailbox at 2:30 PM',
      });
    });
  });

  // ==========================================================================
  // getStuckLetters Tests
  // ==========================================================================
  describe('getStuckLetters', () => {
    it('should return letters stuck in non-terminal status', async () => {
      const stuckLetters = [
        {
          letter_id: 'stuck-1',
          tracking_id: 'track-stuck-1',
          status: 'processing',
          created_at: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), // 20 days ago
          days_in_status: 20,
        },
        {
          letter_id: 'stuck-2',
          tracking_id: 'track-stuck-2',
          status: 'in_transit',
          created_at: new Date(Date.now() - 18 * 24 * 60 * 60 * 1000), // 18 days ago
          days_in_status: 18,
        },
      ];

      vi.mocked(db.query).mockResolvedValueOnce({ rows: stuckLetters } as any);

      const result = await getStuckLetters(14); // Letters stuck > 14 days

      expect(result).toHaveLength(2);
      expect(result[0].letter_id).toBe('stuck-1');
      expect(result[0].days_in_status).toBe(20);
      expect(result[1].letter_id).toBe('stuck-2');
    });

    it('should return empty array when no stuck letters', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as any);

      const result = await getStuckLetters(14);

      expect(result).toHaveLength(0);
    });
  });
});
