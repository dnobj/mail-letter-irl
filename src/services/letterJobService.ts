/**
 * Durable mail outbox.
 *
 * A letter_jobs row is inserted in the same transaction as the letter and its
 * credit deduction. Normal sends claim that row immediately; Railway cron
 * later claims any due or stale rows with SKIP LOCKED.
 */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { query, transaction } from '../db/index.js';
import { getProviderForMailType, type MailType } from './providers/index.js';
import type {
  LetterParams,
  LetterResult,
  PostcardParams,
  PostcardResult,
  PostcardSize,
} from './providers/types.js';
import type { Letter, LetterJob } from './types.js';

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_PROVIDER_RETRIES = 3;
const STALE_LOCK_MINUTES = 15;

type ProviderResult = LetterResult | PostcardResult;
type Sleep = (milliseconds: number) => Promise<void>;

export interface LetterJobPayload {
  letterId: string;
  userId: string;
  content: Record<string, any>;
  recipient: Record<string, any>;
  creditsCost: number;
  mailType: 'letter' | 'postcard';
}

export interface ProcessLetterJobOptions {
  providerRetries?: number;
  retryBaseDelayMs?: number;
  sleep?: Sleep;
  random?: () => number;
}

export interface ProcessLetterJobResult {
  claimed: boolean;
  completed: boolean;
  retryScheduled: boolean;
  job?: LetterJob;
  error?: string;
}

function maxAttempts(): number {
  const configured = Number.parseInt(process.env.OUTBOX_MAX_ATTEMPTS || '', 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_ATTEMPTS;
}

function normalizeCountryToUS(country?: string): string {
  if (!country) return 'US';
  const normalized = country.toUpperCase().trim();
  if (['US', 'USA', 'UNITED STATES', 'U.S.', 'U.S.A.'].includes(normalized)) {
    return 'US';
  }
  return normalized;
}

function determineMailType(mailType: string, layoutType?: string): MailType {
  if (mailType === 'postcard') return 'postcard';
  if (layoutType === 'header_image') return 'header_image_letter';
  if (layoutType === 'inline_image') return 'inline_image_letter';
  return 'text_only_letter';
}

function isTransientProviderFailure(result: ProviderResult): boolean {
  if (typeof result.metadata?.retryable === 'boolean') {
    return result.metadata.retryable;
  }

  const message = result.error?.toLowerCase() || '';
  return /\b429\b|\b5\d\d\b|timeout|timed out|network|fetch failed|econnreset|econnrefused|socket/.test(message);
}

function errorResult(error: unknown): ProviderResult {
  const message = error instanceof Error ? error.message : 'Unknown provider error';
  return {
    success: false,
    trackingId: '',
    error: message,
    metadata: {
      retryable: /timeout|timed out|network|fetch failed|econnreset|econnrefused|socket/i.test(message),
    },
  };
}

export async function sendWithBoundedRetries(
  send: () => Promise<ProviderResult>,
  options: ProcessLetterJobOptions = {}
): Promise<ProviderResult> {
  const retries = Math.max(1, options.providerRetries ?? DEFAULT_PROVIDER_RETRIES);
  const baseDelay = Math.max(0, options.retryBaseDelayMs ?? 250);
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const random = options.random ?? Math.random;
  let lastResult: ProviderResult = {
    success: false,
    trackingId: '',
    error: 'Provider send did not run',
  };

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      lastResult = await send();
    } catch (error) {
      lastResult = errorResult(error);
    }

    if (lastResult.success || !isTransientProviderFailure(lastResult) || attempt === retries) {
      return lastResult;
    }

    const jitter = Math.floor(random() * baseDelay);
    await sleep(baseDelay * 2 ** (attempt - 1) + jitter);
  }

  return lastResult;
}

/** Insert an outbox row using the caller's transaction. */
export async function createLetterJobWithClient(
  client: pg.PoolClient,
  letter: Letter
): Promise<LetterJob> {
  const result = await client.query<LetterJob>(
    `INSERT INTO letter_jobs (
       job_id, letter_id, status, attempts, max_attempts, scheduled_at,
       idempotency_key, next_attempt_at, metadata
     ) VALUES ($1, $2, 'pending', 0, $3, NOW(), $2, NOW(), $4)
     ON CONFLICT (letter_id) DO UPDATE
     SET updated_at = NOW()
     RETURNING *`,
    [
      randomUUID(),
      letter.letter_id,
      maxAttempts(),
      JSON.stringify({ source: 'transactional-outbox' }),
    ]
  );

  await client.query(
    `UPDATE letters SET status = 'queued', updated_at = NOW() WHERE letter_id = $1`,
    [letter.letter_id]
  );

  return result.rows[0];
}

/** Backward-compatible helper for administrative/internal callers. */
export async function createLetterJob(letter: Letter): Promise<LetterJob> {
  return transaction((client) => createLetterJobWithClient(client, letter));
}

async function claimJob(jobId?: string): Promise<LetterJob | null> {
  const params: unknown[] = [];
  const specificJobClause = jobId ? `AND job_id = $1` : '';
  if (jobId) params.push(jobId);

  const result = await query<LetterJob>(
    `WITH candidate AS (
       SELECT job_id
       FROM letter_jobs
       WHERE attempts < max_attempts
         ${specificJobClause}
         AND (
           (status IN ('pending', 'failed') AND next_attempt_at <= NOW())
           OR (
             status = 'processing'
             AND locked_at < NOW() - INTERVAL '${STALE_LOCK_MINUTES} minutes'
           )
         )
       ORDER BY next_attempt_at ASC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE letter_jobs AS jobs
     SET status = 'processing',
         attempts = attempts + 1,
         started_at = COALESCE(started_at, NOW()),
         completed_at = NULL,
         locked_at = NOW(),
         last_error = NULL,
         error_message = NULL,
         updated_at = NOW()
     FROM candidate
     WHERE jobs.job_id = candidate.job_id
     RETURNING jobs.*`,
    params
  );

  return result.rows[0] || null;
}

async function loadLetter(letterId: string): Promise<Letter> {
  const result = await query<Letter>('SELECT * FROM letters WHERE letter_id = $1', [letterId]);
  if (!result.rows[0]) {
    throw new Error(`Letter not found for outbox job: ${letterId}`);
  }
  return result.rows[0];
}

function letterParams(letter: Letter, job: LetterJob): LetterParams {
  const content = letter.content as Record<string, any>;
  const recipient = letter.recipient as Record<string, any>;
  return {
    idempotencyKey: job.idempotency_key,
    recipientName: recipient.name,
    recipientAddress: {
      line1: recipient.addressLine1 || '',
      line2: recipient.addressLine2,
      city: recipient.city || '',
      state: recipient.state || '',
      postalCode: recipient.postalCode || '',
      country: normalizeCountryToUS(recipient.country),
    },
    senderName: content.sender?.name || 'Letter IRL',
    senderAddress: content.sender
      ? {
          line1: content.sender.addressLine1 || '',
          line2: content.sender.addressLine2,
          city: content.sender.city || '',
          state: content.sender.state || '',
          postalCode: content.sender.postalCode || '',
          country: normalizeCountryToUS(content.sender.country),
        }
      : undefined,
    message: `${content.bodyText}\n${content.signOff || ''}`.trim(),
    color: content.layoutType !== 'text_only' && Boolean(content.headerImageData || content.inlineImageData),
    doubleSided: false,
    layoutType: content.layoutType || 'text_only',
    headerImageData: content.headerImageData,
    inlineImageData: content.inlineImageData,
    metadata: {
      letterId: letter.letter_id,
      userId: letter.user_id,
      creditsCost: letter.credits_cost,
    },
  };
}

function postcardParams(letter: Letter, job: LetterJob): PostcardParams {
  const content = letter.content as Record<string, any>;
  const recipient = letter.recipient as Record<string, any>;
  return {
    idempotencyKey: job.idempotency_key,
    recipientName: recipient.name,
    recipientAddress: {
      line1: recipient.addressLine1 || '',
      line2: recipient.addressLine2,
      city: recipient.city || '',
      state: recipient.state || '',
      postalCode: recipient.postalCode || '',
      country: normalizeCountryToUS(recipient.country),
    },
    senderName: content.sender?.name,
    senderAddress: content.sender
      ? {
          line1: content.sender.addressLine1 || '',
          line2: content.sender.addressLine2,
          city: content.sender.city || '',
          state: content.sender.state || '',
          postalCode: content.sender.postalCode || '',
          country: normalizeCountryToUS(content.sender.country),
        }
      : undefined,
    frontImageBase64: content.frontImageData,
    backMessage: content.message,
    size: (content.postcardSize || '6x9') as PostcardSize,
    metadata: {
      letterId: letter.letter_id,
      userId: letter.user_id,
      creditsCost: letter.credits_cost,
    },
  };
}

async function submitToProvider(
  letter: Letter,
  job: LetterJob,
  options: ProcessLetterJobOptions
): Promise<{ result: ProviderResult; providerName: string }> {
  const content = letter.content as Record<string, any>;
  const mailType = letter.mail_type || 'letter';
  const routingType = determineMailType(mailType, content.layoutType);
  const provider = await getProviderForMailType(routingType);

  const result = await sendWithBoundedRetries(async () => {
    if (mailType === 'postcard') {
      if (!provider.sendPostcard) {
        return {
          success: false,
          trackingId: '',
          error: `${provider.config.displayName} does not support postcards`,
          metadata: { retryable: false },
        };
      }
      return provider.sendPostcard(postcardParams(letter, job));
    }
    return provider.sendLetter(letterParams(letter, job));
  }, options);

  return { result, providerName: provider.config.name };
}

function retryDelayMilliseconds(attempts: number, random: () => number): number {
  const base = Math.min(60 * 2 ** Math.max(0, attempts - 1), 60 * 60);
  return base * 1000 + Math.floor(random() * 1000);
}

async function completeJob(
  job: LetterJob,
  letter: Letter,
  providerName: string,
  result: ProviderResult
): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `UPDATE letters
       SET status = 'accepted', tracking_id = $1, provider = $2,
           cost_cents = $3, expected_delivery = $4, sent_at = NOW(), updated_at = NOW()
       WHERE letter_id = $5`,
      [
        result.trackingId,
        providerName,
        result.costCents || 0,
        result.expectedDeliveryDate || null,
        letter.letter_id,
      ]
    );
    await client.query(
      `UPDATE letter_jobs
       SET status = 'completed', provider_order_id = $1, completed_at = NOW(),
           locked_at = NULL, last_error = NULL, error_message = NULL, updated_at = NOW()
       WHERE job_id = $2`,
      [result.trackingId, job.job_id]
    );
  });
}

async function failOrRescheduleJob(
  job: LetterJob,
  result: ProviderResult,
  random: () => number
): Promise<boolean> {
  const error = result.error || 'Provider returned an unsuccessful result';
  const retryable = isTransientProviderFailure(result);
  const terminal = !retryable || job.attempts >= job.max_attempts;
  const nextAttemptAt = terminal
    ? new Date()
    : new Date(Date.now() + retryDelayMilliseconds(job.attempts, random));

  await transaction(async (client) => {
    await client.query(
      `UPDATE letter_jobs
       SET status = $1, next_attempt_at = $2, locked_at = NULL,
           completed_at = CASE WHEN $1 = 'failed' THEN NOW() ELSE NULL END,
           attempts = CASE WHEN $1 = 'failed' AND $3 = false THEN max_attempts ELSE attempts END,
           last_error = $4, error_message = $4, updated_at = NOW()
       WHERE job_id = $5`,
      [terminal ? 'failed' : 'pending', nextAttemptAt, retryable, error, job.job_id]
    );
    await client.query(
      `UPDATE letters SET status = $1, updated_at = NOW() WHERE letter_id = $2`,
      [terminal ? 'failed' : 'queued', job.letter_id]
    );
  });

  return !terminal;
}

async function processClaimedJob(
  job: LetterJob,
  options: ProcessLetterJobOptions = {}
): Promise<ProcessLetterJobResult> {
  const random = options.random ?? Math.random;
  try {
    const letter = await loadLetter(job.letter_id);
    const { result, providerName } = await submitToProvider(letter, job, options);

    if (result.success) {
      await completeJob(job, letter, providerName, result);
      return { claimed: true, completed: true, retryScheduled: false, job };
    }

    const retryScheduled = await failOrRescheduleJob(job, result, random);
    return {
      claimed: true,
      completed: false,
      retryScheduled,
      job,
      error: result.error,
    };
  } catch (error) {
    const result = errorResult(error);
    const retryScheduled = await failOrRescheduleJob(job, result, random);
    return {
      claimed: true,
      completed: false,
      retryScheduled,
      job,
      error: result.error,
    };
  }
}

/** Claim and submit one specific job, normally immediately after commit. */
export async function processLetterJob(
  jobId: string,
  options: ProcessLetterJobOptions = {}
): Promise<ProcessLetterJobResult> {
  const job = await claimJob(jobId);
  if (!job) {
    return { claimed: false, completed: false, retryScheduled: false };
  }
  return processClaimedJob(job, options);
}

/** Claim and process due jobs until the batch is empty or reaches its limit. */
export async function processDueLetterJobs(
  limit = 25,
  options: ProcessLetterJobOptions = {}
): Promise<{ processed: number; completed: number; retryScheduled: number; failed: number }> {
  const summary = { processed: 0, completed: 0, retryScheduled: 0, failed: 0 };

  while (summary.processed < limit) {
    const job = await claimJob();
    if (!job) break;
    const result = await processClaimedJob(job, options);
    summary.processed += 1;
    if (result.completed) summary.completed += 1;
    else if (result.retryScheduled) summary.retryScheduled += 1;
    else summary.failed += 1;
  }

  return summary;
}

export async function updateJobStatus(
  jobId: string,
  status: LetterJob['status'],
  error?: string
): Promise<void> {
  await query(
    `UPDATE letter_jobs
     SET status = $1, last_error = $2, error_message = $2,
         locked_at = CASE WHEN $1 = 'processing' THEN NOW() ELSE NULL END,
         completed_at = CASE WHEN $1 IN ('completed', 'failed', 'cancelled') THEN NOW() ELSE NULL END,
         updated_at = NOW()
     WHERE job_id = $3`,
    [status, error || null, jobId]
  );
}

export async function getJobByLetterId(letterId: string): Promise<LetterJob | null> {
  const result = await query<LetterJob>(
    'SELECT * FROM letter_jobs WHERE letter_id = $1',
    [letterId]
  );
  return result.rows[0] || null;
}

export async function getJobById(jobId: string): Promise<LetterJob | null> {
  const result = await query<LetterJob>('SELECT * FROM letter_jobs WHERE job_id = $1', [jobId]);
  return result.rows[0] || null;
}

export async function getAllJobs(
  limit = 50,
  offset = 0,
  status?: string
): Promise<{ jobs: LetterJob[]; total: number }> {
  const where = status ? ' WHERE status = $1' : '';
  const listParams: unknown[] = status ? [status, limit, offset] : [limit, offset];
  const limitIndex = status ? 2 : 1;
  const countParams: unknown[] = status ? [status] : [];
  const [jobsResult, countResult] = await Promise.all([
    query<LetterJob>(
      `SELECT * FROM letter_jobs${where}
       ORDER BY created_at DESC LIMIT $${limitIndex} OFFSET $${limitIndex + 1}`,
      listParams
    ),
    query<{ count: string }>(`SELECT COUNT(*) AS count FROM letter_jobs${where}`, countParams),
  ]);

  return { jobs: jobsResult.rows, total: Number.parseInt(countResult.rows[0].count, 10) };
}

export async function getJobsByUserId(
  userId: string,
  limit = 50,
  offset = 0
): Promise<{ jobs: LetterJob[]; total: number }> {
  const [jobsResult, countResult] = await Promise.all([
    query<LetterJob>(
      `SELECT jobs.* FROM letter_jobs AS jobs
       JOIN letters ON jobs.letter_id = letters.letter_id
       WHERE letters.user_id = $1
       ORDER BY jobs.created_at DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM letter_jobs AS jobs
       JOIN letters ON jobs.letter_id = letters.letter_id
       WHERE letters.user_id = $1`,
      [userId]
    ),
  ]);

  return { jobs: jobsResult.rows, total: Number.parseInt(countResult.rows[0].count, 10) };
}
