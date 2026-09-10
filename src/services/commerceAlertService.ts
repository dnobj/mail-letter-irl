import { createHash } from 'node:crypto';
import { transaction } from '../db/index.js';

/**
 * Operational alert transitions. Moved out of the legacy admin handler so the
 * tailnet admin panel can call it without the dead route file; the body is
 * unchanged.
 */

export interface CommerceAlertTransition {
  alertId: string;
  status: 'acknowledged' | 'resolved';
  /** Required when resolving; ignored on acknowledge. */
  resolutionCode?: string;
  idempotencyKey: string;
  actorId: string;
}

/**
 * Move one commerce alert to acknowledged or resolved.
 *
 * Separated from the HTTP handler so the transition can be exercised without a
 * request. The handler above it owns parsing, validation and status codes; this
 * owns the state machine and the audit trail. Issue #189: the statement below
 * was rejected by PostgreSQL on every call, and nothing could reach it to
 * notice - the admin surface is local-only and 404s everywhere else, so no test
 * and no deployed environment ever executed it.
 *
 * Throws Error('not_found' | 'invalid_state' | 'idempotency_conflict'), which
 * the handler maps to status codes.
 */
export async function transitionCommerceAlert(
  params: CommerceAlertTransition
): Promise<{ replayed: boolean }> {
  const { alertId, status, idempotencyKey, actorId } = params;
  const resolutionCode = params.resolutionCode || '';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  return transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [idempotencyKey]);
      const replay = await client.query<{
        operation: string; target_type: string; target_reference_hash: string;
        actor_subject_hash: string; reason_code: string; requested_status: string;
      }>(
        `SELECT operation, target_type, target_reference_hash, actor_subject_hash,
                reason_code, after_state->>'status' AS requested_status
         FROM commerce_operator_audit_events
         WHERE idempotency_key_hash = $1`, [hash(idempotencyKey)]
      );
      if (replay.rows[0]) {
        const existing = replay.rows[0];
        if (existing.operation !== 'commerce_alert_transition' ||
            existing.target_type !== 'commerce_alert' ||
            existing.target_reference_hash !== hash(alertId) ||
            existing.actor_subject_hash !== hash(actorId) ||
            existing.reason_code !== (resolutionCode || 'operator_acknowledged') ||
            existing.requested_status !== status) {
          throw new Error('idempotency_conflict');
        }
        return { replayed: true };
      }
      const locked = await client.query<{ status: string; severity: string; alert_type: string }>(
        `SELECT status, severity, alert_type FROM commerce_operational_alerts
         WHERE alert_id = $1 FOR UPDATE`, [alertId]
      );
      const current = locked.rows[0];
      if (!current) throw new Error('not_found');
      if (current.status === 'resolved' || (status === 'acknowledged' && current.status !== 'open')) {
        throw new Error('invalid_state');
      }
      // Every use of $2 is cast. Assigning it to status (a VARCHAR column)
      // deduces varchar while comparing it to an untyped literal deduces text,
      // and PostgreSQL rejects the statement outright with "inconsistent types
      // deduced for parameter $2" - so this threw on EVERY acknowledge and
      // EVERY resolve, and the audit insert below it never ran either.
      //
      // The resolved_* branches keep their ELSE NULL, which reads odd next to
      // the acknowledged_* branches but is what the table requires:
      // valid_commerce_alert_resolution permits an acknowledged row only while
      // resolved_at IS NULL. Preserving those columns on an acknowledge would
      // put the row in a state the CHECK rejects.
      await client.query(
        `UPDATE commerce_operational_alerts SET status = $2::varchar,
           acknowledged_at = CASE WHEN $2::varchar = 'acknowledged' THEN NOW() ELSE acknowledged_at END,
           acknowledged_by_actor_hash = CASE WHEN $2::varchar = 'acknowledged' THEN $3 ELSE acknowledged_by_actor_hash END,
           resolved_at = CASE WHEN $2::varchar = 'resolved' THEN NOW() ELSE NULL END,
           resolved_by_actor_hash = CASE WHEN $2::varchar = 'resolved' THEN $3 ELSE NULL END,
           resolution_code = CASE WHEN $2::varchar = 'resolved' THEN $4 ELSE NULL END,
           updated_at = NOW() WHERE alert_id = $1`,
        [alertId, status, hash(actorId), resolutionCode || null]
      );
      await client.query(
        `INSERT INTO commerce_operator_audit_events
           (idempotency_key_hash, actor_subject_hash, operation, target_type,
            target_reference_hash, reason_code, before_state, after_state)
         VALUES ($1, $2, 'commerce_alert_transition', 'commerce_alert', $3, $4, $5, $6)`,
        [hash(idempotencyKey), hash(actorId), hash(alertId),
          resolutionCode || 'operator_acknowledged',
          JSON.stringify({ status: current.status, severity: current.severity, type: current.alert_type }),
          JSON.stringify({ status, severity: current.severity, type: current.alert_type })]
      );
      return { replayed: false };
  });
}
