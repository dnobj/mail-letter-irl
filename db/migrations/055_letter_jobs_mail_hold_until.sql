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
-- The column keeps the hold the job was created with, as metadata.heldUntil
-- did: an operator's early release (job.dispatch_now) moves only
-- next_attempt_at, so the stuck-order condition counts its grace from the
-- later of the two. A job that leaves pending is no longer held, so the
-- column is cleared then by a trigger, whichever writer moves it (the claim,
-- a cancel, an erasure, an operator); the check holds any writer to that.
--
-- Backfill: the jobs still pending that carry metadata.heldUntil. Development
-- data only; production holds none. The metadata key is left where it is, and
-- no longer written.
--
-- letter_jobs predates 022 and 023 (001), so the legacy-scenario replay needs
-- no guard here.

ALTER TABLE letter_jobs ADD COLUMN mail_hold_until TIMESTAMPTZ;

COMMENT ON COLUMN letter_jobs.mail_hold_until IS
  'The end of an arrive-by hold (#535, #693): the job waits for its mail date until then. Set at creation for held mail only; cleared when the job leaves pending.';

UPDATE letter_jobs
   SET mail_hold_until = (metadata->>'heldUntil')::timestamptz
 WHERE status = 'pending'
   AND metadata ? 'heldUntil';

CREATE FUNCTION letter_jobs_end_mail_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'pending' THEN
    NEW.mail_hold_until := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER letter_jobs_end_mail_hold
  BEFORE INSERT OR UPDATE OF status, mail_hold_until ON letter_jobs
  FOR EACH ROW EXECUTE FUNCTION letter_jobs_end_mail_hold();

ALTER TABLE letter_jobs
  ADD CONSTRAINT letter_jobs_mail_hold_pending
    CHECK (mail_hold_until IS NULL OR status = 'pending');
