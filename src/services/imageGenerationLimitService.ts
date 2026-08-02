/** Explicit, replay-safe image-generation entitlements and reservations. */

import { createHash } from 'node:crypto';
import type pg from 'pg';
import { query, transaction } from '../db/index.js';
import { lockAccountForBalanceChange } from './accountLock.js';
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

export type AmbiguousGenerationDecision = 'consume' | 'release';

export interface AmbiguousGenerationReservation {
  reservationId: string;
  userId: string;
  providerRequestId: string | null;
  resolutionReason: string;
  dispatchStartedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResolveAmbiguousGenerationReservationParams {
  reservationId: string;
  expectedUserId: string;
  actorId: string;
  idempotencyKey: string;
  decision: AmbiguousGenerationDecision;
  resolution: AmbiguousGenerationResolution;
}

export interface AmbiguousGenerationResolutionResult {
  reservationId: string;
  userId: string;
  decision: AmbiguousGenerationDecision;
  resolution: AmbiguousGenerationResolution;
  resultingStatus: 'consumed' | 'released';
  replayed: boolean;
}

export type ImageGenerationResolutionErrorCode =
  | 'idempotency_conflict'
  | 'invalid_request'
  | 'invalid_resolution'
  | 'invalid_state'
  | 'not_found';

export class ImageGenerationResolutionError extends Error {
  constructor(readonly code: ImageGenerationResolutionErrorCode) {
    super(code);
    this.name = 'ImageGenerationResolutionError';
  }
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

interface ReservationRow {
  reservation_id: string;
  entitlement_id: string;
  user_id: string;
  status: ImageGenerationReservationStatus;
}

interface ResolutionAuditRow {
  target_reference_hash: string;
  actor_subject_hash: string;
  subject_binding_hash: string;
  decision: AmbiguousGenerationDecision;
  resolution_reason: AmbiguousGenerationResolution;
  resulting_status: 'consumed' | 'released';
}

function resolutionSubjectBinding(reservationId: string, userId: string): string {
  return createHash('sha256').update(`${reservationId}\0${userId}`).digest('hex');
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

  // Enforced here rather than at each call site so every grant path - pack
  // checkout, JIT checkout, delayed fulfillment, and reconciliation repair -
  // holds the account row before any image_entitlements write.
  await lockAccountForBalanceChange(client, params.userId);
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
    // Canonical account lock order: users -> credit_ledger -> image_entitlements.
    // The expiry sweep below already write-locks entitlement rows, so the
    // account row must be held first or this races a concurrent refund.
    await lockAccountForBalanceChange(client, userId);
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
  // Canonical account lock order: users -> image_entitlements. Restoring quota
  // must not invert against a concurrent reservation or pack refund.
  await lockAccountForBalanceChange(client, row.user_id);
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

export async function listAmbiguousGenerationReservations(
  limit = 50
): Promise<AmbiguousGenerationReservation[]> {
  const normalizedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 50;
  const boundedLimit = Math.min(100, Math.max(1, normalizedLimit));
  const result = await query<AmbiguousGenerationReservation>(
    `SELECT reservation_id AS "reservationId",
            user_id AS "userId",
            provider_request_id AS "providerRequestId",
            resolution_reason AS "resolutionReason",
            dispatch_started_at AS "dispatchStartedAt",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
     FROM image_generation_reservations
     WHERE status = 'ambiguous'
     ORDER BY updated_at, reservation_id
     LIMIT $1`,
    [boundedLimit]
  );
  return result.rows;
}

function isValidResolutionPair(
  decision: AmbiguousGenerationDecision,
  resolution: AmbiguousGenerationResolution
): boolean {
  return decision === 'consume'
    ? resolution === 'provider_confirmed_succeeded'
    : resolution === 'provider_confirmed_failed' || resolution === 'customer_compensation';
}

function replayResolution(
  existing: ResolutionAuditRow,
  params: ResolveAmbiguousGenerationReservationParams
): AmbiguousGenerationResolutionResult {
  if (
    existing.target_reference_hash !== createHash('sha256').update(params.reservationId).digest('hex') ||
    existing.actor_subject_hash !== createHash('sha256').update(params.actorId).digest('hex') ||
    existing.subject_binding_hash !== resolutionSubjectBinding(params.reservationId, params.expectedUserId) ||
    existing.decision !== params.decision ||
    existing.resolution_reason !== params.resolution
  ) {
    throw new ImageGenerationResolutionError('idempotency_conflict');
  }
  return {
    reservationId: params.reservationId,
    userId: params.expectedUserId,
    decision: existing.decision,
    resolution: existing.resolution_reason,
    resultingStatus: existing.resulting_status,
    replayed: true
  };
}

/**
 * Resolve a quarantined provider outcome only after authenticated operator
 * review. The state transition, any quota restoration, and the durable audit
 * record commit in one transaction. The user binding prevents a reservation ID
 * from being used to mutate another account.
 */
export async function resolveAmbiguousGenerationReservation(
  params: ResolveAmbiguousGenerationReservationParams
): Promise<AmbiguousGenerationResolutionResult> {
  if (
    !params.reservationId ||
    params.reservationId.length > 64 ||
    !params.expectedUserId ||
    params.expectedUserId.length > 255 ||
    !params.actorId ||
    params.actorId.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(params.idempotencyKey)
  ) {
    throw new ImageGenerationResolutionError('invalid_request');
  }
  if (!isValidResolutionPair(params.decision, params.resolution)) {
    throw new ImageGenerationResolutionError('invalid_resolution');
  }
  return transaction(async client => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [params.idempotencyKey]
    );
    const replay = await client.query<ResolutionAuditRow>(
      `SELECT target_reference_hash, actor_subject_hash,
              before_state->>'subjectBinding' AS subject_binding_hash,
              after_state->>'decision' AS decision,
              after_state->>'resolution' AS resolution_reason,
              after_state->>'status' AS resulting_status
       FROM commerce_operator_audit_events
       WHERE idempotency_key_hash = $1`,
      [createHash('sha256').update(params.idempotencyKey).digest('hex')]
    );
    if (replay.rows[0]) return replayResolution(replay.rows[0], params);

    const reservation = await client.query<ReservationRow>(
      `SELECT reservation_id, entitlement_id, user_id, status
       FROM image_generation_reservations
       WHERE reservation_id = $1 AND user_id = $2
       FOR UPDATE`,
      [params.reservationId, params.expectedUserId]
    );
    const row = reservation.rows[0];
    if (!row) throw new ImageGenerationResolutionError('not_found');
    if (row.status !== 'ambiguous') {
      throw new ImageGenerationResolutionError('invalid_state');
    }

    const resultingStatus = params.decision === 'consume' ? 'consumed' : 'released';
    if (params.decision === 'consume') {
      const consumed = await client.query<{ reservation_id: string }>(
        `UPDATE image_generation_reservations
         SET status = 'consumed', completed_at = COALESCE(completed_at, NOW()),
              provider_completed_at = COALESCE(provider_completed_at, NOW()),
              resolution_reason = $2, updated_at = NOW()
         WHERE reservation_id = $1 AND status = 'ambiguous'
         RETURNING reservation_id`,
        [params.reservationId, params.resolution]
      );
      if (!consumed.rows[0]) throw new ImageGenerationResolutionError('invalid_state');
    } else {
      await releaseReservationWithClient(client, row, params.resolution, ['ambiguous']);
    }

    await client.query(
      `INSERT INTO commerce_operator_audit_events (
         idempotency_key_hash, actor_subject_hash, operation, target_type,
         target_reference_hash, reason_code, before_state, after_state, provider_evidence
       ) VALUES ($1, $2, 'image_reservation_resolve', 'image_reservation', $3, $4, $5, $6, $7)`,
      [
        createHash('sha256').update(params.idempotencyKey).digest('hex'),
        createHash('sha256').update(params.actorId).digest('hex'),
        createHash('sha256').update(params.reservationId).digest('hex'),
        params.resolution,
        JSON.stringify({ status: 'ambiguous', quotaHeld: true,
          subjectBinding: resolutionSubjectBinding(params.reservationId, params.expectedUserId) }),
        JSON.stringify({ status: resultingStatus, decision: params.decision,
          resolution: params.resolution, quotaHeld: resultingStatus === 'consumed' }),
        JSON.stringify({
          classification: params.resolution,
          providerReferenceStored: false,
          evidenceReviewed: params.resolution !== 'customer_compensation'
        })
      ]
    );

    return {
      reservationId: params.reservationId,
      userId: params.expectedUserId,
      decision: params.decision,
      resolution: params.resolution,
      resultingStatus,
      replayed: false
    };
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
