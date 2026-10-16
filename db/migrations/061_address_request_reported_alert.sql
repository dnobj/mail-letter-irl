-- Purpose: an alert for an address request its recipient reported (#730).
--
-- An address request is a link a sender passes on, where the recipient types
-- their own mailing address (#604). Its page lets a recipient who does not
-- know the sender say so ("I don't know who sent this", #744): the request is
-- declined and nothing is shared. Until now that was only a log line. Now it
-- also opens a warning alert naming the account that made the link, so a
-- person collecting addresses this way is seen without searching logs.
--
-- One alert per reported request: a request is declined once.
--
-- commerce_operational_alerts is 023's; the legacy replay runs without it, so
-- the change is guarded, as 056's and 060's are.

DO $$
BEGIN
  IF to_regclass('commerce_operational_alerts') IS NOT NULL THEN
    ALTER TABLE commerce_operational_alerts DROP CONSTRAINT IF EXISTS valid_commerce_alert_type;
    ALTER TABLE commerce_operational_alerts ADD CONSTRAINT valid_commerce_alert_type CHECK (alert_type IN (
      'stripe_dispute_created',
      'stripe_dispute_closed',
      'mail_provider_outcome_ambiguous',
      'refunded_mail_already_dispatched',
      'stripe_money_event_unmatched',
      'dispute_compensation_incomplete',
      'stripe_partial_refund_unmatched',
      'pack_refund_failed',
      'account_erasure_followup',
      'daily_limit_reached',
      'schedule_missed_mail_day',
      'provider_cancelled_mail',
      'held_mail_funding_reversed',
      'refund_not_completed',
      'address_request_reported'
    ));
  END IF;
END $$;
