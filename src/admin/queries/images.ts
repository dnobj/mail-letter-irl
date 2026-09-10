import type { AdminSqlClient } from "../database.js";

export interface ReservationView {
  reservationId: string;
  entitlementId: string;
  userId: string;
  status: string;
  hasProviderRequestId: boolean;
  resolutionReason: string | null;
  dispatchStartedAt: Date | null;
  providerCompletedAt: Date | null;
  leaseExpiresAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ReservationRow {
  reservation_id: string;
  entitlement_id: string;
  user_id: string;
  status: string;
  has_provider_request_id: boolean;
  resolution_reason: string | null;
  dispatch_started_at: Date | null;
  provider_completed_at: Date | null;
  lease_expires_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const RESERVATION_COLUMNS = `
  reservation_id, entitlement_id, user_id, status, (provider_request_id IS NOT NULL) AS has_provider_request_id,
  resolution_reason, dispatch_started_at, provider_completed_at, lease_expires_at, completed_at, created_at, updated_at
`;

function toReservationView(row: ReservationRow): ReservationView {
  return {
    reservationId: row.reservation_id,
    entitlementId: row.entitlement_id,
    userId: row.user_id,
    status: row.status,
    hasProviderRequestId: row.has_provider_request_id,
    resolutionReason: row.resolution_reason,
    dispatchStartedAt: row.dispatch_started_at,
    providerCompletedAt: row.provider_completed_at,
    leaseExpiresAt: row.lease_expires_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAmbiguousReservations(client: AdminSqlClient, limit: number): Promise<ReservationView[]> {
  const result = await client.query<ReservationRow>(
    `SELECT ${RESERVATION_COLUMNS} FROM image_generation_reservations
     WHERE status = 'ambiguous' ORDER BY updated_at, reservation_id LIMIT $1`,
    [limit],
  );
  return result.rows.map(toReservationView);
}

export async function readReservation(client: AdminSqlClient, reservationId: string): Promise<ReservationView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(reservationId)) return null;
  const result = await client.query<ReservationRow>(
    `SELECT ${RESERVATION_COLUMNS} FROM image_generation_reservations WHERE reservation_id = $1::uuid`,
    [reservationId],
  );
  return result.rows[0] ? toReservationView(result.rows[0]) : null;
}

export interface EntitlementView {
  entitlementId: string;
  sourceType: string;
  sourceReferenceId: string;
  sourceOrderId: string | null;
  quantity: number;
  consumedQuantity: number;
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
}

export async function listEntitlements(client: AdminSqlClient, userId: string): Promise<EntitlementView[]> {
  const result = await client.query<{
    entitlement_id: string;
    source_type: string;
    source_reference_id: string;
    source_order_id: string | null;
    quantity: number;
    consumed_quantity: number;
    status: string;
    expires_at: Date | null;
    created_at: Date;
  }>(
    `SELECT entitlement_id, source_type, source_reference_id, source_order_id, quantity, consumed_quantity,
            status, expires_at, created_at
     FROM image_entitlements WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [userId],
  );
  return result.rows.map((row) => ({
    entitlementId: row.entitlement_id,
    sourceType: row.source_type,
    sourceReferenceId: row.source_reference_id,
    sourceOrderId: row.source_order_id,
    quantity: row.quantity,
    consumedQuantity: row.consumed_quantity,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }));
}
