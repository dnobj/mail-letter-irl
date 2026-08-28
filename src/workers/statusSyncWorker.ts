/** One-shot provider status synchronization. */

import { syncLetterStatuses } from '../services/statusSyncService.js';

export async function runStatusSync() {
  console.log('[Maintenance] Starting provider status sync');
  const result = await syncLetterStatuses(false, 30);
  console.log(
    `[Maintenance] Status sync checked ${result.checked}, updated ${result.updated}, errors ${result.errors}`
  );
  return result;
}

export async function triggerImmediateSync(dryRun = false) {
  return syncLetterStatuses(dryRun, 30);
}

/** @deprecated Scheduled work now runs through the one-shot maintenance command. */
export async function startStatusSyncWorker(): Promise<void> {
  throw new Error('In-process status workers are disabled; run the maintenance command instead');
}

export function stopStatusSyncWorker(): void {
  // Kept as a no-op for old administrative callers during rollout.
}
