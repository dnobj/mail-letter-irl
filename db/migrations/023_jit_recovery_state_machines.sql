-- Forward-only recovery state for issue #69.
--
-- Migration 021 is already applied in development and must not be rewritten.
-- Issue #162 owns 022_admin_audit.sql. This migration has no dependency on
-- 022 and is safe for the migration runner to apply before or after it.

-- ---------------------------------------------------------------------------
-- Crash-safe mail-provider dispatch and financial holds
-- ---------------------------------------------------------------------------

ALTER TABLE letters DROP CONSTRAINT IF EXISTS valid_letter_status;
ALTER TABLE letters ADD CONSTRAINT valid_letter_status CHECK (status IN (
  'draft', 'queued', 'processing', 'held', 'sent', 'accepted', 'in_transit',
  'delivered', 'returned', 'failed', 'cancelled'
));

ALTER TABLE letter_jobs
  DROP CONSTRAINT IF EXISTS valid_job_status,
  DROP CONSTRAINT IF EXISTS letter_jobs_status_check;
ALTER TABLE letter_jobs
  ADD COLUMN IF NOT EXISTS provider_outcome VARCHAR(24) NOT NULL DEFAULT 'not_dispatched',
  ADD COLUMN IF NOT EXISTS provider_dispatch_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hold_reason VARCHAR(100),
  ADD COLUMN IF NOT EXISTS operator_resolution VARCHAR(40),
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- A pre-023 processing lease may have crossed the provider boundary. Never
-- automatically reclaim it: quarantine it until an operator checks PostGrid.
UPDATE letter_jobs
SET status = 'held',
    provider_outcome = 'ambiguous',
    provider_dispatch_started_at = COALESCE(provider_dispatch_started_at, started_at, locked_at, created_at),
    held_at = NOW(),
    hold_reason = 'legacy_processing_outcome_unknown',
    locked_at = NULL,
    updated_at = NOW()
WHERE status = 'processing';

UPDATE letter_jobs
SET provider_outcome = CASE status
      WHEN 'completed' THEN 'accepted'
      WHEN 'failed' THEN 'definite_failure'
      ELSE 'not_dispatched'
    END,
    provider_dispatch_started_at = CASE
      WHEN status = 'completed' THEN COALESCE(provider_dispatch_started_at, started_at, created_at)
      ELSE provider_dispatch_started_at
    END
WHERE status <> 'held';

ALTER TABLE letter_jobs
  ADD CONSTRAINT valid_job_status CHECK (
    status IN ('pending', 'processing', 'held', 'completed', 'failed', 'cancelled')
  ),
  ADD CONSTRAINT valid_letter_job_provider_outcome CHECK (
    provider_outcome IN (
      'not_dispatched', 'dispatching', 'accepted', 'definite_failure', 'ambiguous'
    )
  ),
  ADD CONSTRAINT valid_letter_job_hold CHECK (
    (status = 'held' AND held_at IS NOT NULL AND hold_reason IS NOT NULL)
    OR status <> 'held'
  ),
  ADD CONSTRAINT valid_letter_job_outcome_state CHECK (
    (status = 'processing' AND provider_outcome IN ('not_dispatched', 'dispatching'))
    OR (status = 'held' AND provider_outcome IN ('ambiguous', 'accepted'))
    OR (status = 'completed' AND provider_outcome = 'accepted')
    OR (
      status IN ('pending', 'failed', 'cancelled')
      AND provider_outcome IN ('not_dispatched', 'definite_failure')
    )
  );

UPDATE letters
SET status = 'held', updated_at = NOW()
WHERE letter_id IN (SELECT letter_id FROM letter_jobs WHERE status = 'held')
  AND status IN ('queued', 'processing');

ALTER TABLE orders DROP CONSTRAINT IF EXISTS valid_order_status;
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS amount_known BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS hold_previous_status VARCHAR(30),
  ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hold_reason VARCHAR(100),
  ADD COLUMN IF NOT EXISTS stripe_dispute_status VARCHAR(30),
  ADD CONSTRAINT valid_order_status CHECK (status IN (
    'checkout_pending', 'paid', 'fulfillment_pending', 'fulfilled',
    'payment_failed', 'refund_pending', 'refunded', 'disputed', 'held',
    'cancelled'
  ));

-- Migration 021 had no evidence for some historical amounts and used one cent
-- only to satisfy the legacy NOT NULL/check constraint. Preserve the raw value
-- for audit, but explicitly exclude those indistinguishable placeholders from
-- revenue reporting.
UPDATE orders
SET amount_known = FALSE,
    product_snapshot = product_snapshot || '{"amountTreatment":"unknown_legacy"}'::jsonb
WHERE product_snapshot->>'migrated' = 'true' AND amount_cents = 1;

COMMENT ON COLUMN orders.amount_known IS
  'True only when amount_cents is supported by checkout/provider evidence; false legacy placeholders must not be counted as revenue.';

UPDATE orders
SET hold_previous_status = status,
    status = 'held',
    held_at = NOW(),
    hold_reason = 'legacy_processing_outcome_unknown',
    updated_at = NOW()
WHERE order_type = 'jit_mail'
  AND letter_id IN (SELECT letter_id FROM letter_jobs WHERE status = 'held')
  AND status = 'fulfillment_pending';

DROP INDEX IF EXISTS idx_orders_active_jit_draft_unique;
CREATE UNIQUE INDEX idx_orders_active_jit_draft_unique
  ON orders(draft_id)
  WHERE order_type = 'jit_mail'
    AND status IN (
      'checkout_pending', 'paid', 'fulfillment_pending', 'refund_pending',
      'disputed', 'held'
    );

DROP INDEX IF EXISTS idx_orders_active_jit_user;
CREATE INDEX idx_orders_active_jit_user
  ON orders(user_id, updated_at DESC)
  WHERE order_type = 'jit_mail'
    AND status IN (
      'checkout_pending', 'paid', 'fulfillment_pending', 'refund_pending',
      'disputed', 'held'
    );

CREATE INDEX IF NOT EXISTS idx_letter_jobs_held
  ON letter_jobs(held_at, created_at) WHERE status = 'held';

-- ---------------------------------------------------------------------------
-- Crash-safe image-generation reservations
-- ---------------------------------------------------------------------------

ALTER TABLE image_generation_reservations
  DROP CONSTRAINT IF EXISTS valid_image_reservation_status;

ALTER TABLE image_generation_reservations
  ADD COLUMN IF NOT EXISTS dispatch_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_request_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS resolution_reason VARCHAR(100),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- A legacy reserved row may have crashed either before or after provider
-- dispatch. Preserve the charged quota and surface it for review; releasing it
-- automatically could pay for a second generation after the first was billed.
UPDATE image_generation_reservations
SET status = 'ambiguous',
    dispatch_started_at = COALESCE(dispatch_started_at, created_at),
    completed_at = NULL,
    lease_expires_at = NULL,
    resolution_reason = COALESCE(resolution_reason, 'legacy_outcome_unknown'),
    updated_at = NOW()
WHERE status = 'reserved';

UPDATE image_generation_reservations
SET dispatch_started_at = COALESCE(dispatch_started_at, created_at),
    completed_at = COALESCE(completed_at, created_at),
    provider_completed_at = COALESCE(provider_completed_at, completed_at, created_at),
    lease_expires_at = NULL,
    resolution_reason = COALESCE(resolution_reason, 'provider_succeeded'),
    updated_at = NOW()
WHERE status = 'consumed';

UPDATE image_generation_reservations
SET completed_at = COALESCE(completed_at, created_at),
    lease_expires_at = NULL,
    resolution_reason = COALESCE(resolution_reason, 'definite_failure'),
    updated_at = NOW()
WHERE status = 'released';

ALTER TABLE image_generation_reservations
  ADD CONSTRAINT valid_image_reservation_status CHECK (
    status IN ('reserved', 'dispatched', 'consumed', 'released', 'ambiguous')
  ),
  ADD CONSTRAINT valid_image_reservation_dispatch CHECK (
    (
      status = 'reserved'
      AND dispatch_started_at IS NULL
      AND completed_at IS NULL
      AND lease_expires_at IS NOT NULL
      AND resolution_reason IS NULL
    )
    OR (
      status = 'dispatched'
      AND dispatch_started_at IS NOT NULL
      AND completed_at IS NULL
      AND lease_expires_at IS NOT NULL
      AND resolution_reason IS NULL
    )
    OR (
      status = 'consumed'
      AND dispatch_started_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND provider_completed_at IS NOT NULL
      AND lease_expires_at IS NULL
      AND resolution_reason IS NOT NULL
    )
    OR (
      status = 'released'
      AND completed_at IS NOT NULL
      AND lease_expires_at IS NULL
      AND resolution_reason IS NOT NULL
    )
    OR (
      status = 'ambiguous'
      AND dispatch_started_at IS NOT NULL
      AND completed_at IS NULL
      AND lease_expires_at IS NULL
      AND resolution_reason IS NOT NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_image_generation_reservations_provider_request
  ON image_generation_reservations(provider_request_id)
  WHERE provider_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_image_generation_reservations_recovery
  ON image_generation_reservations(status, lease_expires_at, created_at)
  WHERE status IN ('reserved', 'dispatched', 'ambiguous');

DROP TRIGGER IF EXISTS update_image_generation_reservations_updated_at
  ON image_generation_reservations;
CREATE TRIGGER update_image_generation_reservations_updated_at
  BEFORE UPDATE ON image_generation_reservations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE image_generation_reservations IS
  'Durable image budget state: reserved before dispatch, dispatched before provider I/O, consumed/released for definite outcomes, and ambiguous for manual reconciliation without automatic quota release.';

CREATE TABLE commerce_operator_audit_events (
  audit_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key_hash CHAR(64) NOT NULL UNIQUE,
  actor_subject_hash CHAR(64) NOT NULL,
  operation VARCHAR(60) NOT NULL,
  target_type VARCHAR(40) NOT NULL,
  target_reference_hash CHAR(64) NOT NULL,
  reason_code VARCHAR(80) NOT NULL,
  before_state JSONB NOT NULL,
  after_state JSONB NOT NULL,
  provider_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome VARCHAR(20) NOT NULL DEFAULT 'succeeded',
  retention_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '2 years'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_commerce_operator_audit_operation CHECK (
    operation IN (
      'image_reservation_resolve',
      'mail_fulfillment_resolve',
      'mail_job_retry',
      'commerce_alert_transition'
    )
  ),
  CONSTRAINT valid_commerce_operator_audit_target CHECK (
    target_type IN ('image_reservation', 'letter_job', 'commerce_alert')
  ),
  CONSTRAINT valid_commerce_operator_audit_hashes CHECK (
    idempotency_key_hash ~ '^[0-9a-f]{64}$'
    AND actor_subject_hash ~ '^[0-9a-f]{64}$'
    AND target_reference_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT valid_commerce_operator_audit_json CHECK (
    jsonb_typeof(before_state) = 'object'
    AND jsonb_typeof(after_state) = 'object'
    AND jsonb_typeof(provider_evidence) = 'object'
    AND octet_length(before_state::text) <= 8192
    AND octet_length(after_state::text) <= 8192
    AND octet_length(provider_evidence::text) <= 8192
  ),
  CONSTRAINT valid_commerce_operator_audit_outcome CHECK (
    outcome IN ('succeeded', 'rejected')
  )
);

CREATE OR REPLACE FUNCTION reject_commerce_operator_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'commerce_operator_audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER commerce_operator_audit_events_append_only
  BEFORE UPDATE OR DELETE ON commerce_operator_audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_commerce_operator_audit_mutation();

REVOKE ALL ON TABLE commerce_operator_audit_events FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_commerce_operator_audit_mutation() FROM PUBLIC;

CREATE INDEX idx_commerce_operator_audit_target
  ON commerce_operator_audit_events(target_type, target_reference_hash, created_at DESC);

CREATE INDEX idx_commerce_operator_audit_retention
  ON commerce_operator_audit_events(retention_expires_at, created_at);

COMMENT ON TABLE commerce_operator_audit_events IS
  'Append-only, privacy-minimized operator decisions committed atomically with domain transitions. It intentionally has no user or domain foreign keys so account deletion cannot be blocked. Identifiers are SHA-256 hashes; JSON contains state classifications only. Expired rows require an explicit, privileged retention migration because application roles cannot update or delete audit history.';

-- ---------------------------------------------------------------------------
-- Durable Stripe dispute monitoring
-- ---------------------------------------------------------------------------

ALTER TABLE stripe_webhook_events
  ADD COLUMN IF NOT EXISTS processing_status VARCHAR(20) NOT NULL DEFAULT 'processed',
  ADD COLUMN IF NOT EXISTS provider_payment_intent_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS provider_charge_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS metadata_order_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD CONSTRAINT valid_stripe_webhook_processing_status CHECK (
    processing_status IN ('processed', 'unmatched')
  );

CREATE INDEX idx_stripe_webhook_events_unmatched_money
  ON stripe_webhook_events(
    processing_status, provider_payment_intent_id, provider_charge_id, metadata_order_id
  )
  WHERE processing_status = 'unmatched';

CREATE TABLE commerce_operational_alerts (
  alert_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_event_id VARCHAR(255)
    REFERENCES stripe_webhook_events(event_id) ON DELETE RESTRICT,
  order_id VARCHAR(255) REFERENCES orders(order_id) ON DELETE SET NULL,
  alert_type VARCHAR(60) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by_actor_hash CHAR(64),
  resolved_at TIMESTAMPTZ,
  resolved_by_actor_hash CHAR(64),
  resolution_code VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_commerce_alert_type CHECK (
    alert_type IN (
      'stripe_dispute_created', 'stripe_dispute_closed',
      'mail_provider_outcome_ambiguous', 'refunded_mail_already_dispatched',
      'stripe_money_event_unmatched'
    )
  ),
  CONSTRAINT valid_commerce_alert_severity CHECK (
    severity IN ('info', 'warning', 'critical')
  ),
  CONSTRAINT valid_commerce_alert_status CHECK (
    status IN ('open', 'acknowledged', 'resolved')
  ),
  CONSTRAINT valid_commerce_alert_actor_hashes CHECK (
    (acknowledged_by_actor_hash IS NULL OR acknowledged_by_actor_hash ~ '^[0-9a-f]{64}$')
    AND (resolved_by_actor_hash IS NULL OR resolved_by_actor_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT valid_commerce_alert_resolution CHECK (
    (status = 'open' AND acknowledged_at IS NULL AND resolved_at IS NULL)
    OR (status = 'acknowledged' AND acknowledged_at IS NOT NULL AND resolved_at IS NULL)
    OR (status = 'resolved' AND resolved_at IS NOT NULL AND resolution_code IS NOT NULL)
  ),
  UNIQUE(source_event_id, alert_type)
);

CREATE INDEX idx_commerce_operational_alerts_open
  ON commerce_operational_alerts(status, severity, created_at)
  WHERE status <> 'resolved';

CREATE TRIGGER update_commerce_operational_alerts_updated_at
  BEFORE UPDATE ON commerce_operational_alerts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE commerce_operational_alerts IS
  'Durable, sanitized operational work created in the same transaction as its provider-event claim.';
