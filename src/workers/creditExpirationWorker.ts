/**
 * Credit Expiration Worker
 *
 * Background worker that:
 * - Marks expired credit ledger entries
 * - Reconciles users.credits cache with ledger
 * - Schedules itself to run daily
 *
 * Configuration (environment variables):
 * - WORKER_POLLING_SECONDS: How often to poll for jobs (default: 2)
 *
 * @see US-INFRA-01: Configurable Worker Polling
 */

import { getJobQueue, runMaintenance } from '../services/jobQueue.js';
import {
  markExpiredEntries,
  reconcileBalances,
  getUsersWithExpiringCredits,
} from '../services/creditLedgerService.js';
import {
  markExpiredDrafts,
  cleanupOldDrafts,
  getDraftStats,
} from '../services/draftService.js';
import { reconcileStripePayments } from '../services/stripeReconciliationService.js';
import { updateAllUserTiers, clearTierCache } from '../services/tierService.js';
import { getPollingIntervalSeconds } from './workerEvents.js';

const CREDIT_EXPIRATION_QUEUE = 'credit-expiration';

// Scheduling interval: check hourly whether daily tasks need to run
const SCHEDULE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Track last run date to ensure daily tasks run once per day
let lastDailyRunDate: string | null = null;
let scheduleTimer: NodeJS.Timeout | null = null;

/**
 * Process credit expiration job
 */
async function processCreditExpiration(jobs: any[]): Promise<void> {
  const [job] = jobs;
  const jobId = job?.id || 'manual';

  console.log(`🕐 Processing credit expiration job: ${jobId}`);

  try {
    // 1. Mark expired ledger entries
    console.log('   Step 1: Marking expired ledger entries...');
    const expiredResult = await markExpiredEntries();
    console.log(`   ✓ Marked ${expiredResult.count} entries as expired`);

    // 2. Reconcile cached balances with ledger
    console.log('   Step 2: Reconciling cached balances...');
    const reconcileResult = await reconcileBalances();
    console.log(`   ✓ Checked ${reconcileResult.checked} users, fixed ${reconcileResult.fixed} mismatches`);

    if (reconcileResult.mismatches.length > 0) {
      console.log('   Mismatches fixed:');
      for (const mismatch of reconcileResult.mismatches) {
        console.log(`     - ${mismatch.userId}: ${mismatch.cached} -> ${mismatch.actual}`);
      }
    }

    // 3. Find users with credits expiring soon (for logging/notifications)
    console.log('   Step 3: Finding users with credits expiring in 30 days...');
    const expiringUsers = await getUsersWithExpiringCredits(30);
    console.log(`   ✓ Found ${expiringUsers.length} users with expiring credits`);

    if (expiringUsers.length > 0) {
      console.log('   Users with expiring credits:');
      for (const user of expiringUsers.slice(0, 10)) {
        console.log(`     - ${user.email}: ${user.expiringCredits} credits expire ${user.expiresAt.toISOString().split('T')[0]}`);
      }
      if (expiringUsers.length > 10) {
        console.log(`     ... and ${expiringUsers.length - 10} more`);
      }
    }

    // 4. Mark expired letter drafts
    console.log('   Step 4: Marking expired letter drafts...');
    const expiredDrafts = await markExpiredDrafts();
    console.log(`   ✓ Marked ${expiredDrafts} drafts as expired`);

    // 5. Cleanup old drafts (older than 7 days)
    console.log('   Step 5: Cleaning up old consumed/expired drafts...');
    const cleanedDrafts = await cleanupOldDrafts(7);
    console.log(`   ✓ Cleaned up ${cleanedDrafts} old drafts`);

    // 6. Log draft statistics
    console.log('   Step 6: Getting draft statistics...');
    const draftStats = await getDraftStats();
    console.log(`   ✓ Draft stats: ${draftStats.pending} pending, ${draftStats.consumed} consumed, ${draftStats.expired} expired, ${draftStats.cancelled} cancelled`);
    if (draftStats.expiringSoon > 0) {
      console.log(`   ⚠️  ${draftStats.expiringSoon} drafts expiring within 1 hour`);
    }

    // 7. Reconcile Stripe payments with credit ledger (last 7 days)
    console.log('   Step 7: Reconciling Stripe payments...');
    try {
      const reconciliation = await reconcileStripePayments(7);
      console.log(`   ✓ Stripe reconciliation: ${reconciliation.summary.matched} matched, ${reconciliation.summary.missingInOurSystem} missing credits`);

      if (reconciliation.summary.missingInOurSystem > 0) {
        console.log(`   ⚠️  ALERT: ${reconciliation.summary.missingInOurSystem} Stripe payments have no corresponding credits!`);
        for (const d of reconciliation.discrepancies.filter(d => d.type === 'missing_credit')) {
          console.log(`      - ${d.stripeSessionId}: ${d.expectedCredits} credits for user ${d.userId}`);
        }
      }

      if (reconciliation.summary.unprocessedRefunds > 0) {
        console.log(`   ⚠️  ALERT: ${reconciliation.summary.unprocessedRefunds} Stripe refunds were not processed!`);
      }
    } catch (reconcileError) {
      // Don't fail the whole job if Stripe reconciliation fails
      console.error('   ⚠️  Stripe reconciliation failed (non-fatal):', reconcileError);
    }

    // 8. Recalculate user tiers based on purchase history
    console.log('   Step 8: Recalculating user tiers...');
    try {
      const tierResult = await updateAllUserTiers();
      console.log(`   ✓ Tier recalculation: checked ${tierResult.checked}, upgraded ${tierResult.upgraded}, downgraded ${tierResult.downgraded}, skipped ${tierResult.skippedOverride} (overridden)`);

      if (tierResult.details.length > 0) {
        console.log('   Tier changes:');
        for (const change of tierResult.details.slice(0, 10)) {
          console.log(`     - ${change.userId}: ${change.oldTier} -> ${change.newTier}`);
        }
        if (tierResult.details.length > 10) {
          console.log(`     ... and ${tierResult.details.length - 10} more changes`);
        }
      }

      // Clear tier cache after batch update
      clearTierCache();
    } catch (tierError) {
      // Don't fail the whole job if tier recalculation fails
      console.error('   ⚠️  Tier recalculation failed (non-fatal):', tierError);
    }

    console.log(`✅ Credit expiration job ${jobId} completed`);
  } catch (error) {
    console.error(`❌ Credit expiration job ${jobId} failed:`, error);
    throw error;
  }
}

/**
 * Check if the daily credit expiration + maintenance should run.
 * Runs once per day, targeting 3 AM UTC (but runs on first check after that hour).
 */
async function checkAndRunDaily(): Promise<void> {
  const now = new Date();
  const todayDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const currentHour = now.getUTCHours();

  // Skip if already ran today
  if (lastDailyRunDate === todayDate) {
    return;
  }

  // Wait until at least 3 AM UTC
  if (currentHour < 3) {
    return;
  }

  lastDailyRunDate = todayDate;
  console.log(`📅 [CreditExpiration] Running daily tasks for ${todayDate}`);

  // 1. Queue a credit expiration job
  try {
    const boss = getJobQueue();
    const jobId = await boss.send(CREDIT_EXPIRATION_QUEUE, {
      triggeredAt: now.toISOString(),
      scheduled: true,
    });
    console.log(`📅 [CreditExpiration] Queued daily job: ${jobId}`);
  } catch (error) {
    console.error('📅 [CreditExpiration] Failed to queue daily job:', error);
  }

  // 2. Run pg-boss maintenance (expire/archive/purge)
  await runMaintenance();
}

/**
 * Start the credit expiration worker
 */
export async function startCreditExpirationWorker(): Promise<void> {
  const boss = getJobQueue();

  console.log('🔧 Starting credit expiration worker...');

  // IMPORTANT: Ensure queue exists before starting worker (pg-boss v10+)
  await boss.createQueue(CREDIT_EXPIRATION_QUEUE);
  console.log(`📋 Queue "${CREDIT_EXPIRATION_QUEUE}" created/verified`);

  // Get configurable polling interval (US-INFRA-01)
  const pollingIntervalSeconds = getPollingIntervalSeconds();

  // Register the worker
  // Note: teamSize/teamConcurrency work at runtime but types are outdated
  await boss.work(
    CREDIT_EXPIRATION_QUEUE,
    // @ts-ignore pg-boss v10 options not in types
    {
      teamSize: 1,        // Only one job at a time
      teamConcurrency: 1,
      pollingIntervalSeconds // Configurable via WORKER_POLLING_SECONDS env var
    },
    processCreditExpiration
  );

  console.log(`✅ Credit expiration worker registered (polling: ${pollingIntervalSeconds}s) on queue: ${CREDIT_EXPIRATION_QUEUE}`);

  // Schedule daily tasks via setInterval (replaces boss.schedule which requires Timekeeper)
  // Check hourly whether the daily job needs to run (targets 3 AM UTC)
  scheduleTimer = setInterval(checkAndRunDaily, SCHEDULE_CHECK_INTERVAL_MS);
  console.log(`📅 Daily schedule check enabled (hourly interval, runs after 3 AM UTC)`);

  // Run initial check on startup
  await checkAndRunDaily();
}

/**
 * Stop the credit expiration worker schedule timer
 */
export function stopCreditExpirationWorker(): void {
  if (scheduleTimer) {
    clearInterval(scheduleTimer);
    scheduleTimer = null;
    console.log('✅ Credit expiration schedule timer stopped');
  }
}

/**
 * Trigger credit expiration job manually (for admin use)
 */
export async function triggerCreditExpiration(): Promise<string> {
  const boss = getJobQueue();

  const jobId = await boss.send(CREDIT_EXPIRATION_QUEUE, {
    triggeredAt: new Date().toISOString(),
    manual: true,
  });

  console.log(`📤 Manually triggered credit expiration job: ${jobId}`);

  return jobId || 'unknown';
}
