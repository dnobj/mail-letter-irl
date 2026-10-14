-- Migration: 058_users_email_case_insensitive.sql
-- Purpose: one account per address, whatever its case (#730).
--
-- users.email was UNIQUE as written (001's inline users_email_key), so
-- Bob@example.com and bob@example.com could be two accounts: one person, one
-- mailbox, and every per-email rule (one account per confirmed email, a gift's
-- own-code check) seeing two people. The address is kept as the sign-in gave
-- it; only its uniqueness ignores case.
--
-- Two accounts already differing only in case would make the index fail with
-- a bare 23505; the check below names the problem instead. Joining them is an
-- operator's decision, so the migration stops and waits for one. When this
-- was written, development and production held none.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users GROUP BY lower(email) HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'users holds addresses that differ only in case; join or correct those accounts before migration 058';
  END IF;
END $$;

ALTER TABLE users DROP CONSTRAINT users_email_key;
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- 001's plain index on email served exact-match lookups; every lookup now
-- compares lower(email), which the index above serves.
DROP INDEX IF EXISTS idx_users_email;

COMMENT ON INDEX users_email_lower_key IS
  'One account per address, ignoring case (#730). src/services/userService.ts names it as the email collision.';
