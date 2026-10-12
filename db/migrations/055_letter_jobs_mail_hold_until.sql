-- Migration: 055_letter_jobs_mail_hold_until.sql
-- Purpose: held mail as one column (#693).
--
-- Mail sent with an arrival date (#535) waits in the outbox for its mail date:
-- its job is created pending with next_attempt_at at 09:00 New York time on
-- that date, and until now the end of the hold rode in the job's metadata
-- (metadata.heldUntil), read with ->> by the erasure gate, the stuck-order
-- condition, the admin panel and the admin release. It is a column now.
--
-- Named for the mail's hold, not the operator's: status 'held', held_at and
-- hold_reason (023) are the operator's hold on an unclear provider outcome,
-- which this is not.
--
-- The column means what metadata.heldUntil meant: the hold the job was
-- created with, kept for the job's whole life, so the admin panel still shows
-- that a job was dated mail after the run takes it. Whether a job is held now
-- is src/services/heldMail.ts's predicate, which also asks that it is pending,
-- never attempted and not yet due. An operator's early release
-- (job.dispatch_now) moves only next_attempt_at, so the stuck-order condition
-- counts its grace from the later of the two.
--
-- Backfill: every job that carries metadata.heldUntil in the form the code
-- writes (toISOString); one hand-written in any other form is left without a
-- hold rather than failing the migration. Production holds none. The metadata
-- key is left where it is, and no longer written or read.
--
-- A held job written by code from before this migration (the moments of a
-- deploy, or a rollback across it) carries only the metadata key. The backfill
-- is idempotent and may be run again as it stands to give those jobs their
-- column.
--
-- letter_jobs predates 022 and 023 (001), so the legacy-scenario replay needs
-- no guard here.

ALTER TABLE letter_jobs ADD COLUMN mail_hold_until TIMESTAMPTZ;

COMMENT ON COLUMN letter_jobs.mail_hold_until IS
  'The hold an arrive-by job was created with (#535, #693): it waits for its mail date until then. Null for mail due at once. Held now: src/services/heldMail.ts.';

UPDATE letter_jobs
   SET mail_hold_until = (metadata->>'heldUntil')::timestamptz
 WHERE mail_hold_until IS NULL
   AND metadata->>'heldUntil' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$';
