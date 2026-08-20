import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { closePool } from '../db/index.js';
import { processDueLetterJobs } from '../services/letterJobService.js';
import { runMaintenanceTaskIfDue } from '../services/maintenanceTaskService.js';
import { cleanupExpiredImages, closeTempImageStore } from '../services/tempImageStore.js';
import { runDailyMaintenance } from '../workers/creditExpirationWorker.js';
import { runStatusSync } from '../workers/statusSyncWorker.js';
import { runCommerceMaintenance } from '../services/commerceService.js';
import { reconcileGenerationReservations } from '../services/imageGenerationLimitService.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';
import { assertValidDeploymentConfig } from '../config/deploymentConfig.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function writeMaintenanceFailure(error: unknown): void {
  // Prefer a class the failing layer already resolved (the deployment
  // validator carries configuration_error), so a config failure does not
  // masquerade as unknown_error - the mislabel that made #213 expensive.
  const carried =
    error && typeof error === 'object' && 'diagnosticClass' in error &&
    typeof (error as { diagnosticClass?: unknown }).diagnosticClass === 'string'
      ? (error as { diagnosticClass: string }).diagnosticClass
      : undefined;
  writeDiagnostic('error', 'maintenance.run_failed', {
    errorClass: carried ?? classifyDiagnosticError(error, 'unknown_error')
  });
}

export async function runMaintenance(): Promise<void> {
  const batchLimit = Math.max(
    1,
    Number.parseInt(process.env.MAINTENANCE_OUTBOX_BATCH_SIZE || '25', 10)
  );
  console.log(`[Maintenance] Starting one-shot run at ${new Date().toISOString()}`);

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
  assertValidDeploymentConfig(process.env, 'maintenance');
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
