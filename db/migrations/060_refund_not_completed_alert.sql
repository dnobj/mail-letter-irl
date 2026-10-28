-- Migration: 060_refund_not_completed_alert.sql
-- Purpose: an alert for a refund that failed or was cancelled at Stripe (#730).
--
-- The hourly refund sweep used to answer a failed or cancelled full refund by
-- creating another: a refund an operator cancelled in Stripe came back an hour
-- later, and one that failed (a closed card) was tried again to the same card.
-- Now the order is held (last_error_code REFUND_NOT_COMPLETED, which the sweep
-- skips) and this critical alert asks a person: refund another way in Stripe,
-- whose webhook completes the order, or leave it.
--
-- One open alert per order: the partial unique index below. Once resolved, a
-- later failure on the same order raises a new one.
--
-- commerce_operational_alerts is 023's; the legacy replay runs without it, so
-- the change is guarded, as 056's is.

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
      'refund_not_completed'
    ));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_alerts_refund_not_completed_order
      ON commerce_operational_alerts (order_id)
      WHERE alert_type = 'refund_not_completed' AND status <> 'resolved';
  END IF;
END $$;
