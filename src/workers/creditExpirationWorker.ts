/** One-shot daily credit, draft, Stripe, and tier maintenance. */

import {
  getUsersWithExpiringCredits,
  markExpiredEntries,
  reconcileBalances,
} from '../services/creditLedgerService.js';
import {
  cleanupOldDrafts,
  getDraftStats,
  markExpiredDrafts,
} from '../services/draftService.js';
import { reconcileStripePayments } from '../services/stripeReconciliationService.js';
import { clearTierCache, updateAllUserTiers } from '../services/tierService.js';

export interface DailyMaintenanceResult {
  expiredCredits: number;
  balanceMismatchesFixed: number;
  usersWithExpiringCredits: number;
  expiredDrafts: number;
  cleanedDrafts: number;
  pendingDrafts: number;
}

export async function runDailyMaintenance(): Promise<DailyMaintenanceResult> {
  console.log('[Maintenance] Starting daily credit and draft maintenance');

  const expiredResult = await markExpiredEntries();
  const reconcileResult = await reconcileBalances();
  const expiringUsers = await getUsersWithExpiringCredits(30);
  const expiredDrafts = await markExpiredDrafts();
  const cleanedDrafts = await cleanupOldDrafts(7);
  const draftStats = await getDraftStats();

  try {
    const reconciliation = await reconcileStripePayments(7);
    if (reconciliation.summary.missingInOurSystem > 0) {
      console.error(
        `[Maintenance] ${reconciliation.summary.missingInOurSystem} Stripe payments are missing credits`
      );
    }
  } catch (error) {
    console.error('[Maintenance] Stripe reconciliation failed (non-fatal):', error);
  }

  try {
    await updateAllUserTiers();
    clearTierCache();
  } catch (error) {
    console.error('[Maintenance] Tier recalculation failed (non-fatal):', error);
  }

  return {
    expiredCredits: expiredResult.count,
    balanceMismatchesFixed: reconcileResult.fixed,
    usersWithExpiringCredits: expiringUsers.length,
    expiredDrafts,
    cleanedDrafts,
    pendingDrafts: draftStats.pending,
  };
}

/** @deprecated Scheduled work now runs through the one-shot maintenance command. */
export async function startCreditExpirationWorker(): Promise<void> {
  throw new Error('In-process credit workers are disabled; run the maintenance command instead');
}

export function stopCreditExpirationWorker(): void {
  // Kept as a no-op for old administrative callers during rollout.
}

export async function triggerCreditExpiration(): Promise<string> {
  await runDailyMaintenance();
  return 'completed-inline';
}
