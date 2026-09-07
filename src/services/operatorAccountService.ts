import type pg from 'pg';

import { NON_LOSS_DISPUTE_STATUSES } from './commerceService.js';
import { grantImageEntitlementWithClient } from './imageGenerationLimitService.js';
import type { ImageEntitlement } from './types.js';

/**
 * Operator decisions on accounts and orders that had no tooling: lifting a
 * dispute send block, releasing an amount-mismatch quarantine, and a
 * compensation image grant. Each takes the caller's client so the admin
 * command runner commits the change, its run row and its audit row together.
 */

/**
 * The least a caller must provide: a pg PoolClient and the admin panel's
 * read-only client both satisfy it, so previews and commands share the same
 * predicates.
 */
type Client = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

export type LiftSendBlockOutcome = 'lifted' | 'not_blocked' | 'dispute_standing';

/** Disputes that still justify a block: everything not in the non-loss set. */
export async function countStandingDisputes(client: Client, userId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM stripe_disputes
     WHERE user_id = $1 AND NOT (status = ANY($2::text[]))`,
    [userId, [...NON_LOSS_DISPUTE_STATUSES]]
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Lift a send block by operator decision. Same predicate as the automatic
 * unblock after a won dispute (unblockAccountSends): refused while any
 * dispute that would itself justify a block still stands.
 */
export async function liftSendBlock(client: Client, userId: string): Promise<LiftSendBlockOutcome> {
  const user = await client.query<{ sends_blocked_at: Date | null }>(
    'SELECT sends_blocked_at FROM users WHERE user_id = $1 FOR UPDATE',
    [userId]
  );
  if (!user.rows[0]) throw new Error('not_found');
  if (!user.rows[0].sends_blocked_at) return 'not_blocked';
  if ((await countStandingDisputes(client, userId)) > 0) return 'dispute_standing';
  await client.query(
    `UPDATE users SET sends_blocked_at = NULL, sends_blocked_reason = NULL, updated_at = NOW()
     WHERE user_id = $1`,
    [userId]
  );
  return 'lifted';
}

export type ReleaseQuarantineOutcome = 'released' | 'not_quarantined';

/**
 * Clear a PAYMENT_AMOUNT_MISMATCH quarantine so the hourly sweep may refund
 * the order. The sweep gates on the code (commerceService, refund lane), so
 * clearing it is the operator's deliberate "yes, refund this one".
 */
export async function releaseAmountMismatchQuarantine(
  client: Client,
  orderId: string,
  reason: string
): Promise<ReleaseQuarantineOutcome> {
  const order = await client.query<{ status: string; last_error_code: string | null }>(
    'SELECT status, last_error_code FROM orders WHERE order_id = $1 FOR UPDATE',
    [orderId]
  );
  const row = order.rows[0];
  if (!row) throw new Error('not_found');
  if (row.last_error_code !== 'PAYMENT_AMOUNT_MISMATCH') return 'not_quarantined';
  await client.query(
    `UPDATE orders SET last_error_code = NULL, last_error = NULL, updated_at = NOW() WHERE order_id = $1`,
    [orderId]
  );
  await client.query(
    `INSERT INTO commerce_order_events (order_id, event_type, from_status, to_status, metadata)
     VALUES ($1, 'operator.quarantine_released', $2, $2, $3::jsonb)`,
    [orderId, row.status, JSON.stringify({ reason: reason.slice(0, 500), clearedCode: 'PAYMENT_AMOUNT_MISMATCH' })]
  );
  return 'released';
}

const OPERATOR_GRANT_DAYS = 365;

/**
 * A compensation image grant. Unique per reference (the admin run id), so a
 * replayed command cannot grant twice; null means the grant already exists.
 */
export async function grantOperatorImageEntitlement(
  client: Pick<pg.PoolClient, 'query'>,
  params: { userId: string; quantity: number; reference: string }
): Promise<ImageEntitlement | null> {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + OPERATOR_GRANT_DAYS);
  return grantImageEntitlementWithClient(client, {
    userId: params.userId,
    sourceType: 'operator_grant',
    sourceReferenceId: params.reference,
    quantity: params.quantity,
    expiresAt
  });
}
