-- 036: an erasure leaves work for an operator, and now says so (#453).
--
-- An account erasure (035, #289) runs in the hourly maintenance job and leaves
-- three things to do by hand (docs/account-erasure.md): delete the Auth0 user
-- with the account's id in the environment's tenant, and take the id out of
-- LETTER_IRL_BETA_ALLOWED_SUBJECTS and LETTER_IRL_ADMIN_USER_IDS if it is
-- listed. Nothing reminded anyone, and a forgotten Auth0 deletion leaves the
-- person's name and email with Auth0 while the erasure looks finished. The
-- erasure now opens an `account_erasure_followup` alert in the transaction
-- that writes the tombstone, and the alert stays open until an operator
-- resolves it.
--
-- Extends the allow-list from 023/024/028 the way 024 and 028 did: the full
-- list is restated because a CHECK constraint cannot be amended in place, and
-- the block is guarded on the table existing because the legacy-scenario
-- integration tests stage every migration except 022 and 023.

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
          'account_erasure_followup'
        )
      );
  END IF;
END $$;
