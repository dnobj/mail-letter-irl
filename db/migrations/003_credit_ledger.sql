-- Migration 003: Credit Ledger for Serialized Credits with Expiration
--
-- This migration introduces a serialized credit system where each batch of credits
-- is tracked individually with source, expiration, and consumption tracking.
-- This enables:
-- - Different expiration policies per credit source
-- - FIFO consumption prioritizing soon-to-expire credits
-- - Better analytics and tracking
-- - Promo codes and campaigns

-- ============================================================================
-- ENUMS
-- ============================================================================

-- Credit source types (referral reserved for future use)
CREATE TYPE credit_source_type AS ENUM (
  'purchase',       -- Stripe/payment purchases
  'signup_bonus',   -- New user welcome credits
  'promo',          -- Promotional campaign credits
  'adjustment',     -- Manual admin adjustments
  'refund',         -- Refunds from cancelled orders/letters
  'legacy'          -- Migrated from old system
);

CREATE TYPE credit_ledger_status AS ENUM (
  'active',         -- Available for use
  'depleted',       -- All credits consumed (remaining_amount = 0)
  'expired',        -- Past expiration date
  'revoked'         -- Manually cancelled (fraud, etc.)
);

-- ============================================================================
-- CREDIT LEDGER TABLE
-- ============================================================================

-- Main ledger table - source of truth for all credit balances
CREATE TABLE credit_ledger (
  ledger_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,

  -- Credit amounts
  initial_amount INTEGER NOT NULL CHECK (initial_amount > 0),
  remaining_amount INTEGER NOT NULL CHECK (remaining_amount >= 0),

  -- Source tracking
  source_type credit_source_type NOT NULL,
  source_reference_id VARCHAR(255),  -- order_id, promo_code, campaign_id, etc.
  source_metadata JSONB,             -- Additional context (stripe session, promo campaign, etc.)

  -- Expiration handling
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,            -- NULL means never expires
  expiration_policy VARCHAR(50),     -- 'fixed_date', 'days_from_activation', 'never'
  expiration_days INTEGER,           -- For 'days_from_activation' policy

  -- Status and audit
  status credit_ledger_status NOT NULL DEFAULT 'active',
  description TEXT,

  -- Related entries (for refunds, adjustments linked to original)
  related_ledger_id UUID REFERENCES credit_ledger(ledger_id),

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT remaining_lte_initial CHECK (remaining_amount <= initial_amount),
  CONSTRAINT valid_expiration_policy CHECK (
    expiration_policy IS NULL OR
    expiration_policy IN ('fixed_date', 'days_from_activation', 'never')
  )
);

-- ============================================================================
-- CREDIT CONSUMPTION TABLE
-- ============================================================================

-- Audit trail linking credit transactions to specific ledger entries consumed
CREATE TABLE credit_consumption (
  consumption_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id INTEGER NOT NULL REFERENCES credit_transactions(transaction_id) ON DELETE CASCADE,
  ledger_id UUID NOT NULL REFERENCES credit_ledger(ledger_id) ON DELETE CASCADE,

  amount INTEGER NOT NULL CHECK (amount > 0),
  ledger_remaining_after INTEGER NOT NULL CHECK (ledger_remaining_after >= 0),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Each ledger entry can only be consumed once per transaction
  UNIQUE(transaction_id, ledger_id)
);

-- ============================================================================
-- PROMO CAMPAIGNS TABLE
-- ============================================================================

CREATE TABLE promo_campaigns (
  campaign_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Campaign identification
  code VARCHAR(50) NOT NULL UNIQUE,  -- The promo code users enter (case-insensitive lookup)
  name VARCHAR(255) NOT NULL,
  description TEXT,

  -- Credit configuration
  credits_amount INTEGER NOT NULL CHECK (credits_amount > 0),
  expiration_policy VARCHAR(50) NOT NULL DEFAULT 'days_from_activation',
  expiration_days INTEGER DEFAULT 90,          -- Days until credits expire
  fixed_expiration_date TIMESTAMPTZ,           -- For fixed_date policy

  -- Usage limits
  max_total_redemptions INTEGER,               -- NULL = unlimited
  max_per_user INTEGER NOT NULL DEFAULT 1,     -- Usually 1
  current_redemptions INTEGER NOT NULL DEFAULT 0,

  -- Validity window
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMPTZ,                         -- NULL = no end date

  -- Targeting (optional)
  requires_new_user BOOLEAN NOT NULL DEFAULT false,

  -- Status: draft, active, paused, ended, expired
  status VARCHAR(50) NOT NULL DEFAULT 'draft',

  -- Audit
  created_by VARCHAR(255),                     -- Admin who created it
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_promo_status CHECK (status IN ('draft', 'active', 'paused', 'ended', 'expired')),
  CONSTRAINT valid_promo_expiration_policy CHECK (
    expiration_policy IN ('fixed_date', 'days_from_activation', 'never')
  )
);

-- ============================================================================
-- PROMO REDEMPTIONS TABLE
-- ============================================================================

-- Track individual promo code redemptions
CREATE TABLE promo_redemptions (
  redemption_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES promo_campaigns(campaign_id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  ledger_id UUID NOT NULL REFERENCES credit_ledger(ledger_id) ON DELETE CASCADE,

  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Enforce max_per_user at DB level (for max_per_user = 1)
  UNIQUE(campaign_id, user_id)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Credit Ledger indexes
CREATE INDEX idx_credit_ledger_user_id ON credit_ledger(user_id);
CREATE INDEX idx_credit_ledger_status ON credit_ledger(status);
CREATE INDEX idx_credit_ledger_source_type ON credit_ledger(source_type);

-- Active entries with remaining credits (for balance calculations)
CREATE INDEX idx_credit_ledger_user_active ON credit_ledger(user_id)
  WHERE status = 'active' AND remaining_amount > 0;

-- FIFO consumption order: expire soonest first, then oldest first
CREATE INDEX idx_credit_ledger_consumption_order ON credit_ledger(user_id, expires_at NULLS LAST, created_at)
  WHERE status = 'active' AND remaining_amount > 0;

-- Expiring credits lookup (for background job and notifications)
CREATE INDEX idx_credit_ledger_expires_at ON credit_ledger(expires_at)
  WHERE expires_at IS NOT NULL AND status = 'active';

-- Source reference lookup
CREATE INDEX idx_credit_ledger_source_ref ON credit_ledger(source_reference_id)
  WHERE source_reference_id IS NOT NULL;

-- Credit Consumption indexes
CREATE INDEX idx_credit_consumption_transaction ON credit_consumption(transaction_id);
CREATE INDEX idx_credit_consumption_ledger ON credit_consumption(ledger_id);

-- Promo Campaign indexes
CREATE INDEX idx_promo_campaigns_code ON promo_campaigns(LOWER(code));
CREATE INDEX idx_promo_campaigns_status ON promo_campaigns(status);
CREATE INDEX idx_promo_campaigns_active ON promo_campaigns(status, starts_at, ends_at)
  WHERE status = 'active';

-- Promo Redemptions indexes
CREATE INDEX idx_promo_redemptions_campaign ON promo_redemptions(campaign_id);
CREATE INDEX idx_promo_redemptions_user ON promo_redemptions(user_id);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Update updated_at timestamp for credit_ledger
CREATE TRIGGER update_credit_ledger_updated_at
  BEFORE UPDATE ON credit_ledger
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Update updated_at timestamp for promo_campaigns
CREATE TRIGGER update_promo_campaigns_updated_at
  BEFORE UPDATE ON promo_campaigns
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE credit_ledger IS 'Serialized credit entries with expiration tracking. Source of truth for credit balances.';
COMMENT ON COLUMN credit_ledger.remaining_amount IS 'Credits still available from this entry (decremented on consumption)';
COMMENT ON COLUMN credit_ledger.expires_at IS 'When credits expire. NULL means never expires.';
COMMENT ON COLUMN credit_ledger.source_metadata IS 'JSON with source-specific data (stripe_session_id, order_details, etc.)';
COMMENT ON COLUMN credit_ledger.related_ledger_id IS 'Links refunds/adjustments to original entry';

COMMENT ON TABLE credit_consumption IS 'Audit trail linking credit transactions to specific ledger entries consumed';
COMMENT ON COLUMN credit_consumption.ledger_remaining_after IS 'Snapshot of ledger entry remaining_amount after this consumption';

COMMENT ON TABLE promo_campaigns IS 'Promotional credit campaigns with redeemable codes';
COMMENT ON COLUMN promo_campaigns.code IS 'Case-insensitive promo code that users enter';
COMMENT ON COLUMN promo_campaigns.expiration_days IS 'Days from redemption until credits expire (for days_from_activation policy)';

COMMENT ON TABLE promo_redemptions IS 'Track which users redeemed which promo codes';
