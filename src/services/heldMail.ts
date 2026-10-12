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
