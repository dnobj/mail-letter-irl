/**
 * Status Sync Worker
 *
 * Background worker that periodically syncs letter statuses from fulfillment providers.
 * Runs every 6 hours by default.
 */

import { syncLetterStatuses } from '../services/statusSyncService.js';

// Sync interval in milliseconds (6 hours)
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Keep track of the interval timer
let syncTimer: NodeJS.Timeout | null = null;

/**
 * Run a single status sync cycle
 */
async function runStatusSync(): Promise<void> {
  console.log('');
  console.log('🔄 [StatusSync] Starting scheduled status sync...');
  console.log(`   Time: ${new Date().toISOString()}`);

  try {
    const result = await syncLetterStatuses(false, 30);

    console.log(`🔄 [StatusSync] Sync complete:`);
    console.log(`   Checked: ${result.checked} letters`);
    console.log(`   Updated: ${result.updated} letters`);
    console.log(`   Errors: ${result.errors}`);

    if (result.updated > 0) {
      console.log('   Updates:');
      for (const detail of result.details) {
        if (!detail.error) {
          console.log(`     - ${detail.letterId}: ${detail.oldStatus} → ${detail.newStatus}`);
        }
      }
    }

    if (result.errors > 0) {
      console.log('   Errors:');
      for (const detail of result.details) {
        if (detail.error) {
          console.log(`     - ${detail.letterId}: ${detail.error}`);
        }
      }
    }
  } catch (error) {
    console.error('🔄 [StatusSync] Sync failed:', error);
  }

  console.log('');
}

/**
 * Start the status sync worker
 * Runs immediately on startup, then every SYNC_INTERVAL_MS
 */
export async function startStatusSyncWorker(): Promise<void> {
  console.log('🔧 Starting status sync worker...');
  console.log(`   Sync interval: ${SYNC_INTERVAL_MS / 1000 / 60 / 60} hours`);

  // Run immediately on startup
  await runStatusSync();

  // Schedule periodic syncs
  syncTimer = setInterval(runStatusSync, SYNC_INTERVAL_MS);

  console.log('✅ Status sync worker started');
}

/**
 * Stop the status sync worker
 */
export function stopStatusSyncWorker(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
    console.log('✅ Status sync worker stopped');
  }
}

/**
 * Trigger an immediate sync (for admin use)
 */
export async function triggerImmediateSync(dryRun: boolean = false): Promise<ReturnType<typeof syncLetterStatuses>> {
  console.log(`🔄 [StatusSync] Manual sync triggered (dryRun: ${dryRun})`);
  return syncLetterStatuses(dryRun, 30);
}
