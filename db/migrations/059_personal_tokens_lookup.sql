-- Migration: 059_personal_tokens_lookup.sql
-- Purpose: find a personal access token by the SHA-256 of the whole token (#730).
--
-- A token was found by its last four characters, the suffix the website shows,
-- and then a bcrypt compare against every active row sharing them. Any request
-- whose suffix matched a live token cost a bcrypt compare, chosen by whoever
-- sent it. token_lookup is the SHA-256 of the token, matched exactly through
-- the unique index below, so finding a token costs one indexed read whatever
-- is sent.
--
-- Unkeyed on purpose: a token carries about 165 random bits, so its SHA-256
-- cannot be reversed or guessed, and a key would only be one more secret to
-- keep and rotate. token_hash (bcrypt) stays as it was.
--
-- Tokens made before this have no lookup: src/services/patService.ts finds
-- them as before and fills it in on their first use. Every one of them
-- expires within 90 days of 057, after which none is left without.
--
-- The admin reader's column list on this table is explicit (provisioning),
-- so neither role is granted the new column.

ALTER TABLE personal_access_tokens ADD COLUMN token_lookup CHAR(64);

CREATE UNIQUE INDEX idx_pat_token_lookup ON personal_access_tokens (token_lookup)
  WHERE token_lookup IS NOT NULL;

COMMENT ON COLUMN personal_access_tokens.token_lookup IS
  'SHA-256 (hex) of the whole token, how validateToken finds it (#730). NULL only on a token made before 059 and not used since.';
