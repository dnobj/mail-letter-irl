/**
 * Held mail (#535, #693): one predicate for a job waiting for its mail date, read by the
 * outbox (letterJobService: the pause count and the admin release), the erasure gate
 * (accountErasureService) and the admin panel (src/admin/queries/jobs.ts). No imports,
 * so the admin process can read it without the API's database module.
 */

/**
 * Mail waiting for its mail date (#535, #693): its job pending, never attempted or
 * dispatched, carrying the hold it was created with (mail_hold_until, which
 * createLetterJobWithClient sets only for held mail) and not yet due. A SQL
 * condition on the letter_jobs row named `alias`, by the database's clock.
 * Due already, a job is no longer held: an operator's release (job.dispatch_now)
 * moves only next_attempt_at, and leaves the hold it ended. Parenthesised, so it
 * stands as one condition wherever it goes; the alias is a plain name.
 */
export function heldMailJobSql(alias: string): string {
  if (!/^[a-z_]+$/.test(alias)) throw new Error(`heldMailJobSql: not a table alias: ${alias}`);
  return `(${alias}.status = 'pending'
      AND ${alias}.provider_outcome = 'not_dispatched'
      AND ${alias}.attempts = 0
      AND ${alias}.mail_hold_until IS NOT NULL
      AND ${alias}.next_attempt_at > NOW())`;
}

/**
 * Mail left for the operator (#696): a job held for its funding
 * (fundingHeldJobSql), or of an account whose sending is blocked. A SQL
 * condition on the letter_jobs row named `alias`. A plain read of users, no
 * lock: the outbox's dispatch marker reads the same again under its locks and
 * puts back a job that turned so between the claim and the mark (letterJobService).
 * The outbox's claim, its marker and its waiting count leave such a job, and the maintenance run's
 * count of late letters (#699) leaves its letter: it waits for a person, who
 * may take weeks, as a dispute does.
 */
export function leftForOperatorSql(alias: string): string {
  if (!/^[a-z_]+$/.test(alias)) throw new Error(`leftForOperatorSql: not a table alias: ${alias}`);
  return `(${fundingHeldJobSql(alias)}
       OR EXISTS (
         SELECT 1 FROM letters held_letter
           JOIN users held_user ON held_user.user_id = held_letter.user_id
          WHERE held_letter.letter_id = ${alias}.letter_id
            AND held_user.sends_blocked_reason IS NOT NULL
       ))`;
}

/** The same as heldMailJobSql, for a job already read, at `now`. */
export function isHeldMailJobState(
  job: { status: string; providerOutcome: string; attempts: number; mailHoldUntil: Date | null; nextAttemptAt: Date | null },
  now: number = Date.now()
): boolean {
  return (
    job.status === 'pending' &&
    job.providerOutcome === 'not_dispatched' &&
    job.attempts === 0 &&
    job.mailHoldUntil !== null &&
    job.nextAttemptAt !== null &&
    job.nextAttemptAt.getTime() > now
  );
}

/**
 * Mail held because the money that paid for it was reversed (#696, decision D2): a pack
 * refunded in full (funding_reversed) or disputed (funding_disputed, held when a dispute that
 * takes the money opens, and kept if it is won, for the operator to release). Its job
 * stays pending and never dispatched, as mail the outbox has not taken always is (a held
 * job must have reached the provider, 023's valid_letter_job_outcome_state), and carries
 * one of these as its hold_reason, which the outbox claim skips. The operator releases it
 * (job.dispatch_now, which clears the reason) or cancels it (job.cancel_held).
 */
export const FUNDING_HOLD_REASONS = ['funding_reversed', 'funding_disputed'] as const;
export type FundingHoldReason = (typeof FUNDING_HOLD_REASONS)[number];

/** Whether a job's hold_reason is a funding hold. */
export function isFundingHoldReason(reason: string | null | undefined): reason is FundingHoldReason {
  return typeof reason === 'string' && (FUNDING_HOLD_REASONS as readonly string[]).includes(reason);
}

/**
 * A SQL condition on the letter_jobs row named `alias`: held for its funding (#696), not
 * dispatched. Parenthesised; the reasons are this module's own constants, never input.
 * Two-valued: a job with no hold_reason is FALSE, never NULL, so NOT of it holds every
 * ordinary job (`NULL IN (...)` is NULL, and NOT NULL is not TRUE).
 */
export function fundingHeldJobSql(alias: string): string {
  if (!/^[a-z_]+$/.test(alias)) throw new Error(`fundingHeldJobSql: not a table alias: ${alias}`);
  const reasons = FUNDING_HOLD_REASONS.map(reason => `'${reason}'`).join(', ');
  return `(${alias}.provider_outcome = 'not_dispatched'
      AND ${alias}.hold_reason IS NOT NULL
      AND ${alias}.hold_reason IN (${reasons}))`;
}
