-- Migration 011: Personal Access Tokens for MCP Authentication
--
-- This migration introduces Personal Access Tokens (PAT) to allow MCP clients
-- like Claude Desktop to authenticate without OAuth flows.
--
-- User Stories:
-- - US-MCP-01: Generate Personal Access Token
-- - US-MCP-02: Revoke Personal Access Token
-- - US-MCP-03: Authenticate via Personal Access Token

-- ============================================================================
-- ENUMS
-- ============================================================================

CREATE TYPE pat_status AS ENUM (
  'active',   -- Token is valid and usable
  'revoked'   -- Token has been revoked by user
);

-- ============================================================================
-- PERSONAL ACCESS TOKENS TABLE
-- ============================================================================

CREATE TABLE personal_access_tokens (
  token_id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,

  -- Token identification
  name VARCHAR(100) NOT NULL,
  token_hash VARCHAR(255) NOT NULL,    -- bcrypt hash - NEVER store raw token
  token_prefix CHAR(4) NOT NULL,       -- Last 4 chars for UI identification

  -- Status and expiration
  status pat_status NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ,              -- NULL = never expires

  -- Usage tracking
  last_used_at TIMESTAMPTZ,

  -- Audit timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT pat_name_length CHECK (char_length(name) >= 1 AND char_length(name) <= 100)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Find tokens by user (for listing)
CREATE INDEX idx_pat_user_id ON personal_access_tokens(user_id);

-- Find active tokens efficiently
CREATE INDEX idx_pat_user_active ON personal_access_tokens(user_id)
  WHERE status = 'active';

-- Find tokens that need expiration checking
CREATE INDEX idx_pat_expires_at ON personal_access_tokens(expires_at)
  WHERE expires_at IS NOT NULL AND status = 'active';

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE personal_access_tokens IS 'Personal Access Tokens for MCP client authentication (US-MCP-01, US-MCP-02, US-MCP-03)';
COMMENT ON COLUMN personal_access_tokens.token_hash IS 'bcrypt hash of token - raw token is shown once at creation and never stored';
COMMENT ON COLUMN personal_access_tokens.token_prefix IS 'Last 4 characters of token for UI display (e.g., "...o345")';
COMMENT ON COLUMN personal_access_tokens.expires_at IS 'Optional expiration timestamp - NULL means token never expires';
