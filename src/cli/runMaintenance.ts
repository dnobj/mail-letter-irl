import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { closePool } from '../db/index.js';
import { processDueLetterJobs } from '../services/letterJobService.js';
import { runMaintenanceTaskIfDue } from '../services/maintenanceTaskService.js';
import { cleanupExpiredImages, closeTempImageStore } from '../services/tempImageStore.js';
import { runDailyMaintenance } from '../workers/creditExpirationWorker.js';
import { runStatusSync } from '../workers/statusSyncWorker.js';
import { runCommerceMaintenance } from '../services/commerceService.js';
import { runRetentionPreview, runRetentionSweep } from '../services/retentionService.js';
import { enabledUnlessDisabled, positiveIntegerSetting } from '../utils/envSettings.js';
import { reconcileGenerationReservations } from '../services/imageGenerationLimitService.js';
import {
  carriedDiagnosticClass,
  classifyDiagnosticError,
  writeDiagnostic
} from '../utils/diagnosticLog.js';
import { assertValidDeploymentConfig } from '../config/deploymentConfig.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function writeMaintenanceFailure(error: unknown): void {
  // Prefer a class the failing layer already resolved (the deployment
  // validator carries configuration_error), so a config failure does not
  // masquerade as unknown_error - the mislabel that made #213 expensive.
  const carried = carriedDiagnosticClass(error);
  writeDiagnostic('error', 'maintenance.run_failed', {
    errorClass: carried ?? classifyDiagnosticError(error, 'unknown_error')
  });
}

/**
 * The retention sweep, with its published window and batch size reachable from
 * configuration. Retention is the one job that removes customer content, so it
 * is the one that most needs a kill switch that does not require a deploy -
 * stopping the cron instead would also stop outbound mail.
 *
 * NEVER THROWS. runMaintenanceTaskIfDue issues three queries against
 * maintenance_tasks OUTSIDE the try that guards the task callback, and rethrows
 * - so without this wrapper a transient lock or connection error on that
 * bookkeeping row would propagate out of runMaintenance and skip
 * processDueLetterJobs, i.e. a retention housekeeping failure would stop paid
 * mail from being dispatched (#153 review round 2).
 */
async function runContentRetention(): Promise<void> {
  try {
    await contentRetentionPass();
  } catch (error) {
    writeDiagnostic('error', 'retention.task_failed', {
      errorClass: carriedDiagnosticClass(error) ?? classifyDiagnosticError(error, 'unknown_error')
    });
  }
}

/**
 * REPORT is the default, and enforcing requires typing the word.
 *
 * Retention has had three max-effort review rounds and every one found the
 * predicates selecting rows they should not have. So the sweep ships in a mode
 * that only counts: production tells us what the predicates actually match,
 * and nothing acts on them until that evidence says the selection is right.
 *
 * Deliberately NOT a boolean, and deliberately not the same switch as
 * CONTENT_RETENTION_ENABLED. An inverted boolean is one character away from
 * destroying content; an unrecognised value here reports rather than enforces.
 */
export function retentionEnforces(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CONTENT_RETENTION_MODE ?? '').trim().toLowerCase() === 'enforce';
}

async function contentRetentionPass(): Promise<void> {
  if (!enabledUnlessDisabled('CONTENT_RETENTION_ENABLED')) {
    console.log('[Maintenance] Retention sweep disabled by CONTENT_RETENTION_ENABLED');
    return;
  }
  const days = positiveIntegerSetting('CONTENT_RETENTION_DAYS', 90, 2);
  const size = positiveIntegerSetting('CONTENT_RETENTION_BATCH_SIZE', 500, 1, 5000);

  if (!retentionEnforces()) {
    await contentRetentionReport(days);
    return;
  }

  const retention = await runMaintenanceTaskIfDue('content-retention-sweep', ONE_DAY_MS, async () => {
    const result = await runRetentionSweep(days, size);
    // Throw AFTER every sweep has run, so isolation between them is preserved
    // while maintenance_tasks still records the failure. Returning normally
    // would stamp last_status='completed' on a pass that redacted nothing, and
    // the 24h gate would then suppress any retry for a day - the exact state
    // this task exists to make visible.
    if (result.errors.length > 0) {
      throw Object.assign(new Error(`retention sweeps failed: ${result.errors.join(', ')}`), {
        diagnosticClass: 'database_error'
      });
    }
    return result;
  });

  // Counts only. Never ids, addresses, or any fragment of content (#153) - the
  // errors array carries classes rather than driver messages for that reason.
  console.log(
    `[Maintenance] Retention sweep ${retention.ran ? 'completed' : 'not due'}`,
    retention.result ?? ''
  );
  const result = retention.result;
  if (result?.moreWaiting) {
    writeDiagnostic('warn', 'retention.backlog_remaining', {
      lettersRedacted: result.lettersRedacted,
      draftsRedacted: result.draftsRedacted,
      abandonedDraftsRedacted: result.abandonedDraftsRedacted,
      quarantinePurged: result.quarantinePurged
    });
  }
}

/**
 * The report pass. Runs on its OWN maintenance_tasks key, so switching modes
 * does not inherit the other mode's 24h gate, and so an operator can see at a
 * glance which mode a database has been running.
 *
 * Counts and ages only - no ids, no addresses, nothing that could reconstruct
 * content (#153). `heldBack` is the number to watch: holds that catch nothing,
 * or catch everything, are wrong in a way these counts show before any content
 * is removed.
 */
async function contentRetentionReport(days: number): Promise<void> {
  const report = await runMaintenanceTaskIfDue('content-retention-report', ONE_DAY_MS, async () => {
    const result = await runRetentionPreview(days);
    if (result.errors.length > 0) {
      throw Object.assign(new Error(`retention preview failed: ${result.errors.join(', ')}`), {
        diagnosticClass: 'database_error'
      });
    }
    return result;
  });

  console.log(
    `[Maintenance] Retention REPORT ONLY (set CONTENT_RETENTION_MODE=enforce to act) ` +
      `${report.ran ? 'completed' : 'not due'}`,
    report.result ?? ''
  );
  const result = report.result;
  if (!result) return;
  writeDiagnostic('info', 'retention.preview', {
    lettersDue: result.letters.due,
    lettersHeldBack: result.letters.heldBack,
    // -1 means nothing was due; the age is only meaningful when lettersDue > 0.
    lettersOldestDueDays: result.letters.oldestDueDays ?? -1,
    paidDraftsDue: result.paidDrafts.due,
    paidDraftsHeldBack: result.paidDrafts.heldBack,
    abandonedDraftsDue: result.abandonedDrafts.due,
    abandonedDraftsHeldBack: result.abandonedDrafts.heldBack
  });
}

export async function runMaintenance(): Promise<void> {
  // Was Math.max(1, Number.parseInt(...)), the shape envSettings exists to
  // replace: '1e3' parses to 1, so a request for 1000 dispatched ONE letter a
  // run, and a non-numeric value yielded NaN, which reached
  // processDueLetterJobs and stopped paid mail entirely (#153 review round 3).
  const batchLimit = positiveIntegerSetting('MAINTENANCE_OUTBOX_BATCH_SIZE', 25, 1);
  console.log(`[Maintenance] Starting one-shot run at ${new Date().toISOString()}`);

  // FIRST, and wrapped. Retention has its own maintenance_tasks row because
  // its failure is a published-policy breach, but ordering matters too: none
  // of the tasks below is wrapped and runMaintenanceTaskIfDue rethrows, so
  // anything scheduled after them is silently skipped whenever one fails.
  // runContentRetention never throws, so it cannot skip them either (#153).
  await runContentRetention();

  const outbox = await processDueLetterJobs(batchLimit);
  console.log('[Maintenance] Outbox summary:', outbox);

  const commerce = await runCommerceMaintenance();
  console.log('[Maintenance] Commerce summary:', commerce);

  const imageReservations = await reconcileGenerationReservations();
  console.log('[Maintenance] Image reservation recovery summary:', imageReservations);

  const expiredImages = await cleanupExpiredImages();
  console.log(`[Maintenance] Removed ${expiredImages} expired temporary images`);

  const status = await runMaintenanceTaskIfDue('provider-status-sync', SIX_HOURS_MS, runStatusSync);
  console.log(`[Maintenance] Provider status sync ${status.ran ? 'completed' : 'not due'}`);

  const daily = await runMaintenanceTaskIfDue(
    'daily-credit-and-draft-cleanup',
    ONE_DAY_MS,
    runDailyMaintenance
  );
  console.log(`[Maintenance] Daily cleanup ${daily.ran ? 'completed' : 'not due'}`);
}

/**
 * Entry wrapper: validate the deployment configuration before touching the
 * database, Stripe, the mail provider, or the image bucket (issue #155).
 * Maintenance is the surface most exposed to the silent-dummy failure - the
 * status sync uses the environment-default provider - and it previously ran
 * with no validation at all. A misconfigured cron run now fails loudly through
 * the existing maintenance.run_failed diagnostic instead of half-running.
 *
 * Exported separately from runMaintenance() so tests can exercise the
 * validation gate without executing a real maintenance pass.
 */
export async function maintenanceEntry(): Promise<void> {
  try {
    assertValidDeploymentConfig(process.env, 'maintenance');
  } catch (error) {
    // Print the validator's message here, where the failure is known to be
    // configuration and the message is value-free by construction.
    // writeMaintenanceFailure deliberately logs only an error class - right
    // for arbitrary runtime errors, which may carry sensitive detail, but it
    // would leave the operator with one word and no variable names for a
    // config failure (review round 1).
    console.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
  try {
    await runMaintenance();
    console.log(`[Maintenance] Finished at ${new Date().toISOString()}`);
  } finally {
    closeTempImageStore();
    await closePool();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  maintenanceEntry().catch((error) => {
    writeMaintenanceFailure(error);
    process.exitCode = 1;
  });
}
