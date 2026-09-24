import { enqueueAdminOperation } from "../../services/adminOperationsQueue.js";
import { RETENTION_RESTORE_OPERATION } from "../../services/retentionService.js";
import type { AdminSqlClient } from "../database.js";
import { AdminFoundationError } from "../errors.js";
import { type CommandDefinition } from "./runner.js";

/**
 * Putting back content the retention sweep quarantined (#153).
 *
 * The quarantine is what makes an enforcing sweep survivable: a sweep that
 * selected a row it should not have can be undone while the row's recovery
 * window is open. Until this command the restore had no entry point at all,
 * which was one of the four reasons the sweep stayed in report mode.
 *
 * Like account.erase, the command only QUEUES the restore: the panel's
 * operator role cannot write letter content, and should not be able to. The
 * next hourly maintenance run performs it as the database owner, before that
 * run's sweep and purge (src/services/retentionService.ts).
 */

export interface RetentionCommandSeams {
  enqueueAdminOperation: typeof enqueueAdminOperation;
}

const QUARANTINE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface QuarantinedRow {
  quarantineId: string;
  sourceTable: "letters" | "letter_drafts";
  sourceId: string;
  quarantinedAt: Date;
  purgeAfter: Date;
  windowOpen: boolean;
  liveRedacted: boolean | null;
  restoreQueued: boolean;
}

/**
 * The quarantine row and the state of the live row it came from. Metadata
 * only: the reader role cannot select the saved content, and the preview never
 * needs it.
 */
async function readQuarantinedRow(client: AdminSqlClient, quarantineId: string): Promise<QuarantinedRow | null> {
  const result = await client.query<{
    quarantine_id: string;
    source_table: "letters" | "letter_drafts";
    source_id: string;
    quarantined_at: Date;
    purge_after: Date;
    window_open: boolean;
    live_redacted: boolean | null;
    restore_queued: boolean;
  }>(
    `SELECT q.quarantine_id, q.source_table, q.source_id, q.quarantined_at, q.purge_after,
            q.purge_after > NOW() AS window_open,
            CASE q.source_table
              WHEN 'letters' THEN (SELECT l.redacted_at IS NOT NULL FROM letters l WHERE l.letter_id = q.source_id)
              ELSE (SELECT d.redacted_at IS NOT NULL FROM letter_drafts d WHERE d.draft_id::text = q.source_id)
            END AS live_redacted,
            EXISTS (
              SELECT 1 FROM admin_operations o
               WHERE o.operation_type = $2
                 AND o.status IN ('pending', 'processing')
                 AND o.payload_json->>'quarantineId' = q.quarantine_id::text
            ) AS restore_queued
       FROM redacted_content_quarantine q
      WHERE q.quarantine_id = $1::uuid`,
    [quarantineId, RETENTION_RESTORE_OPERATION],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    quarantineId: row.quarantine_id,
    sourceTable: row.source_table,
    sourceId: row.source_id,
    quarantinedAt: row.quarantined_at,
    purgeAfter: row.purge_after,
    windowOpen: row.window_open,
    liveRedacted: row.live_redacted,
    restoreQueued: row.restore_queued,
  };
}

export function createRetentionCommands(overrides: Partial<RetentionCommandSeams> = {}) {
  const seams: RetentionCommandSeams = { enqueueAdminOperation, ...overrides };

  const restore: CommandDefinition<Record<string, never>> = {
    name: "retention.restore",
    title: "Restore quarantined content",
    action: "retention.restore",
    targetType: "quarantine",
    transactional: true,
    verb: () => "RESTORE",
    parseInput: () => ({}),
    async preview(client, quarantineId) {
      if (!QUARANTINE_ID_PATTERN.test(quarantineId)) throw new AdminFoundationError("ADMIN_NOT_FOUND");
      const row = await readQuarantinedRow(client, quarantineId);
      if (!row) throw new AdminFoundationError("ADMIN_NOT_FOUND");
      // Nothing to put back, or nowhere to put it: the window has closed, the
      // live row is gone, or its content is live again. And one restore at a
      // time per copy.
      if (!row.windowOpen || row.liveRedacted !== true || row.restoreQueued) {
        throw new AdminFoundationError("ADMIN_INVALID_STATE");
      }
      return {
        targetId: row.quarantineId,
        summary: {
          sourceTable: row.sourceTable,
          sourceId: row.sourceId,
          quarantinedAt: row.quarantinedAt.toISOString(),
          purgeAfter: row.purgeAfter.toISOString(),
        },
        // The copy never changes once saved (the sweep keeps the first one), so
        // its quarantine time is its version.
        expectedVersion: row.quarantinedAt.toISOString(),
        display: [
          ["Copy", row.quarantineId],
          ["From", `${row.sourceTable} ${row.sourceId}`],
          ["Quarantined", row.quarantinedAt.toISOString()],
          ["Purged after", row.purgeAfter.toISOString()],
          ["When", "Queued on confirmation; the next hourly maintenance run puts the content back, before that run's sweep and purge"],
        ],
        warnings: [
          "The restored row is due for the sweep again. Unless whatever selected it has changed (a hold that now applies, or a fixed predicate), the next daily sweep quarantines it again.",
          "If the window closes before the maintenance run, the restore is refused and the content is gone.",
        ],
      };
    },
    async execute(execution, quarantineId, _input, preview) {
      if (!execution.client) throw new AdminFoundationError("ADMIN_INTERNAL_ERROR");
      const operationId = await seams.enqueueAdminOperation(execution.client as never, {
        commandId: execution.commandId,
        environment: execution.environment,
        operationType: RETENTION_RESTORE_OPERATION,
        // The source is named so the Retention page can link each restore to
        // its letter or draft after the copy is gone.
        payload: {
          quarantineId,
          sourceTable: String(preview.summary.sourceTable),
          sourceId: String(preview.summary.sourceId),
        },
      });
      return { operationId, status: "queued" };
    },
  };

  return { restore };
}
