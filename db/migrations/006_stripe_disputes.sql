-- Migration: 006_stripe_disputes
-- Description: Add table for tracking Stripe disputes/chargebacks
-- Created: 2024-12-04

-- ============================================================================
-- Stripe Disputes Table
-- Tracks chargebacks and disputes from Stripe for admin visibility
-- ============================================================================

CREATE TABLE IF NOT EXISTS stripe_disputes (
    dispute_id TEXT PRIMARY KEY,
    charge_id TEXT NOT NULL,
    payment_intent_id TEXT,
    user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'open', -- 'open', 'won', 'lost', 'under_review'
    evidence_due_by TIMESTAMPTZ,
    stripe_created_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for looking up disputes by user
CREATE INDEX IF NOT EXISTS idx_stripe_disputes_user_id ON stripe_disputes(user_id);

-- Index for looking up disputes by status (for alerts)
CREATE INDEX IF NOT EXISTS idx_stripe_disputes_status ON stripe_disputes(status);

-- Index for looking up disputes by charge
CREATE INDEX IF NOT EXISTS idx_stripe_disputes_charge_id ON stripe_disputes(charge_id);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_stripe_disputes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stripe_disputes_updated_at_trigger ON stripe_disputes;
CREATE TRIGGER stripe_disputes_updated_at_trigger
    BEFORE UPDATE ON stripe_disputes
    FOR EACH ROW
    EXECUTE FUNCTION update_stripe_disputes_updated_at();

-- Add comment
COMMENT ON TABLE stripe_disputes IS 'Tracks Stripe disputes/chargebacks for admin monitoring';
