import { transaction } from '../db/index.js';

/**
 * Operator audit records are kept for 2 years after the action they record,
 * and are exempt from account erasure for that period (#395); this deletes them
 * once the two years are up (#398).
 *
 * Both audit tables refuse every UPDATE and DELETE through a trigger. Since
 * migration 062 the trigger lets one DELETE through: of a row past its two
 * years, in a transaction that has set letter_irl.audit_retention_purge. So the
 * deletes below run with that setting on, in their own transaction, and the
 * trigger, not this WHERE clause alone, is what keeps a younger row: a
 * predicate here that matched too much would be refused, not obeyed.
 *
 *   admin_audit_events: occurred_at more than 2 years ago.
 *   commerce_operator_audit_events: retention_expires_at passed (two years
 *   after the row, migration 023's default).
 *
 * In batches, oldest first, a bounded number per run: nothing expires before
 * July 2028, and then the backlog is at most a day's actions. Returns counts;
 * callers log counts, never a row.
 */
export const AUDIT_RETENTION_BATCH = 500;
export const AUDIT_RETENTION_MAX_BATCHES = 20;

export interface AuditRetentionResult {
  adminDeleted: number;
  commerceDeleted: number;
}

export async function purgeExpiredAuditRecords(
  batch: number = AUDIT_RETENTION_BATCH,
  maxBatches: number = AUDIT_RETENTION_MAX_BATCHES
): Promise<AuditRetentionResult> {
  const result: AuditRetentionResult = { adminDeleted: 0, commerceDeleted: 0 };
  for (let round = 0; round < maxBatches; round += 1) {
    const deleted = await transaction(async client => {
      await client.query("SET LOCAL letter_irl.audit_retention_purge = 'on'");
      const admin = await client.query(
        `DELETE FROM admin_audit_events
          WHERE id IN (
            SELECT id FROM admin_audit_events
             WHERE occurred_at < NOW() - INTERVAL '2 years'
             ORDER BY occurred_at
             LIMIT $1
          )`,
        [batch]
      );
      const commerce = await client.query(
        `DELETE FROM commerce_operator_audit_events
          WHERE audit_event_id IN (
            SELECT audit_event_id FROM commerce_operator_audit_events
             WHERE retention_expires_at < NOW()
             ORDER BY retention_expires_at
             LIMIT $1
          )`,
        [batch]
      );
      return { admin: admin.rowCount ?? 0, commerce: commerce.rowCount ?? 0 };
    });
    result.adminDeleted += deleted.admin;
    result.commerceDeleted += deleted.commerce;
    if (deleted.admin < batch && deleted.commerce < batch) break;
  }
  return result;
}
