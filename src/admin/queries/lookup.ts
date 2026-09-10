import type { AdminSqlClient } from "../database.js";

/**
 * Exact-match lookup across the identifiers an operator holds: an Auth0
 * subject, an email, an order, letter or job id, a Stripe payment intent,
 * checkout session, refund, charge, dispute or event id, an alert id, a pack
 * refund id, or an admin command id. No `%term%` scans on any table.
 */

export type LookupKind =
  | "account"
  | "order"
  | "letter"
  | "job"
  | "alert"
  | "dispute"
  | "pack_refund"
  | "webhook_event"
  | "command";

export interface LookupMatch {
  kind: LookupKind;
  id: string;
  label: string;
  href: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{3,4}-[0-9a-f]{12}$/i;

export function normalizeLookupTerm(raw: string | undefined): string | null {
  const term = (raw ?? "").trim();
  if (term.length === 0 || term.length > 255) return null;
  // Whitespace and control characters never appear in an identifier.
  if (Array.from(term).some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) {
    return null;
  }
  return term;
}

export async function lookupIdentifier(
  client: AdminSqlClient,
  term: string,
): Promise<LookupMatch[]> {
  const matches: LookupMatch[] = [];
  const isUuid = UUID_PATTERN.test(term);

  const users = await client.query<{ user_id: string }>(
    `SELECT user_id FROM users WHERE user_id = $1 OR lower(email) = lower($1) LIMIT 5`,
    [term],
  );
  for (const row of users.rows) {
    matches.push({
      kind: "account",
      id: row.user_id,
      label: `Account ${row.user_id}`,
      href: `/accounts/${encodeURIComponent(row.user_id)}`,
    });
  }

  const orders = await client.query<{ order_id: string; status: string; order_type: string }>(
    `SELECT order_id, status, order_type FROM orders
     WHERE order_id = $1
        OR stripe_payment_intent_id = $1
        OR stripe_checkout_session_id = $1
        OR stripe_refund_id = $1
     LIMIT 5`,
    [term],
  );
  for (const row of orders.rows) {
    matches.push({
      kind: "order",
      id: row.order_id,
      label: `Order ${row.order_id} (${row.order_type}, ${row.status})`,
      href: `/orders/${encodeURIComponent(row.order_id)}`,
    });
  }

  const letters = await client.query<{ letter_id: string; status: string }>(
    `SELECT letter_id, status FROM letters WHERE letter_id = $1 OR tracking_id = $1 LIMIT 5`,
    [term],
  );
  for (const row of letters.rows) {
    matches.push({
      kind: "letter",
      id: row.letter_id,
      label: `Letter ${row.letter_id} (${row.status})`,
      href: `/letters/${encodeURIComponent(row.letter_id)}`,
    });
  }

  const jobs = await client.query<{ job_id: string; status: string }>(
    `SELECT job_id, status FROM letter_jobs
     WHERE job_id = $1 OR provider_order_id = $1 OR idempotency_key = $1
     LIMIT 5`,
    [term],
  );
  for (const row of jobs.rows) {
    matches.push({
      kind: "job",
      id: row.job_id,
      label: `Job ${row.job_id} (${row.status})`,
      href: `/jobs/${encodeURIComponent(row.job_id)}`,
    });
  }

  if (isUuid) {
    const alerts = await client.query<{ alert_id: string; alert_type: string; status: string }>(
      `SELECT alert_id, alert_type, status FROM commerce_operational_alerts WHERE alert_id = $1::uuid`,
      [term],
    );
    for (const row of alerts.rows) {
      matches.push({
        kind: "alert",
        id: row.alert_id,
        label: `Alert ${row.alert_type} (${row.status})`,
        href: `/alerts/${encodeURIComponent(row.alert_id)}`,
      });
    }
    const refunds = await client.query<{ pack_refund_id: string; order_id: string; status: string }>(
      `SELECT pack_refund_id, order_id, status FROM commerce_pack_refunds WHERE pack_refund_id = $1::uuid`,
      [term],
    );
    for (const row of refunds.rows) {
      matches.push({
        kind: "pack_refund",
        id: row.pack_refund_id,
        label: `Pack refund on order ${row.order_id} (${row.status})`,
        href: `/orders/${encodeURIComponent(row.order_id)}`,
      });
    }
    const commands = await client.query<{ id: string; action: string; status: string }>(
      `SELECT id, action, status FROM admin_command_runs WHERE id = $1::uuid OR correlation_id = $1::uuid LIMIT 5`,
      [term],
    );
    for (const row of commands.rows) {
      matches.push({
        kind: "command",
        id: row.id,
        label: `Command ${row.action} (${row.status})`,
        href: `/commands/${encodeURIComponent(row.id)}`,
      });
    }
  } else {
    const refunds = await client.query<{ pack_refund_id: string; order_id: string; status: string }>(
      `SELECT pack_refund_id, order_id, status FROM commerce_pack_refunds WHERE stripe_refund_id = $1 LIMIT 5`,
      [term],
    );
    for (const row of refunds.rows) {
      matches.push({
        kind: "pack_refund",
        id: row.pack_refund_id,
        label: `Pack refund on order ${row.order_id} (${row.status})`,
        href: `/orders/${encodeURIComponent(row.order_id)}`,
      });
    }
  }

  const disputes = await client.query<{ dispute_id: string; status: string }>(
    `SELECT dispute_id, status FROM stripe_disputes
     WHERE dispute_id = $1 OR charge_id = $1 OR payment_intent_id = $1
     LIMIT 5`,
    [term],
  );
  for (const row of disputes.rows) {
    matches.push({
      kind: "dispute",
      id: row.dispute_id,
      label: `Dispute ${row.dispute_id} (${row.status})`,
      href: `/disputes`,
    });
  }

  const events = await client.query<{ event_id: string; event_type: string; processing_status: string }>(
    `SELECT event_id, event_type, processing_status FROM stripe_webhook_events
     WHERE event_id = $1 OR provider_object_id = $1 OR provider_payment_intent_id = $1 OR provider_charge_id = $1
     ORDER BY received_at DESC LIMIT 5`,
    [term],
  );
  for (const row of events.rows) {
    matches.push({
      kind: "webhook_event",
      id: row.event_id,
      label: `Webhook ${row.event_type} (${row.processing_status})`,
      href: `/alerts`,
    });
  }

  return matches;
}
