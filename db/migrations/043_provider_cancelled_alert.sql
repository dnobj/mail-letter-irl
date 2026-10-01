-- Migration: 043_provider_cancelled_alert.sql
-- Purpose: an operator alert for mail the provider cancelled after accepting it (#566).
--
-- PostGrid cancels a piece only while it is still `ready`, never once it is
-- printing, so a cancelled piece was never printed. The hourly status sync now
-- reads PostGrid's `cancelled` (it knew only `canceled`, and so read a cancelled
-- piece as accepted forever): the letter fails, what paid for it comes back as
-- for any definite rejection, and 'provider_cancelled_mail' is raised once per
-- letter (letterJobService.failProviderCancelledLetter). For a Pay & Send
-- letter, whose order was already fulfilled, the alert asks a person to decide
-- the refund. A partial unique index on the letter keeps it one per letter even
-- if two runs overlap.
--
-- commerce_operational_alerts is a 023 object, so this sits in a DO block
-- guarded through to_regclass: the commerce ACID legacy replay runs every
-- migration after 023 on a schema without it, as 024, 028, 036, 038 and 041 do.
-- The list is 041's with the new type added.

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
          'daily_limit_reached',
          'schedule_missed_mail_day',
          'provider_cancelled_mail'
        )
      );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_alerts_provider_cancelled_letter
      ON commerce_operational_alerts ((details->>'letterId'))
      WHERE alert_type = 'provider_cancelled_mail';
  END IF;
END $$;
