import type { AdminSqlClient } from "../database.js";
import { serializeDetails } from "./alerts.js";
import { decodeCursor, encodeCursor, toPage, type Page } from "./paging.js";

export interface AuditEventView {
  id: string;
  occurredAt: Date;
  actorId: string;
  actorName: string;
  environment: string;
  mode: string;
  correlationId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  reason: string | null;
  inputSummary: string;
  beforeSummary: string;
  afterSummary: string;
  outcome: string;
  errorCode: string | null;
  commandId: string | null;
}

interface AuditRow {
  id: string;
  occurred_at: Date;
  actor_sid: string;
  actor_name: string;
  environment: string;
  mode: string;
  correlation_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  reason: string | null;
  input_summary_json: unknown;
  before_summary_json: unknown;
  after_summary_json: unknown;
  outcome: string;
  error_code: string | null;
  command_id: string | null;
}

const AUDIT_COLUMNS = `
  id, occurred_at, actor_sid, actor_name, environment, mode, correlation_id, action,
  target_type, target_id, reason, input_summary_json, before_summary_json,
  after_summary_json, outcome, error_code, command_id
`;

function toAuditView(row: AuditRow): AuditEventView {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actorId: row.actor_sid,
    actorName: row.actor_name,
    environment: row.environment,
    mode: row.mode,
    correlationId: row.correlation_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    reason: row.reason,
    inputSummary: serializeDetails(row.input_summary_json, 1000),
    beforeSummary: serializeDetails(row.before_summary_json, 1000),
    afterSummary: serializeDetails(row.after_summary_json, 1000),
    outcome: row.outcome,
    errorCode: row.error_code,
    commandId: row.command_id,
  };
}

export async function listAuditEvents(
  client: AdminSqlClient,
  options: { limit: number; cursor?: string; targetId?: string; outcome?: string; action?: string },
): Promise<Page<AuditEventView>> {
  const cursor = decodeCursor(options.cursor);
  const params: unknown[] = [options.limit + 1];
  const clauses: string[] = ["TRUE"];
  if (options.targetId) {
    params.push(options.targetId);
    clauses.push(`target_id = $${params.length}`);
  }
  if (options.action) {
    params.push(options.action);
    clauses.push(`action = $${params.length}`);
  }
  if (options.outcome === "denied" || options.outcome === "failed") {
    params.push(options.outcome);
    clauses.push(`outcome = $${params.length}`);
  }
  if (cursor) {
    params.push(cursor.at, cursor.id);
    clauses.push(
      `(occurred_at, id::text) < ($${params.length - 1}::timestamptz, $${params.length})`,
    );
  }
  const result = await client.query<AuditRow>(
    `SELECT ${AUDIT_COLUMNS} FROM admin_audit_events
     WHERE ${clauses.join(" AND ")}
     ORDER BY occurred_at DESC, id DESC LIMIT $1`,
    params,
  );
  return toPage(result.rows.map(toAuditView), options.limit, (row) =>
    encodeCursor(row.occurredAt, row.id),
  );
}

export interface CommandRunView {
  id: string;
  idempotencyKey: string;
  actorId: string;
  environment: string;
  action: string;
  targetType: string;
  targetId: string | null;
  previewDigest: string;
  expectedVersion: string | null;
  status: string;
  requestedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  correlationId: string;
  sanitizedResult: string;
  errorCode: string | null;
}

interface CommandRow {
  id: string;
  idempotency_key: string;
  actor_sid: string;
  environment: string;
  action: string;
  target_type: string;
  target_id: string | null;
  preview_digest: string;
  expected_version: string | null;
  status: string;
  requested_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  correlation_id: string;
  sanitized_result_json: unknown;
  error_code: string | null;
}

const COMMAND_COLUMNS = `
  id, idempotency_key, actor_sid, environment, action, target_type, target_id, preview_digest,
  expected_version, status, requested_at, started_at, completed_at, correlation_id,
  sanitized_result_json, error_code
`;

function toCommandView(row: CommandRow): CommandRunView {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    actorId: row.actor_sid,
    environment: row.environment,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    previewDigest: row.preview_digest,
    expectedVersion: row.expected_version,
    status: row.status,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    correlationId: row.correlation_id,
    sanitizedResult: serializeDetails(row.sanitized_result_json, 4000),
    errorCode: row.error_code,
  };
}

export async function listCommandRuns(
  client: AdminSqlClient,
  options: { limit: number; cursor?: string; targetId?: string },
): Promise<Page<CommandRunView>> {
  const cursor = decodeCursor(options.cursor);
  const params: unknown[] = [options.limit + 1];
  const clauses: string[] = ["TRUE"];
  if (options.targetId) {
    params.push(options.targetId);
    clauses.push(`target_id = $${params.length}`);
  }
  if (cursor) {
    params.push(cursor.at, cursor.id);
    clauses.push(
      `(requested_at, id::text) < ($${params.length - 1}::timestamptz, $${params.length})`,
    );
  }
  const result = await client.query<CommandRow>(
    `SELECT ${COMMAND_COLUMNS} FROM admin_command_runs
     WHERE ${clauses.join(" AND ")}
     ORDER BY requested_at DESC, id DESC LIMIT $1`,
    params,
  );
  return toPage(result.rows.map(toCommandView), options.limit, (row) =>
    encodeCursor(row.requestedAt, row.id),
  );
}

export async function readCommandRun(
  client: AdminSqlClient,
  id: string,
): Promise<{ command: CommandRunView; events: AuditEventView[] } | null> {
  const result = await client.query<CommandRow>(
    `SELECT ${COMMAND_COLUMNS} FROM admin_command_runs WHERE id = $1::uuid`,
    [id],
  );
  if (!result.rows[0]) return null;
  const events = await client.query<AuditRow>(
    `SELECT ${AUDIT_COLUMNS} FROM admin_audit_events WHERE command_id = $1::uuid
     ORDER BY occurred_at DESC LIMIT 50`,
    [id],
  );
  return {
    command: toCommandView(result.rows[0]),
    events: events.rows.map(toAuditView),
  };
}

export interface OperatorAuditView {
  auditEventId: string;
  operation: string;
  targetType: string;
  reasonCode: string;
  outcome: string;
  beforeState: string;
  afterState: string;
  createdAt: Date;
}

/** The domain's own hashed audit: hashes are not shown, only what happened. */
export async function listOperatorAuditEvents(
  client: AdminSqlClient,
  limit: number,
): Promise<OperatorAuditView[]> {
  const result = await client.query<{
    audit_event_id: string;
    operation: string;
    target_type: string;
    reason_code: string;
    outcome: string;
    before_state: unknown;
    after_state: unknown;
    created_at: Date;
  }>(
    `SELECT audit_event_id, operation, target_type, reason_code, outcome, before_state, after_state, created_at
     FROM commerce_operator_audit_events ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    auditEventId: row.audit_event_id,
    operation: row.operation,
    targetType: row.target_type,
    reasonCode: row.reason_code,
    outcome: row.outcome,
    beforeState: serializeDetails(row.before_state, 600),
    afterState: serializeDetails(row.after_state, 600),
    createdAt: row.created_at,
  }));
}
