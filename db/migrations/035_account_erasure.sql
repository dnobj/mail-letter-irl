-- 035: the tombstone an account erasure leaves behind (#289, docs/account-erasure.md).
--
-- Erasure anonymises rather than deletes (the owner's decision on #289,
-- 2026-09-23). The users row stays behind as a tombstone because orders,
-- ledger lots, disputes and refunds keep foreign keys to it, and those records
-- are kept for accounting. Its email becomes a placeholder nobody can own, and
-- the saved return address - the one place on the row that holds a name - is
-- cleared. The erasure itself is src/services/accountErasureService.ts.
--
-- erased_at is what sign-in refuses on. Deleting the Auth0 user is not enough
-- on its own: a social sign-in presents the same subject when the person signs
-- in again, and an access token already issued stays valid for up to a day.
-- Either would reach prepareAuthenticatedUser, which writes the address it
-- carries back onto the row (src/auth/identity.ts).
--
-- The CHECK holds the tombstone against every later writer rather than
-- trusting each one to look first: an erased row cannot take an address or a
-- real email again unless the same statement clears erased_at, which is a
-- deliberate reopening, done by hand (docs/account-erasure.md).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS erased_at TIMESTAMPTZ;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_erased_tombstone;
ALTER TABLE users ADD CONSTRAINT users_erased_tombstone CHECK (
  erased_at IS NULL OR (
    return_address IS NULL
    AND return_address_validated_at IS NULL
    AND email LIKE 'erased-%@erased.invalid'
  )
);

COMMENT ON COLUMN users.erased_at IS
  'Set by the account erasure (#289). Sign-in refuses an erased account; the row stays as a tombstone for the kept financial records.';
