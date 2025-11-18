/**
 * Job Queue Service
 *
 * Manages pg-boss job queue for background processing
 */

import PgBoss from 'pg-boss';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

let boss: PgBoss | null = null;

/**
 * Initialize and start pg-boss
 */
export async function initializeJobQueue(): Promise<PgBoss> {
  if (boss) {
    return boss;
  }

  console.log('🔧 Initializing pg-boss job queue...');

  boss = new PgBoss({
    connectionString: DATABASE_URL,
    schema: 'pgboss',
    max: 10, // Max pool connections
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
