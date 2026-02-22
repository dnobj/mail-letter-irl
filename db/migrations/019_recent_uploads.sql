-- Migration: 019_recent_uploads.sql
-- Purpose: Database-backed recent upload store for reliable image URL fallback
-- When sendFollowUpMessage fails to deliver the uploaded image URL to ChatGPT,
-- preview tools can still retrieve the URL from this table.

CREATE TABLE recent_uploads (
  user_id    VARCHAR(255) PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  image_url  TEXT NOT NULL,
  context    VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reuse existing trigger function from 001_initial_schema.sql
CREATE TRIGGER update_recent_uploads_updated_at
  BEFORE UPDATE ON recent_uploads
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE recent_uploads IS 'Per-user most recent image upload URL for fallback when sendFollowUpMessage fails';
COMMENT ON COLUMN recent_uploads.context IS 'Upload context: postcard, header_image, or inline_image';
