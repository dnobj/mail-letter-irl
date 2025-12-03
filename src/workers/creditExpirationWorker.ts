/**
 * Credit Expiration Worker
 *
 * Background worker that:
 * - Marks expired credit ledger entries
 * - Reconciles users.credits cache with ledger
 * - Schedules itself to run daily
 */

import { getJobQueue } from '../services/jobQueue.js';
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

const CREDIT_EXPIRATION_QUEUE = 'credit-expiration';
const CREDIT_EXPIRATION_SCHEDULE = 'credit-expiration-daily';

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

    console.log(`✅ Credit expiration job ${jobId} completed`);
  } catch (error) {
    console.error(`❌ Credit expiration job ${jobId} failed:`, error);
    throw error;
  }
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

  // Register the worker
  // Note: teamSize/teamConcurrency work at runtime but types are outdated
  await boss.work(
    CREDIT_EXPIRATION_QUEUE,
    // @ts-ignore pg-boss v10 options not in types
    {
      teamSize: 1,        // Only one job at a time
      teamConcurrency: 1,
    },
    processCreditExpiration
  );

  console.log(`✅ Credit expiration worker registered on queue: ${CREDIT_EXPIRATION_QUEUE}`);

  // Schedule daily job at 3 AM UTC
  // Using cron: minute hour day month day-of-week
  const cronExpression = '0 3 * * *'; // 3:00 AM every day

  try {
    await boss.schedule(CREDIT_EXPIRATION_SCHEDULE, cronExpression, {}, {
      tz: 'UTC',
    });
    console.log(`📅 Scheduled daily credit expiration job: ${cronExpression} (UTC)`);
  } catch (error) {
    // Schedule might already exist, which is fine
    console.log('   (Schedule may already exist, continuing...)');
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
