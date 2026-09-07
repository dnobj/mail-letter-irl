import type { AdminSqlClient } from "../database.js";
import { countAlerts, type AlertCounts } from "./alerts.js";
import { readOutboxBacklog, type OutboxBacklog } from "./jobs.js";

export interface MaintenanceTaskView {
  taskName: string;
  lastStartedAt: Date | null;
  lastCompletedAt: Date | null;
  lockedAt: Date | null;
  lastStatus: string | null;
  lastErrorPresent: boolean;
  updatedAt: Date;
}

export interface MaintenanceHealth {
  tasks: MaintenanceTaskView[];
  outbox: OutboxBacklog;
  alerts: AlertCounts;
  stuckOrders: number;
  quarantinedOrders: number;
  unmatchedWebhookEvents: number;
  lastWebhookReceivedAt: Date | null;
  packRefundsInFlight: number;
  pendingAdminOperations: number;
  latestMigration: string | null;
  marker: string | null;
  accounts: number;
  blockedAccounts: number;
}

export async function readMaintenanceHealth(
  client: AdminSqlClient,
): Promise<MaintenanceHealth> {
  const tasks = await client.query<{
    task_name: string;
    last_started_at: Date | null;
    last_completed_at: Date | null;
    locked_at: Date | null;
    last_status: string | null;
    has_error: boolean;
    updated_at: Date;
  }>(
    `SELECT task_name, last_started_at, last_completed_at, locked_at, last_status,
            (last_error IS NOT NULL) AS has_error, updated_at
     FROM maintenance_tasks ORDER BY task_name`,
  );
  // The same predicate the hourly maintenance logs commerce.stuck_orders_detected on.
  const stuck = await client.query<{ stuck: string; quarantined: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('paid', 'fulfillment_pending', 'refund_pending')
                          AND updated_at < NOW() - INTERVAL '30 minutes')::text AS stuck,
       COUNT(*) FILTER (WHERE last_error_code = 'PAYMENT_AMOUNT_MISMATCH')::text AS quarantined
     FROM orders`,
  );
  const webhooks = await client.query<{ unmatched: string; last_received: Date | null }>(
    `SELECT COUNT(*) FILTER (WHERE processing_status = 'unmatched' AND resolved_at IS NULL)::text AS unmatched,
            MAX(received_at) AS last_received
     FROM stripe_webhook_events`,
  );
  const refunds = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM commerce_pack_refunds
     WHERE status IN ('letters_revoked', 'stripe_pending')`,
  );
  const operations = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM admin_operations WHERE status IN ('pending', 'processing')`,
  );
  const migration = await client.query<{ name: string }>(
    `SELECT name FROM migrations ORDER BY name DESC LIMIT 1`,
  );
  const marker = await client.query<{ environment: string }>(
    `SELECT environment FROM admin_environment_marker LIMIT 1`,
  );
  const accounts = await client.query<{ total: string; blocked: string }>(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE sends_blocked_at IS NOT NULL)::text AS blocked
     FROM users`,
  );

  return {
    tasks: tasks.rows.map((row) => ({
      taskName: row.task_name,
      lastStartedAt: row.last_started_at,
      lastCompletedAt: row.last_completed_at,
      lockedAt: row.locked_at,
      lastStatus: row.last_status,
      lastErrorPresent: row.has_error,
      updatedAt: row.updated_at,
    })),
    outbox: await readOutboxBacklog(client),
    alerts: await countAlerts(client),
    stuckOrders: Number(stuck.rows[0]?.stuck ?? 0),
    quarantinedOrders: Number(stuck.rows[0]?.quarantined ?? 0),
    unmatchedWebhookEvents: Number(webhooks.rows[0]?.unmatched ?? 0),
    lastWebhookReceivedAt: webhooks.rows[0]?.last_received ?? null,
    packRefundsInFlight: Number(refunds.rows[0]?.count ?? 0),
    pendingAdminOperations: Number(operations.rows[0]?.count ?? 0),
    latestMigration: migration.rows[0]?.name ?? null,
    marker: marker.rows[0]?.environment ?? null,
    accounts: Number(accounts.rows[0]?.total ?? 0),
    blockedAccounts: Number(accounts.rows[0]?.blocked ?? 0),
  };
}
