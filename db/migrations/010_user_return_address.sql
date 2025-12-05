-- Migration: 010_user_return_address.sql
-- Purpose: Add return address storage for users

-- Add return address column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS return_address JSONB;

-- Add timestamp for when address was last validated
ALTER TABLE users ADD COLUMN IF NOT EXISTS return_address_validated_at TIMESTAMPTZ;

-- Comments
COMMENT ON COLUMN users.return_address IS 'User preferred return/sender address for letters (validated)';
COMMENT ON COLUMN users.return_address_validated_at IS 'When the return address was last validated with provider';
