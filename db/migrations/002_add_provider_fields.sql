-- Migration: Add provider tracking fields to letters table
-- Date: 2025-11-18
-- Purpose: Add columns needed for letter provider integration (PostGrid, etc.)

-- Rename tracking_number to tracking_id for consistency
ALTER TABLE letters
  RENAME COLUMN tracking_number TO tracking_id;

-- Add provider information columns
ALTER TABLE letters
  ADD COLUMN IF NOT EXISTS provider VARCHAR(50),
  ADD COLUMN IF NOT EXISTS cost_cents INTEGER,
  ADD COLUMN IF NOT EXISTS expected_delivery TIMESTAMP,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- Add index on tracking_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_letters_tracking_id ON letters(tracking_id);

-- Add index on provider for analytics
CREATE INDEX IF NOT EXISTS idx_letters_provider ON letters(provider);

-- Update existing records to have updated_at
UPDATE letters SET updated_at = created_at WHERE updated_at IS NULL;

-- Add comment to table
COMMENT ON COLUMN letters.tracking_id IS 'Provider tracking ID (e.g., PostGrid letter ID)';
COMMENT ON COLUMN letters.provider IS 'Letter fulfillment provider (dummy, postgrid, lob, etc.)';
COMMENT ON COLUMN letters.cost_cents IS 'Actual cost charged by provider in cents';
COMMENT ON COLUMN letters.expected_delivery IS 'Provider estimated delivery date';
