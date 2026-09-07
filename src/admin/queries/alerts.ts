import type { AdminSqlClient } from "../database.js";
import { decodeCursor, encodeCursor, toPage, type Page } from "./paging.js";

export interface AlertView {
  alertId: string;
  alertType: string;
  severity: string;
  status: string;
  orderId: string | null;
  sourceEventId: string | null;
  /** Serialized, bounded; alert details never carry PII by policy. */
  details: string;
  createdAt: Date;
  updatedAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  resolutionCode: string | null;
}

interface AlertRow {
  alert_id: string;
  alert_type: string;
  severity: string;
  status: string;
  order_id: string | null;
  source_event_id: string | null;
  details: unknown;
  created_at: Date;
  updated_at: Date;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
  resolution_code: string | null;
}

const ALERT_COLUMNS = `
  alert_id, alert_type, severity, status, order_id, source_event_id, details,
  created_at, updated_at, acknowledged_at, resolved_at, resolution_code
`;

export function serializeDetails(details: unknown, maxLength = 2000): string {
  let text: string;
  try {
    text = JSON.stringify(details ?? {}, null, 1);
  } catch {
    text = "{}";
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function toAlertView(row: AlertRow): AlertView {
  return {
    alertId: row.alert_id,
    alertType: row.alert_type,
    severity: row.severity,
    status: row.status,
    orderId: row.order_id,
    sourceEventId: row.source_event_id,
    details: serializeDetails(row.details),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
    resolutionCode: row.resolution_code,
  };
}

export type AlertFilter = "active" | "open" | "acknowledged" | "resolved" | "all";

export function parseAlertFilter(value: string | undefined): AlertFilter {
  switch (value) {
    case "open":
    case "acknowledged":
    case "resolved":
    case "all":
      return value;
    default:
      return "active";
  }
}

export async function listAlerts(
  client: AdminSqlClient,
  options: { filter: AlertFilter; limit: number; cursor?: string },
): Promise<Page<AlertView>> {
  const cursor = decodeCursor(options.cursor);
  const statusClause =
    options.filter === "active"
      ? `status IN ('open', 'acknowledged')`
      : options.filter === "all"
        ? "TRUE"
        : `status = $3`;
  const params: unknown[] = [options.limit + 1, cursor?.at ?? null];
  if (options.filter !== "active" && options.filter !== "all") {
    params.push(options.filter);
  }
  const cursorClause = cursor
    ? `AND (created_at, alert_id::text) < ($2::timestamptz, $${params.length + 1})`
    : "";
  if (cursor) params.push(cursor.id);
  const result = await client.query<AlertRow>(
    `SELECT ${ALERT_COLUMNS} FROM commerce_operational_alerts
     WHERE ${statusClause} ${cursorClause}
     ORDER BY created_at DESC, alert_id DESC
     LIMIT $1`,
    params,
  );
  return toPage(result.rows.map(toAlertView), options.limit, (row) =>
    encodeCursor(row.createdAt, row.alertId),
  );
}

export async function readAlert(
  client: AdminSqlClient,
  alertId: string,
): Promise<AlertView | null> {
  const result = await client.query<AlertRow>(
    `SELECT ${ALERT_COLUMNS} FROM commerce_operational_alerts WHERE alert_id = $1::uuid`,
    [alertId],
  );
  return result.rows[0] ? toAlertView(result.rows[0]) : null;
}

export interface AlertCounts {
  open: number;
  acknowledged: number;
  critical: number;
}

export async function countAlerts(client: AdminSqlClient): Promise<AlertCounts> {
  const result = await client.query<{ open: string; acknowledged: string; critical: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'open')::text AS open,
       COUNT(*) FILTER (WHERE status = 'acknowledged')::text AS acknowledged,
       COUNT(*) FILTER (WHERE status IN ('open', 'acknowledged') AND severity = 'critical')::text AS critical
     FROM commerce_operational_alerts`,
  );
  const row = result.rows[0];
  return {
    open: Number(row?.open ?? 0),
    acknowledged: Number(row?.acknowledged ?? 0),
    critical: Number(row?.critical ?? 0),
  };
}

export interface WebhookEventView {
  eventId: string;
  eventType: string;
  processingStatus: string;
  providerObjectId: string | null;
  providerPaymentIntentId: string | null;
  providerChargeId: string | null;
  metadataOrderId: string | null;
  orderId: string | null;
  receivedAt: Date;
  processedAt: Date;
  resolvedAt: Date | null;
}

const WEBHOOK_COLUMNS = `
  event_id, event_type, processing_status, provider_object_id, provider_payment_intent_id,
  provider_charge_id, metadata_order_id, order_id, received_at, processed_at, resolved_at
`;

interface WebhookRow {
  event_id: string;
  event_type: string;
  processing_status: string;
  provider_object_id: string | null;
  provider_payment_intent_id: string | null;
  provider_charge_id: string | null;
  metadata_order_id: string | null;
  order_id: string | null;
  received_at: Date;
  processed_at: Date;
  resolved_at: Date | null;
}

function toWebhookView(row: WebhookRow): WebhookEventView {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    processingStatus: row.processing_status,
    providerObjectId: row.provider_object_id,
    providerPaymentIntentId: row.provider_payment_intent_id,
    providerChargeId: row.provider_charge_id,
    metadataOrderId: row.metadata_order_id,
    orderId: row.order_id,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
    resolvedAt: row.resolved_at,
  };
}

export async function listUnmatchedWebhookEvents(
  client: AdminSqlClient,
  limit: number,
): Promise<WebhookEventView[]> {
  const result = await client.query<WebhookRow>(
    `SELECT ${WEBHOOK_COLUMNS} FROM stripe_webhook_events
     WHERE processing_status = 'unmatched' AND resolved_at IS NULL
     ORDER BY received_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map(toWebhookView);
}

export async function listRecentWebhookEvents(
  client: AdminSqlClient,
  limit: number,
): Promise<WebhookEventView[]> {
  const result = await client.query<WebhookRow>(
    `SELECT ${WEBHOOK_COLUMNS} FROM stripe_webhook_events
     ORDER BY received_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map(toWebhookView);
}

export async function listWebhookEventsForOrder(
  client: AdminSqlClient,
  orderId: string,
): Promise<WebhookEventView[]> {
  const result = await client.query<WebhookRow>(
    `SELECT ${WEBHOOK_COLUMNS} FROM stripe_webhook_events
     WHERE order_id = $1 OR metadata_order_id = $1
     ORDER BY received_at DESC LIMIT 50`,
    [orderId],
  );
  return result.rows.map(toWebhookView);
}

export async function listAlertsForOrder(
  client: AdminSqlClient,
  orderId: string,
): Promise<AlertView[]> {
  const result = await client.query<AlertRow>(
    `SELECT ${ALERT_COLUMNS} FROM commerce_operational_alerts
     WHERE order_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [orderId],
  );
  return result.rows.map(toAlertView);
}
