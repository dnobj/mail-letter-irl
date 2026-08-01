/** Explicit, replay-safe image-generation entitlements and reservations. */

import type pg from 'pg';
import { query, transaction } from '../db/index.js';
import type { ImageEntitlement } from './types.js';

export interface GenerationQuota {
  used: number;
  allowance: number;
  remaining: number;
}

export interface GenerationLimitCheck extends GenerationQuota {
  allowed: boolean;
}

export interface GenerationReservation extends GenerationQuota {
  reserved: boolean;
  reservationId?: string;
}

export type ImageGenerationReservationStatus =
  | 'reserved'
  | 'dispatched'
  | 'consumed'
  | 'released'
  | 'ambiguous';

export interface GenerationReservationReconciliation {
  releasedBeforeDispatch: number;
  markedAmbiguous: number;
  ambiguousTotal: number;
}

export type AmbiguousGenerationResolution =
  | 'provider_confirmed_succeeded'
  | 'provider_confirmed_failed'
  | 'customer_compensation';

export interface GrantImageEntitlementParams {
  userId: string;
  sourceType: string;
  sourceReferenceId: string;
  sourceOrderId?: string;
  quantity: number;
  expiresAt?: Date;
}

interface QuotaRow {
  allowance: string | number;
  used: string | number;
  remaining: string | number;
}

interface ReservationRow {
  reservation_id: string;
  entitlement_id: string;
  user_id: string;
  status: ImageGenerationReservationStatus;
}

function positiveIntegerSetting(name: string, fallback: number, minimum: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function preDispatchLeaseExpiresAt(): Date {
  const minutes = positiveIntegerSetting(
    'IMAGE_RESERVATION_PRE_DISPATCH_TIMEOUT_MINUTES',
    15,
    1
  );
  return new Date(Date.now() + minutes * 60_000);
}

function providerOutcomeLeaseExpiresAt(): Date {
  const minutes = positiveIntegerSetting(
    'IMAGE_RESERVATION_PROVIDER_TIMEOUT_MINUTES',
    30,
    5
  );
  return new Date(Date.now() + minutes * 60_000);
}

function toQuota(row?: QuotaRow): GenerationQuota {
  return {
    allowance: Number(row?.allowance ?? 0),
    used: Number(row?.used ?? 0),
    remaining: Number(row?.remaining ?? 0)
  };
}

async function getGenerationQuotaWithClient(
  client: Pick<pg.PoolClient, 'query'>,
  userId: string
): Promise<GenerationQuota> {
  const result = await client.query<QuotaRow>(
    `SELECT
       COALESCE(SUM(quantity), 0) AS allowance,
       COALESCE(SUM(consumed_quantity), 0) AS used,
       COALESCE(SUM(
         CASE
           WHEN status = 'active' AND (expires_at IS NULL OR expires_at > NOW())
             THEN quantity - consumed_quantity
           ELSE 0
         END
       ), 0) AS remaining
     FROM image_entitlements
     WHERE user_id = $1
       AND status <> 'revoked'`,
    [userId]
  );
  return toQuota(result.rows[0]);
}

export async function getGenerationQuota(userId: string): Promise<GenerationQuota> {
  return getGenerationQuotaWithClient(
    {
      query: <T extends pg.QueryResultRow = any>(text: string, params?: any[]) =>
        query<T>(text, params)
    } as Pick<pg.PoolClient, 'query'>,
    userId
  );
}

export async function checkGenerationLimit(userId: string): Promise<GenerationLimitCheck> {
  const quota = await getGenerationQuota(userId);
  return { ...quota, allowed: quota.remaining > 0 };
}

/**
 * Add one entitlement grant. The source pair is unique, so replayed payment
 * events cannot grant the same purchase twice.
 */
export async function grantImageEntitlementWithClient(
  client: Pick<pg.PoolClient, 'query'>,
  params: GrantImageEntitlementParams
): Promise<ImageEntitlement | null> {
  if (!Number.isInteger(params.quantity) || params.quantity <= 0) return null;

  const result = await client.query<ImageEntitlement>(
    `INSERT INTO image_entitlements (
       user_id, source_type, source_reference_id, source_order_id,
       quantity, consumed_quantity, status, expires_at
     ) VALUES ($1, $2, $3, $4, $5, 0, 'active', $6)
     ON CONFLICT (source_type, source_reference_id) DO NOTHING
     RETURNING *`,
    [
      params.userId,
      params.sourceType,
      params.sourceReferenceId,
      params.sourceOrderId || null,
      params.quantity,
      params.expiresAt || null
    ]
  );
  return result.rows[0] || null;
}

export async function grantImageEntitlement(
  params: GrantImageEntitlementParams
): Promise<ImageEntitlement | null> {
  return transaction(client => grantImageEntitlementWithClient(client, params));
}

/** Atomically reserve one available grant before calling the image provider. */
export async function reserveGeneration(userId: string): Promise<GenerationReservation> {
  return transaction(async client => {
    await client.query(
      `UPDATE image_entitlements
       SET status = 'expired', updated_at = NOW()
       WHERE user_id = $1 AND status = 'active' AND expires_at <= NOW()`,
      [userId]
    );

    const selected = await client.query<ImageEntitlement>(
      `SELECT * FROM image_entitlements
       WHERE user_id = $1
         AND status = 'active'
         AND consumed_quantity < quantity
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY expires_at NULLS LAST, created_at, entitlement_id
       LIMIT 1
       FOR UPDATE`,
      [userId]
    );

    const entitlement = selected.rows[0];
    if (!entitlement) {
      const quota = await getGenerationQuotaWithClient(client, userId);
      return { ...quota, reserved: false };
    }

    await client.query(
      `UPDATE image_entitlements
       SET consumed_quantity = consumed_quantity + 1,
           status = CASE
             WHEN consumed_quantity + 1 >= quantity THEN 'depleted'
             ELSE 'active'
           END,
           updated_at = NOW()
       WHERE entitlement_id = $1`,
      [entitlement.entitlement_id]
    );
    await client.query(
      `UPDATE users
       SET image_generations_used = image_generations_used + 1, updated_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );

    const reservation = await client.query<{ reservation_id: string }>(
      `INSERT INTO image_generation_reservations (
         entitlement_id, user_id, status, lease_expires_at
       ) VALUES ($1, $2, 'reserved', $3)
       RETURNING reservation_id`,
      [entitlement.entitlement_id, userId, preDispatchLeaseExpiresAt()]
    );
    const quota = await getGenerationQuotaWithClient(client, userId);

    return {
      ...quota,
      reserved: true,
      reservationId: reservation.rows[0].reservation_id
    };
  });
}

/** Durably mark provider dispatch before any network I/O begins. */
export async function markGenerationDispatched(
  userId: string,
  reservationId: string
): Promise<boolean> {
  const result = await query<{ reservation_id: string }>(
    `UPDATE image_generation_reservations
     SET status = 'dispatched', dispatch_started_at = NOW(),
         lease_expires_at = $3, resolution_reason = NULL, updated_at = NOW()
     WHERE reservation_id = $1 AND user_id = $2 AND status = 'reserved'
       AND lease_expires_at > NOW()
     RETURNING reservation_id`,
    [reservationId, userId, providerOutcomeLeaseExpiresAt()]
  );
  return Boolean(result.rows[0]);
}

/** Mark a successful provider call as having consumed its reservation. */
export async function commitGenerationReservation(
  reservationId: string,
  providerRequestId?: string
): Promise<boolean> {
  const result = await query<{ reservation_id: string }>(
    `UPDATE image_generation_reservations
     SET status = 'consumed', completed_at = COALESCE(completed_at, NOW()),
         provider_completed_at = COALESCE(provider_completed_at, NOW()),
         provider_request_id = COALESCE(provider_request_id, $2),
         lease_expires_at = NULL, resolution_reason = 'provider_succeeded',
         updated_at = NOW()
     WHERE reservation_id = $1 AND status IN ('dispatched', 'ambiguous')
     RETURNING reservation_id`,
    [reservationId, providerRequestId || null]
  );
  if (result.rows[0]) return true;
  const current = await query<{ status: ImageGenerationReservationStatus }>(
    'SELECT status FROM image_generation_reservations WHERE reservation_id = $1',
    [reservationId]
  );
  return current.rows[0]?.status === 'consumed';
}

async function releaseReservationWithClient(
  client: Pick<pg.PoolClient, 'query'>,
  row: ReservationRow,
  reason: string,
  expectedStatuses: ImageGenerationReservationStatus[]
): Promise<boolean> {
  if (!expectedStatuses.includes(row.status)) return false;
  const entitlement = await client.query<{ entitlement_id: string }>(
    `UPDATE image_entitlements
     SET consumed_quantity = consumed_quantity - 1,
         status = CASE
           WHEN status = 'depleted' AND (expires_at IS NULL OR expires_at > NOW()) THEN 'active'
           WHEN status = 'depleted' THEN 'expired'
           ELSE status
         END,
         updated_at = NOW()
     WHERE entitlement_id = $1 AND consumed_quantity > 0
     RETURNING entitlement_id`,
    [row.entitlement_id]
  );
  if (!entitlement.rows[0]) {
    throw new Error('Image reservation entitlement counter is inconsistent');
  }
  const user = await client.query<{ user_id: string }>(
    `UPDATE users
     SET image_generations_used = image_generations_used - 1,
         updated_at = NOW()
     WHERE user_id = $1 AND image_generations_used > 0
     RETURNING user_id`,
    [row.user_id]
  );
  if (!user.rows[0]) {
    throw new Error('Image reservation user counter is inconsistent');
  }
  await client.query(
    `UPDATE image_generation_reservations
     SET status = 'released', completed_at = NOW(), lease_expires_at = NULL,
         resolution_reason = $2, updated_at = NOW()
     WHERE reservation_id = $1 AND status = ANY($3::varchar[])`,
    [row.reservation_id, reason, expectedStatuses]
  );
  return true;
}

/** Return a reservation only after a definite non-billable provider outcome. */
export async function releaseGenerationReservation(
  userId: string,
  reservationId: string,
  reason = 'definite_failure'
): Promise<boolean> {
  return transaction(async client => {
    const reservation = await client.query<ReservationRow>(
      `SELECT reservation_id, entitlement_id, status
       FROM image_generation_reservations
       WHERE reservation_id = $1 AND user_id = $2
       FOR UPDATE`,
      [reservationId, userId]
    );
    const row = reservation.rows[0];
    if (!row) return false;
    return releaseReservationWithClient(
      client,
      { ...row, user_id: userId },
      reason,
      ['reserved', 'dispatched']
    );
  });
}

/** Preserve charged quota when provider dispatch has an unknown outcome. */
export async function markGenerationReservationAmbiguous(
  userId: string,
  reservationId: string,
  reason = 'provider_outcome_unknown',
  providerRequestId?: string
): Promise<boolean> {
  const result = await query<{ reservation_id: string }>(
    `UPDATE image_generation_reservations
     SET status = 'ambiguous', lease_expires_at = NULL,
         provider_request_id = COALESCE(provider_request_id, $4),
         resolution_reason = $3, updated_at = NOW()
     WHERE reservation_id = $1 AND user_id = $2 AND status = 'dispatched'
     RETURNING reservation_id`,
    [reservationId, userId, reason, providerRequestId || null]
  );
  return Boolean(result.rows[0]);
}

/**
 * Resolve a quarantined provider outcome only after operator/provider review.
 * A confirmed success consumes the held quota. A confirmed failure or an
 * explicit customer-compensation decision restores the exact entitlement.
 */
export async function resolveAmbiguousGenerationReservation(
  reservationId: string,
  resolution: AmbiguousGenerationResolution
): Promise<boolean> {
  return transaction(async client => {
    const reservation = await client.query<ReservationRow>(
      `SELECT reservation_id, entitlement_id, user_id, status
       FROM image_generation_reservations
       WHERE reservation_id = $1
       FOR UPDATE`,
      [reservationId]
    );
    const row = reservation.rows[0];
    if (!row || row.status !== 'ambiguous') return false;
    if (resolution === 'provider_confirmed_succeeded') {
      await client.query(
        `UPDATE image_generation_reservations
         SET status = 'consumed', completed_at = COALESCE(completed_at, NOW()),
             provider_completed_at = COALESCE(provider_completed_at, NOW()),
             resolution_reason = $2, updated_at = NOW()
         WHERE reservation_id = $1 AND status = 'ambiguous'`,
        [reservationId, resolution]
      );
      return true;
    }
    return releaseReservationWithClient(client, row, resolution, ['ambiguous']);
  });
}

/**
 * Reconcile process crashes without risking a second provider charge.
 *
 * - stale `reserved` rows were never durably dispatched and are released;
 * - stale `dispatched` rows are outcome-ambiguous and keep quota consumed;
 * - ambiguous rows remain inspectable until provider evidence or an explicit
 *   operator decision resolves them.
 */
export async function reconcileGenerationReservations(
  limit = 100
): Promise<GenerationReservationReconciliation> {
  const boundedLimit = Math.min(500, Math.max(1, limit));
  return transaction(async client => {
    const staleReserved = await client.query<ReservationRow>(
      `SELECT reservation_id, entitlement_id, user_id, status
       FROM image_generation_reservations
       WHERE status = 'reserved' AND lease_expires_at <= NOW()
       ORDER BY lease_expires_at, reservation_id
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [boundedLimit]
    );
    let releasedBeforeDispatch = 0;
    for (const row of staleReserved.rows) {
      if (
        await releaseReservationWithClient(
          client,
          row,
          'crash_before_provider_dispatch',
          ['reserved']
        )
      ) {
        releasedBeforeDispatch += 1;
      }
    }

    const marked = await client.query<{ reservation_id: string }>(
      `WITH stale AS (
         SELECT reservation_id
         FROM image_generation_reservations
         WHERE status = 'dispatched' AND lease_expires_at <= NOW()
         ORDER BY lease_expires_at, reservation_id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE image_generation_reservations AS reservations
       SET status = 'ambiguous', lease_expires_at = NULL,
           resolution_reason = 'provider_outcome_unknown_after_crash',
           updated_at = NOW()
       FROM stale
       WHERE reservations.reservation_id = stale.reservation_id
       RETURNING reservations.reservation_id`,
      [boundedLimit]
    );
    const ambiguous = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM image_generation_reservations
       WHERE status = 'ambiguous'`
    );
    return {
      releasedBeforeDispatch,
      markedAmbiguous: marked.rowCount || 0,
      ambiguousTotal: Number.parseInt(ambiguous.rows[0]?.count || '0', 10)
    };
  });
}
