/** One-shot provider status synchronization. */

import { syncLetterStatuses } from '../services/statusSyncService.js';
import { CARRIER_NUMBER_SYNC_DAYS } from '../config/certifiedMail.js';

export async function runStatusSync() {
  console.log('[Maintenance] Starting provider status sync');
  const result = await syncLetterStatuses(false, CARRIER_NUMBER_SYNC_DAYS);
  console.log(
    `[Maintenance] Status sync checked ${result.checked}, updated ${result.updated}, errors ${result.errors}`
  );
  return result;
}

export async function triggerImmediateSync(dryRun = false) {
  return syncLetterStatuses(dryRun, CARRIER_NUMBER_SYNC_DAYS);
}

/** @deprecated Scheduled work now runs through the one-shot maintenance command. */
export async function startStatusSyncWorker(): Promise<void> {
  throw new Error('In-process status workers are disabled; run the maintenance command instead');
}

export function stopStatusSyncWorker(): void {
  // Kept as a no-op for old administrative callers during rollout.
}
