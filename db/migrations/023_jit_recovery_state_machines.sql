-- Forward-only recovery state for issue #69.
--
-- Migration 021 is already applied in development and must not be rewritten.
-- Issue #162 owns 022_admin_audit.sql. This migration has no dependency on
-- 022 and is safe for the migration runner to apply before or after it.

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

-- ---------------------------------------------------------------------------
-- Durable Stripe dispute monitoring
-- ---------------------------------------------------------------------------

CREATE TABLE commerce_operational_alerts (
  alert_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_event_id VARCHAR(255) NOT NULL
    REFERENCES stripe_webhook_events(event_id) ON DELETE RESTRICT,
  alert_type VARCHAR(60) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_commerce_alert_type CHECK (
    alert_type IN ('stripe_dispute_created', 'stripe_dispute_closed')
  ),
  CONSTRAINT valid_commerce_alert_severity CHECK (
    severity IN ('info', 'warning', 'critical')
  ),
  CONSTRAINT valid_commerce_alert_status CHECK (
    status IN ('open', 'acknowledged', 'resolved')
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
