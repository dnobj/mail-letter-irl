-- Migration 017: Add contact fields to feature_requests
-- Purpose: Allow users to optionally provide email and consent to be contacted

-- Add email field (optional - user can provide if different from account email)
ALTER TABLE feature_requests
  ADD COLUMN contact_email VARCHAR(255);

-- Add consent field (did user agree to be contacted about this request?)
ALTER TABLE feature_requests
  ADD COLUMN contact_consent BOOLEAN NOT NULL DEFAULT false;

-- Add constraint for email length
ALTER TABLE feature_requests ADD CONSTRAINT feature_requests_contact_email_length
  CHECK (contact_email IS NULL OR char_length(contact_email) <= 255);
