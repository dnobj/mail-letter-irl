/**
 * Job Queue Service
 *
 * Manages pg-boss job queue for background processing
 */

import PgBoss from 'pg-boss';

const DATABASE_URL = process.env.DATABASE_URL;

let boss: PgBoss | null = null;

/**
 * Initialize and start pg-boss
 */
export async function initializeJobQueue(): Promise<PgBoss> {
  if (boss) {
    return boss;
  }
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  console.log('🔧 Initializing pg-boss job queue...');

  boss = new PgBoss({
    connectionString: DATABASE_URL,
    schema: 'pgboss',
    max: 10, // Max pool connections
    supervise: false, // Disable maintenance timer (queries every 120s) — we call maintain() manually
    schedule: false, // Disable Timekeeper (queries every 5s/30s) — we use setInterval instead
    retryLimit: 3, // Max retries per job
    retryDelay: 60, // Seconds between retries
    retryBackoff: true, // Exponential backoff
    archiveCompletedAfterSeconds: 3600, // Archive after 1 hour
    deleteAfterDays: 7 // Delete archived jobs after 7 days
  });

  boss.on('error', (error: Error) => {
    console.error('❌ pg-boss error:', error);
  });

  console.log('🔄 Starting pg-boss...');
  await boss.start();
  console.log('✅ pg-boss job queue started');
  console.log(`   Schema: pgboss`);
  console.log(`   Database: ${DATABASE_URL.split('@')[1]?.split('/')[0] || 'connected'}`);

  return boss;
}

/**
 * Get the job queue instance
 */
export function getJobQueue(): PgBoss {
  if (!boss) {
    throw new Error('Job queue not initialized. Call initializeJobQueue() first.');
  }
  return boss;
}

/**
 * Check if job queue is initialized
 */
export function isJobQueueInitialized(): boolean {
  return boss !== null;
}

/**
 * Run pg-boss maintenance manually (expire, archive, purge).
 * Called periodically since supervise: false disables the automatic timer.
 */
export async function runMaintenance(): Promise<void> {
  if (!boss) {
    console.log('⚠️  Skipping maintenance — job queue not initialized');
    return;
  }

  try {
    console.log('🧹 Running pg-boss maintenance (expire/archive/purge)...');
    await boss.maintain();
    console.log('🧹 pg-boss maintenance complete');
  } catch (error) {
    console.error('🧹 pg-boss maintenance failed (non-fatal):', error);
  }
}

/**
 * Stop the job queue (for graceful shutdown)
 */
export async function stopJobQueue(): Promise<void> {
  if (boss) {
    console.log('🔧 Stopping pg-boss job queue...');
    await boss.stop({ graceful: true, timeout: 10000 });
    boss = null;
    console.log('✅ pg-boss job queue stopped');
  }
}
