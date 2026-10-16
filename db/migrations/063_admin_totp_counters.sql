-- Migration: 063_admin_totp_counters.sql
-- Purpose: the admin panel's last accepted TOTP counter, kept in the database
-- (#730).
--
-- Write elevation takes a TOTP code, and a code is accepted only for a
-- counter (a 30-second step) above the last one accepted, so a code cannot be
-- used twice. That last counter lived in the admin process's memory: a restart,
-- or a second process, forgot it, and a code just used could be used again
-- within its window. This keeps it, per key: an operator's login while each
-- operator has a secret of their own (ADMIN_TOTP_SECRETS), or one shared key
-- under the legacy shared secret.
--
-- Written only by the admin operator role (granted by provisioning, which
-- must be re-run once); no customer data. Not one of 022's objects, so it is
-- created the same way whatever order 022 ran in.

CREATE TABLE IF NOT EXISTS admin_totp_counters (
  counter_key VARCHAR(255) PRIMARY KEY,
  last_counter BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_totp_counters_key_check CHECK (char_length(counter_key) BETWEEN 1 AND 255),
  CONSTRAINT admin_totp_counters_counter_check CHECK (last_counter >= 0)
);

REVOKE ALL ON TABLE admin_totp_counters FROM PUBLIC;

COMMENT ON TABLE admin_totp_counters IS
  'The last TOTP counter accepted for admin write elevation, by operator login (or one shared key), so a code cannot be used twice (#730).';
