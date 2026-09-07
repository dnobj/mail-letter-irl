import type { AdminSqlClient } from "../database.js";
import { maskEmail } from "./accounts.js";

export interface DisputeView {
  disputeId: string;
  chargeId: string;
  paymentIntentId: string | null;
  userId: string | null;
  orderId: string | null;
  amountCents: number;
  currency: string;
  reason: string | null;
  status: string;
  evidenceDueBy: Date | null;
  stripeCreatedAt: Date | null;
  createdAt: Date;
  resolvedAt: Date | null;
  updatedAt: Date;
}

interface DisputeRow {
  dispute_id: string;
  charge_id: string;
  payment_intent_id: string | null;
  user_id: string | null;
  order_id: string | null;
  amount_cents: number;
  currency: string;
  reason: string | null;
  status: string;
  evidence_due_by: Date | null;
  stripe_created_at: Date | null;
  created_at: Date;
  resolved_at: Date | null;
  updated_at: Date;
}

const DISPUTE_SQL = `
  SELECT d.dispute_id, d.charge_id, d.payment_intent_id, d.user_id, o.order_id,
         d.amount_cents, d.currency, d.reason, d.status, d.evidence_due_by,
         d.stripe_created_at, d.created_at, d.resolved_at, d.updated_at
  FROM stripe_disputes d
  LEFT JOIN orders o ON o.stripe_payment_intent_id = d.payment_intent_id
`;

/** Statuses after which a dispute no longer needs the operator. */
export const CLOSED_DISPUTE_STATUSES = [
  "won",
  "lost",
  "prevented",
  "warning_closed",
  "charge_refunded",
] as const;

function toDisputeView(row: DisputeRow): DisputeView {
  return {
    disputeId: row.dispute_id,
    chargeId: row.charge_id,
    paymentIntentId: row.payment_intent_id,
    userId: row.user_id,
    orderId: row.order_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    reason: row.reason,
    status: row.status,
    evidenceDueBy: row.evidence_due_by,
    stripeCreatedAt: row.stripe_created_at,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    updatedAt: row.updated_at,
  };
}

export async function listDisputes(
  client: AdminSqlClient,
  options: { limit: number; openOnly: boolean },
): Promise<DisputeView[]> {
  const result = await client.query<DisputeRow>(
    `${DISPUTE_SQL}
     WHERE ($2::boolean = FALSE OR NOT (d.status = ANY($3::text[])))
     ORDER BY d.created_at DESC LIMIT $1`,
    [options.limit, options.openOnly, [...CLOSED_DISPUTE_STATUSES]],
  );
  return result.rows.map(toDisputeView);
}

export async function listDisputesForOrder(
  client: AdminSqlClient,
  paymentIntentId: string | null,
): Promise<DisputeView[]> {
  if (!paymentIntentId) return [];
  const result = await client.query<DisputeRow>(
    `${DISPUTE_SQL} WHERE d.payment_intent_id = $1 ORDER BY d.created_at DESC LIMIT 20`,
    [paymentIntentId],
  );
  return result.rows.map(toDisputeView);
}

export interface BlockedAccountView {
  userId: string;
  emailMasked: string;
  sendsBlockedAt: Date;
  sendsBlockedReason: string;
  openDisputes: number;
  lostDisputes: number;
}

export async function listBlockedAccounts(
  client: AdminSqlClient,
  limit: number,
): Promise<BlockedAccountView[]> {
  const result = await client.query<{
    user_id: string;
    email: string;
    sends_blocked_at: Date;
    sends_blocked_reason: string;
    open_disputes: string;
    lost_disputes: string;
  }>(
    `SELECT u.user_id, u.email, u.sends_blocked_at, u.sends_blocked_reason,
            (SELECT COUNT(*) FROM stripe_disputes d WHERE d.user_id = u.user_id
               AND NOT (d.status = ANY($2::text[])))::text AS open_disputes,
            (SELECT COUNT(*) FROM stripe_disputes d WHERE d.user_id = u.user_id
               AND d.status = 'lost')::text AS lost_disputes
     FROM users u
     WHERE u.sends_blocked_at IS NOT NULL
     ORDER BY u.sends_blocked_at DESC LIMIT $1`,
    [limit, [...CLOSED_DISPUTE_STATUSES]],
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    emailMasked: maskEmail(row.email),
    sendsBlockedAt: row.sends_blocked_at,
    sendsBlockedReason: row.sends_blocked_reason,
    openDisputes: Number(row.open_disputes),
    lostDisputes: Number(row.lost_disputes),
  }));
}
