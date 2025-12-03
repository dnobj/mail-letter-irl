-- Migration 004: Letter Drafts for Idempotent Send Operations
--
-- This migration introduces a draft system to prevent duplicate sends and double-charging
-- when MCP tool calls are retried by AI clients (e.g., ChatGPT).
--
-- Flow:
-- 1. quote_and_preview_letter creates a draft (status='pending', expires in 24h)
-- 2. send_letter consumes the draft (status='consumed', links to letter_id)
-- 3. If send_letter is called again with same draft, returns existing letter (idempotent)

-- ============================================================================
-- DRAFT STATUS ENUM
-- ============================================================================

CREATE TYPE draft_status AS ENUM (
  'pending',      -- Draft created, waiting to be sent
  'consumed',     -- Draft was sent (linked to a letter)
  'expired',      -- Draft expired without being sent (24h default)
  'cancelled'     -- Draft was explicitly cancelled
);

-- ============================================================================
-- LETTER DRAFTS TABLE
-- ============================================================================

CREATE TABLE letter_drafts (
  draft_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,

  -- Letter content (validated and ready to send)
  sender JSONB NOT NULL,
  recipient JSONB NOT NULL,
  body_text TEXT NOT NULL,
  sign_off TEXT NOT NULL,

  -- Computed values from preview
  required_credits INTEGER NOT NULL CHECK (required_credits > 0),
  preview_html TEXT,

  -- Address validation results (cached from preview)
  sender_validation JSONB,
  recipient_validation JSONB,

  -- Lifecycle management
  status draft_status NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,

  -- Idempotency: tracks if this draft has been consumed
  consumed_at TIMESTAMPTZ,
  consumed_letter_id VARCHAR(255) REFERENCES letters(letter_id) ON DELETE SET NULL,

  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Primary lookup: user's pending drafts
CREATE INDEX idx_letter_drafts_user_pending ON letter_drafts(user_id, status)
  WHERE status = 'pending';

-- Expiration cleanup: find drafts that need to be marked expired
CREATE INDEX idx_letter_drafts_expires_at ON letter_drafts(expires_at)
  WHERE status = 'pending';

-- Idempotency check: find consumed draft by letter_id
CREATE INDEX idx_letter_drafts_consumed_letter ON letter_drafts(consumed_letter_id)
  WHERE consumed_letter_id IS NOT NULL;

-- Fast lookup by draft_id and user (for authorization check)
CREATE INDEX idx_letter_drafts_id_user ON letter_drafts(draft_id, user_id);

-- Cleanup: find old consumed/expired drafts for deletion
CREATE INDEX idx_letter_drafts_cleanup ON letter_drafts(status, updated_at)
  WHERE status IN ('consumed', 'expired', 'cancelled');

-- ============================================================================
-- TRIGGER FOR updated_at
-- ============================================================================

CREATE TRIGGER update_letter_drafts_updated_at
  BEFORE UPDATE ON letter_drafts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE letter_drafts IS 'Temporary drafts created during preview, consumed on send for idempotency. Prevents duplicate sends when AI clients retry requests.';
COMMENT ON COLUMN letter_drafts.draft_id IS 'UUID returned to client for use in send_letter - the idempotency key';
COMMENT ON COLUMN letter_drafts.consumed_letter_id IS 'The letter_id created when this draft was sent - enables idempotent retries to return existing letter';
COMMENT ON COLUMN letter_drafts.expires_at IS 'Drafts expire after 24 hours if not consumed';
COMMENT ON COLUMN letter_drafts.sender_validation IS 'Cached address validation result from preview';
COMMENT ON COLUMN letter_drafts.recipient_validation IS 'Cached address validation result from preview';
