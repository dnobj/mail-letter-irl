-- Migration: 056_held_mail_funding_reversed.sql
-- Purpose: an alert for mail held because the pack that paid for it was
-- refunded in full or lost to a dispute (#696, decision D2).
--
-- Such mail waits for the operator instead of printing: its job keeps a funding
-- hold_reason the outbox claim skips (src/services/heldMail.ts). One alert per
-- order says so, however many events (a dispute's create and its close, a refund
-- pending then succeeded) reach the hold: the unique index below.
--
-- commerce_operational_alerts is 023's; the legacy replay runs without it, so
-- the change is guarded, as 043's is.

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
      'held_mail_funding_reversed'
    ));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_alerts_held_mail_funding_order
      ON commerce_operational_alerts (order_id)
      WHERE alert_type = 'held_mail_funding_reversed';
  END IF;
END $$;
