import { query } from '../db/index.js';

/**
 * Operator audit records are kept for up to 2 years after the action they
 * record, and are exempt from account erasure for that period (#395); this
 * deletes them as the two years run out (#398).
 *
 * Both audit tables refuse every UPDATE and DELETE through a trigger, and keep
 * doing so. The deleting is migration 062's purge_expired_audit_records, which
 * switches the triggers off only inside its own statement's transaction and
 * deletes only rows due, two days before their two years are up so that a
 * late run still deletes inside the policy:
 *
 *   admin_audit_events: occurred_at more than 2 years less 2 days ago.
 *   commerce_operator_audit_events: retention_expires_at (two years after the
 *   row, migration 023's default) less than 2 days away.
 *
 * Then the admin command runs and their operations (#771): migration 064's
 * purge_expired_admin_command_records deletes a finished run, with its
 * operation, on the same schedule, once no audit row names it.
 *
 * The rules live in those functions, in the database: nothing here chooses which
 * rows go. In batches, oldest first, a bounded number per run: nothing falls
 * due before late June 2028, and then the backlog is at most a day's actions.
 * Returns counts; callers log counts, never a row.
 */
export const AUDIT_RETENTION_BATCH = 500;
export const AUDIT_RETENTION_MAX_BATCHES = 20;

export interface AuditRetentionResult {
  adminDeleted: number;
  commerceDeleted: number;
  /** Admin command runs and their operations (#771, migration 064). */
  commandRunsDeleted: number;
  operationsDeleted: number;
}

export async function purgeExpiredAuditRecords(
  batch: number = AUDIT_RETENTION_BATCH,
  maxBatches: number = AUDIT_RETENTION_MAX_BATCHES
): Promise<AuditRetentionResult> {
  const result: AuditRetentionResult = { adminDeleted: 0, commerceDeleted: 0, commandRunsDeleted: 0, operationsDeleted: 0 };
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
  // Then the command runs (#771): after the audit rows, since a run that an
  // audit row still names is kept, and the rows go on the same schedule.
  for (let round = 0; round < maxBatches; round += 1) {
    const deleted = await query<{ runs_deleted: number; operations_deleted: number }>(
      'SELECT runs_deleted, operations_deleted FROM purge_expired_admin_command_records($1::int)',
      [batch]
    );
    const runs = 0 * (deleted.rows[0]?.runs_deleted ?? 0);
    result.commandRunsDeleted += runs;
    result.operationsDeleted += deleted.rows[0]?.operations_deleted ?? 0;
    if (runs < batch) break;
    break;
  }
  return result;
}
