/**
 * Tier Service
 *
 * Handles user tier calculation and management:
 * - Calculate tier based on purchase history (non-refunded purchases, 120-day window)
 * - Batch update tiers for all users (daily job)
 * - Get effective tier (respecting manual overrides)
 * - Cache tier lookups for rate limiting performance
 */

import { query } from '../db/index.js';
import type {
  User,
  UserTier,
  TierPromotionCriteria,
  TierCalculationResult,
  TierUpdateBatchResult,
} from './types.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Promotion criteria for each tier.
 * Standard is the default - no criteria needed.
 * Trusted requires 3+ non-refunded purchases with the 3rd being 120+ days old.
 */
export const TIER_PROMOTION_CRITERIA: Record<UserTier, TierPromotionCriteria | null> = {
  standard: null, // Default tier, no criteria needed
  trusted: {
    minNonRefundedPurchases: 3,
    minDaysSinceQualifyingPurchase: 120, // Past chargeback window
  },
};

/**
 * Rate limit multipliers by tier.
 * Standard tier = 1x (baseline), other tiers multiply from there.
 */
export const TIER_RATE_MULTIPLIERS: Record<UserTier, Record<string, number>> = {
  standard: {
    // Baseline - all multipliers implicitly 1x
  },
  trusted: {
    auth: 1.5,        // 10 -> 15/min
    send_letter: 2.5, // 20 -> 50/hr
    api: 2.0,         // 100 -> 200/min
    checkout: 2.0,    // 10 -> 20/min
    mcp: 2.0,         // 60 -> 120/min
    // admin: unchanged (no entry = 1x)
  },
};

// ============================================================================
// Tier Cache (for rate limiting performance)
// ============================================================================

const tierCache = new Map<string, { tier: UserTier; expiresAt: number }>();
const TIER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Get the effective tier for a user (respects manual override)
 */
export function getEffectiveTier(user: User): UserTier {
  return user.tier_override ?? user.tier;
}

/**
 * Get rate limit multiplier for a tier and endpoint type
 */
export function getTierMultiplier(tier: UserTier, endpointType: string): number {
  const tierMultipliers = TIER_RATE_MULTIPLIERS[tier] || {};
  return tierMultipliers[endpointType] ?? 1.0;
}

/**
 * Calculate what tier a user should be based on current criteria.
 *
 * Queries non-refunded purchases from credit_ledger:
 * - Only counts purchases without matching refund entries
 * - Checks if 3rd purchase is 120+ days old (past chargeback window)
 */
export async function calculateUserTier(userId: string): Promise<TierCalculationResult> {
  // Get non-refunded purchases ordered by date
  // A purchase is "refunded" if there's a refund entry linking to it via related_ledger_id
  const result = await query<{
    ledger_id: string;
    created_at: Date;
  }>(
    `SELECT cl.ledger_id, cl.created_at
     FROM credit_ledger cl
     WHERE cl.user_id = $1
       AND cl.source_type = 'purchase'
       AND NOT EXISTS (
         SELECT 1 FROM credit_ledger ref
         WHERE ref.source_type = 'refund'
           AND ref.related_ledger_id = cl.ledger_id
       )
     ORDER BY cl.created_at ASC`,
    [userId]
  );

  const purchases = result.rows;
  const purchaseCount = purchases.length;
  const trustedCriteria = TIER_PROMOTION_CRITERIA.trusted!;

  // Check purchase count criteria
  const meetsPurchaseCriteria = purchaseCount >= trustedCriteria.minNonRefundedPurchases;

  // Check qualifying purchase age (3rd purchase must be 120+ days old)
  let daysSinceQualifyingPurchase: number | null = null;
  let meetsAgeCriteria = false;

  if (purchaseCount >= trustedCriteria.minNonRefundedPurchases) {
    // Get the Nth purchase (0-indexed, so index 2 for 3rd purchase)
    const qualifyingPurchase = purchases[trustedCriteria.minNonRefundedPurchases - 1];
    const purchaseDate = new Date(qualifyingPurchase.created_at);
    const now = new Date();
    daysSinceQualifyingPurchase = Math.floor(
      (now.getTime() - purchaseDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    meetsAgeCriteria = daysSinceQualifyingPurchase >= trustedCriteria.minDaysSinceQualifyingPurchase;
  }

  // Determine tier (check highest tier first for future extensibility)
  let tier: UserTier = 'standard';
  if (meetsPurchaseCriteria && meetsAgeCriteria) {
    tier = 'trusted';
  }

  return {
    tier,
    purchaseCount,
    daysSinceQualifyingPurchase,
    meetsPurchaseCriteria,
    meetsAgeCriteria,
  };
}

/**
 * Update a single user's tier based on current criteria.
 * Only updates calculated tier - respects tier_override.
 */
export async function updateUserTier(userId: string): Promise<User> {
  const calculation = await calculateUserTier(userId);

  const result = await query<User>(
    `UPDATE users
     SET tier = $1,
         tier_calculated_at = NOW(),
         updated_at = NOW()
     WHERE user_id = $2
     RETURNING *`,
    [calculation.tier, userId]
  );

  if (result.rows.length === 0) {
    throw new Error(`User not found: ${userId}`);
  }

  const user = result.rows[0];
  invalidateTierCache(userId);

  const effectiveTier = getEffectiveTier(user);
  console.log(
    `   Tier updated: calculated=${calculation.tier}, effective=${effectiveTier} ` +
    `(purchases: ${calculation.purchaseCount}, days since qualifying: ${calculation.daysSinceQualifyingPurchase ?? 'N/A'})`
  );

  return user;
}

/**
 * Batch update tiers for all users.
 * Used by daily background job.
 *
 * - Skips users with tier_override (manually set)
 * - Only updates users whose calculated tier differs from current
 */
export async function updateAllUserTiers(): Promise<TierUpdateBatchResult> {
  const trustedCriteria = TIER_PROMOTION_CRITERIA.trusted!;

  // Get all users with their purchase info
  const usersResult = await query<{
    user_id: string;
    current_tier: UserTier;
    tier_override: UserTier | null;
  }>(
    `SELECT user_id, tier as current_tier, tier_override FROM users`
  );

  let checked = 0;
  let upgraded = 0;
  let downgraded = 0;
  let unchanged = 0;
  let skippedOverride = 0;
  const details: TierUpdateBatchResult['details'] = [];

  for (const row of usersResult.rows) {
    checked++;

    // Skip if manually overridden
    if (row.tier_override !== null) {
      skippedOverride++;
      continue;
    }

    // Calculate tier for this user
    const calculation = await calculateUserTier(row.user_id);

    if (calculation.tier !== row.current_tier) {
      // Update tier
      await query(
        `UPDATE users
         SET tier = $1, tier_calculated_at = NOW(), updated_at = NOW()
         WHERE user_id = $2`,
        [calculation.tier, row.user_id]
      );

      details.push({
        userId: row.user_id,
        oldTier: row.current_tier,
        newTier: calculation.tier,
      });

      // Determine if upgrade or downgrade
      const tierOrder: UserTier[] = ['standard', 'trusted'];
      const oldRank = tierOrder.indexOf(row.current_tier);
      const newRank = tierOrder.indexOf(calculation.tier);

      if (newRank > oldRank) {
        upgraded++;
      } else {
        downgraded++;
      }
    } else {
      unchanged++;
    }
  }

  // Clear entire cache after batch update
  clearTierCache();

  return { checked, upgraded, downgraded, unchanged, skippedOverride, details };
}

/**
 * Get cached tier for rate limiting.
 * Uses in-memory cache with 5-minute TTL to minimize DB hits.
 */
export async function getCachedUserTier(userId: string): Promise<UserTier> {
  const now = Date.now();
  const cached = tierCache.get(userId);

  if (cached && cached.expiresAt > now) {
    return cached.tier;
  }

  // Cache miss or expired - fetch from DB
  const result = await query<{ tier: UserTier; tier_override: UserTier | null }>(
    'SELECT tier, tier_override FROM users WHERE user_id = $1',
    [userId]
  );

  if (result.rows.length === 0) {
    return 'standard'; // Default for unknown users
  }

  const effectiveTier = result.rows[0].tier_override ?? result.rows[0].tier;

  tierCache.set(userId, {
    tier: effectiveTier,
    expiresAt: now + TIER_CACHE_TTL_MS,
  });

  return effectiveTier;
}

/**
 * Invalidate tier cache for a user (after tier update)
 */
export function invalidateTierCache(userId: string): void {
  tierCache.delete(userId);
}

/**
 * Clear all tier cache entries (after batch update)
 */
export function clearTierCache(): void {
  tierCache.clear();
}

/**
 * Get tier cache stats for monitoring
 */
export function getTierCacheStats(): { size: number; ttlMs: number } {
  return {
    size: tierCache.size,
    ttlMs: TIER_CACHE_TTL_MS,
  };
}
