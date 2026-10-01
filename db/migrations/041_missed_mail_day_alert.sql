-- Migration: 041_missed_mail_day_alert.sql
-- Purpose: an operator alert for held mail that missed its mail day (#535).
--
-- Mail sent to arrive by a date waits in the outbox until 09:00 New York time
-- on its mail date (040). If it has still not been accepted by the printer at
-- 18:00 that day (dispatch paused, the provider down, retries running out),
-- the hourly maintenance raises 'schedule_missed_mail_day', one per letter
-- (scheduledMailService.raiseMissedMailDayAlerts). A partial unique index on
-- the letter keeps it one per letter even if two runs overlap.
--
-- commerce_operational_alerts is a 023 object, so this sits in a DO block
-- guarded through to_regclass: the commerce ACID legacy replay runs every
-- migration after 023 on a schema without it, as 024, 028, 036 and 038 do.
-- The list is 038's with the new type added.

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
          'schedule_missed_mail_day'
        )
      );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_alerts_missed_mail_day_letter
      ON commerce_operational_alerts ((details->>'letterId'))
      WHERE alert_type = 'schedule_missed_mail_day';
  END IF;
END $$;
