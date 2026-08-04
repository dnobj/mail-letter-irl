-- Account send-block for disputed payments, for issue #150.
--
-- Migrations 021, 022 and 023 are already applied in development and must not
-- be rewritten. This migration depends on none of them beyond the base `users`
-- table from 001, so the runner may apply it in any order relative to those.
--
-- Every statement here is transaction-safe. The migrator runs the whole pending
-- set inside one transaction, so nothing in this file may use CONCURRENTLY,
-- VACUUM, REINDEX or ALTER TYPE ... ADD VALUE. See db/README.md.

-- ---------------------------------------------------------------------------
-- Send blocking
-- ---------------------------------------------------------------------------
--
-- Approved policy for issue #150: a goodwill refund absorbs any packs the
-- customer already spent and leaves the account unrestricted, but a dispute or
-- chargeback zeroes the pack balance AND blocks further sends pending operator
-- review.
--
-- Deliberately NOT modelled as a negative `users.credits`. That column carries
-- CHECK (credits >= 0) from 001_initial_schema.sql, and letting a balance go
-- negative would change the meaning of every read of it across the codebase.
-- A separate block flag keeps the balance honest and makes the restriction
-- explicit and auditable.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sends_blocked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sends_blocked_reason VARCHAR(64);

-- Only meaningful when a block is present; a reason without a timestamp would
-- be ambiguous about whether the account is actually restricted.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_send_block_consistent;
ALTER TABLE users ADD CONSTRAINT users_send_block_consistent CHECK (
  (sends_blocked_at IS NULL AND sends_blocked_reason IS NULL) OR
  (sends_blocked_at IS NOT NULL AND sends_blocked_reason IS NOT NULL)
);

-- Operators need to list restricted accounts; the partial index keeps this
-- cheap given the overwhelming majority of rows are unblocked.
CREATE INDEX IF NOT EXISTS idx_users_sends_blocked
  ON users (sends_blocked_at)
  WHERE sends_blocked_at IS NOT NULL;

COMMENT ON COLUMN users.sends_blocked_at IS
  'Set when a dispute or chargeback restricts the account. NULL means sends are permitted. Cleared only by an operator after review; winning a dispute does not clear it automatically.';
COMMENT ON COLUMN users.sends_blocked_reason IS
  'Stable machine-readable reason code, e.g. payment_disputed. Never free text and never customer PII.';
