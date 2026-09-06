-- 029: proportional refunds of letter packs (#323).
--
-- One row per operator-issued proportional refund. The letters leave the
-- account in the transaction that inserts the row; the Stripe refund is created
-- afterwards under an idempotency key derived from pack_refund_id; the webhook
-- confirms the row it finds in Stripe metadata. The row is the durable record
-- that lets a crash between those steps be finished rather than repeated.
--
-- orders.credits_refunded and orders.amount_refunded_cents let the full-refund
-- path decrement credits_purchased by what is left, and let the webhook tell a
-- Dashboard "refund the remainder" apart from an unmatched partial.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS credits_refunded INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_refunded_cents INTEGER NOT NULL DEFAULT 0;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS valid_order_credits_refunded,
  DROP CONSTRAINT IF EXISTS valid_order_amount_refunded;
ALTER TABLE orders
  ADD CONSTRAINT valid_order_credits_refunded CHECK (
    credits_refunded >= 0 AND (credits IS NULL OR credits_refunded <= credits)
  ),
  ADD CONSTRAINT valid_order_amount_refunded CHECK (
    amount_refunded_cents >= 0 AND amount_refunded_cents <= amount_cents
  );

COMMENT ON COLUMN orders.credits_refunded IS
  'Credits already returned to the customer as cash through proportional refunds. A full refund decrements credits_purchased by credits - credits_refunded, never by the whole pack twice.';
COMMENT ON COLUMN orders.amount_refunded_cents IS
  'Minor units confirmed refunded by Stripe (proportional refunds that succeeded, or the full amount). Updated only on a Stripe-confirmed transition.';

CREATE TABLE IF NOT EXISTS commerce_pack_refunds (
  pack_refund_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id VARCHAR(255) NOT NULL REFERENCES orders(order_id) ON DELETE RESTRICT,
  user_id VARCHAR(255) NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  environment VARCHAR(20) NOT NULL,
  letters INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'letters_revoked',
  stripe_payment_intent_id VARCHAR(255) NOT NULL,
  stripe_refund_id VARCHAR(255),
  stripe_idempotency_key VARCHAR(255) NOT NULL,
  stripe_attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code VARCHAR(100),
  failure_reason VARCHAR(80),
  reason_code VARCHAR(80) NOT NULL,
  actor_subject_hash CHAR(64) NOT NULL,
  idempotency_key_hash CHAR(64) NOT NULL,
  admin_command_id UUID,
  compensation_ledger_id UUID REFERENCES credit_ledger(ledger_id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_pack_refund_environment CHECK (environment IN ('development', 'production')),
  CONSTRAINT valid_pack_refund_counts CHECK (letters > 0 AND credits > 0 AND amount_cents > 0),
  CONSTRAINT valid_pack_refund_status CHECK (
    status IN ('letters_revoked', 'stripe_pending', 'succeeded', 'failed', 'compensated')
  ),
  CONSTRAINT valid_pack_refund_settlement CHECK (
    (status = 'letters_revoked' AND settled_at IS NULL AND failed_at IS NULL)
    OR (status = 'stripe_pending' AND stripe_refund_id IS NOT NULL AND settled_at IS NULL AND failed_at IS NULL)
    OR (status = 'succeeded' AND stripe_refund_id IS NOT NULL AND settled_at IS NOT NULL AND failed_at IS NULL)
    OR (status IN ('failed', 'compensated') AND failed_at IS NOT NULL AND last_error_code IS NOT NULL)
  ),
  CONSTRAINT valid_pack_refund_compensation CHECK (
    (status = 'compensated' AND compensation_ledger_id IS NOT NULL) OR status <> 'compensated'
  ),
  CONSTRAINT valid_pack_refund_hashes CHECK (
    actor_subject_hash ~ '^[0-9a-f]{64}$' AND idempotency_key_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT valid_pack_refund_reason CHECK (reason_code ~ '^[a-z][a-z0-9_]{2,79}$')
);

-- One proportional refund per pack (owner's rule). A failed/compensated attempt
-- releases the slot so a corrected command can be issued.
CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_pack_refunds_live_per_order
  ON commerce_pack_refunds(order_id)
  WHERE status IN ('letters_revoked', 'stripe_pending', 'succeeded');

-- A Stripe refund can settle exactly one command.
CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_pack_refunds_stripe_refund
  ON commerce_pack_refunds(stripe_refund_id)
  WHERE stripe_refund_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_pack_refunds_idempotency
  ON commerce_pack_refunds(stripe_idempotency_key);

CREATE INDEX IF NOT EXISTS idx_commerce_pack_refunds_sweep
  ON commerce_pack_refunds(status, updated_at)
  WHERE status IN ('letters_revoked', 'stripe_pending');

DROP TRIGGER IF EXISTS update_commerce_pack_refunds_updated_at ON commerce_pack_refunds;
CREATE TRIGGER update_commerce_pack_refunds_updated_at
  BEFORE UPDATE ON commerce_pack_refunds
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- admin_command_id is a soft link to the admin foundation's command ledger
-- (022). It is deliberately NOT a foreign key: a guarded FK would exist only
-- when 022 had already been applied, and the legacy-scenario suites prove
-- that migration order must not change the resulting schema. The admin
-- command runner writes both rows in one transaction, which is the integrity
-- that matters.
COMMENT ON COLUMN commerce_pack_refunds.admin_command_id IS
  'Soft link to admin_command_runs.id (022) when the command ran through the admin foundation; not a foreign key so that migration order cannot change the schema.';

-- The operator audit vocabulary from 023, restated with the new operation and
-- target. Guarded for the same staging reason as above.
DO $$
BEGIN
  IF to_regclass('commerce_operator_audit_events') IS NOT NULL THEN
    ALTER TABLE commerce_operator_audit_events
      DROP CONSTRAINT IF EXISTS valid_commerce_operator_audit_operation;
    ALTER TABLE commerce_operator_audit_events
      ADD CONSTRAINT valid_commerce_operator_audit_operation CHECK (
        operation IN (
          'image_reservation_resolve',
          'mail_fulfillment_resolve',
          'mail_job_retry',
          'commerce_alert_transition',
          'pack_refund'
        )
      );
    ALTER TABLE commerce_operator_audit_events
      DROP CONSTRAINT IF EXISTS valid_commerce_operator_audit_target;
    ALTER TABLE commerce_operator_audit_events
      ADD CONSTRAINT valid_commerce_operator_audit_target CHECK (
        target_type IN ('image_reservation', 'letter_job', 'commerce_alert', 'order')
      );
  END IF;
END $$;

COMMENT ON TABLE commerce_pack_refunds IS
  'Operator-issued proportional refunds of letter packs. Letters are revoked in the transaction that inserts the row; the Stripe refund is created afterwards under the stored idempotency key and confirmed by webhook metadata.';
