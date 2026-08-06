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
import {
  hasReturnedCreditsForLetter,
  returnConsumedCreditsForLetter
} from './creditLedgerService.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';

const DEFAULT_MAX_ATTEMPTS = 5;
const STALE_LOCK_MINUTES = 15;

type ProviderResult = LetterResult | PostcardResult;

export interface LetterJobPayload {
  letterId: string;
  userId: string;
  content: Record<string, any>;
  recipient: Record<string, any>;
  creditsCost: number;
  mailType: 'letter' | 'postcard';
}

export interface ProcessLetterJobOptions {
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

/**
 * Submit to the mail provider exactly once per claimed outbox job.
 *
 * There is deliberately no automatic in-flight retry. The only outcome that
 * would be safe to repeat is one the provider authoritatively rejected, and an
 * authoritative rejection is not transient - repeating it just re-earns the same
 * refusal. Every other outcome (5xx, 408/409/425/429, transport loss, timeout,
 * unreadable body, unusable 2xx) may mean the piece was already accepted and
 * physically mailed, so it becomes a durable hold for operator reconciliation
 * instead of a second submission.
 *
 * A thrown provider error carries no response at all and is therefore always
 * ambiguous.
 */
export async function submitToProviderOnce(
  send: () => Promise<ProviderResult>
): Promise<ProviderResult> {
  try {
    return await send();
  } catch (error) {
    return errorResult(error);
  }
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
    // 'failed' joins 'completed' as a state this may not reverse. A job that
    // already reached a terminal failure has been compensated - the pack went
    // back, or the order moved to refund_pending - and un-failing it puts the
    // letter back within reach of a resend that re-deducts nothing. The stale
    // claimant whose provider call throws long after another handler finished
    // the job is exactly the caller this refuses. The alert below still fires,
    // so a late signal against a settled job reaches an operator rather than
    // silently reopening it.
    await client.query(
      `UPDATE letter_jobs SET status = 'held', provider_outcome = 'ambiguous',
         held_at = NOW(), hold_reason = 'provider_outcome_ambiguous', locked_at = NULL,
         last_error = $2, error_message = $2, updated_at = NOW()
       WHERE job_id = $1 AND status NOT IN ('completed', 'failed')`,
      [job.job_id, errorClass]
    );
    await client.query(
      `UPDATE letters SET status = 'held', updated_at = NOW()
       WHERE letter_id = $1
         AND status NOT IN ('accepted','sent','in_transit','delivered','returned','failed')`,
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

  const result = await submitToProviderOnce(async () => {
    if (mailType === 'postcard') {
      if (!provider.sendPostcard) {
        // Nothing was submitted, so this is an authoritative rejection.
        return {
          success: false,
          trackingId: '',
          error: `${provider.config.displayName} does not support postcards`,
          metadata: { retryable: false, submissionOutcome: 'definite_rejection' },
        };
      }
      return provider.sendPostcard(postcardParams(letter, job));
    }
    return provider.sendLetter(letterParams(letter, job));
  });

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
    // Transition only the funding order already locked above. Re-deriving it
    // from letter_id here would write a row outside the canonical lock order.
    const fulfilledOrder = fundingOrderId
      ? await client.query<{ order_id: string }>(
        `UPDATE orders
         SET status = 'fulfilled', fulfilled_at = NOW(), completed_at = NOW(),
             last_error_code = NULL, last_error = NULL, updated_at = NOW()
         WHERE order_id = $1 AND order_type = 'jit_mail'
           AND status = 'fulfillment_pending'
         RETURNING order_id`,
        [fundingOrderId]
      )
      : { rows: [] as { order_id: string }[] };
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

/**
 * Return a prepaid send's credits when the job ends terminally.
 *
 * Only for prepaid_balance letters: jit_order funding is compensated by moving
 * the order to refund_pending, which the Stripe path then settles.
 *
 * Idempotent inside returnConsumedCreditsForLetter, so replayed failure
 * handling, a re-run of maintenance, or two concurrent handlers that both reach
 * a terminal transition cannot return the pack twice.
 */
async function returnPrepaidCreditsForFailedLetter(
  client: Pick<pg.PoolClient, 'query'>,
  letterId: string,
  failureCode: string
): Promise<void> {
  const letter = await client.query<{ user_id: string; funding_type: string }>(
    'SELECT user_id, funding_type FROM letters WHERE letter_id = $1',
    [letterId]
  );
  const row = letter.rows[0];
  if (!row || row.funding_type !== 'prepaid_balance') return;
  await returnConsumedCreditsForLetter(client, {
    letterId,
    userId: row.user_id,
    failureCode
  });
}

async function failOrRescheduleJob(
  job: LetterJob,
  result: ProviderResult,
  random: () => number
): Promise<boolean> {
  const error = result.error || 'Provider returned an unsuccessful result';
  // Fail safe: only an explicit `definite_rejection` may compensate a paid send.
  // A provider that reports no classification has not proved that the piece was
  // refused, and an unnecessary hold is recoverable while refunding physically
  // mailed post is not.
  const ambiguous = result.metadata?.submissionOutcome !== 'definite_rejection';
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
    const fundingOrderId = await lockFundingGraph(client, job);
    // Every use of the status parameter is cast. Assigning it to status (a
    // VARCHAR column) deduces varchar, while comparing it to an untyped literal
    // deduces text, and PostgreSQL rejects the statement outright with
    // "inconsistent types deduced for parameter $1". That threw here on EVERY
    // definite rejection, so the throw was caught upstream as a post-dispatch
    // error and the job was held as ambiguous - the terminal branch below,
    // including the credit return, could never run.
    // The predicate is the dispatch this result belongs to. A provider call can
    // outlive its own claim: the lock ages out, maintenance quarantines the job
    // as ambiguous, an operator resolves that hold - and only then does the
    // original call return. Without this, that late result overwrites whatever
    // the operator decided. The dangerous shape is an operator-confirmed
    // acceptance: the terminal write would flip completed to failed and hand
    // the pack back for a piece that is physically in the mail. Every other
    // terminal writer in this file carries the same kind of guard
    // (completeJob's eligibility check, holdAmbiguousDispatch's status
    // predicate); this one did not, and its transition only became reachable
    // when the casts above started working.
    const owned = await client.query(
      `UPDATE letter_jobs
       SET status = $1::varchar, next_attempt_at = $2, locked_at = NULL,
           completed_at = CASE WHEN $1::varchar = 'failed' THEN NOW() ELSE NULL END,
           provider_outcome = CASE WHEN $1::varchar = 'failed' THEN 'definite_failure' ELSE provider_outcome END,
           last_error = $3, error_message = $3, updated_at = NOW()
       WHERE job_id = $4 AND status = 'processing' AND provider_outcome = 'dispatching'`,
      [terminal ? 'failed' : 'pending', nextAttemptAt, error, job.job_id]
    );
    // Nothing below may run on a job this result no longer owns - not the
    // letter transition, not the order's move to refund_pending, and above all
    // not the credit return.
    if (!owned.rowCount) {
      writeDiagnostic('warn', 'outbox.terminal_transition_superseded', {
        jobId: job.job_id,
        errorClass: classifyDiagnosticError(new Error(error), 'provider_error')
      });
      return;
    }
    await client.query(
      `UPDATE letters SET status = $1, updated_at = NOW() WHERE letter_id = $2`,
      [terminal ? 'failed' : 'queued', job.letter_id]
    );
    if (terminal && fundingOrderId) {
      const refundOrder = await client.query<{ order_id: string }>(
        `UPDATE orders
         SET status = 'refund_pending', refund_pending_at = NOW(),
             last_error_code = 'PROVIDER_SUBMISSION_FAILED', last_error = $2,
             updated_at = NOW()
         WHERE order_id = $1 AND order_type = 'jit_mail'
           AND status = 'fulfillment_pending'
         RETURNING order_id`,
        [fundingOrderId, error]
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

    // Issue #151. A pay-per-send order moves to refund_pending above, but a
    // prepaid send previously returned nothing - the pack was consumed before
    // the provider was called and never came back, so the customer paid and got
    // no letter. Safe to return here and only here: this branch is reached only
    // on an explicit definite_rejection, so no mail was accepted. Ambiguous
    // outcomes are held above and never reach it.
    if (terminal && !fundingOrderId) {
      await returnPrepaidCreditsForFailedLetter(client, job.letter_id, 'provider_definite_rejection');
    }
  });

  return !terminal;
}

async function failBeforeDispatch(job: LetterJob, error: unknown, random: () => number): Promise<boolean> {
  const retryable = job.attempts < job.max_attempts;
  const errorClass = classifyDiagnosticError(error, 'unknown_error');
  await transaction(async client => {
    const fundingOrderId = await lockFundingGraph(client, job);
    const owned = await client.query(
      // Cast every use of $2, for the reason given in failOrRescheduleJob: the
      // uncast form is rejected by PostgreSQL, which threw this whole
      // transaction away on every pre-dispatch failure, retryable or terminal.
      `UPDATE letter_jobs SET status = $2::varchar, next_attempt_at = $3, locked_at = NULL,
         completed_at = CASE WHEN $2::varchar = 'failed' THEN NOW() ELSE NULL END,
         last_error = $4, error_message = $4, updated_at = NOW()
       WHERE job_id = $1 AND provider_outcome = 'not_dispatched'`,
      [job.job_id, retryable ? 'pending' : 'failed',
        new Date(Date.now() + retryDelayMilliseconds(job.attempts, random)), errorClass]
    );
    // The job predicate above already refuses a job that has since been
    // dispatched; the writes below have to answer to it rather than run anyway.
    // A stale claimant that loses the predicate would otherwise walk a letter
    // back to 'queued' after another worker failed it, and call the return on
    // a letter it no longer owns.
    if (!owned.rowCount) {
      writeDiagnostic('warn', 'outbox.pre_dispatch_transition_superseded', {
        jobId: job.job_id,
        errorClass
      });
      return;
    }
    await client.query(
      `UPDATE letters SET status = $2, updated_at = NOW()
       WHERE letter_id = $1 AND status NOT IN ('held','cancelled')`,
      [job.letter_id, retryable ? 'queued' : 'failed']
    );
    if (!retryable && fundingOrderId) {
      const refundOrder = await client.query<{ order_id: string }>(
        `UPDATE orders SET status = 'refund_pending', refund_pending_at = NOW(),
           last_error_code = 'PRE_DISPATCH_TERMINAL_FAILURE', last_error = $2,
           updated_at = NOW()
         WHERE order_id = $1 AND order_type = 'jit_mail'
           AND status = 'fulfillment_pending'
         RETURNING order_id`,
        [fundingOrderId, errorClass]
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

    // Issue #151, prepaid equivalent. Safe unconditionally on this path: the
    // job never reached the provider (the guard above requires
    // provider_outcome = 'not_dispatched'), so no mail can exist.
    if (!retryable && !fundingOrderId) {
      await returnPrepaidCreditsForFailedLetter(client, job.letter_id, errorClass);
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
    // Cast every use of $1, for the reason given in failOrRescheduleJob.
    `UPDATE letter_jobs
     SET status = $1::varchar, last_error = $2, error_message = $2,
         locked_at = CASE WHEN $1::varchar = 'processing' THEN NOW() ELSE NULL END,
         completed_at = CASE WHEN $1::varchar IN ('completed', 'failed', 'cancelled') THEN NOW() ELSE NULL END,
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

    // Issue #151. Once the pack is back, only 'rejected' is still safe - and it
    // is a no-op the return absorbs. 'retry' resends a letter the customer has
    // been compensated for and nothing re-deducts on the way back through the
    // outbox; 'accepted' asserts the mail exists while the refund stands. This
    // mirrors the guard on the admin retry path. holdAmbiguousDispatch now
    // refuses to reopen a terminal job, so reaching here with a returned pack
    // should be impossible; the guard stays because the cost of being wrong is
    // mail the customer was refunded for.
    if (params.decision !== 'rejected' && await hasReturnedCreditsForLetter(client, {
      letterId: ids.letter_id,
      userId: params.expectedUserId
    })) {
      throw new AdminMailResolutionError('invalid_state');
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
      // Issue #151. This decision is the operator asserting conclusive evidence
      // that the provider refused the piece, so it is the same terminal state
      // failOrRescheduleJob reaches on a definite rejection and it owes the
      // customer the same compensation. A pay-per-send order gets that below by
      // moving to refund_pending; without this a prepaid customer got nothing,
      // and reconciliation was the ONLY route to a terminal failure that never
      // returned the pack. Ordering holds: the funding order, letter and job are
      // already locked above, and the account lock is taken last, as on the
      // automatic path. Exactly-once is enforced inside the return itself, so an
      // automatic handler racing this resolution cannot pay twice.
      await returnPrepaidCreditsForFailedLetter(
        client, ids.letter_id, 'operator_confirmed_rejection'
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
    // Issue #151. A prepaid letter whose pack has already been returned must not
    // be resent: nothing re-deducts on the way back through the outbox, so the
    // customer would keep the pack AND get the letter. The pay-per-send
    // equivalent is already guarded by retryableJitRefund above, which refuses
    // once the money has actually gone back; a returned pack is immediate and
    // irreversible, so the prepaid answer is always to refuse. Sending anyway
    // means selling the customer a new one, which is a deliberate decision
    // rather than a silent side effect of a retry.
    if (await hasReturnedCreditsForLetter(client, {
      letterId: ids.letter_id,
      userId: params.expectedUserId
    })) {
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
