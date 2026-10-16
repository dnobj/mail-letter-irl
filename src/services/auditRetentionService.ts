import { query } from '../db/index.js';

/**
 * Operator audit records are kept for 2 years after the action they record,
 * and are exempt from account erasure for that period (#395); this deletes them
 * once the two years are up (#398).
 *
 * Both audit tables refuse every UPDATE and DELETE through a trigger, and keep
 * doing so. The deleting is migration 062's purge_expired_audit_records, which
 * switches the triggers off only inside its own statement's transaction and
 * deletes only rows past their two years:
 *
 *   admin_audit_events: occurred_at more than 2 years ago.
 *   commerce_operator_audit_events: retention_expires_at passed (two years
 *   after the row, migration 023's default).
 *
 * The rule lives in that function, in the database: nothing here chooses which
 * rows go. In batches, oldest first, a bounded number per run: nothing expires
 * before July 2028, and then the backlog is at most a day's actions. Returns
 * counts; callers log counts, never a row.
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
    // One statement, so one transaction: the triggers are off only inside it.
    const deleted = await query<{ admin_deleted: number; commerce_deleted: number }>(
      'SELECT admin_deleted, commerce_deleted FROM purge_expired_audit_records($1::int)',
      [batch]
    );
    const admin = deleted.rows[0]?.admin_deleted ?? 0;
    const commerce = deleted.rows[0]?.commerce_deleted ?? 0;
    result.adminDeleted += admin;
    result.commerceDeleted += commerce;
    if (admin < batch && commerce < batch) break;
  }
  return result;
}
