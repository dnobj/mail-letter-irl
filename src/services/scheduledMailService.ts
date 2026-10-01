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
import { query, transaction } from '../db/index.js';
import { CREDITS_PER_LETTER } from '../config/products.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';
import { returnConsumedCreditsForLetter } from './creditLedgerService.js';
import { returnGiftLetterForFailedSendWithClient } from './giftLetterService.js';

/** The failure code a cancel's return records (source_metadata.failure_code). */
export const CANCELLED_BY_CUSTOMER = 'cancelled_by_customer';

/** The operator alert for held mail that missed its mail day (migration 041). */
export const MISSED_MAIL_DAY_ALERT = 'schedule_missed_mail_day';

/**
 * Held mail that missed its mail day (#535): a letter with a mail date, not
 * at the printer at 18:00 New York time that day: still queued (dispatch
 * paused, the provider down), taken and not accepted, or failed (its retries
 * ran out, or the provider refused it). Raises one operator alert per letter,
 * ever, and logs schedule.missed_mail_day with how many were new. A letter
 * held after an ambiguous dispatch is left out: it has its own critical alert.
 *
 * Once per letter: NOT EXISTS, with a partial unique index behind it (041)
 * and ON CONFLICT DO NOTHING, so two runs at once still raise one.
 *
 * Run hourly by maintenance, after the outbox. Never throws: a task that
 * throws there skips every task after it, so a failure is logged instead.
 * Returns how many alerts it raised.
 */
export async function raiseMissedMailDayAlerts(): Promise<number> {
  try {
    const raised = await query(
      `INSERT INTO commerce_operational_alerts (order_id, alert_type, severity, details)
       SELECT held.funding_order_id, $1::varchar, 'warning',
              jsonb_build_object('letterId', held.letter_id, 'mailOn', held.mail_on::text, 'userId', held.user_id)
         FROM letters held
        WHERE held.mail_on IS NOT NULL
          AND held.status IN ('queued', 'processing', 'failed')
          AND (held.mail_on + TIME '18:00') AT TIME ZONE 'America/New_York' < NOW()
          AND NOT EXISTS (
            SELECT 1 FROM commerce_operational_alerts seen
             WHERE seen.alert_type = $1::varchar
               AND seen.details->>'letterId' = held.letter_id
          )
        ORDER BY held.mail_on
        LIMIT 100
       ON CONFLICT DO NOTHING
       RETURNING alert_id`,
      [MISSED_MAIL_DAY_ALERT]
    );
    const count = raised.rowCount ?? 0;
    if (count > 0) writeDiagnostic('error', 'schedule.missed_mail_day', { count });
    return count;
  } catch (error) {
    writeDiagnostic('error', 'schedule.missed_mail_day_check_failed', {
      errorClass: classifyDiagnosticError(error, 'database_error')
    });
    return 0;
  }
}

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

/**
 * What of its cost did not come back usable:
 * - `none`: all of it came back;
 * - `partial`: some, the rest having been refunded with its pack or expired;
 * - `expired`: none usable, because what paid for it ran out while the mail
 *   was held (a returned lot keeps its expiry);
 * - `refunded`: none, because it had already been paid back in cash (a
 *   revoked lot, or a gift whose purchase was reversed).
 */
export type ReturnShortfall = 'none' | 'partial' | 'expired' | 'refunded';

export interface CancelledScheduledMail {
  letterId: string;
  /** True when it was already cancelled: nothing changed and nothing went back. */
  alreadyCancelled: boolean;
  /**
   * What went back usable, in the units the account shows: letters
   * (CREDITS_PER_LETTER credits each, whole letters only), or its gift letter.
   */
  returned: { kind: 'letters' | 'gift_letter'; count: number };
  shortfall: ReturnShortfall;
  arriveBy: string | null;
  mailOn: string | null;
}

export type CancelScheduledMailResult =
  | { ok: true; cancelled: CancelledScheduledMail }
  | { ok: false; refusal: ScheduledMailRefusal };

interface HeldLetterRow {
  status: string;
  funding_type: string;
  credits_cost: number;
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
    `SELECT status, funding_type, credits_cost, arrive_by, mail_on FROM letters
      WHERE letter_id = $1 AND user_id = $2
      FOR UPDATE`,
    [params.letterId, params.userId]
  );
  const letter = letterResult.rows[0];
  if (!letter) return refuse('not_found');

  // Where it is first, so each answer is true of it: a letter a refund
  // cancelled is already cancelled, and one already printed is too late,
  // whatever paid for it or whether it had a date.
  const dates = { arriveBy: letter.arrive_by, mailOn: letter.mail_on };
  if (letter.status === 'cancelled') {
    return {
      ok: true,
      cancelled: {
        letterId: params.letterId,
        alreadyCancelled: true,
        returned: { kind: returnedKind(letter.funding_type), count: 0 },
        shortfall: 'none',
        ...dates
      }
    };
  }
  if (letter.status !== 'queued') return refuse('too_late');
  // Refused here, holding only the letter and waiting on nothing after it, so
  // the order-first lock order of Pay & Send's fulfilment cannot deadlock it.
  if (letter.funding_type === 'jit_order') return refuse('pay_and_send');
  if (letter.mail_on === null) return refuse('not_scheduled');

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
  const back =
    letter.funding_type === 'gift_letter'
      ? await giftBack(client, returnParams)
      : await creditsBack(client, returnParams, letter.credits_cost);

  writeDiagnostic('info', 'schedule.cancelled', {
    fundingType: letter.funding_type,
    returned: back.count,
    shortfall: back.shortfall
  });
  return {
    ok: true,
    cancelled: {
      letterId: params.letterId,
      alreadyCancelled: false,
      returned: { kind: returnedKind(letter.funding_type), count: back.count },
      shortfall: back.shortfall,
      ...dates
    }
  };
}

type ReturnParams = Parameters<typeof returnConsumedCreditsForLetter>[1];

async function giftBack(
  client: Pick<pg.PoolClient, 'query'>,
  params: ReturnParams
): Promise<{ count: number; shortfall: ReturnShortfall }> {
  const count = await returnGiftLetterForFailedSendWithClient(client, params);
  // The returned gift gets a fresh lifetime at least, so it is never expired.
  return { count, shortfall: count > 0 ? 'none' : 'refunded' };
}

/**
 * A prepaid letter's credits back, counted in letters, and what of its cost
 * did not come back usable. The return keeps each lot's expiry, so credits
 * whose lot ran out while the mail was held come back already expired: they
 * are not counted, and the shortfall says why.
 */
async function creditsBack(
  client: Pick<pg.PoolClient, 'query'>,
  params: ReturnParams,
  creditsCost: number
): Promise<{ count: number; shortfall: ReturnShortfall }> {
  const credits = await returnConsumedCreditsForLetter(client, params);
  const expired =
    credits > 0
      ? Number(
          (
            await client.query<{ expired: number }>(
              `SELECT COALESCE(SUM(initial_amount), 0)::int AS expired
                 FROM credit_ledger
                WHERE user_id = $1
                  AND source_type = 'adjustment'
                  AND source_metadata->>'letter_id' = $2
                  AND source_metadata->>'reason' = 'send_failed'
                  AND expires_at IS NOT NULL
                  AND expires_at <= NOW()`,
              [params.userId, params.letterId]
            )
          ).rows[0]?.expired ?? 0
        )
      : 0;
  const usable = credits - expired;
  const count = Math.floor(usable / CREDITS_PER_LETTER);
  const shortfall: ReturnShortfall =
    usable >= creditsCost ? 'none' : usable > 0 ? 'partial' : expired > 0 ? 'expired' : 'refunded';
  return { count, shortfall };
}
