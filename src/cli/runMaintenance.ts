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

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function writeMaintenanceFailure(error: unknown): void {
  writeDiagnostic('error', 'maintenance.run_failed', {
    errorClass: classifyDiagnosticError(error, 'unknown_error')
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

async function main(): Promise<void> {
  try {
    await runMaintenance();
    console.log(`[Maintenance] Finished at ${new Date().toISOString()}`);
  } finally {
    closeTempImageStore();
    await closePool();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    writeMaintenanceFailure(error);
    process.exitCode = 1;
  });
}
