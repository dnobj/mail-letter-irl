-- Migration 005: User Tiers for Rate Limit Differentiation
--
-- Adds a tier system to users for differentiated rate limiting.
-- Tiers are calculated automatically based on purchase history:
-- - standard: Default for new users
-- - trusted: Earned through 3+ non-refunded purchases with 3rd purchase 120+ days old
--
-- The 120-day requirement ensures all purchases are past the credit card
-- chargeback window (Visa/MC/Discover/Amex = 120 days) before promotion.

-- ============================================================================
-- ENUM: User Tiers
-- ============================================================================

CREATE TYPE user_tier AS ENUM (
  'standard',    -- Default tier for new users
  'trusted'      -- Earned through time + purchases (past chargeback window)
  -- Future tiers: 'premium', 'enterprise', etc.
);

-- ============================================================================
-- ADD TIER COLUMNS TO USERS TABLE
-- ============================================================================

-- Current calculated tier
ALTER TABLE users
ADD COLUMN tier user_tier NOT NULL DEFAULT 'standard';

-- Manual override by admin (NULL = use calculated tier)
ALTER TABLE users
ADD COLUMN tier_override user_tier DEFAULT NULL;

-- When tier was last automatically calculated
ALTER TABLE users
ADD COLUMN tier_calculated_at TIMESTAMPTZ DEFAULT NOW();

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Index for querying users by tier (useful for analytics)
CREATE INDEX idx_users_tier ON users(tier);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON COLUMN users.tier IS 'Current user tier for rate limiting. Calculated daily based on purchase history.';
COMMENT ON COLUMN users.tier_override IS 'Admin manual override. When NOT NULL, this tier is used instead of calculated tier.';
COMMENT ON COLUMN users.tier_calculated_at IS 'When the tier was last automatically calculated by the daily worker.';
