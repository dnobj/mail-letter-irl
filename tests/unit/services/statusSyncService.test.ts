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

// A provider's cancel goes to the outbox's own transaction (#566).
vi.mock('../../../src/services/letterJobService.js', () => {
  return {
    failProviderCancelledLetter: vi.fn(),
  };
});

// Import after mocking
import * as db from '../../../src/db/index.js';
import { getLetterProvider } from '../../../src/services/providers/index.js';
import { failProviderCancelledLetter } from '../../../src/services/letterJobService.js';
import {
  syncLetterStatuses,
  getStuckLetters,
  getLetterStatusHistory,
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
  describe('windows counted from when a letter mailed (#535)', () => {
    const flat = (call: unknown[]) => String(call[0]).replace(/\s+/g, ' ');

    it('follows a letter for its window from sent_at, so held mail is still synced after it mails', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as any);
      await syncLetterStatuses(true, 30);
      expect(flat(vi.mocked(db.query).mock.calls[0])).toContain(
        "AND COALESCE(sent_at, created_at) > NOW() - INTERVAL '30 days'"
      );
    });

    it('counts a stuck letter from sent_at, not from the weeks it was held', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as any);
      await getStuckLetters(14);
      const sql = flat(vi.mocked(db.query).mock.calls[0]);
      expect(sql).toContain('EXTRACT(DAY FROM NOW() - COALESCE(sent_at, created_at))::INTEGER as days_in_status');
      expect(sql).toContain("AND COALESCE(sent_at, created_at) < NOW() - INTERVAL '14 days'");
    });
  });

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
      // A class, never the provider message: the detail reaches the admin command run and its audit row (#394).
      expect(errorDetail?.error).toBe('provider_error');
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

    it('records a class, never the provider message, when a letter fails to sync (#394)', async () => {
      const testLetters = [createLetterRowForSync({
        letterId: 'letter-fail',
        trackingId: 'track-fail',
        status: 'in_transit',
      })];
      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: testLetters } as any)
        .mockResolvedValue({ rows: [], rowCount: 1 } as any);
      // The shape PostGridProvider.getStatus throws: a plain Error wrapping the provider's text.
      mockProvider.getStatus.mockRejectedValueOnce(
        new Error('Failed to get provider status: HTTP 500 from https://api.postgrid.invalid/letters/track-fail for Recipient Person')
      );
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const result = await syncLetterStatuses(false, 30);

      expect(result.errors).toBe(1);
      expect(result.details[0]).toEqual({
        letterId: 'letter-fail',
        trackingId: 'track-fail',
        oldStatus: 'in_transit',
        newStatus: 'in_transit',
        providerRawStatus: '',
        error: 'provider_error',
      });
      expect(JSON.stringify(result)).not.toContain('postgrid.invalid');
      expect(JSON.stringify(result)).not.toContain('Recipient Person');
    });

    it('prefers a class a lower layer attached to the failure (#394)', async () => {
      const testLetters = [createLetterRowForSync({ letterId: 'letter-carried', trackingId: 'track-carried', status: 'in_transit' })];
      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: testLetters } as any)
        .mockResolvedValue({ rows: [], rowCount: 1 } as any);
      mockProvider.getStatus.mockRejectedValueOnce(
        Object.assign(new Error('connect ETIMEDOUT 10.0.0.9:443'), { code: 'ETIMEDOUT', diagnosticClass: 'configuration_error' })
      );
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const result = await syncLetterStatuses(false, 30);

      expect(result.details[0].error).toBe('configuration_error');
      expect(JSON.stringify(result)).not.toContain('10.0.0.9');
    });
  });

  // ==========================================================================
  // getStuckLetters Tests
  // ==========================================================================
  describe("a provider's cancel (#566)", () => {
    const cancelled = { status: 'failed', statusMessage: 'Letter was canceled before sending' };
    const writes = () => vi.mocked(db.query).mock.calls.filter(call => /UPDATE|INSERT/.test(String(call[0])));

    it('hands it to failProviderCancelledLetter, and writes nothing itself', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [createLetterRowForSync({ letterId: 'letter-cancelled', trackingId: 'track-cancelled', status: 'accepted' })]
      } as any);
      mockProvider.getStatus.mockResolvedValueOnce(cancelled);
      vi.mocked(failProviderCancelledLetter).mockResolvedValueOnce('failed');

      const result = await syncLetterStatuses(false, 30);

      expect(failProviderCancelledLetter).toHaveBeenCalledWith({
        letterId: 'letter-cancelled',
        providerRawStatus: 'Letter was canceled before sending'
      });
      expect(writes()).toEqual([]);
      expect(result.updated).toBe(1);
      expect(result.details).toEqual([expect.objectContaining({ letterId: 'letter-cancelled', newStatus: 'failed' })]);
    });

    it('counts nothing when the letter had already ended', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [createLetterRowForSync({ letterId: 'letter-ended', trackingId: 'track-ended', status: 'accepted' })]
      } as any);
      mockProvider.getStatus.mockResolvedValueOnce(cancelled);
      vi.mocked(failProviderCancelledLetter).mockResolvedValueOnce('unchanged');

      const result = await syncLetterStatuses(false, 30);

      expect(result.updated).toBe(0);
      expect(result.details).toEqual([]);
      expect(writes()).toEqual([]);
    });

    it('only reports it in a dry run', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [createLetterRowForSync({ letterId: 'letter-dry', trackingId: 'track-dry', status: 'accepted' })]
      } as any);
      mockProvider.getStatus.mockResolvedValueOnce(cancelled);

      const result = await syncLetterStatuses(true, 30);

      expect(failProviderCancelledLetter).not.toHaveBeenCalled();
      expect(result.updated).toBe(1);
      expect(writes()).toEqual([]);
    });

    it('writes any other status itself, as before', async () => {
      vi.mocked(db.query)
        .mockResolvedValueOnce({
          rows: [createLetterRowForSync({ letterId: 'letter-moving', trackingId: 'track-moving', status: 'accepted' })]
        } as any)
        .mockResolvedValue({ rows: [], rowCount: 1 } as any);
      mockProvider.getStatus.mockResolvedValueOnce({ status: 'processing', statusMessage: 'Letter is being printed' });

      await syncLetterStatuses(false, 30);

      expect(failProviderCancelledLetter).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(2);
    });
  });

  describe("a certified letter's USPS number (#625)", () => {
    const NUMBER = '9407 1000 0000 0000 0000 00';
    const certified = (over: Record<string, unknown> = {}) => ({
      ...createLetterRowForSync({ letterId: 'letter-cert', trackingId: 'track-cert', status: 'processing' }),
      mail_service: 'certified',
      carrier_tracking_number: null,
      ...over,
    });
    const moving = { status: 'processing', statusMessage: 'Printing' };
    const flat = (call: unknown[]) => String(call[0]).replace(/\s+/g, ' ');
    const numberWrites = () =>
      vi.mocked(db.query).mock.calls.filter(call => /SET carrier_tracking_number = /.test(String(call[0])));
    const allWrites = () => vi.mocked(db.query).mock.calls.filter(call => /UPDATE|INSERT/.test(String(call[0])));
    const reading = (row: unknown) =>
      vi
        .mocked(db.query)
        .mockResolvedValueOnce({ rows: [row] } as any)
        .mockResolvedValue({ rows: [], rowCount: 1 } as any);

    it('stores the number once the carrier has it, though the status has not moved', async () => {
      reading(certified());
      mockProvider.getStatus.mockResolvedValueOnce({ ...moving, carrierTrackingNumber: NUMBER });

      const result = await syncLetterStatuses(false, 30);

      expect(numberWrites()).toHaveLength(1);
      expect(numberWrites()[0][1]).toEqual(['letter-cert', NUMBER]);
      // Nothing else was written: the status, and so its history, did not move.
      expect(allWrites()).toHaveLength(1);
      expect(result.updated).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('stores it beside a change of status', async () => {
      reading(certified());
      mockProvider.getStatus.mockResolvedValueOnce({
        status: 'in_transit',
        statusMessage: 'In transit',
        carrierTrackingNumber: NUMBER,
      });

      const result = await syncLetterStatuses(false, 30);

      expect(numberWrites()).toHaveLength(1);
      expect(numberWrites()[0][1]).toEqual(['letter-cert', NUMBER]);
      // The status and its history are written as before.
      expect(allWrites()).toHaveLength(3);
      expect(result.updated).toBe(1);
    });

    it('asks the database to write it only to a certified letter, and only if it differs', async () => {
      reading(certified());
      mockProvider.getStatus.mockResolvedValueOnce({ ...moving, carrierTrackingNumber: NUMBER });

      await syncLetterStatuses(false, 30);

      const sql = flat(numberWrites()[0]);
      expect(sql).toContain("SET carrier_tracking_number = $2::text");
      expect(sql).toContain("AND mail_service <> 'standard'");
      expect(sql).toContain('AND carrier_tracking_number IS DISTINCT FROM $2::text');
    });

    it('does not write a number the letter already has', async () => {
      reading(certified({ carrier_tracking_number: NUMBER }));
      mockProvider.getStatus.mockResolvedValueOnce({ ...moving, carrierTrackingNumber: NUMBER });

      await syncLetterStatuses(false, 30);

      expect(allWrites()).toEqual([]);
    });

    it('replaces a number that differs: the provider has the last word', async () => {
      reading(certified({ carrier_tracking_number: '9407 1000 0000 0000 0000 11' }));
      mockProvider.getStatus.mockResolvedValueOnce({ ...moving, carrierTrackingNumber: NUMBER });

      await syncLetterStatuses(false, 30);

      expect(numberWrites()).toHaveLength(1);
      expect(numberWrites()[0][1]).toEqual(['letter-cert', NUMBER]);
    });

    it('writes nothing while the provider has no number', async () => {
      reading(certified());
      mockProvider.getStatus.mockResolvedValueOnce(moving);

      await syncLetterStatuses(false, 30);

      expect(allWrites()).toEqual([]);
    });

    it.each([undefined, null, '', 'standard'])(
      'gives a standard letter (%j) no number, whatever the provider reports',
      async service => {
        reading(certified({ mail_service: service }));
        mockProvider.getStatus.mockResolvedValueOnce({ ...moving, carrierTrackingNumber: NUMBER });

        await syncLetterStatuses(false, 30);

        expect(allWrites()).toEqual([]);
      }
    );

    it('writes nothing in a dry run, and still counts the change', async () => {
      reading(certified());
      mockProvider.getStatus.mockResolvedValueOnce({
        status: 'in_transit',
        statusMessage: 'In transit',
        carrierTrackingNumber: NUMBER,
      });

      const result = await syncLetterStatuses(true, 30);

      expect(allWrites()).toEqual([]);
      expect(result.updated).toBe(1);
    });

    it('counts a failed write as that letter\'s error, naming a class and not the database\'s text', async () => {
      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [certified()] } as any)
        .mockRejectedValueOnce(new Error('connection to 10.0.0.1 lost'));
      mockProvider.getStatus.mockResolvedValueOnce({ ...moving, carrierTrackingNumber: NUMBER });

      const result = await syncLetterStatuses(false, 30);

      expect(result.errors).toBe(1);
      expect(JSON.stringify(result.details)).not.toContain('10.0.0.1');
    });

    it('keeps asking for the number of a certified letter that was delivered without one', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as any);

      await syncLetterStatuses(false, 30);

      const sql = flat(vi.mocked(db.query).mock.calls[0]);
      expect(sql).toContain('mail_service, carrier_tracking_number');
      expect(sql).toContain(
        "WHERE ( status NOT IN ('delivered', 'returned', 'failed', 'cancelled') " +
          "OR (status = 'delivered' AND mail_service <> 'standard' AND carrier_tracking_number IS NULL) )"
      );
      expect(sql).toContain('AND tracking_id IS NOT NULL');
    });

    it('stores the number of a letter that was delivered before it had one, and counts no change', async () => {
      reading(certified({ status: 'delivered' }));
      mockProvider.getStatus.mockResolvedValueOnce({
        status: 'delivered',
        statusMessage: 'Delivered',
        carrierTrackingNumber: NUMBER,
      });

      const result = await syncLetterStatuses(false, 30);

      expect(numberWrites()).toHaveLength(1);
      expect(allWrites()).toHaveLength(1);
      expect(result.updated).toBe(0);
    });
  });

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

  // ==========================================================================
  // Status History Tests
  // ==========================================================================
  describe('status history', () => {
    it('should insert history record when status changes', async () => {
      const testLetters = [createLetterRowForSync({
        letterId: 'letter-history',
        trackingId: 'track-history',
        status: 'processing',
      })];

      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: testLetters } as any)
        .mockResolvedValue({ rows: [], rowCount: 1 } as any);

      mockProvider.getStatus.mockResolvedValueOnce({
        status: 'delivered',
        statusMessage: 'Delivered to recipient',
      });

      await syncLetterStatuses(false, 30);

      // Verify INSERT into letter_status_history was called
      const insertCalls = vi.mocked(db.query).mock.calls.filter(
        call => (call[0] as string).includes('INSERT INTO letter_status_history')
      );
      expect(insertCalls).toHaveLength(1);

      // Check the parameters passed to the INSERT
      const insertParams = insertCalls[0][1] as any[];
      expect(insertParams[0]).toBe('letter-history'); // letter_id
      expect(insertParams[1]).toBe('processing'); // old_status
      expect(insertParams[2]).toBe('delivered'); // new_status
      expect(insertParams[3]).toBe('Delivered to recipient'); // provider_raw_status
    });

    it('should not insert history record when status unchanged', async () => {
      const testLetters = [createLetterRowForSync({
        letterId: 'letter-no-change',
        trackingId: 'track-no-change',
        status: 'processing',
      })];

      vi.mocked(db.query).mockResolvedValueOnce({ rows: testLetters } as any);

      mockProvider.getStatus.mockResolvedValueOnce({
        status: 'processing', // Same status
        statusMessage: 'Still processing',
      });

      await syncLetterStatuses(false, 30);

      // Verify no INSERT was called
      const insertCalls = vi.mocked(db.query).mock.calls.filter(
        call => (call[0] as string).includes('INSERT INTO letter_status_history')
      );
      expect(insertCalls).toHaveLength(0);
    });

    it('should not insert history record in dry run mode', async () => {
      const testLetters = [createLetterRowForSync({
        letterId: 'letter-dry-history',
        trackingId: 'track-dry-history',
        status: 'processing',
      })];

      vi.mocked(db.query).mockResolvedValueOnce({ rows: testLetters } as any);

      mockProvider.getStatus.mockResolvedValueOnce({
        status: 'delivered',
        statusMessage: 'Delivered',
      });

      await syncLetterStatuses(true, 30); // dryRun = true

      // Verify no INSERT was called
      const insertCalls = vi.mocked(db.query).mock.calls.filter(
        call => (call[0] as string).includes('INSERT INTO letter_status_history')
      );
      expect(insertCalls).toHaveLength(0);
    });
  });

  // ==========================================================================
  // getLetterStatusHistory Tests
  // ==========================================================================
  describe('getLetterStatusHistory', () => {
    it('should return history entries for a letter', async () => {
      const historyEntries = [
        {
          old_status: null,
          new_status: 'queued',
          provider_raw_status: null,
          source: 'send',
          changed_at: new Date('2025-12-01T10:00:00Z'),
        },
        {
          old_status: 'queued',
          new_status: 'processing',
          provider_raw_status: 'Being printed',
          source: 'sync',
          changed_at: new Date('2025-12-02T14:00:00Z'),
        },
        {
          old_status: 'processing',
          new_status: 'delivered',
          provider_raw_status: 'Delivered to mailbox',
          source: 'sync',
          changed_at: new Date('2025-12-05T09:00:00Z'),
        },
      ];

      vi.mocked(db.query).mockResolvedValueOnce({ rows: historyEntries } as any);

      const result = await getLetterStatusHistory('test-letter-123');

      expect(result).toHaveLength(3);
      expect(result[0].new_status).toBe('queued');
      expect(result[1].new_status).toBe('processing');
      expect(result[2].new_status).toBe('delivered');
    });

    it('should return empty array for letter with no history', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as any);

      const result = await getLetterStatusHistory('nonexistent-letter');

      expect(result).toHaveLength(0);
    });
  });
});
