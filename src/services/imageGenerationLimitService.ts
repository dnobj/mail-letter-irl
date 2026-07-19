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
      `INSERT INTO image_generation_reservations (entitlement_id, user_id, status)
       VALUES ($1, $2, 'reserved')
       RETURNING reservation_id`,
      [entitlement.entitlement_id, userId]
    );
    const quota = await getGenerationQuotaWithClient(client, userId);

    return {
      ...quota,
      reserved: true,
      reservationId: reservation.rows[0].reservation_id
    };
  });
}

/** Mark a successful provider call as having consumed its reservation. */
export async function commitGenerationReservation(reservationId: string): Promise<void> {
  await query(
    `UPDATE image_generation_reservations
     SET status = 'consumed', completed_at = NOW()
     WHERE reservation_id = $1 AND status = 'reserved'`,
    [reservationId]
  );
}

/** Return a reservation to its exact entitlement after a failed provider call. */
export async function releaseGenerationReservation(
  userId: string,
  reservationId?: string
): Promise<void> {
  await transaction(async client => {
    const reservation = await client.query<{
      reservation_id: string;
      entitlement_id: string;
      status: string;
    }>(
      reservationId
        ? `SELECT reservation_id, entitlement_id, status
           FROM image_generation_reservations
           WHERE reservation_id = $1 AND user_id = $2
           FOR UPDATE`
        : `SELECT reservation_id, entitlement_id, status
           FROM image_generation_reservations
           WHERE user_id = $2 AND status = 'reserved'
           ORDER BY created_at DESC
           LIMIT 1
           FOR UPDATE`,
      [reservationId || null, userId]
    );
    const row = reservation.rows[0];
    if (!row || row.status !== 'reserved') return;

    await client.query(
      `UPDATE image_entitlements
       SET consumed_quantity = GREATEST(consumed_quantity - 1, 0),
           status = CASE
             WHEN status = 'depleted' THEN 'active'
             ELSE status
           END,
           updated_at = NOW()
       WHERE entitlement_id = $1`,
      [row.entitlement_id]
    );
    await client.query(
      `UPDATE users
       SET image_generations_used = GREATEST(image_generations_used - 1, 0),
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );
    await client.query(
      `UPDATE image_generation_reservations
       SET status = 'released', completed_at = NOW()
       WHERE reservation_id = $1`,
      [row.reservation_id]
    );
  });
}
