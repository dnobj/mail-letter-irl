-- 028: an unmatched partial refund is operator work, not a quiet order event.
--
-- Until now processRefundEvent recorded a refund for less than the order amount
-- as `ignored: true, reason: 'partial_refund'` on commerce_order_events and
-- returned. The customer kept both the money and the letters, and nothing
-- reached an operator (#323). Proportional refunds issued by the app carry the
-- command id in Stripe metadata and are confirmed by it; anything else that
-- moves part of the money must land in the alert queue.
--
-- Extends the allow-list from 023/024 the same way 024 did: the full list has
-- to be restated because CHECK constraints cannot be amended in place, and the
-- block is guarded on the table existing because the legacy-scenario
-- integration tests deliberately stage a subset of migrations.

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
          'pack_refund_failed'
        )
      );
  END IF;
END $$;
