-- Migration: 057_personal_tokens_expire.sql
-- Purpose: every personal access token expires (#730).
--
-- Tokens made since audit A-02 carry an expiry (src/services/patService.ts,
-- resolveTokenExpiry: 90 days by default, at most 365). Tokens made before it
-- were stored with none, and a token with no expiry stays valid long after the
-- client it was made for is gone.
--
-- Each such token now expires 90 days after it was made, the default a new
-- one gets, but never sooner than 30 days from this migration: a token in use
-- today keeps working for a month, and its owner sees the date in their list
-- and can make a new one. A revoked token gets a date too; it changes nothing
-- for it.
--
-- Then the column holds every token to it: NOT NULL, with the same 90 days as
-- its default, so a row inserted without one (a fixture, a script) still
-- expires, and none can be made that never does.

UPDATE personal_access_tokens
   SET expires_at = GREATEST(created_at + INTERVAL '90 days', NOW() + INTERVAL '30 days')
 WHERE expires_at IS NULL;

ALTER TABLE personal_access_tokens
  ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '90 days'),
  ALTER COLUMN expires_at SET NOT NULL;

COMMENT ON COLUMN personal_access_tokens.expires_at IS
  'When the token stops working. Every token has one (#730): 90 days by default, at most 365.';
