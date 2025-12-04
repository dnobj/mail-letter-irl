/**
 * Unit tests for creditLedgerService
 *
 * Tests the credit ledger business logic including:
 * - Adding credits with different expiration policies
 * - Deducting credits with FIFO ordering
 * - Balance calculations and expiration tracking
 *
 * User Stories Covered:
 * - US-2.1: Check Credit Balance
 * - US-2.3: Credit Expiration (FIFO consumption)
 * - US-2.7: Insufficient Credits Flow
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testUsers, createUserRow } from '../../fixtures/users.js';
import {
  createLedgerEntry,
  createFIFOTestEntries,
  createTransaction,
  daysFromNow,
  daysAgo,
} from '../../fixtures/credits.js';

// Mock the database module before importing the service
vi.mock('../../../src/db/index.js', () => {
  return {
    query: vi.fn(),
    transaction: vi.fn(),
  };
});

// Import after mocking
import * as db from '../../../src/db/index.js';
import {
  addCreditsToLedger,
  deductCreditsFromLedger,
  getDetailedBalance,
  getAvailableCredits,
  hasSufficientCredits,
  markExpiredEntries,
} from '../../../src/services/creditLedgerService.js';

describe('creditLedgerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // addCreditsToLedger Tests
  // ==========================================================================
  describe('addCreditsToLedger', () => {
    it('should add credits with default purchase expiration (2 years)', async () => {
      const mockUser = createUserRow({ ...testUsers.sarah, credits: 14 });
      const mockLedgerEntry = createLedgerEntry(testUsers.sarah.user_id, 10, {
        sourceType: 'purchase',
        expiresInDays: 730,
      });
      const mockTransaction = createTransaction(
        testUsers.sarah.user_id,
        10,
        14,
        'purchase'
      );

      // Mock transaction to execute callback with mock client
      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn()
            // First call: upsert user
            .mockResolvedValueOnce({ rows: [mockUser] })
            // Second call: insert ledger entry
            .mockResolvedValueOnce({ rows: [mockLedgerEntry] })
            // Third call: insert transaction
            .mockResolvedValueOnce({ rows: [mockTransaction] }),
        };
        return callback(mockClient as any);
      });

      const result = await addCreditsToLedger({
        userId: testUsers.sarah.user_id,
        email: testUsers.sarah.email,
        credits: 10,
        sourceType: 'purchase',
      });

      expect(result.user.credits).toBe(14);
      expect(result.ledgerEntry.initial_amount).toBe(10);
      expect(result.ledgerEntry.source_type).toBe('purchase');
      expect(result.transaction.amount).toBe(10);
    });

    it('should add promo credits with 90-day expiration', async () => {
      const mockUser = createUserRow({ ...testUsers.alex, credits: 5 });
      const mockLedgerEntry = createLedgerEntry(testUsers.alex.user_id, 5, {
        sourceType: 'promo',
        expiresInDays: 90,
      });
      const mockTransaction = createTransaction(
        testUsers.alex.user_id,
        5,
        5,
        'promo'
      );

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn()
            .mockResolvedValueOnce({ rows: [mockUser] })
            .mockResolvedValueOnce({ rows: [mockLedgerEntry] })
            .mockResolvedValueOnce({ rows: [mockTransaction] }),
        };
        return callback(mockClient as any);
      });

      const result = await addCreditsToLedger({
        userId: testUsers.alex.user_id,
        email: testUsers.alex.email,
        credits: 5,
        sourceType: 'promo',
      });

      expect(result.ledgerEntry.source_type).toBe('promo');
      // Promo should expire in ~90 days
      expect(result.ledgerEntry.expires_at).not.toBeNull();
    });

    it('should add adjustment credits that never expire', async () => {
      const mockUser = createUserRow({ ...testUsers.sarah, credits: 14 });
      const mockLedgerEntry = createLedgerEntry(testUsers.sarah.user_id, 4, {
        sourceType: 'adjustment',
        expiresAt: null,
      });
      const mockTransaction = createTransaction(
        testUsers.sarah.user_id,
        4,
        14,
        'adjustment'
      );

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn()
            .mockResolvedValueOnce({ rows: [mockUser] })
            .mockResolvedValueOnce({ rows: [mockLedgerEntry] })
            .mockResolvedValueOnce({ rows: [mockTransaction] }),
        };
        return callback(mockClient as any);
      });

      const result = await addCreditsToLedger({
        userId: testUsers.sarah.user_id,
        email: testUsers.sarah.email,
        credits: 4,
        sourceType: 'adjustment',
        description: 'Customer service credit',
      });

      expect(result.ledgerEntry.expires_at).toBeNull();
      expect(result.ledgerEntry.source_type).toBe('adjustment');
    });

    it('should throw error for zero or negative credits', async () => {
      await expect(
        addCreditsToLedger({
          userId: testUsers.sarah.user_id,
          email: testUsers.sarah.email,
          credits: 0,
          sourceType: 'purchase',
        })
      ).rejects.toThrow('Credits must be positive');

      await expect(
        addCreditsToLedger({
          userId: testUsers.sarah.user_id,
          email: testUsers.sarah.email,
          credits: -5,
          sourceType: 'purchase',
        })
      ).rejects.toThrow('Credits must be positive');
    });

    it('should use custom expiration days when provided', async () => {
      const mockUser = createUserRow({ ...testUsers.sarah, credits: 10 });
      const customDays = 45;
      const mockLedgerEntry = createLedgerEntry(testUsers.sarah.user_id, 10, {
        sourceType: 'promo',
        expiresInDays: customDays,
      });
      const mockTransaction = createTransaction(
        testUsers.sarah.user_id,
        10,
        10,
        'promo'
      );

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn()
            .mockResolvedValueOnce({ rows: [mockUser] })
            .mockResolvedValueOnce({ rows: [mockLedgerEntry] })
            .mockResolvedValueOnce({ rows: [mockTransaction] }),
        };
        return callback(mockClient as any);
      });

      const result = await addCreditsToLedger({
        userId: testUsers.sarah.user_id,
        email: testUsers.sarah.email,
        credits: 10,
        sourceType: 'promo',
        expirationDays: customDays,
      });

      expect(result.ledgerEntry.expiration_days).toBe(customDays);
    });
  });

  // ==========================================================================
  // deductCreditsFromLedger Tests - FIFO Consumption
  // ==========================================================================
  describe('deductCreditsFromLedger', () => {
    it('should deduct credits using FIFO with expiration priority', async () => {
      // Create entries that should be consumed in specific order
      const entries = createFIFOTestEntries(testUsers.marcus.user_id);
      const mockUser = createUserRow({ ...testUsers.marcus, credits: 26 }); // 3+5+10+8
      const updatedUser = { ...mockUser, credits: 24 }; // After deducting 2
      const mockTransaction = createTransaction(
        testUsers.marcus.user_id,
        -2,
        24,
        'deduction'
      );

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn()
            // Lock user
            .mockResolvedValueOnce({ rows: [mockUser] })
            // Get ledger entries (in FIFO order)
            .mockResolvedValueOnce({ rows: entries })
            // Update user
            .mockResolvedValueOnce({ rows: [updatedUser] })
            // Insert transaction
            .mockResolvedValueOnce({ rows: [mockTransaction] })
            // Update ledger entry
            .mockResolvedValueOnce({ rows: [] })
            // Insert consumption record
            .mockResolvedValueOnce({
              rows: [{
                consumption_id: 1,
                transaction_id: mockTransaction.transaction_id,
                ledger_id: entries[0].ledger_id,
                amount: 2,
                ledger_remaining_after: 1,
              }],
            }),
        };
        return callback(mockClient as any);
      });

      const result = await deductCreditsFromLedger({
        userId: testUsers.marcus.user_id,
        credits: 2,
        letterId: 'letter-001',
      });

      expect(result.user.credits).toBe(24);
      expect(result.transaction.amount).toBe(-2);
      // Should consume from the first entry (expiring soonest)
      expect(result.consumedFrom).toBeDefined();
      expect(result.consumedFrom![0].ledger_id).toBe(entries[0].ledger_id);
    });

    it('should throw error for insufficient credits', async () => {
      const mockUser = createUserRow({ ...testUsers.newUser, credits: 0 });

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn()
            .mockResolvedValueOnce({ rows: [mockUser] })
            .mockResolvedValueOnce({ rows: [] }), // No ledger entries
        };
        return callback(mockClient as any);
      });

      await expect(
        deductCreditsFromLedger({
          userId: testUsers.newUser.user_id,
          credits: 2,
          letterId: 'letter-001',
        })
      ).rejects.toThrow('Insufficient credits');
    });

    it('should throw error for user not found', async () => {
      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn().mockResolvedValueOnce({ rows: [] }),
        };
        return callback(mockClient as any);
      });

      await expect(
        deductCreditsFromLedger({
          userId: 'nonexistent-user',
          credits: 2,
          letterId: 'letter-001',
        })
      ).rejects.toThrow('User not found');
    });

    it('should consume from multiple ledger entries if needed', async () => {
      // Create entries with small amounts
      const entries = [
        createLedgerEntry(testUsers.marcus.user_id, 2, { expiresInDays: 7 }),
        createLedgerEntry(testUsers.marcus.user_id, 3, { expiresInDays: 30 }),
        createLedgerEntry(testUsers.marcus.user_id, 5, { expiresAt: null }),
      ];
      const mockUser = createUserRow({ ...testUsers.marcus, credits: 10 });
      const updatedUser = { ...mockUser, credits: 5 }; // After deducting 5
      const mockTransaction = createTransaction(
        testUsers.marcus.user_id,
        -5,
        5,
        'deduction'
      );

      let queryCallCount = 0;

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn().mockImplementation(async () => {
            queryCallCount++;
            switch (queryCallCount) {
              case 1: return { rows: [mockUser] }; // Lock user
              case 2: return { rows: entries }; // Get ledger entries
              case 3: return { rows: [updatedUser] }; // Update user
              case 4: return { rows: [mockTransaction] }; // Insert transaction
              // Remaining calls are ledger updates and consumption records
              default: return { rows: [{ consumption_id: queryCallCount }] };
            }
          }),
        };
        return callback(mockClient as any);
      });

      const result = await deductCreditsFromLedger({
        userId: testUsers.marcus.user_id,
        credits: 5,
        letterId: 'letter-002',
      });

      expect(result.user.credits).toBe(5);
      // Should have consumed from 2 entries (2 + 3 = 5)
      expect(result.consumedFrom!.length).toBe(2);
    });

    it('should throw error for zero or negative credits', async () => {
      await expect(
        deductCreditsFromLedger({
          userId: testUsers.sarah.user_id,
          credits: 0,
          letterId: 'letter-001',
        })
      ).rejects.toThrow('Credits must be positive');
    });
  });

  // ==========================================================================
  // getAvailableCredits Tests
  // ==========================================================================
  describe('getAvailableCredits', () => {
    it('should return sum of non-expired remaining credits', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ total: '15' }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result = await getAvailableCredits(testUsers.marcus.user_id);

      expect(result).toBe(15);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('SUM(remaining_amount)'),
        [testUsers.marcus.user_id]
      );
    });

    it('should return 0 for user with no credits', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ total: '0' }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result = await getAvailableCredits(testUsers.newUser.user_id);

      expect(result).toBe(0);
    });
  });

  // ==========================================================================
  // hasSufficientCredits Tests
  // ==========================================================================
  describe('hasSufficientCredits', () => {
    it('should return true when user has enough credits', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ total: '10' }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result = await hasSufficientCredits(testUsers.marcus.user_id, 2);

      expect(result).toBe(true);
    });

    it('should return false when user has insufficient credits', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ total: '1' }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result = await hasSufficientCredits(testUsers.eleanor.user_id, 2);

      expect(result).toBe(false);
    });

    it('should return true when credits exactly match required', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ total: '2' }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result = await hasSufficientCredits(testUsers.sarah.user_id, 2);

      expect(result).toBe(true);
    });
  });

  // ==========================================================================
  // getDetailedBalance Tests
  // ==========================================================================
  describe('getDetailedBalance', () => {
    it('should return detailed balance breakdown', async () => {
      const entries = createFIFOTestEntries(testUsers.marcus.user_id);

      vi.mocked(db.query).mockResolvedValueOnce({
        rows: entries,
        rowCount: entries.length,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result = await getDetailedBalance(testUsers.marcus.user_id);

      // Total should be sum of all remaining amounts (3+5+10+8 = 26)
      expect(result.totalAvailable).toBe(26);
      // Never expiring should be 8 (the adjustment)
      expect(result.neverExpiring).toBe(8);
      // By source should include promo, purchase, and adjustment
      expect(result.bySource.length).toBeGreaterThan(0);
    });

    it('should return zero totals for user with no credits', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result = await getDetailedBalance(testUsers.newUser.user_id);

      expect(result.totalAvailable).toBe(0);
      expect(result.expiringSoon).toBe(0);
      expect(result.neverExpiring).toBe(0);
    });
  });

  // ==========================================================================
  // markExpiredEntries Tests
  // ==========================================================================
  describe('markExpiredEntries', () => {
    it('should mark expired entries and return count', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 5,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      });

      const result = await markExpiredEntries();

      expect(result.count).toBe(5);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE credit_ledger')
      );
    });

    it('should return 0 when no entries expired', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      });

      const result = await markExpiredEntries();

      expect(result.count).toBe(0);
    });
  });
});
