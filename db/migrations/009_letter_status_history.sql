-- Migration: 009_letter_status_history.sql
-- Purpose: Track complete status change history for letters

-- Create status history table
CREATE TABLE IF NOT EXISTS letter_status_history (
  history_id SERIAL PRIMARY KEY,
  letter_id TEXT NOT NULL REFERENCES letters(letter_id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT NOT NULL,
  provider_raw_status TEXT,
  source TEXT NOT NULL DEFAULT 'sync', -- 'sync', 'send', 'manual', 'webhook'
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient lookups by letter
CREATE INDEX IF NOT EXISTS idx_letter_status_history_letter_id
  ON letter_status_history (letter_id, changed_at DESC);

-- Backfill initial status entries for existing letters
-- This creates a single history entry for each letter's current status
INSERT INTO letter_status_history (letter_id, old_status, new_status, provider_raw_status, source, changed_at)
SELECT
  letter_id,
  NULL as old_status,
  status as new_status,
  provider_raw_status,
  'backfill' as source,
  COALESCE(status_updated_at, created_at) as changed_at
FROM letters
WHERE NOT EXISTS (
  SELECT 1 FROM letter_status_history h WHERE h.letter_id = letters.letter_id
);

-- Add comments
COMMENT ON TABLE letter_status_history IS 'Complete audit trail of letter status changes';
COMMENT ON COLUMN letter_status_history.source IS 'What triggered the status change: sync, send, manual, webhook, backfill';
