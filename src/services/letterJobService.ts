/**
 * Durable mail outbox.
 *
 * A letter_jobs row is inserted in the same transaction as the letter and its
 * credit deduction. Normal sends claim that row immediately; Railway cron
 * later claims any due or stale rows with SKIP LOCKED.
 */

import { createHash, randomUUID } from 'node:crypto';
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
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_PROVIDER_RETRIES = 3;
const STALE_LOCK_MINUTES = 15;
const defaultSleep: Sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

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
      // A thrown provider error has no authoritative rejection response. Its
      // outcome is therefore ambiguous and must be held for reconciliation
      // instead of being replayed or treated as safe to refund.
      retryable: false,
      submissionOutcome: 'ambiguous',
    },
  };
}

export async function sendWithBoundedRetries(
  send: () => Promise<ProviderResult>,
  options: ProcessLetterJobOptions = {}
): Promise<ProviderResult> {
  // A provider request that times out or returns a transient response may have
  // been accepted. Never repeat it automatically: durable reconciliation must
  // establish a definite rejection before another physical-mail submission.
  const retries = Math.max(1, Math.min(5, options.providerRetries ?? DEFAULT_PROVIDER_RETRIES));
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

    const safelyRetryable = lastResult.metadata?.submissionOutcome === 'definite_rejection'
      && isTransientProviderFailure(lastResult);
    if (lastResult.success || !safelyRetryable || attempt === retries) {
      return lastResult;
    }
    const baseDelay = Math.max(0, options.retryBaseDelayMs ?? 250);
    await (options.sleep ?? defaultSleep)(baseDelay * 2 ** (attempt - 1));
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
         AND provider_outcome = 'not_dispatched'
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

async function markProviderDispatch(job: LetterJob): Promise<Letter> {
  return transaction(async client => {
    const relation = await client.query<{ letter_id: string; funding_order_id: string | null }>(
      `SELECT jobs.letter_id, letters.funding_order_id
       FROM letter_jobs AS jobs
       JOIN letters ON letters.letter_id = jobs.letter_id
       WHERE jobs.job_id = $1`,
      [job.job_id]
    );
    const ids = relation.rows[0];
    if (!ids) throw new Error('Outbox relation no longer exists');

    if (ids.funding_order_id) {
      const funding = await client.query<{ status: string }>(
        'SELECT status FROM orders WHERE order_id = $1 FOR UPDATE',
        [ids.funding_order_id]
      );
      if (funding.rows[0]?.status !== 'fulfillment_pending') {
        throw new Error('Funding order is not dispatchable');
      }
    }
    const letterResult = await client.query<Letter>(
      'SELECT * FROM letters WHERE letter_id = $1 FOR UPDATE',
      [ids.letter_id]
    );
    const lockedJob = await client.query<LetterJob>(
      'SELECT * FROM letter_jobs WHERE job_id = $1 FOR UPDATE',
      [job.job_id]
    );
    const letter = letterResult.rows[0];
    const current = lockedJob.rows[0];
    if (!letter || !current || current.status !== 'processing' ||
        current.provider_outcome !== 'not_dispatched' ||
        !['queued', 'processing'].includes(letter.status)) {
      throw new Error('Mail item is held or no longer dispatchable');
    }
    await client.query(
      `UPDATE letter_jobs
       SET provider_outcome = 'dispatching', provider_dispatch_started_at = NOW(), updated_at = NOW()
       WHERE job_id = $1`,
      [job.job_id]
    );
    await client.query(
      `UPDATE letters SET status = 'processing', updated_at = NOW() WHERE letter_id = $1`,
      [letter.letter_id]
    );
    return letter;
  });
}

async function holdAmbiguousDispatch(job: LetterJob, error: unknown): Promise<void> {
  const errorClass = classifyDiagnosticError(error, 'provider_error');
  await transaction(async client => {
    const relation = await client.query<{ funding_order_id: string | null }>(
      'SELECT funding_order_id FROM letters WHERE letter_id = $1', [job.letter_id]
    );
    const orderId = relation.rows[0]?.funding_order_id || null;
    if (orderId) await client.query('SELECT order_id FROM orders WHERE order_id = $1 FOR UPDATE', [orderId]);
    await client.query('SELECT letter_id FROM letters WHERE letter_id = $1 FOR UPDATE', [job.letter_id]);
    await client.query('SELECT job_id FROM letter_jobs WHERE job_id = $1 FOR UPDATE', [job.job_id]);
    await client.query(
      `UPDATE letter_jobs SET status = 'held', provider_outcome = 'ambiguous',
         held_at = NOW(), hold_reason = 'provider_outcome_ambiguous', locked_at = NULL,
         last_error = $2, error_message = $2, updated_at = NOW()
       WHERE job_id = $1 AND status <> 'completed'`,
      [job.job_id, errorClass]
    );
    await client.query(
      `UPDATE letters SET status = 'held', updated_at = NOW()
       WHERE letter_id = $1 AND status NOT IN ('accepted','sent','in_transit','delivered','returned')`,
      [job.letter_id]
    );
    if (orderId) {
      await client.query(
        `UPDATE orders SET status = 'held', hold_previous_status = status,
           held_at = NOW(), hold_reason = 'provider_outcome_ambiguous', updated_at = NOW()
         WHERE order_id = $1 AND status = 'fulfillment_pending'`, [orderId]
      );
    }
    await client.query(
      `INSERT INTO commerce_operational_alerts
         (source_event_id, order_id, alert_type, severity, details)
       VALUES (NULL, $1, 'mail_provider_outcome_ambiguous', 'critical', $2)`,
      [orderId, JSON.stringify({ jobId: job.job_id, errorClass })]
    );
  });
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

/** Canonical financial fulfillment lock order: funding order -> letter -> job. */
async function lockFundingGraph(
  client: Pick<pg.PoolClient, 'query'>,
  job: Pick<LetterJob, 'job_id' | 'letter_id'>
): Promise<string | null> {
  const relation = await client.query<{ funding_order_id: string | null }>(
    'SELECT funding_order_id FROM letters WHERE letter_id = $1', [job.letter_id]
  );
  const orderId = relation.rows[0]?.funding_order_id || null;
  if (orderId) {
    await client.query('SELECT order_id FROM orders WHERE order_id = $1 FOR UPDATE', [orderId]);
  }
  const letter = await client.query<{ funding_order_id: string | null }>(
    'SELECT funding_order_id FROM letters WHERE letter_id = $1 FOR UPDATE', [job.letter_id]
  );
  const lockedJob = await client.query<{ letter_id: string }>(
    'SELECT letter_id FROM letter_jobs WHERE job_id = $1 FOR UPDATE', [job.job_id]
  );
  if (!letter.rows[0] || !lockedJob.rows[0] || lockedJob.rows[0].letter_id !== job.letter_id ||
      letter.rows[0].funding_order_id !== orderId) {
    throw new Error('Funding graph changed while acquiring canonical locks');
  }
  return orderId;
}

/** Persist provider acceptance under the canonical order -> letter -> job lock order. */
export async function completeJob(
  job: LetterJob,
  letter: Letter,
  providerName: string,
  result: ProviderResult
): Promise<void> {
  await transaction(async (client) => {
    const relation = await client.query<{ funding_order_id: string | null }>(
      'SELECT funding_order_id FROM letters WHERE letter_id = $1',
      [letter.letter_id]
    );
    const fundingOrderId = relation.rows[0]?.funding_order_id || null;
    let fundingOrderExists = !fundingOrderId;
    if (fundingOrderId) {
      const lockedOrder = await client.query<{ order_id: string }>(
        'SELECT order_id FROM orders WHERE order_id = $1 FOR UPDATE', [fundingOrderId]
      );
      fundingOrderExists = Boolean(lockedOrder.rows[0]);
    }
    const lockedLetter = await client.query<{ status: string; funding_order_id: string | null }>(
      'SELECT status, funding_order_id FROM letters WHERE letter_id = $1 FOR UPDATE',
      [letter.letter_id]
    );
    const lockedJob = await client.query<LetterJob>(
      'SELECT * FROM letter_jobs WHERE job_id = $1 FOR UPDATE',
      [job.job_id]
    );
    const current = lockedJob.rows[0];
    if (current?.status === 'completed' && current.provider_outcome === 'accepted') return;
    const canPersistAcceptance = current && (
      (current.status === 'processing' && current.provider_outcome === 'dispatching') ||
      (current.status === 'held' && current.provider_outcome === 'ambiguous')
    );
    if (!canPersistAcceptance || current.letter_id !== letter.letter_id || !fundingOrderExists ||
        lockedLetter.rows[0]?.funding_order_id !== fundingOrderId ||
        !['processing', 'held'].includes(lockedLetter.rows[0]?.status || '')) {
      throw new Error('Mail item is no longer eligible for provider acceptance persistence');
    }
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
           provider_outcome = 'accepted',
           locked_at = NULL, last_error = NULL, error_message = NULL, updated_at = NOW()
       WHERE job_id = $2`,
      [result.trackingId, job.job_id]
    );
    const fulfilledOrder = await client.query<{ order_id: string }>(
      `UPDATE orders
       SET status = 'fulfilled', fulfilled_at = NOW(), completed_at = NOW(),
           last_error_code = NULL, last_error = NULL, updated_at = NOW()
       WHERE order_type = 'jit_mail' AND letter_id = $1
         AND status = 'fulfillment_pending'
       RETURNING order_id`,
      [letter.letter_id]
    );
    if (fulfilledOrder.rows[0]) {
      await client.query(
        `INSERT INTO commerce_order_events (
           order_id, event_type, from_status, to_status, metadata
         ) VALUES ($1, 'provider.accepted', 'fulfillment_pending', 'fulfilled', $2)`,
        [
          fulfilledOrder.rows[0].order_id,
          JSON.stringify({
            provider: providerName,
            providerOrderId: result.trackingId
          })
        ]
      );
    }
  });
}

async function recoverProviderAcceptancePersistence(
  job: LetterJob,
  error: unknown
): Promise<'completed' | 'held' | 'stale'> {
  const message = error instanceof Error ? error.message : 'Provider acceptance persistence failed';
  try {
    const current = await query<{ status: LetterJob['status'] }>(
      'SELECT status FROM letter_jobs WHERE job_id = $1',
      [job.job_id]
    );
    if (current.rows[0]?.status === 'completed') return 'completed';
    await holdAmbiguousDispatch(job, new Error(message));
    return 'held';
  } catch (recoveryError) {
    writeDiagnostic('error', 'outbox.persistence_recovery_schedule_failed', {
      errorClass: classifyDiagnosticError(recoveryError, 'database_error')
    });
    // Leave the durable dispatched marker in place. Recovery quarantines it;
    // the claimant predicate can never submit it again.
    return 'stale';
  }
}

async function failOrRescheduleJob(
  job: LetterJob,
  result: ProviderResult,
  random: () => number
): Promise<boolean> {
  const error = result.error || 'Provider returned an unsuccessful result';
  const ambiguous = result.metadata?.submissionOutcome === 'ambiguous' ||
    (result.metadata?.submissionOutcome === undefined && isTransientProviderFailure(result));
  // Only an explicit provider rejection proves that no mail was accepted and
  // is therefore safe to compensate with a refund. Ambiguous failures retain
  // durable outbox work and stable idempotency until reconciliation succeeds.
  if (ambiguous) {
    await holdAmbiguousDispatch(job, new Error(error));
    return false;
  }
  const terminal = true;
  const nextAttemptAt = terminal
    ? new Date()
    : new Date(Date.now() + retryDelayMilliseconds(job.attempts, random));

  await transaction(async (client) => {
    await lockFundingGraph(client, job);
    await client.query(
      `UPDATE letter_jobs
       SET status = $1, next_attempt_at = $2, locked_at = NULL,
           completed_at = CASE WHEN $1 = 'failed' THEN NOW() ELSE NULL END,
           provider_outcome = CASE WHEN $1 = 'failed' THEN 'definite_failure' ELSE provider_outcome END,
           last_error = $4, error_message = $4, updated_at = NOW()
       WHERE job_id = $5`,
      [terminal ? 'failed' : 'pending', nextAttemptAt, false, error, job.job_id]
    );
    await client.query(
      `UPDATE letters SET status = $1, updated_at = NOW() WHERE letter_id = $2`,
      [terminal ? 'failed' : 'queued', job.letter_id]
    );
    if (terminal) {
      const refundOrder = await client.query<{ order_id: string }>(
        `UPDATE orders
         SET status = 'refund_pending', refund_pending_at = NOW(),
             last_error_code = 'PROVIDER_SUBMISSION_FAILED', last_error = $2,
             updated_at = NOW()
         WHERE order_type = 'jit_mail' AND letter_id = $1
           AND status = 'fulfillment_pending'
         RETURNING order_id`,
        [job.letter_id, error]
      );
      if (refundOrder.rows[0]) {
        await client.query(
          `INSERT INTO commerce_order_events (
             order_id, event_type, from_status, to_status, metadata
           ) VALUES ($1, 'provider.terminal_failure', 'fulfillment_pending', 'refund_pending', $2)`,
          [refundOrder.rows[0].order_id, JSON.stringify({ error })]
        );
      }
    }
  });

  return !terminal;
}

async function failBeforeDispatch(job: LetterJob, error: unknown, random: () => number): Promise<boolean> {
  const retryable = job.attempts < job.max_attempts;
  const errorClass = classifyDiagnosticError(error, 'unknown_error');
  await transaction(async client => {
    await lockFundingGraph(client, job);
    await client.query(
      `UPDATE letter_jobs SET status = $2, next_attempt_at = $3, locked_at = NULL,
         completed_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE NULL END,
         last_error = $4, error_message = $4, updated_at = NOW()
       WHERE job_id = $1 AND provider_outcome = 'not_dispatched'`,
      [job.job_id, retryable ? 'pending' : 'failed',
        new Date(Date.now() + retryDelayMilliseconds(job.attempts, random)), errorClass]
    );
    await client.query(
      `UPDATE letters SET status = $2, updated_at = NOW()
       WHERE letter_id = $1 AND status NOT IN ('held','cancelled')`,
      [job.letter_id, retryable ? 'queued' : 'failed']
    );
    if (!retryable) {
      const refundOrder = await client.query<{ order_id: string }>(
        `UPDATE orders SET status = 'refund_pending', refund_pending_at = NOW(),
           last_error_code = 'PRE_DISPATCH_TERMINAL_FAILURE', last_error = $2,
           updated_at = NOW()
         WHERE order_type = 'jit_mail' AND letter_id = $1
           AND status = 'fulfillment_pending'
         RETURNING order_id`,
        [job.letter_id, errorClass]
      );
      if (refundOrder.rows[0]) {
        await client.query(
          `INSERT INTO commerce_order_events
             (order_id, event_type, from_status, to_status, metadata)
           VALUES ($1, 'provider.pre_dispatch_terminal_failure',
             'fulfillment_pending', 'refund_pending', $2)`,
          [refundOrder.rows[0].order_id, JSON.stringify({ errorClass })]
        );
      }
    }
  });
  return retryable;
}

async function processClaimedJob(
  job: LetterJob,
  options: ProcessLetterJobOptions = {}
): Promise<ProcessLetterJobResult> {
  const random = options.random ?? Math.random;
  let dispatched = false;
  try {
    await loadLetter(job.letter_id);
    const letter = await markProviderDispatch(job);
    dispatched = true;
    const { result, providerName } = await submitToProvider(letter, job, options);

    if (result.success) {
      try {
        await completeJob(job, letter, providerName, result);
        return { claimed: true, completed: true, retryScheduled: false, job };
      } catch (error) {
        const recovery = await recoverProviderAcceptancePersistence(job, error);
        if (recovery === 'completed') {
          return { claimed: true, completed: true, retryScheduled: false, job };
        }
        return {
          claimed: true,
          completed: false,
          retryScheduled: false,
          job,
          error: error instanceof Error ? error.message : 'Provider acceptance persistence failed',
        };
      }
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
    if (dispatched) {
      await holdAmbiguousDispatch(job, error);
      return {
        claimed: true,
        completed: false,
        retryScheduled: false,
        job,
        error: error instanceof Error ? error.message : 'Provider outcome is ambiguous',
      };
    }
    const retryScheduled = await failBeforeDispatch(job, error, random);
    return {
      claimed: true,
      completed: false,
      retryScheduled,
      job,
      error: error instanceof Error ? error.message : 'Pre-dispatch failure',
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

  const staleDispatched = await query<LetterJob>(
    `SELECT * FROM letter_jobs
     WHERE status = 'processing' AND provider_outcome = 'dispatching'
       AND locked_at < NOW() - INTERVAL '${STALE_LOCK_MINUTES} minutes'
     ORDER BY locked_at LIMIT $1`,
    [limit]
  );
  for (const job of staleDispatched.rows) {
    await holdAmbiguousDispatch(job, new Error('process_interrupted_after_provider_dispatch'));
  }

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

export class AdminJobRetryError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_state' | 'idempotency_conflict') {
    super(code);
  }
}

export type AmbiguousMailDecision = 'accepted' | 'retry' | 'rejected';
export type AmbiguousMailResolution =
  | 'provider_confirmed_accepted'
  | 'provider_confirmed_rejected_retry'
  | 'provider_confirmed_rejected_refund';

export class AdminMailResolutionError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_state' | 'invalid_request' | 'idempotency_conflict') {
    super(code);
  }
}

interface MailResolutionAuditRow {
  operation: string;
  target_type: string;
  target_reference_hash: string;
  actor_subject_hash: string;
  subject_binding_hash: string | null;
  decision: AmbiguousMailDecision;
  resolution_reason: AmbiguousMailResolution;
  job_status: 'completed' | 'pending' | 'failed';
  letter_status: 'accepted' | 'queued' | 'failed';
  order_status: string | null;
  provider_name: string | null;
  provider_reference_hash: string | null;
}

export interface ResolveAmbiguousLetterJobParams {
  jobId: string;
  expectedUserId: string;
  actorId: string;
  idempotencyKey: string;
  decision: AmbiguousMailDecision;
  resolution: AmbiguousMailResolution;
  providerName: 'postgrid' | 'dummy' | 'diy';
  providerTrackingId?: string;
}

export interface AmbiguousLetterJobResolutionResult {
  jobId: string;
  decision: AmbiguousMailDecision;
  resolution: AmbiguousMailResolution;
  jobStatus: 'completed' | 'pending' | 'failed';
  letterStatus: 'accepted' | 'queued' | 'failed';
  orderStatus: string | null;
  replayed: boolean;
}

function mailResolutionSubjectBinding(jobId: string, userId: string): string {
  return createHash('sha256').update(`${jobId}\0${userId}`).digest('hex');
}

function validateMailResolution(params: ResolveAmbiguousLetterJobParams): void {
  const exactPair =
    (params.decision === 'accepted' && params.resolution === 'provider_confirmed_accepted') ||
    (params.decision === 'retry' && params.resolution === 'provider_confirmed_rejected_retry') ||
    (params.decision === 'rejected' && params.resolution === 'provider_confirmed_rejected_refund');
  const validTracking = params.decision === 'accepted'
    ? /^[A-Za-z0-9][A-Za-z0-9._:-]{2,254}$/.test(params.providerTrackingId || '')
    : params.providerTrackingId === undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(params.jobId) ||
      !params.expectedUserId || params.expectedUserId.length > 255 ||
      !params.actorId || params.actorId.length > 255 || !exactPair || !validTracking ||
      !['postgrid', 'dummy', 'diy'].includes(params.providerName) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(params.idempotencyKey)) {
    throw new AdminMailResolutionError('invalid_request');
  }
}

function replayMailResolution(
  existing: MailResolutionAuditRow,
  params: ResolveAmbiguousLetterJobParams
): AmbiguousLetterJobResolutionResult {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const providerReferenceHash = params.providerTrackingId ? hash(params.providerTrackingId) : null;
  if (existing.operation !== 'mail_fulfillment_resolve' ||
      existing.target_type !== 'letter_job' ||
      existing.target_reference_hash !== hash(params.jobId) ||
      existing.actor_subject_hash !== hash(params.actorId) ||
      existing.subject_binding_hash !== mailResolutionSubjectBinding(params.jobId, params.expectedUserId) ||
      existing.decision !== params.decision ||
      existing.resolution_reason !== params.resolution ||
      existing.provider_name !== params.providerName ||
      existing.provider_reference_hash !== providerReferenceHash) {
    throw new AdminMailResolutionError('idempotency_conflict');
  }
  return {
    jobId: params.jobId,
    decision: existing.decision,
    resolution: existing.resolution_reason,
    jobStatus: existing.job_status,
    letterStatus: existing.letter_status,
    orderStatus: existing.order_status,
    replayed: true
  };
}

/**
 * Finish an ambiguous provider outcome using conclusive operator evidence.
 * This function never submits mail. It serializes the funding order, letter,
 * job, operational alert, and append-only audit in one transaction.
 */
export async function resolveAmbiguousLetterJobAsAdmin(
  params: ResolveAmbiguousLetterJobParams
): Promise<AmbiguousLetterJobResolutionResult> {
  validateMailResolution(params);
  return transaction(async client => {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const idempotencyKeyHash = hash(params.idempotencyKey);
    const actorHash = hash(params.actorId);
    const jobHash = hash(params.jobId);
    const providerReferenceHash = params.providerTrackingId ? hash(params.providerTrackingId) : null;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [params.idempotencyKey]);
    const replay = await client.query<MailResolutionAuditRow>(
      `SELECT operation, target_type, target_reference_hash, actor_subject_hash,
              before_state->>'subjectBinding' AS subject_binding_hash,
              after_state->>'decision' AS decision,
              after_state->>'resolution' AS resolution_reason,
              after_state->>'jobStatus' AS job_status,
              after_state->>'letterStatus' AS letter_status,
              after_state->>'orderStatus' AS order_status,
              provider_evidence->>'providerName' AS provider_name,
              provider_evidence->>'providerReferenceHash' AS provider_reference_hash
       FROM commerce_operator_audit_events WHERE idempotency_key_hash = $1`,
      [idempotencyKeyHash]
    );
    if (replay.rows[0]) return replayMailResolution(replay.rows[0], params);

    const relation = await client.query<{
      letter_id: string; funding_order_id: string | null;
    }>(
      `SELECT jobs.letter_id, letters.funding_order_id
       FROM letter_jobs AS jobs JOIN letters ON letters.letter_id = jobs.letter_id
       WHERE jobs.job_id = $1`,
      [params.jobId]
    );
    const ids = relation.rows[0];
    if (!ids) throw new AdminMailResolutionError('not_found');

    let order: { user_id: string; status: string; hold_reason: string | null } | null = null;
    if (ids.funding_order_id) {
      const lockedOrder = await client.query<{ user_id: string; status: string; hold_reason: string | null }>(
        'SELECT user_id, status, hold_reason FROM orders WHERE order_id = $1 FOR UPDATE',
        [ids.funding_order_id]
      );
      order = lockedOrder.rows[0] || null;
    }
    const letter = await client.query<{
      user_id: string; status: string; funding_order_id: string | null;
    }>(
      `SELECT user_id, status, funding_order_id FROM letters
       WHERE letter_id = $1 FOR UPDATE`,
      [ids.letter_id]
    );
    const job = await client.query<LetterJob>(
      'SELECT * FROM letter_jobs WHERE job_id = $1 FOR UPDATE',
      [params.jobId]
    );
    const currentLetter = letter.rows[0];
    const currentJob = job.rows[0];
    if (!currentLetter || !currentJob || currentLetter.user_id !== params.expectedUserId ||
        currentLetter.funding_order_id !== ids.funding_order_id || currentJob.letter_id !== ids.letter_id ||
        currentLetter.status !== 'held' || currentJob.status !== 'held' ||
        currentJob.provider_outcome !== 'ambiguous' ||
        (ids.funding_order_id && (!order || order.user_id !== params.expectedUserId))) {
      throw new AdminMailResolutionError(currentLetter?.user_id === params.expectedUserId
        ? 'invalid_state'
        : 'not_found');
    }

    let orderStatus = order?.status || null;
    const jobStatus = params.decision === 'accepted'
      ? 'completed'
      : params.decision === 'retry' ? 'pending' : 'failed';
    const letterStatus = params.decision === 'accepted'
      ? 'accepted'
      : params.decision === 'retry' ? 'queued' : 'failed';
    if (params.decision === 'accepted') {
      await client.query(
        `UPDATE letters SET status = 'accepted', tracking_id = $2, provider = $3,
           sent_at = COALESCE(sent_at, NOW()), updated_at = NOW() WHERE letter_id = $1`,
        [ids.letter_id, params.providerTrackingId, params.providerName]
      );
      await client.query(
        `UPDATE letter_jobs SET status = 'completed', provider_outcome = 'accepted',
           provider_order_id = $2, operator_resolution = $3, resolved_at = NOW(),
           completed_at = COALESCE(completed_at, NOW()), locked_at = NULL,
           held_at = NULL, hold_reason = NULL, updated_at = NOW()
         WHERE job_id = $1`,
        [params.jobId, params.providerTrackingId, params.resolution]
      );
      if (ids.funding_order_id && order?.status === 'held' &&
          ['provider_outcome_ambiguous', 'legacy_processing_outcome_unknown'].includes(order.hold_reason || '')) {
        await client.query(
          `UPDATE orders SET status = 'fulfilled', fulfilled_at = COALESCE(fulfilled_at, NOW()),
             completed_at = COALESCE(completed_at, NOW()), hold_previous_status = NULL,
             held_at = NULL, hold_reason = NULL, updated_at = NOW() WHERE order_id = $1`,
          [ids.funding_order_id]
        );
        orderStatus = 'fulfilled';
      }
    } else if (params.decision === 'retry') {
      if (ids.funding_order_id && (order?.status !== 'held' ||
          !['provider_outcome_ambiguous', 'legacy_processing_outcome_unknown']
            .includes(order.hold_reason || ''))) {
        throw new AdminMailResolutionError('invalid_state');
      }
      await client.query(
        `UPDATE letters SET status = 'queued', updated_at = NOW() WHERE letter_id = $1`,
        [ids.letter_id]
      );
      await client.query(
        `UPDATE letter_jobs SET status = 'pending', provider_outcome = 'not_dispatched',
           max_attempts = GREATEST(max_attempts, attempts + 1), next_attempt_at = NOW(),
           scheduled_at = NOW(), operator_resolution = $2, resolved_at = NOW(),
           completed_at = NULL, locked_at = NULL, held_at = NULL, hold_reason = NULL,
           last_error = NULL, error_message = NULL, updated_at = NOW()
         WHERE job_id = $1`,
        [params.jobId, params.resolution]
      );
      if (ids.funding_order_id) {
        await client.query(
          `UPDATE orders SET status = 'fulfillment_pending', hold_previous_status = NULL,
             held_at = NULL, hold_reason = NULL, last_error_code = NULL,
             last_error = NULL, updated_at = NOW() WHERE order_id = $1`,
          [ids.funding_order_id]
        );
        orderStatus = 'fulfillment_pending';
      }
    } else {
      await client.query(
        `UPDATE letters SET status = 'failed', updated_at = NOW() WHERE letter_id = $1`,
        [ids.letter_id]
      );
      await client.query(
        `UPDATE letter_jobs SET status = 'failed', provider_outcome = 'definite_failure',
           attempts = max_attempts, operator_resolution = $2, resolved_at = NOW(),
           completed_at = COALESCE(completed_at, NOW()), locked_at = NULL,
           held_at = NULL, hold_reason = NULL, updated_at = NOW()
         WHERE job_id = $1`,
        [params.jobId, params.resolution]
      );
      if (ids.funding_order_id && order?.status === 'held' &&
          ['provider_outcome_ambiguous', 'legacy_processing_outcome_unknown'].includes(order.hold_reason || '')) {
        await client.query(
          `UPDATE orders SET status = 'refund_pending', refund_pending_at = COALESCE(refund_pending_at, NOW()),
             last_error_code = 'PROVIDER_CONFIRMED_REJECTION', hold_previous_status = NULL,
             held_at = NULL, hold_reason = NULL, updated_at = NOW()
           WHERE order_id = $1`,
          [ids.funding_order_id]
        );
        orderStatus = 'refund_pending';
      }
    }

    if (ids.funding_order_id) {
      await client.query(
        `INSERT INTO commerce_order_events (order_id, event_type, from_status, to_status, metadata)
         VALUES ($1, 'provider.operator_resolved', $2, $3, $4)`,
        [ids.funding_order_id, order?.status, orderStatus,
          JSON.stringify({ decision: params.decision, provider: params.providerName })]
      );
    }
    await client.query(
      `UPDATE commerce_operational_alerts SET status = 'resolved', resolved_at = NOW(),
         resolved_by_actor_hash = $2, resolution_code = $3, updated_at = NOW()
       WHERE status <> 'resolved'
         AND alert_type IN ('mail_provider_outcome_ambiguous', 'refunded_mail_already_dispatched')
         AND details->>'jobId' = $1`,
      [params.jobId, actorHash, params.resolution]
    );
    await client.query(
      `INSERT INTO commerce_operator_audit_events (
         idempotency_key_hash, actor_subject_hash, operation, target_type,
         target_reference_hash, reason_code, before_state, after_state, provider_evidence
       ) VALUES ($1, $2, 'mail_fulfillment_resolve', 'letter_job', $3, $4, $5, $6, $7)`,
      [idempotencyKeyHash, actorHash, jobHash, params.resolution,
        JSON.stringify({ jobStatus: 'held', letterStatus: 'held', orderStatus: order?.status || null,
          subjectBinding: mailResolutionSubjectBinding(params.jobId, params.expectedUserId) }),
        JSON.stringify({ decision: params.decision, resolution: params.resolution,
          jobStatus, letterStatus, orderStatus }),
        JSON.stringify({ providerName: params.providerName, providerReferenceHash })]
    );
    return {
      jobId: params.jobId,
      decision: params.decision,
      resolution: params.resolution,
      jobStatus,
      letterStatus,
      orderStatus,
      replayed: false
    };
  });
}

export async function retryLetterJobAsAdmin(params: {
  jobId: string;
  expectedUserId: string;
  actorId: string;
  reason: string;
  idempotencyKey: string;
}): Promise<{ jobId: string; replayed: boolean }> {
  return transaction(async client => {
    const idempotencyKeyHash = createHash('sha256').update(params.idempotencyKey).digest('hex');
    const actorHash = createHash('sha256').update(params.actorId).digest('hex');
    const jobHash = createHash('sha256').update(params.jobId).digest('hex');
    const reasonHash = createHash('sha256').update(params.reason).digest('hex');
    const expectedUserHash = createHash('sha256').update(params.expectedUserId).digest('hex');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [params.idempotencyKey]);
    const replay = await client.query<{
      operation: string;
      target_type: string;
      target_reference_hash: string;
      actor_subject_hash: string;
      operator_reason_hash: string | null;
      expected_user_hash: string | null;
    }>(
      `SELECT operation, target_type, target_reference_hash, actor_subject_hash,
              provider_evidence->>'operatorReasonHash' AS operator_reason_hash,
              provider_evidence->>'expectedUserHash' AS expected_user_hash
       FROM commerce_operator_audit_events
       WHERE idempotency_key_hash = $1`,
      [idempotencyKeyHash]
    );
    if (replay.rows[0]) {
      const existing = replay.rows[0];
      if (
        existing.operation !== 'mail_job_retry' ||
        existing.target_type !== 'letter_job' ||
        existing.target_reference_hash !== jobHash ||
        existing.actor_subject_hash !== actorHash ||
        existing.operator_reason_hash !== reasonHash ||
        existing.expected_user_hash !== expectedUserHash
      ) {
        throw new AdminJobRetryError('idempotency_conflict');
      }
      return { jobId: params.jobId, replayed: true };
    }
    const relation = await client.query<{ letter_id: string; funding_order_id: string | null }>(
      `SELECT jobs.letter_id, letters.funding_order_id FROM letter_jobs AS jobs
       JOIN letters ON letters.letter_id = jobs.letter_id WHERE jobs.job_id = $1`, [params.jobId]
    );
    const ids = relation.rows[0];
    if (!ids) throw new AdminJobRetryError('not_found');
    let orderStatus: string | null = null;
    let beforeOrderStatus: string | null = null;
    let retryableJitRefund = false;
    if (ids.funding_order_id) {
      const order = await client.query<{
        status: string; user_id: string; last_error_code: string | null;
        refund_attempts: number; stripe_refund_id: string | null;
      }>(
        `SELECT status, user_id, last_error_code, refund_attempts, stripe_refund_id
         FROM orders WHERE order_id = $1 FOR UPDATE`, [ids.funding_order_id]
      );
      const fundingOrder = order.rows[0];
      if (!fundingOrder || fundingOrder.user_id !== params.expectedUserId) {
        throw new AdminJobRetryError('not_found');
      }
      orderStatus = fundingOrder.status;
      beforeOrderStatus = fundingOrder.status;
      retryableJitRefund = fundingOrder.status === 'refund_pending' &&
        ['PROVIDER_SUBMISSION_FAILED', 'PRE_DISPATCH_TERMINAL_FAILURE'].includes(
          fundingOrder.last_error_code || ''
        ) && fundingOrder.refund_attempts === 0 && !fundingOrder.stripe_refund_id;
    }
    const letter = await client.query<{ status: string; user_id: string; funding_order_id: string | null }>(
      'SELECT status, user_id, funding_order_id FROM letters WHERE letter_id = $1 FOR UPDATE', [ids.letter_id]
    );
    const job = await client.query<LetterJob>(
      'SELECT * FROM letter_jobs WHERE job_id = $1 FOR UPDATE', [params.jobId]
    );
    const current = job.rows[0];
    if (!current || current.status !== 'failed' || current.provider_outcome !== 'definite_failure' ||
        current.letter_id !== ids.letter_id ||
        letter.rows[0]?.funding_order_id !== ids.funding_order_id ||
        current.operator_resolution || letter.rows[0]?.user_id !== params.expectedUserId ||
        letter.rows[0]?.status !== 'failed' ||
        (ids.funding_order_id && orderStatus !== 'fulfillment_pending' && !retryableJitRefund)) {
      throw new AdminJobRetryError('invalid_state');
    }
    if (ids.funding_order_id && retryableJitRefund) {
      await client.query(
        `UPDATE orders SET status = 'fulfillment_pending', refund_pending_at = NULL,
           last_error_code = NULL, last_error = NULL, updated_at = NOW()
         WHERE order_id = $1`, [ids.funding_order_id]
      );
      await client.query(
        `INSERT INTO commerce_order_events
           (order_id, event_type, from_status, to_status, metadata)
         VALUES ($1, 'provider.operator_retry', 'refund_pending', 'fulfillment_pending', $2)`,
        [ids.funding_order_id, JSON.stringify({ reason: 'confirmed_definite_rejection' })]
      );
      orderStatus = 'fulfillment_pending';
    }
    await client.query(
      `UPDATE letter_jobs SET status = 'pending', provider_outcome = 'not_dispatched',
         max_attempts = GREATEST(max_attempts, attempts + 1),
         next_attempt_at = NOW(), scheduled_at = NOW(), completed_at = NULL,
         last_error = NULL, error_message = NULL, updated_at = NOW() WHERE job_id = $1`,
      [params.jobId]
    );
    await client.query(
      `UPDATE letters SET status = 'queued', updated_at = NOW() WHERE letter_id = $1`,
      [ids.letter_id]
    );
    await client.query(
      `INSERT INTO commerce_operator_audit_events
         (idempotency_key_hash, actor_subject_hash, operation, target_type,
          target_reference_hash, reason_code, before_state, after_state, provider_evidence)
       VALUES ($1, $2, 'mail_job_retry', 'letter_job', $3, 'operator_confirmed_rejection', $4, $5, $6)`,
      [idempotencyKeyHash,
        actorHash,
        jobHash,
        JSON.stringify({
          jobStatus: current.status,
          providerOutcome: current.provider_outcome,
          orderStatus: beforeOrderStatus
        }),
        JSON.stringify({ jobStatus: 'pending', providerOutcome: 'not_dispatched', orderStatus }),
        JSON.stringify({ operatorReasonHash: reasonHash, expectedUserHash })]
    );
    return { jobId: params.jobId, replayed: false };
  });
}
