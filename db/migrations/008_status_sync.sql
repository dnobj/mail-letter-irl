-- Migration: 008_status_sync.sql
-- Purpose: Add columns for tracking letter status sync from fulfillment providers

-- Add status tracking columns to letters table
ALTER TABLE letters
  ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_raw_status TEXT;

-- Add index for efficient sync queries (non-terminal letters from last 30 days)
CREATE INDEX IF NOT EXISTS idx_letters_status_sync
  ON letters (status, created_at)
  WHERE status NOT IN ('delivered', 'returned', 'failed', 'cancelled')
  AND tracking_id IS NOT NULL;

-- Update existing letters to set status_updated_at to updated_at
UPDATE letters
SET status_updated_at = COALESCE(updated_at, created_at)
WHERE status_updated_at IS NULL;

-- Add comment for documentation
COMMENT ON COLUMN letters.status_updated_at IS 'Timestamp when status was last synced from provider';
COMMENT ON COLUMN letters.provider_raw_status IS 'Raw status string from provider (PostGrid, etc.) for debugging';
