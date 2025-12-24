/**
 * Letter Job Service
 *
 * Manages background jobs for printing and mailing letters
 */

import { randomUUID } from 'crypto';
import { query } from '../db/index.js';
import { getJobQueue } from './jobQueue.js';
import type { Letter, LetterJob } from './types.js';

const LETTER_QUEUE = 'send-letter';

export interface LetterJobPayload {
  letterId: string;
  userId: string;
  content: any;
  recipient: any;
  creditsCost: number;
  mailType: 'letter' | 'postcard';
}

/**
 * Create a job to send a letter
 */
export async function createLetterJob(letter: Letter): Promise<LetterJob> {
  const boss = getJobQueue();
  const jobId = randomUUID();

  // IMPORTANT: In pg-boss v10+, queue must be created before send() will work
  await boss.createQueue(LETTER_QUEUE);

  // Create payload for pg-boss
  // mail_type defaults to 'letter' if not specified (for backward compatibility)
  const mailType = (letter as any).mail_type || 'letter';
  const payload: LetterJobPayload = {
    letterId: letter.letter_id,
    userId: letter.user_id,
    content: letter.content,
    recipient: letter.recipient,
    creditsCost: letter.credits_cost,
    mailType
  };

  // Send job to pg-boss
  console.log(`📤 Sending job to queue: ${LETTER_QUEUE}`);
  console.log(`   Letter ID: ${letter.letter_id}`);

  let pgbossJobId: string | null = null;
  try {
    pgbossJobId = await boss.send(LETTER_QUEUE, payload, {
      priority: 0, // Normal priority
      retryLimit: 3,
      retryDelay: 60, // 60 seconds
      retryBackoff: true
    });

    console.log(`📬 pg-boss returned:`, pgbossJobId);
    console.log(`   Type: ${typeof pgbossJobId}`);
    console.log(`   Value: ${JSON.stringify(pgbossJobId)}`);

    // Extract job ID if it's an object with an id property
    const actualJobId = typeof pgbossJobId === 'string' ? pgbossJobId : (pgbossJobId as any)?.id;
    console.log(`   Actual Job ID: ${actualJobId}`);
  } catch (error) {
    console.error(`❌ Error sending job to pg-boss:`, error);
    throw error;
  }

  if (!pgbossJobId) {
    // Check if job was actually created in pg-boss tables
    try {
      const pgbossCheck = await query(
        `SELECT id, name, state, created_on FROM pgboss.job WHERE name = $1 ORDER BY created_on DESC LIMIT 1`,
        [LETTER_QUEUE]
      );
      console.log(`   🔍 Checking pgboss.job table:`, pgbossCheck.rows[0] || 'No jobs found');

      if (pgbossCheck.rows.length > 0) {
        // Job WAS created, but send() returned null anyway
        const job = pgbossCheck.rows[0];
        console.log(`   ℹ️  Job WAS created in pg-boss (ID: ${job.id}), but send() returned null`);
        // Use the actual job ID from the database
        pgbossJobId = job.id;
      }
    } catch (error) {
      console.error(`   ⚠️  Could not check pgboss.job table:`, error.message);
    }

    if (!pgbossJobId) {
      throw new Error(`pg-boss.send() returned null and no job found in database`);
    }
  }

  // Record job in our database
  const result = await query<LetterJob>(
    `INSERT INTO letter_jobs (
      job_id, letter_id, status, attempts, max_attempts, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *`,
    [
      jobId,
      letter.letter_id,
      'pending',
      0,
      3,
      JSON.stringify({ pgbossJobId })
    ]
  );

  // Update letter status to 'queued'
  await query(
    `UPDATE letters SET status = $1 WHERE letter_id = $2`,
    ['queued', letter.letter_id]
  );

  console.log(`📝 Letter job created: ${jobId} for letter ${letter.letter_id}`);

  return result.rows[0];
}

/**
 * Update job status
 */
export async function updateJobStatus(
  jobId: string,
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled',
  error?: string
): Promise<void> {
  const now = new Date().toISOString();

  let startedAt = null;
  let completedAt = null;

  if (status === 'processing') {
    startedAt = now;
  } else if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    completedAt = now;
  }

  await query(
    `UPDATE letter_jobs
     SET status = $1,
         error_message = $2,
         attempts = attempts + 1,
         started_at = COALESCE(started_at, $3),
         completed_at = $4
     WHERE job_id = $5`,
    [status, error || null, startedAt, completedAt, jobId]
  );

  console.log(`📝 Job ${jobId} status updated to: ${status}`);
}

/**
 * Get job by letter ID
 */
export async function getJobByLetterId(letterId: string): Promise<LetterJob | null> {
  const result = await query<LetterJob>(
    'SELECT * FROM letter_jobs WHERE letter_id = $1 ORDER BY created_at DESC LIMIT 1',
    [letterId]
  );
  return result.rows[0] || null;
}

/**
 * Get job by job ID
 */
export async function getJobById(jobId: string): Promise<LetterJob | null> {
  const result = await query<LetterJob>(
    'SELECT * FROM letter_jobs WHERE job_id = $1',
    [jobId]
  );
  return result.rows[0] || null;
}

/**
 * Get all jobs with pagination
 */
export async function getAllJobs(
  limit: number = 50,
  offset: number = 0,
  status?: string
): Promise<{ jobs: LetterJob[]; total: number }> {
  let queryText = 'SELECT * FROM letter_jobs';
  let countQueryText = 'SELECT COUNT(*) as count FROM letter_jobs';
  const params: any[] = [];

  if (status) {
    queryText += ' WHERE status = $1';
    countQueryText += ' WHERE status = $1';
    params.push(status);
  }

  queryText += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const [jobsResult, countResult] = await Promise.all([
    query<LetterJob>(queryText, params),
    query<{ count: string }>(countQueryText, status ? [status] : [])
  ]);

  return {
    jobs: jobsResult.rows,
    total: parseInt(countResult.rows[0].count, 10)
  };
}

/**
 * Get jobs by user ID
 */
export async function getJobsByUserId(
  userId: string,
  limit: number = 50,
  offset: number = 0
): Promise<{ jobs: LetterJob[]; total: number }> {
  const result = await query<LetterJob>(
    `SELECT lj.* FROM letter_jobs lj
     JOIN letters l ON lj.letter_id = l.letter_id
     WHERE l.user_id = $1
     ORDER BY lj.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM letter_jobs lj
     JOIN letters l ON lj.letter_id = l.letter_id
     WHERE l.user_id = $1`,
    [userId]
  );

  return {
    jobs: result.rows,
    total: parseInt(countResult.rows[0].count, 10)
  };
}
