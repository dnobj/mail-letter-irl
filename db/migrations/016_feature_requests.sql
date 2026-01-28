-- Migration 016: Feature Requests Table
-- Purpose: Allow users to submit feature requests through ChatGPT
-- User Story: US-FEEDBACK-01

-- Create enum for feature request status
CREATE TYPE feature_request_status AS ENUM (
  'new',
  'reviewed',
  'planned',
  'in_progress',
  'completed',
  'declined',
  'duplicate'
);

-- Create enum for feature request category
CREATE TYPE feature_request_category AS ENUM (
  'new_feature',
  'improvement',
  'integration',
  'mail_type',
  'international',
  'other'
);

-- Create feature_requests table
CREATE TABLE feature_requests (
  request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  category feature_request_category NOT NULL DEFAULT 'other',
  attempted_action VARCHAR(255),  -- What user was trying to do when they requested this
  status feature_request_status NOT NULL DEFAULT 'new',
  admin_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ
);

-- Add constraint for title length
ALTER TABLE feature_requests ADD CONSTRAINT feature_requests_title_length
  CHECK (char_length(title) <= 200);

-- Add constraint for description length
ALTER TABLE feature_requests ADD CONSTRAINT feature_requests_description_length
  CHECK (char_length(description) <= 2000);

-- Add constraint for attempted_action length
ALTER TABLE feature_requests ADD CONSTRAINT feature_requests_attempted_action_length
  CHECK (attempted_action IS NULL OR char_length(attempted_action) <= 255);

-- Indexes for common queries
CREATE INDEX idx_feature_requests_user_id ON feature_requests(user_id);
CREATE INDEX idx_feature_requests_status ON feature_requests(status);
CREATE INDEX idx_feature_requests_category ON feature_requests(category);
CREATE INDEX idx_feature_requests_created_at ON feature_requests(created_at DESC);

-- Index for rate limiting query (recent requests by user)
CREATE INDEX idx_feature_requests_user_recent ON feature_requests(user_id, created_at DESC);

-- Auto-update updated_at timestamp
CREATE TRIGGER feature_requests_updated_at
  BEFORE UPDATE ON feature_requests
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
