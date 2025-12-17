/**
 * Unit tests for promoService
 *
 * Tests the promo code redemption logic including:
 * - Race condition prevention for max_total_redemptions
 * - Atomic increment with conditional check
 * - New user validation
 * - Normal redemption flow
 *
 * User Stories Covered:
 * - US-PROMO-02: Redeem Promo Code
 * - US-SEC-06: Promo Code Abuse Prevention
 * - US-EDGE-08: Promo Redemption Race Condition Prevention
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testUsers, createUserRow } from '../../fixtures/users.js';
import {
  testCampaigns,
  createCampaign,
  createCampaignRow,
  createRedemption,
  createConcurrentScenario,
} from '../../fixtures/promos.js';
import { createLedgerEntry } from '../../fixtures/credits.js';

// Mock the database module before importing the service
vi.mock('../../../src/db/index.js', () => {
  return {
    query: vi.fn(),
    transaction: vi.fn(),
  };
});

// Mock userService
vi.mock('../../../src/services/userService.js', () => {
  return {
    findUser: vi.fn(),
  };
});

// Import after mocking
import * as db from '../../../src/db/index.js';
import * as userService from '../../../src/services/userService.js';
import {
  redeemPromoCode,
  validatePromoCode,
  validatePromoCodePublic,
  getCampaignByCode,
} from '../../../src/services/promoService.js';

describe('promoService', () => {
  beforeEach(() => {
    // Reset all mocks to clean state between tests
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // validatePromoCodePublic Tests (Preview Gate)
  // ==========================================================================
  describe('validatePromoCodePublic', () => {
    it('should return valid for active campaign with available redemptions', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [createCampaignRow(testCampaigns.welcome)],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result = await validatePromoCodePublic('WELCOME5');

      expect(result.valid).toBe(true);
      expect(result.campaign?.code).toBe('WELCOME5');
    });

    it('should return invalid when campaign is at max redemptions', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [createCampaignRow(testCampaigns.atLimit)],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result = await validatePromoCodePublic('ATLIMIT');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Promo code redemption limit reached');
    });

    it('should return invalid for non-existent code', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result = await validatePromoCodePublic('NOTEXIST');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Promo code not found');
    });

    it('should return invalid for inactive campaign', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [createCampaignRow(testCampaigns.inactive)],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result = await validatePromoCodePublic('INACTIVE');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Promo code is not active');
    });
  });

  // ==========================================================================
  // validatePromoCode Tests (User-specific validation)
  // ==========================================================================
  describe('validatePromoCode', () => {
    it('should return valid for new user on new-users-only campaign', async () => {
      // Mock campaign lookup
      vi.mocked(db.query)
        .mockResolvedValueOnce({
          rows: [createCampaignRow(testCampaigns.newUsersOnly)],
          rowCount: 1,
          command: 'SELECT',
          oid: 0,
          fields: [],
        })
        // Mock redemption check
        .mockResolvedValueOnce({
          rows: [],
          rowCount: 0,
          command: 'SELECT',
          oid: 0,
          fields: [],
        })
        // Mock transaction count for new user check
        .mockResolvedValueOnce({
          rows: [{ count: '0' }],
          rowCount: 1,
          command: 'SELECT',
          oid: 0,
          fields: [],
        });

      // User doesn't exist yet (new user)
      vi.mocked(userService.findUser).mockResolvedValueOnce(null);

      const result = await validatePromoCode('NEWUSER10', testUsers.newUser.user_id);

      expect(result.valid).toBe(true);
    });

    it('should return invalid for existing user on new-users-only campaign', async () => {
      // Mock campaign lookup
      vi.mocked(db.query)
        .mockResolvedValueOnce({
          rows: [createCampaignRow(testCampaigns.newUsersOnly)],
          rowCount: 1,
          command: 'SELECT',
          oid: 0,
          fields: [],
        })
        // Mock redemption check
        .mockResolvedValueOnce({
          rows: [],
          rowCount: 0,
          command: 'SELECT',
          oid: 0,
          fields: [],
        })
        // Mock transaction count for existing user
        .mockResolvedValueOnce({
          rows: [{ count: '5' }],
          rowCount: 1,
          command: 'SELECT',
          oid: 0,
          fields: [],
        });

      // User exists
      vi.mocked(userService.findUser).mockResolvedValueOnce(createUserRow(testUsers.marcus));

      const result = await validatePromoCode('NEWUSER10', testUsers.marcus.user_id);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('This promo code is for new users only');
    });

    it('should return invalid when user already redeemed', async () => {
      // Mock campaign lookup
      vi.mocked(db.query)
        .mockResolvedValueOnce({
          rows: [createCampaignRow(testCampaigns.welcome)],
          rowCount: 1,
          command: 'SELECT',
          oid: 0,
          fields: [],
        })
        // Mock redemption check - user already redeemed
        .mockResolvedValueOnce({
          rows: [createRedemption(testCampaigns.welcome.campaign_id, testUsers.alex.user_id)],
          rowCount: 1,
          command: 'SELECT',
          oid: 0,
          fields: [],
        });

      const result = await validatePromoCode('WELCOME5', testUsers.alex.user_id);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('You have already redeemed this promo code');
    });
  });

  // ==========================================================================
  // redeemPromoCode Tests - Race Condition Prevention
  // ==========================================================================
  describe('redeemPromoCode - race condition prevention', () => {
    it('should successfully redeem when under limit', async () => {
      const campaign = createCampaign({
        code: 'TESTREDEEM',
        credits_amount: 5,
        max_total_redemptions: 100,
        current_redemptions: 50,
      });

      const mockLedgerEntry = createLedgerEntry(testUsers.alex.user_id, 5, {
        sourceType: 'promo',
      });

      // Mock validation queries
      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [campaign], rowCount: 1, command: 'SELECT', oid: 0, fields: [] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });

      // Mock transaction - atomic increment happens FIRST
      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn()
            // 1. Atomic increment FIRST (succeeds - under limit)
            .mockResolvedValueOnce({ rows: [{ ...campaign, current_redemptions: 51 }], rowCount: 1 })
            // 2. Upsert user
            .mockResolvedValueOnce({ rows: [createUserRow({ ...testUsers.alex, credits: 5 })] })
            // 3. Insert ledger entry
            .mockResolvedValueOnce({ rows: [{ ...mockLedgerEntry, ledger_id: 'uuid-123' }] })
            // 4. Insert transaction
            .mockResolvedValueOnce({ rows: [{ transaction_id: 1 }] })
            // 5. Insert redemption
            .mockResolvedValueOnce({ rows: [] }),
        };
        return callback(mockClient as any);
      });

      const result = await redeemPromoCode({
        userId: testUsers.alex.user_id,
        email: testUsers.alex.email,
        promoCode: 'TESTREDEEM',
      });

      expect(result.success).toBe(true);
      expect(result.credits).toBe(5);
    });

    it('should fail when atomic increment returns no rows (limit reached during transaction)', async () => {
      const scenario = createConcurrentScenario();

      // Mock validation - sees 0 redemptions (passes)
      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [scenario.beforeRedemption], rowCount: 1, command: 'SELECT', oid: 0, fields: [] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });

      // Mock transaction - atomic increment fails (someone else got there first)
      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn()
            // Atomic increment FIRST - returns no rows (limit reached)
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
        };
        return callback(mockClient as any);
      });

      const result = await redeemPromoCode({
        userId: testUsers.alex.user_id,
        email: testUsers.alex.email,
        promoCode: 'CONCURRENT',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('limit reached');
    });

    it('should handle unlimited campaign (no max_total_redemptions)', async () => {
      const campaign = testCampaigns.unlimited;

      const mockLedgerEntry = createLedgerEntry(testUsers.alex.user_id, 2, {
        sourceType: 'promo',
      });

      // Mock validation queries
      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [campaign], rowCount: 1, command: 'SELECT', oid: 0, fields: [] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });

      // Mock transaction - atomic increment FIRST
      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn()
            // 1. Atomic increment (succeeds - no limit)
            .mockResolvedValueOnce({ rows: [{ ...campaign, current_redemptions: 1 }], rowCount: 1 })
            // 2. Upsert user
            .mockResolvedValueOnce({ rows: [createUserRow({ ...testUsers.alex, credits: 2 })] })
            // 3. Insert ledger entry
            .mockResolvedValueOnce({ rows: [{ ...mockLedgerEntry, ledger_id: 'uuid-456' }] })
            // 4. Insert transaction
            .mockResolvedValueOnce({ rows: [{ transaction_id: 2 }] })
            // 5. Insert redemption
            .mockResolvedValueOnce({ rows: [] }),
        };
        return callback(mockClient as any);
      });

      const result = await redeemPromoCode({
        userId: testUsers.alex.user_id,
        email: testUsers.alex.email,
        promoCode: 'UNLIMITED',
      });

      expect(result.success).toBe(true);
      expect(result.credits).toBe(2);
    });

    it('should fail validation when campaign already at limit', async () => {
      // Validation should catch this before even trying transaction
      vi.mocked(db.query)
        // Campaign lookup
        .mockResolvedValueOnce({ rows: [testCampaigns.atLimit], rowCount: 1, command: 'SELECT', oid: 0, fields: [] });
      // Note: validatePromoCode will return early with "limit reached" before checking redemptions

      const result = await redeemPromoCode({
        userId: testUsers.alex.user_id,
        email: testUsers.alex.email,
        promoCode: 'ATLIMIT',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Promo code redemption limit reached');
      // Transaction should NOT have been called because validation fails first
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('should use FIFO expiration for promo credits', async () => {
      const campaign = createCampaign({
        code: 'EXPIRING',
        credits_amount: 5,
        expiration_policy: 'days_from_activation',
        expiration_days: 90,
        max_total_redemptions: null,
      });

      // Mock validation
      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [campaign], rowCount: 1, command: 'SELECT', oid: 0, fields: [] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });

      let capturedExpiresAt: Date | null = null;

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn().mockImplementation((sql: string, params: any[]) => {
            // 1. Atomic increment FIRST
            if (sql.includes('UPDATE promo_campaigns')) {
              return { rows: [campaign], rowCount: 1 };
            }
            // 2. Upsert user
            if (sql.includes('INSERT INTO users')) {
              return { rows: [createUserRow({ ...testUsers.alex, credits: 5 })] };
            }
            // 3. Insert ledger entry
            if (sql.includes('INSERT INTO credit_ledger')) {
              // Capture the expires_at parameter (index 4 in the params)
              capturedExpiresAt = params[4];
              return { rows: [{ ledger_id: 'uuid-789', expires_at: capturedExpiresAt }] };
            }
            // 4. Insert transaction
            if (sql.includes('INSERT INTO credit_transactions')) {
              return { rows: [{ transaction_id: 3 }] };
            }
            // 5. Insert redemption
            if (sql.includes('INSERT INTO promo_redemptions')) {
              return { rows: [] };
            }
            return { rows: [] };
          }),
        };
        return callback(mockClient as any);
      });

      const result = await redeemPromoCode({
        userId: testUsers.alex.user_id,
        email: testUsers.alex.email,
        promoCode: 'EXPIRING',
      });

      expect(result.success).toBe(true);
      expect(result.expiresAt).toBeDefined();
      // Should expire in ~90 days
      const daysUntilExpiration = Math.floor(
        (result.expiresAt!.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );
      expect(daysUntilExpiration).toBeGreaterThanOrEqual(89);
      expect(daysUntilExpiration).toBeLessThanOrEqual(91);
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================
  describe('edge cases', () => {
    it('should be case-insensitive for promo codes', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [testCampaigns.welcome],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result = await validatePromoCodePublic('welcome5'); // lowercase

      expect(result.valid).toBe(true);
      expect(result.campaign?.code).toBe('WELCOME5'); // stored as uppercase
    });

    it('should trim whitespace from promo codes', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [testCampaigns.welcome],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result = await validatePromoCodePublic('  WELCOME5  '); // with whitespace

      expect(result.valid).toBe(true);
    });

    it('should handle concurrent redemptions to same campaign gracefully', async () => {
      // This tests the scenario where two users try to redeem at the exact same time
      // One should succeed, one should fail with a clear error

      const singleUseCampaign = testCampaigns.singleUse;

      // First user: validation passes (sees current_redemptions = 0)
      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [singleUseCampaign], rowCount: 1, command: 'SELECT', oid: 0, fields: [] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });

      // First user's transaction succeeds - atomic increment FIRST
      vi.mocked(db.transaction).mockImplementationOnce(async (callback) => {
        const mockClient = {
          query: vi.fn()
            // 1. Atomic increment succeeds (was 0, now 1)
            .mockResolvedValueOnce({ rows: [{ ...singleUseCampaign, current_redemptions: 1 }], rowCount: 1 })
            // 2. Upsert user
            .mockResolvedValueOnce({ rows: [createUserRow({ ...testUsers.alex, credits: 10 })] })
            // 3. Insert ledger
            .mockResolvedValueOnce({ rows: [{ ledger_id: 'uuid-first' }] })
            // 4. Insert transaction
            .mockResolvedValueOnce({ rows: [{ transaction_id: 10 }] })
            // 5. Insert redemption
            .mockResolvedValueOnce({ rows: [] }),
        };
        return callback(mockClient as any);
      });

      const result1 = await redeemPromoCode({
        userId: testUsers.alex.user_id,
        email: testUsers.alex.email,
        promoCode: 'SINGLEUSE',
      });

      expect(result1.success).toBe(true);

      // Second user's validation passes (stale read - still sees 0 redemptions)
      // This simulates the race condition where both users read before either writes
      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [singleUseCampaign], rowCount: 1, command: 'SELECT', oid: 0, fields: [] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });

      // Second user's transaction fails - atomic increment returns no rows
      vi.mocked(db.transaction).mockImplementationOnce(async (callback) => {
        const mockClient = {
          query: vi.fn()
            // Atomic increment fails - limit already reached by first user
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
        };
        return callback(mockClient as any);
      });

      const result2 = await redeemPromoCode({
        userId: testUsers.marcus.user_id,
        email: testUsers.marcus.email,
        promoCode: 'SINGLEUSE',
      });

      expect(result2.success).toBe(false);
      expect(result2.error).toContain('limit reached');
    });
  });
});
