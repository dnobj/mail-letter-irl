import { RETENTION_RESTORE_OPERATION } from "../../services/retentionService.js";
import type { AdminSqlClient } from "../database.js";

/** Read models for the retention, routing and support pages (slice 5). */

export interface QuarantineView {
  quarantineId: string;
  sourceTable: string;
  sourceId: string;
  /** The account the letter or draft belongs to; null when the row is gone. */
  userId: string | null;
  quarantinedAt: Date;
  purgeAfter: Date;
}

export interface RetentionCounts {
  lettersRedacted: number;
  draftsRedacted: number;
  quarantinedLetters: number;
  quarantinedDrafts: number;
  purgeDueNow: number;
}

export async function readRetentionCounts(client: AdminSqlClient): Promise<RetentionCounts> {
  const letters = await client.query<{ redacted: string }>(
    `SELECT COUNT(*) FILTER (WHERE redacted_at IS NOT NULL)::text AS redacted FROM letters`,
  );
  const drafts = await client.query<{ redacted: string }>(
    `SELECT COUNT(*) FILTER (WHERE redacted_at IS NOT NULL)::text AS redacted FROM letter_drafts`,
  );
  const quarantine = await client.query<{ letters: string; drafts: string; due: string }>(
    `SELECT COUNT(*) FILTER (WHERE source_table = 'letters')::text AS letters,
            COUNT(*) FILTER (WHERE source_table = 'letter_drafts')::text AS drafts,
            COUNT(*) FILTER (WHERE purge_after <= NOW())::text AS due
     FROM redacted_content_quarantine`,
  );
  return {
    lettersRedacted: Number(letters.rows[0]?.redacted ?? 0),
    draftsRedacted: Number(drafts.rows[0]?.redacted ?? 0),
    quarantinedLetters: Number(quarantine.rows[0]?.letters ?? 0),
    quarantinedDrafts: Number(quarantine.rows[0]?.drafts ?? 0),
    purgeDueNow: Number(quarantine.rows[0]?.due ?? 0),
  };
}

/**
 * Metadata only: the quarantined content column is not selectable by the
 * reader. Newest first; with a search, only the copies of that letter or
 * draft, or of every letter and draft on that account, so a copy older than
 * the newest page can still be found and restored (#450 review).
 */
export async function listQuarantine(
  client: AdminSqlClient,
  limit: number,
  search: string | null = null,
): Promise<QuarantineView[]> {
  const result = await client.query<{
    quarantine_id: string;
    source_table: string;
    source_id: string;
    user_id: string | null;
    quarantined_at: Date;
    purge_after: Date;
  }>(
    `SELECT q.quarantine_id, q.source_table, q.source_id, COALESCE(l.user_id, d.user_id) AS user_id,
            q.quarantined_at, q.purge_after
     FROM redacted_content_quarantine q
     LEFT JOIN letters l ON q.source_table = 'letters' AND l.letter_id = q.source_id
     LEFT JOIN letter_drafts d ON q.source_table = 'letter_drafts' AND d.draft_id::text = q.source_id
     WHERE $2::varchar IS NULL
        OR q.source_id = $2::varchar
        OR l.user_id = $2::varchar
        OR d.user_id = $2::varchar
     ORDER BY q.quarantined_at DESC LIMIT $1::int`,
    [limit, search],
  );
  return result.rows.map((row) => ({
    quarantineId: row.quarantine_id,
    sourceTable: row.source_table,
    sourceId: row.source_id,
    userId: row.user_id,
    quarantinedAt: row.quarantined_at,
    purgeAfter: row.purge_after,
  }));
}

export interface RestoreOperationView {
  operationId: string;
  status: string;
  sourceTable: string | null;
  sourceId: string | null;
  requestedAt: Date;
  completedAt: Date | null;
  errorCode: string | null;
  result: Record<string, unknown> | null;
}

/**
 * The newest restores the panel queued, with how each ended: the only place a
 * restore's outcome shows, since a copy that went back leaves the quarantine
 * (#450 review). Codes, reasons and counts only.
 */
export async function listRecentRestores(client: AdminSqlClient, limit: number): Promise<RestoreOperationView[]> {
  const result = await client.query<{
    id: string;
    status: string;
    source_table: string | null;
    source_id: string | null;
    requested_at: Date;
    completed_at: Date | null;
    error_code: string | null;
    sanitized_result_json: Record<string, unknown> | null;
  }>(
    `SELECT o.id, o.status, o.payload_json->>'sourceTable' AS source_table,
            o.payload_json->>'sourceId' AS source_id, r.requested_at, o.completed_at,
            o.error_code, o.sanitized_result_json
     FROM admin_operations o
     JOIN admin_command_runs r ON r.id = o.command_id
     WHERE o.operation_type = $1::varchar
     ORDER BY r.requested_at DESC, o.id DESC LIMIT $2::int`,
    [RETENTION_RESTORE_OPERATION, limit],
  );
  return result.rows.map((row) => ({
    operationId: String(row.id),
    status: row.status,
    sourceTable: row.source_table,
    sourceId: row.source_id,
    requestedAt: row.requested_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    result: row.sanitized_result_json,
  }));
}

export interface RoutingRow {
  id: number;
  mailType: string;
  provider: string;
  enabled: boolean;
  updatedAt: Date;
  updatedBy: string | null;
}

export async function listRouting(client: AdminSqlClient): Promise<RoutingRow[]> {
  const result = await client.query<{
    id: number;
    mail_type: string;
    provider: string;
    enabled: boolean;
    updated_at: Date;
    updated_by: string | null;
  }>(`SELECT id, mail_type, provider, enabled, updated_at, updated_by FROM provider_routing ORDER BY mail_type`);
  return result.rows.map((row) => ({
    id: row.id,
    mailType: row.mail_type,
    provider: row.provider,
    enabled: row.enabled,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }));
}

export async function readRoutingRow(client: AdminSqlClient, mailType: string): Promise<RoutingRow | null> {
  const rows = await listRouting(client);
  return rows.find((row) => row.mailType === mailType) ?? null;
}

export interface StuckLetterView {
  letterId: string;
  status: string;
  createdAt: Date;
  daysInStatus: number;
}

/** Letters with a provider reference that have not reached a terminal status. */
export async function listStuckLetters(client: AdminSqlClient, days: number, limit: number): Promise<StuckLetterView[]> {
  const result = await client.query<{ letter_id: string; status: string; created_at: Date; days: number }>(
    `SELECT letter_id, status, created_at,
            EXTRACT(DAY FROM NOW() - created_at)::int AS days
     FROM letters
     WHERE status NOT IN ('delivered', 'returned', 'failed', 'cancelled')
       AND tracking_id IS NOT NULL
       AND created_at < NOW() - make_interval(days => $1::int)
     ORDER BY created_at ASC LIMIT $2`,
    [days, limit],
  );
  return result.rows.map((row) => ({
    letterId: row.letter_id,
    status: row.status,
    createdAt: row.created_at,
    daysInStatus: Number(row.days),
  }));
}

export interface FeatureRequestView {
  requestId: string;
  userId: string;
  title: string;
  description: string;
  category: string;
  attemptedAction: string | null;
  status: string;
  adminNotes: string | null;
  contactConsent: boolean;
  createdAt: Date;
  reviewedAt: Date | null;
  resolvedAt: Date | null;
}

export async function listFeatureRequests(client: AdminSqlClient, limit: number): Promise<FeatureRequestView[]> {
  const result = await client.query<{
    request_id: string;
    user_id: string;
    title: string;
    description: string;
    category: string;
    attempted_action: string | null;
    status: string;
    admin_notes: string | null;
    contact_consent: boolean;
    created_at: Date;
    reviewed_at: Date | null;
    resolved_at: Date | null;
  }>(
    `SELECT request_id, user_id, title, description, category::text AS category, attempted_action,
            status::text AS status, admin_notes, contact_consent, created_at, reviewed_at, resolved_at
     FROM feature_requests ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    requestId: row.request_id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    category: row.category,
    attemptedAction: row.attempted_action,
    status: row.status,
    adminNotes: row.admin_notes,
    contactConsent: row.contact_consent,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    resolvedAt: row.resolved_at,
  }));
}

export interface TokenStatsView {
  total: number;
  active: number;
  revoked: number;
  usedToday: number;
  usedLast7Days: number;
}

/** Counts only, the same as the legacy stats route; hashes are never read. */
export async function readTokenStats(client: AdminSqlClient): Promise<TokenStatsView> {
  const result = await client.query<{ total: string; active: string; revoked: string; used_today: string; used_7d: string }>(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE status = 'active')::text AS active,
            COUNT(*) FILTER (WHERE status = 'revoked')::text AS revoked,
            COUNT(*) FILTER (WHERE status = 'active' AND last_used_at >= NOW() - INTERVAL '1 day')::text AS used_today,
            COUNT(*) FILTER (WHERE status = 'active' AND last_used_at >= NOW() - INTERVAL '7 days')::text AS used_7d
     FROM personal_access_tokens`,
  );
  const row = result.rows[0];
  return {
    total: Number(row?.total ?? 0),
    active: Number(row?.active ?? 0),
    revoked: Number(row?.revoked ?? 0),
    usedToday: Number(row?.used_today ?? 0),
    usedLast7Days: Number(row?.used_7d ?? 0),
  };
}
