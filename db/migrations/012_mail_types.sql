-- Migration 012: Add mail_type support for postcards
--
-- Adds support for different mail types (letters vs postcards) with
-- postcard-specific fields for image storage.
--
-- User Stories:
-- - US-POSTCARD-01: Preview a Postcard
-- - US-POSTCARD-02: Send a Postcard
-- - US-POSTCARD-03: Postcard Image Processing

-- ============================================================================
-- MAIL TYPE ENUM
-- ============================================================================

CREATE TYPE mail_type AS ENUM (
  'letter',     -- Standard letter (default, current behavior)
  'postcard'    -- 6x9 postcard with front image and back message
);

COMMENT ON TYPE mail_type IS 'Distinguishes between letters and postcards for routing and pricing';

-- ============================================================================
-- LETTER_DRAFTS ADDITIONS
-- ============================================================================

-- Add mail_type column with default 'letter' for backwards compatibility
ALTER TABLE letter_drafts
  ADD COLUMN mail_type mail_type NOT NULL DEFAULT 'letter';

-- Postcard-specific columns (NULL for letters)
ALTER TABLE letter_drafts
  ADD COLUMN front_image_data TEXT,      -- Base64 data URI of processed image (JPEG)
  ADD COLUMN front_image_url TEXT,       -- Original URL from OpenAI for debugging
  ADD COLUMN postcard_size VARCHAR(10);  -- '6x9' (only size for now)

-- Make sign_off nullable for postcards (postcards use body_text as message)
-- Note: body_text is repurposed as 'message' for postcards
ALTER TABLE letter_drafts
  ALTER COLUMN sign_off DROP NOT NULL;

-- ============================================================================
-- LETTERS TABLE ADDITIONS
-- ============================================================================

-- Add mail_type column with default 'letter' for backwards compatibility
ALTER TABLE letters
  ADD COLUMN mail_type mail_type NOT NULL DEFAULT 'letter';

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Index for querying by mail type (useful for reporting)
CREATE INDEX idx_letters_mail_type ON letters(mail_type);
CREATE INDEX idx_letter_drafts_mail_type ON letter_drafts(mail_type);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON COLUMN letter_drafts.mail_type IS 'Type of mail: letter (default) or postcard';
COMMENT ON COLUMN letter_drafts.front_image_data IS 'Base64 JPEG data URI for postcard front image (1800x2700 at 300 DPI)';
COMMENT ON COLUMN letter_drafts.front_image_url IS 'Original image URL from OpenAI for debugging; NULL for letters';
COMMENT ON COLUMN letter_drafts.postcard_size IS 'Postcard dimensions: 6x9 (only supported size currently)';

COMMENT ON COLUMN letters.mail_type IS 'Type of mail: letter (default) or postcard';

-- ============================================================================
-- CONSTRAINTS
-- ============================================================================

-- Validate postcard_size values
ALTER TABLE letter_drafts
  ADD CONSTRAINT valid_postcard_size CHECK (
    postcard_size IS NULL OR postcard_size IN ('6x4', '6x9', '6x11')
  );

-- Postcards must have an image
ALTER TABLE letter_drafts
  ADD CONSTRAINT postcard_requires_image CHECK (
    mail_type != 'postcard' OR front_image_data IS NOT NULL
  );

-- Postcards must have a size
ALTER TABLE letter_drafts
  ADD CONSTRAINT postcard_requires_size CHECK (
    mail_type != 'postcard' OR postcard_size IS NOT NULL
  );
