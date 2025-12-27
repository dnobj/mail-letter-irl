-- Migration 013: Letter Layout Support
--
-- Adds support for multiple letter layout types:
-- - text_only: Current default, plain text letter
-- - header_image: Image at top (branding, letterhead, decorative)
-- - inline_image: Image after signature/closing
--
-- User Stories:
-- - US-LAYOUT-01: Preview Letter with Header Image
-- - US-LAYOUT-02: Preview Letter with Inline Image
-- - US-LAYOUT-03: Layout Type Detection and Override
-- - US-LAYOUT-04: Letter Layout Image Processing
-- - US-LAYOUT-05: Letter Layout Widget Preview
-- - US-LAYOUT-06: Letter Layout PostGrid Printing

-- ============================================================================
-- LETTER_DRAFTS ADDITIONS
-- ============================================================================

-- Add layout_type column with default 'text_only' for backwards compatibility
ALTER TABLE letter_drafts
  ADD COLUMN layout_type VARCHAR(20) NOT NULL DEFAULT 'text_only';

-- Header image columns (NULL unless layout_type = 'header_image')
ALTER TABLE letter_drafts
  ADD COLUMN header_image_data TEXT,      -- Base64 data URI of processed image (JPEG, 1950x600 at 300 DPI)
  ADD COLUMN header_image_url TEXT;       -- Original URL from OpenAI for debugging

-- Inline image columns (NULL unless layout_type = 'inline_image')
ALTER TABLE letter_drafts
  ADD COLUMN inline_image_data TEXT,      -- Base64 data URI of processed image (JPEG, 1950x900 at 300 DPI)
  ADD COLUMN inline_image_url TEXT;       -- Original URL from OpenAI for debugging

-- ============================================================================
-- CONSTRAINTS
-- ============================================================================

-- Validate layout_type values
ALTER TABLE letter_drafts
  ADD CONSTRAINT check_letter_layout_type CHECK (
    layout_type IN ('text_only', 'header_image', 'inline_image')
  );

-- Header image layout requires image data
ALTER TABLE letter_drafts
  ADD CONSTRAINT header_layout_requires_image CHECK (
    layout_type != 'header_image' OR header_image_data IS NOT NULL
  );

-- Inline image layout requires image data
ALTER TABLE letter_drafts
  ADD CONSTRAINT inline_layout_requires_image CHECK (
    layout_type != 'inline_image' OR inline_image_data IS NOT NULL
  );

-- Cannot have both header and inline images (mutually exclusive layouts)
ALTER TABLE letter_drafts
  ADD CONSTRAINT layout_images_mutually_exclusive CHECK (
    NOT (header_image_data IS NOT NULL AND inline_image_data IS NOT NULL)
  );

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Index for querying by layout type (useful for reporting)
CREATE INDEX idx_letter_drafts_layout_type ON letter_drafts(layout_type)
  WHERE mail_type = 'letter';

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON COLUMN letter_drafts.layout_type IS 'Letter layout type: text_only (default), header_image, or inline_image';
COMMENT ON COLUMN letter_drafts.header_image_data IS 'Base64 JPEG data URI for header image (1950x600 at 300 DPI, max 2 inches height)';
COMMENT ON COLUMN letter_drafts.header_image_url IS 'Original header image URL from OpenAI for debugging; NULL for non-header layouts';
COMMENT ON COLUMN letter_drafts.inline_image_data IS 'Base64 JPEG data URI for inline image (1950x900 at 300 DPI, max 3 inches height)';
COMMENT ON COLUMN letter_drafts.inline_image_url IS 'Original inline image URL from OpenAI for debugging; NULL for non-inline layouts';
