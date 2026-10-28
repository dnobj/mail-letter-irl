-- 038: the daily limits can be changed while running, and say when they refuse someone.
--
-- The daily safety limits were environment variables only: letters per
-- account, letters across every account and money per account (#179), and
-- gift sends (docs/gift-letters.md). Changing one meant a Railway variable
-- change and a redeploy, and nothing told the operator when one turned a
-- customer away. The owner wants to inspect and lift them as the business
-- grows (2026-09-28). So:
--
-- daily_limit_overrides: an operator's value for one limit, for everyone or,
--   for the two per-account limits, for one account, and for the rest of the
--   UTC day or until cleared. Only the admin panel writes it, through
--   limit.set and limit.clear. Rows are never deleted: clearing stamps
--   cleared_at, so the table is its own history (the admin roles hold no
--   DELETE outside promo_campaigns). At most one uncleared row per limit and
--   account; an expired row stays uncleared until the next change clears it.
--
-- daily_limit_refusals: how many times each limit refused, per UTC day. The
--   first row for a limit and day is what opens that day's alert, so a burst
--   of refusals opens one alert, not one each. It holds no account ids: the
--   alert names the first account, and alerts already carry account ids.
--
-- daily_limit_defaults: the values the API process runs with, from its
--   environment, written when it starts. The admin panel runs as its own
--   service with its own environment, so this is how it shows them.
--
-- And a new operational alert type, daily_limit_reached. The full list is
-- restated, as 024, 028 and 036 did, because a CHECK constraint cannot be
-- amended in place, and the block is guarded on the table existing because
-- the legacy-scenario integration tests stage every migration except 022 and
-- 023.

CREATE TABLE IF NOT EXISTS daily_limit_overrides (
  override_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  limit_key VARCHAR(40) NOT NULL,
  -- NULL means every account. Only the two per-account limits may name one.
  user_id VARCHAR(255) REFERENCES users(user_id) ON DELETE CASCADE,
  value INTEGER NOT NULL,
  -- NULL means until an operator clears it.
  expires_at TIMESTAMPTZ,
  -- The admin command runs that set and cleared it: soft links, like 029's,
  -- so this table does not depend on the admin tables of 022.
  created_by_command_id VARCHAR(64),
  cleared_at TIMESTAMPTZ,
  cleared_by_command_id VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_daily_limit_override_key CHECK (
    limit_key IN ('global_daily_mail', 'account_daily_mail', 'account_daily_charge_cents', 'gift_daily_send')
  ),
  CONSTRAINT daily_limit_override_value_not_negative CHECK (value >= 0),
  CONSTRAINT daily_limit_override_account_scope CHECK (
    user_id IS NULL OR limit_key IN ('account_daily_mail', 'account_daily_charge_cents')
  ),
  CONSTRAINT daily_limit_override_cleared_pair CHECK (
    (cleared_at IS NULL) = (cleared_by_command_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_limit_overrides_one_uncleared
  ON daily_limit_overrides (limit_key, COALESCE(user_id, ''))
  WHERE cleared_at IS NULL;

DROP TRIGGER IF EXISTS update_daily_limit_overrides_updated_at ON daily_limit_overrides;
CREATE TRIGGER update_daily_limit_overrides_updated_at
  BEFORE UPDATE ON daily_limit_overrides
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS daily_limit_refusals (
  limit_key VARCHAR(40) NOT NULL,
  utc_day DATE NOT NULL,
  refusals INTEGER NOT NULL DEFAULT 1,
  first_refused_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_refused_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (limit_key, utc_day),
  CONSTRAINT valid_daily_limit_refusal_key CHECK (
    limit_key IN ('global_daily_mail', 'account_daily_mail', 'account_daily_charge_cents', 'gift_daily_send')
  ),
  CONSTRAINT daily_limit_refusals_positive CHECK (refusals >= 1)
);

CREATE TABLE IF NOT EXISTS daily_limit_defaults (
  limit_key VARCHAR(40) PRIMARY KEY,
  value INTEGER NOT NULL,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_daily_limit_default_key CHECK (
    limit_key IN ('global_daily_mail', 'account_daily_mail', 'account_daily_charge_cents', 'gift_daily_send')
  ),
  CONSTRAINT daily_limit_default_not_negative CHECK (value >= 0)
);

DO $$
BEGIN
  IF to_regclass('commerce_operational_alerts') IS NOT NULL THEN
    ALTER TABLE commerce_operational_alerts
      DROP CONSTRAINT IF EXISTS valid_commerce_alert_type;
    ALTER TABLE commerce_operational_alerts
      ADD CONSTRAINT valid_commerce_alert_type CHECK (
        alert_type IN (
          'stripe_dispute_created', 'stripe_dispute_closed',
          'mail_provider_outcome_ambiguous', 'refunded_mail_already_dispatched',
          'stripe_money_event_unmatched',
          'dispute_compensation_incomplete',
          'stripe_partial_refund_unmatched',
          'pack_refund_failed',
          'account_erasure_followup',
          'daily_limit_reached'
        )
      );
  END IF;
END $$;

COMMENT ON TABLE daily_limit_overrides IS
  'Operator values for the daily limits, for everyone or one account; cleared, never deleted (038).';
COMMENT ON TABLE daily_limit_refusals IS
  'Refusals per daily limit per UTC day; the first row of a day opens the day''s alert (038).';
COMMENT ON TABLE daily_limit_defaults IS
  'The daily limits the API process runs with, from its environment, written at start (038).';
