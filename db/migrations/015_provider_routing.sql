-- Migration 015: Provider Routing Control
--
-- Adds database-driven provider routing to control which fulfillment provider
-- handles each mail type. This enables flexible routing between providers
-- (PostGrid, DIY, Lob) via admin UI without code deployment.
--
-- User Stories:
-- - Provider routing control via admin panel
-- - DIYProvider support for manual mail fulfillment

-- ============================================================================
-- PROVIDER ROUTING TABLE
-- ============================================================================

CREATE TABLE provider_routing (
  id SERIAL PRIMARY KEY,
  mail_type VARCHAR(50) NOT NULL UNIQUE,  -- 'text_only_letter', 'header_image_letter', 'inline_image_letter', 'postcard'
  provider VARCHAR(50) NOT NULL,           -- 'postgrid', 'diy', 'lob', 'dummy'
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_by VARCHAR(255)                  -- Admin who made the change
);

-- ============================================================================
-- DEFAULT ROUTING (all to PostGrid initially)
-- ============================================================================

INSERT INTO provider_routing (mail_type, provider) VALUES
  ('text_only_letter', 'postgrid'),
  ('header_image_letter', 'postgrid'),
  ('inline_image_letter', 'postgrid'),
  ('postcard', 'postgrid');

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX idx_provider_routing_mail_type ON provider_routing(mail_type);
CREATE INDEX idx_provider_routing_enabled ON provider_routing(enabled);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE provider_routing IS 'Controls which fulfillment provider handles each mail type';
COMMENT ON COLUMN provider_routing.mail_type IS 'Type of mail: text_only_letter, header_image_letter, inline_image_letter, postcard';
COMMENT ON COLUMN provider_routing.provider IS 'Provider identifier: postgrid, diy, lob, dummy';
COMMENT ON COLUMN provider_routing.enabled IS 'Whether this routing rule is active';
COMMENT ON COLUMN provider_routing.updated_at IS 'Last modification timestamp';
COMMENT ON COLUMN provider_routing.updated_by IS 'Admin email/ID who made the change';

-- ============================================================================
-- TRIGGER FOR updated_at
-- ============================================================================

CREATE OR REPLACE FUNCTION update_provider_routing_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER provider_routing_updated_at
  BEFORE UPDATE ON provider_routing
  FOR EACH ROW
  EXECUTE FUNCTION update_provider_routing_timestamp();
