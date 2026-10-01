/**
 * Cancelling held mail (#535): a letter or postcard sent with an arrival date
 * waits in the outbox until its mail date (docs/letter-send-flow.md), and until
 * it goes to the printer the person can cancel it free. Its letter, or its gift
 * letter, goes back exactly once.
 *
 * Nothing outside Letter IRL is involved: a held job has never been dispatched
 * (provider_outcome 'not_dispatched'), so cancelling is a change to our own
 * rows and the return the outbox already makes for a refused send.
 */

import type pg from 'pg';
import { transaction } from '../db/index.js';
import { writeDiagnostic } from '../utils/diagnosticLog.js';
import { returnConsumedCreditsForLetter } from './creditLedgerService.js';
import { returnGiftLetterForFailedSendWithClient } from './giftLetterService.js';

/** The failure code a cancel's return records (source_metadata.failure_code). */
export const CANCELLED_BY_CUSTOMER = 'cancelled_by_customer';

/** Why held mail was not cancelled. */
export type ScheduledMailRefusal =
  /** No such letter, or it is someone else's: the two read the same. */
  | 'not_found'
  /** Mail sent with no arrival date goes to the printer at once. */
  | 'not_scheduled'
  /** Pay & Send: refunds are decided by a person (the owner's decision on #535). */
  | 'pay_and_send'
  /** It has gone to the printer, or did not go out at all. */
  | 'too_late'
  /** The outbox holds it at this moment: it is going to the printer now. */
  | 'busy';

export interface CancelledScheduledMail {
  letterId: string;
  /** True when it was already cancelled: nothing changed and nothing went back. */
  alreadyCancelled: boolean;
  /** What went back: the letters it cost, or its gift letter. */
  returned: { kind: 'letters' | 'gift_letter'; count: number };
  arriveBy: string | null;
  mailOn: string | null;
}

export type CancelScheduledMailResult =
  | { ok: true; cancelled: CancelledScheduledMail }
  | { ok: false; refusal: ScheduledMailRefusal };

interface HeldLetterRow {
  status: string;
  funding_type: string;
  arrive_by: string | null;
  mail_on: string | null;
}

interface HeldJobRow {
  job_id: string;
  status: string;
  provider_outcome: string;
}

/** PostgreSQL's lock_not_available, which NOWAIT raises. */
const LOCK_NOT_AVAILABLE = '55P03';

function lockConflict(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === LOCK_NOT_AVAILABLE;
}

function returnedKind(fundingType: string): CancelledScheduledMail['returned']['kind'] {
  return fundingType === 'gift_letter' ? 'gift_letter' : 'letters';
}

/**
 * Cancels the caller's held letter, in one transaction.
 *
 * The rows are locked in the outbox's canonical order, letter then job, and
 * the account last, inside the return. A held letter has no funding order:
 * Pay & Send is refused as soon as the letter is read, with nothing waited on.
 *
 * - **The letter's lock waits.** Its other holders are short transactions: the
 *   outbox's, which take it before the job and commit before any provider
 *   call, and another cancel. So a second cancel waits for the first and then
 *   answers as already cancelled.
 * - **The job's lock is NOWAIT.** The one holder of a job's lock without its
 *   letter's is the claim taking it to the printer, so a conflict answers
 *   "going to the printer now" rather than waiting to find it gone.
 *
 * The claim skips a job this holds (SKIP LOCKED) and takes only a pending one,
 * so once this commits the letter can never be dispatched.
 *
 * Idempotent: a letter already cancelled answers as cancelled, changes
 * nothing and returns nothing more (the returns are exactly-once besides).
 */
export async function cancelScheduledMail(params: {
  letterId: string;
  userId: string;
}): Promise<CancelScheduledMailResult> {
  try {
    return await transaction(client => cancelScheduledMailWithClient(client, params));
  } catch (error) {
    if (lockConflict(error)) {
      writeDiagnostic('info', 'schedule.cancel_refused', { reason: 'busy' });
      return { ok: false, refusal: 'busy' };
    }
    throw error;
  }
}

export async function cancelScheduledMailWithClient(
  client: Pick<pg.PoolClient, 'query'>,
  params: { letterId: string; userId: string }
): Promise<CancelScheduledMailResult> {
  const refuse = (refusal: ScheduledMailRefusal): CancelScheduledMailResult => {
    writeDiagnostic('info', 'schedule.cancel_refused', { reason: refusal });
    return { ok: false, refusal };
  };

  const letterResult = await client.query<HeldLetterRow>(
    `SELECT status, funding_type, arrive_by, mail_on FROM letters
      WHERE letter_id = $1 AND user_id = $2
      FOR UPDATE`,
    [params.letterId, params.userId]
  );
  const letter = letterResult.rows[0];
  if (!letter) return refuse('not_found');
  // Refused here, holding only the letter and waiting on nothing after it, so
  // the order-first lock order of Pay & Send's fulfilment cannot deadlock it.
  if (letter.funding_type === 'jit_order') return refuse('pay_and_send');
  if (letter.mail_on === null) return refuse('not_scheduled');

  const dates = { arriveBy: letter.arrive_by, mailOn: letter.mail_on };
  if (letter.status === 'cancelled') {
    return {
      ok: true,
      cancelled: {
        letterId: params.letterId,
        alreadyCancelled: true,
        returned: { kind: returnedKind(letter.funding_type), count: 0 },
        ...dates
      }
    };
  }
  if (letter.status !== 'queued') return refuse('too_late');

  const jobResult = await client.query<HeldJobRow>(
    `SELECT job_id, status, provider_outcome FROM letter_jobs
      WHERE letter_id = $1
      FOR UPDATE NOWAIT`,
    [params.letterId]
  );
  const job = jobResult.rows[0];
  if (!job || job.status !== 'pending' || job.provider_outcome !== 'not_dispatched') {
    return refuse('too_late');
  }

  await client.query(
    `UPDATE letter_jobs
        SET status = 'cancelled', locked_at = NULL, completed_at = NOW(),
            last_error = $2, error_message = NULL, updated_at = NOW()
      WHERE job_id = $1`,
    [job.job_id, CANCELLED_BY_CUSTOMER]
  );
  await client.query(
    `UPDATE letters
        SET status = 'cancelled', status_updated_at = NOW(), updated_at = NOW()
      WHERE letter_id = $1`,
    [params.letterId]
  );
  await client.query(
    `INSERT INTO letter_status_history (letter_id, old_status, new_status, source)
     VALUES ($1, 'queued', 'cancelled', 'customer')`,
    [params.letterId]
  );

  const returnParams = {
    letterId: params.letterId,
    userId: params.userId,
    failureCode: CANCELLED_BY_CUSTOMER,
    cause: 'cancelled' as const
  };
  const count =
    letter.funding_type === 'gift_letter'
      ? await returnGiftLetterForFailedSendWithClient(client, returnParams)
      : await returnConsumedCreditsForLetter(client, returnParams);

  writeDiagnostic('info', 'schedule.cancelled', {
    fundingType: letter.funding_type,
    returned: count
  });
  return {
    ok: true,
    cancelled: {
      letterId: params.letterId,
      alreadyCancelled: false,
      returned: { kind: returnedKind(letter.funding_type), count },
      ...dates
    }
  };
}
