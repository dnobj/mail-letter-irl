-- Migration 022: add the environment identity and durable admin command/audit foundation.
--
-- Migration 021_jit_commerce_foundation.sql is the required predecessor.
-- This migration is additive and intentionally does not create environment
-- roles. scripts/provisionAdminDatabaseAccess.ts grants narrowly scoped access
-- only after the environment-specific login roles already exist.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM migrations
    WHERE name = '021_jit_commerce_foundation.sql'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '022_admin_audit.sql requires 021_jit_commerce_foundation.sql';
  END IF;
END;
$$;

CREATE TABLE admin_environment_marker (
  environment VARCHAR(20) PRIMARY KEY,
  configured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  configured_by VARCHAR(255) NOT NULL,

  CONSTRAINT admin_environment_marker_environment_check
    CHECK (environment IN ('development', 'production')),
  CONSTRAINT admin_environment_marker_configured_by_check
    CHECK (char_length(configured_by) BETWEEN 1 AND 255)
);

-- A unique expression index permits one configured environment row while
-- leaving initial provisioning responsible for inserting that row.
CREATE UNIQUE INDEX admin_environment_marker_singleton
  ON admin_environment_marker ((TRUE));

CREATE TABLE admin_command_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key VARCHAR(255) NOT NULL,
  actor_sid VARCHAR(255) NOT NULL,
  environment VARCHAR(20) NOT NULL,
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(100) NOT NULL,
  target_id VARCHAR(255),
  preview_digest VARCHAR(64) NOT NULL,
  expected_version VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  correlation_id UUID NOT NULL,
  sanitized_result_json JSONB,
  error_code VARCHAR(100),

  CONSTRAINT admin_command_runs_environment_check
    CHECK (environment IN ('development', 'production')),
  CONSTRAINT admin_command_runs_idempotency_key_check
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  CONSTRAINT admin_command_runs_actor_sid_check
    CHECK (char_length(actor_sid) BETWEEN 1 AND 255),
  CONSTRAINT admin_command_runs_action_check
    CHECK (char_length(action) BETWEEN 1 AND 100),
  CONSTRAINT admin_command_runs_target_type_check
    CHECK (char_length(target_type) BETWEEN 1 AND 100),
  CONSTRAINT admin_command_runs_target_id_check
    CHECK (target_id IS NULL OR char_length(target_id) BETWEEN 1 AND 255),
  CONSTRAINT admin_command_runs_preview_digest_check
    CHECK (preview_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT admin_command_runs_status_check
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'rejected')),
  CONSTRAINT admin_command_runs_result_size_check
    CHECK (
      sanitized_result_json IS NULL OR
      octet_length(sanitized_result_json::text) <= 32768
    ),
  CONSTRAINT admin_command_runs_timing_check
    CHECK (
      (started_at IS NULL OR started_at >= requested_at) AND
      (completed_at IS NULL OR completed_at >= COALESCE(started_at, requested_at))
    ),
  CONSTRAINT admin_command_runs_completion_check
    CHECK (
      (status IN ('pending', 'running') AND completed_at IS NULL) OR
      (status IN ('succeeded', 'failed', 'rejected') AND completed_at IS NOT NULL)
    ),
  CONSTRAINT admin_command_runs_error_check
    CHECK (
      (status IN ('pending', 'running', 'succeeded') AND error_code IS NULL) OR
      (status IN ('failed', 'rejected') AND error_code IS NOT NULL)
    ),
  CONSTRAINT admin_command_runs_environment_idempotency_unique
    UNIQUE (environment, idempotency_key),
  CONSTRAINT admin_command_runs_id_environment_unique
    UNIQUE (id, environment)
);

CREATE TABLE admin_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id UUID NOT NULL,
  operation_type VARCHAR(100) NOT NULL,
  environment VARCHAR(20) NOT NULL,
  payload_json JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by VARCHAR(255),
  completed_at TIMESTAMPTZ,
  sanitized_result_json JSONB,
  error_code VARCHAR(100),

  CONSTRAINT admin_operations_command_unique UNIQUE (command_id),
  CONSTRAINT admin_operations_command_environment_fk
    FOREIGN KEY (command_id, environment)
    REFERENCES admin_command_runs(id, environment)
    ON DELETE RESTRICT,
  CONSTRAINT admin_operations_environment_check
    CHECK (environment IN ('development', 'production')),
  CONSTRAINT admin_operations_type_check
    CHECK (char_length(operation_type) BETWEEN 1 AND 100),
  CONSTRAINT admin_operations_status_check
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
  CONSTRAINT admin_operations_attempts_check
    CHECK (attempts BETWEEN 0 AND 100),
  CONSTRAINT admin_operations_payload_size_check
    CHECK (octet_length(payload_json::text) <= 65536),
  CONSTRAINT admin_operations_result_size_check
    CHECK (
      sanitized_result_json IS NULL OR
      octet_length(sanitized_result_json::text) <= 32768
    ),
  CONSTRAINT admin_operations_lock_check
    CHECK (
      (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL) OR
      status <> 'processing'
    ),
  CONSTRAINT admin_operations_completion_check
    CHECK (
      (status IN ('pending', 'processing') AND completed_at IS NULL) OR
      (status IN ('succeeded', 'failed') AND completed_at IS NOT NULL)
    ),
  CONSTRAINT admin_operations_error_check
    CHECK (
      (status IN ('pending', 'processing', 'succeeded') AND error_code IS NULL) OR
      (status = 'failed' AND error_code IS NOT NULL)
    )
);

CREATE TABLE admin_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_sid VARCHAR(255) NOT NULL,
  actor_name VARCHAR(255) NOT NULL,
  environment VARCHAR(20) NOT NULL,
  mode VARCHAR(20) NOT NULL,
  session_id_hash VARCHAR(64) NOT NULL,
  correlation_id UUID NOT NULL,
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(100) NOT NULL,
  target_id VARCHAR(255),
  reason VARCHAR(1000),
  input_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  before_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome VARCHAR(20) NOT NULL,
  error_code VARCHAR(100),
  command_id UUID,

  CONSTRAINT admin_audit_events_actor_sid_check
    CHECK (char_length(actor_sid) BETWEEN 1 AND 255),
  CONSTRAINT admin_audit_events_actor_name_check
    CHECK (char_length(actor_name) BETWEEN 1 AND 255),
  CONSTRAINT admin_audit_events_environment_check
    CHECK (environment IN ('development', 'production')),
  CONSTRAINT admin_audit_events_mode_check
    CHECK (mode IN ('read-only', 'full')),
  CONSTRAINT admin_audit_events_session_hash_check
    CHECK (session_id_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT admin_audit_events_action_check
    CHECK (char_length(action) BETWEEN 1 AND 100),
  CONSTRAINT admin_audit_events_target_type_check
    CHECK (char_length(target_type) BETWEEN 1 AND 100),
  CONSTRAINT admin_audit_events_target_id_check
    CHECK (target_id IS NULL OR char_length(target_id) BETWEEN 1 AND 255),
  CONSTRAINT admin_audit_events_reason_check
    CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 1000),
  CONSTRAINT admin_audit_events_input_size_check
    CHECK (octet_length(input_summary_json::text) <= 32768),
  CONSTRAINT admin_audit_events_before_size_check
    CHECK (octet_length(before_summary_json::text) <= 32768),
  CONSTRAINT admin_audit_events_after_size_check
    CHECK (octet_length(after_summary_json::text) <= 32768),
  CONSTRAINT admin_audit_events_outcome_check
    CHECK (outcome IN ('succeeded', 'failed', 'denied')),
  CONSTRAINT admin_audit_events_error_check
    CHECK (
      (outcome = 'succeeded' AND error_code IS NULL) OR
      (outcome IN ('failed', 'denied') AND error_code IS NOT NULL)
    ),
  CONSTRAINT admin_audit_events_command_environment_fk
    FOREIGN KEY (command_id, environment)
    REFERENCES admin_command_runs(id, environment)
    ON DELETE RESTRICT
);

CREATE INDEX admin_audit_events_actor_time_idx
  ON admin_audit_events (environment, actor_sid, occurred_at DESC);

CREATE INDEX admin_audit_events_target_time_idx
  ON admin_audit_events (environment, target_type, target_id, occurred_at DESC);

CREATE INDEX admin_audit_events_correlation_idx
  ON admin_audit_events (correlation_id);

CREATE INDEX admin_command_runs_status_idx
  ON admin_command_runs (environment, status, requested_at);

CREATE INDEX admin_command_runs_correlation_idx
  ON admin_command_runs (correlation_id);

CREATE INDEX admin_operations_claimable_idx
  ON admin_operations (environment, available_at, id)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION reject_admin_audit_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'admin_audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER admin_audit_events_append_only
  BEFORE UPDATE OR DELETE ON admin_audit_events
  FOR EACH ROW
  EXECUTE FUNCTION reject_admin_audit_event_mutation();

REVOKE ALL ON TABLE admin_environment_marker FROM PUBLIC;
REVOKE ALL ON TABLE admin_command_runs FROM PUBLIC;
REVOKE ALL ON TABLE admin_operations FROM PUBLIC;
REVOKE ALL ON TABLE admin_audit_events FROM PUBLIC;

COMMENT ON TABLE admin_environment_marker IS
  'Singleton environment identity set during explicit per-branch admin access provisioning.';
COMMENT ON TABLE admin_command_runs IS
  'Durable idempotent outcomes for typed local-admin commands.';
COMMENT ON TABLE admin_operations IS
  'Environment-local provider operations claimed by a deployed worker in a later delivery slice.';
COMMENT ON TABLE admin_audit_events IS
  'Append-only actor, action, target, and outcome history for local-admin access and commands.';
COMMENT ON FUNCTION reject_admin_audit_event_mutation() IS
  'Rejects UPDATE and DELETE so application paths cannot rewrite admin audit history.';
