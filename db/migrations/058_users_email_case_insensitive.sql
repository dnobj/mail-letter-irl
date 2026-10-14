-- Migration: 058_users_email_case_insensitive.sql
-- Purpose: one account per address, whatever its case (#730).
--
-- users.email was UNIQUE as written (001's inline users_email_key), so
-- Bob@example.com and bob@example.com could be two accounts: one person, one
-- mailbox, and every per-email rule (one account per confirmed email, a gift's
-- own-code check) seeing two people. The address is kept as the sign-in gave
-- it; only its uniqueness ignores case.
--
-- Two accounts already differing only in case would make the index build fail
-- with an error that says nothing of what to do, and that the deploy log's
-- diagnostic reduces to its class; the check below stops first, as a
-- unique_violation (so that diagnostic reads 23505 on 058), with a message
-- saying what to do for anyone running it by hand. The table is not locked
-- before the check: holding a lower lock and then upgrading to the ALTER's can
-- deadlock against a send that holds an account row and then updates it. A
-- pair added in the instant between the check and the index fails the index
-- build instead, which rolls the whole run back just the same. Joining the
-- accounts is an operator's decision, so the migration waits for one. Find
-- them with: SELECT lower(email) FROM users GROUP BY 1 HAVING COUNT(*) > 1.
-- When this was written, development and production held none.
--
-- lower() folds case by the database's locale. Neon's use PostgreSQL's builtin
-- C.UTF-8, which folds Unicode letters (development and production, checked
-- 2026-10-14), much as JavaScript's toLowerCase() does for the gift and promo
-- rules (PostgreSQL maps letter by letter, so a rare letter such as a dotted
-- capital I folds differently). Under a plain
-- "C" locale only ASCII would fold, and a non-ASCII address could count as two
-- here and one there.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users GROUP BY lower(email) HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'users holds addresses that differ only in case; join or correct those accounts before migration 058'
      USING ERRCODE = 'unique_violation';
  END IF;
END $$;

ALTER TABLE users DROP CONSTRAINT users_email_key;
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- 001's plain index on email served exact-match lookups; every lookup now
-- compares lower(email), which the index above serves.
DROP INDEX IF EXISTS idx_users_email;

COMMENT ON INDEX users_email_lower_key IS
  'One account per address, ignoring case (#730). src/services/userService.ts names it as the email collision.';
