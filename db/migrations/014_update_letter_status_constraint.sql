-- Migration: 014_update_letter_status_constraint.sql
-- Purpose: Update letter status constraint to include all PostGrid-mapped statuses
--
-- Background: The letterWorker sets status='accepted' after successful submission,
-- but the original constraint only allowed: draft, queued, processing, sent, failed, cancelled
--
-- New statuses from PostGrid mapping:
-- - accepted: Letter accepted by provider (maps from: ready, rendered)
-- - processing: Being printed (maps from: processed, printed)
-- - in_transit: Mailed and in postal system (maps from: mailed, in_transit)
-- - delivered: Successfully delivered
-- - returned: Returned to sender

-- Drop the old constraint
ALTER TABLE letters DROP CONSTRAINT IF EXISTS valid_letter_status;

-- Add the new constraint with all valid statuses
ALTER TABLE letters ADD CONSTRAINT valid_letter_status
  CHECK (status IN (
    'draft',       -- Initial state before queueing
    'queued',      -- Waiting in job queue
    'processing',  -- Being processed/printed
    'sent',        -- Legacy status (kept for backwards compatibility)
    'accepted',    -- Accepted by print provider
    'in_transit',  -- Mailed, in postal system
    'delivered',   -- Successfully delivered
    'returned',    -- Returned to sender
    'failed',      -- Processing failed
    'cancelled'    -- Cancelled by user
  ));

-- Add comment explaining the statuses
COMMENT ON COLUMN letters.status IS 'Letter status: draft → queued → processing → accepted → in_transit → delivered/returned/failed';
