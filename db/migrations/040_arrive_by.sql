-- 040: mail held to arrive by a date (#535).
--
-- A preview can name the date its mail should arrive by. Letter IRL works
-- back to the date it must go to the printer (src/services/deliverySchedule.ts),
-- and the send holds its job in the outbox (letter_jobs.next_attempt_at) until
-- 09:00 New York time that day, when the hourly maintenance run sends it to
-- PostGrid as an ordinary order. PostGrid's own sendDate is not used: #535
-- gives the four reasons.
--
-- The draft records both dates and the send copies them to the letter. They
-- are columns, not JSON, so the operator queries and the dashboard can filter
-- on them. Both are NULL for mail sent as soon as possible, and set together;
-- the mail date is never after the arrival date. They are calendar dates in
-- America/New_York, read as 'YYYY-MM-DD' strings (src/db/dateParser.ts).
--
-- letter_drafts and letters predate 022 and 023, so the legacy-scenario replay
-- (which stages every migration except those two) needs no guard here.

ALTER TABLE letter_drafts
  ADD COLUMN arrive_by DATE,
  ADD COLUMN mail_on DATE,
  ADD CONSTRAINT letter_drafts_schedule_pair
    CHECK ((arrive_by IS NULL) = (mail_on IS NULL)),
  ADD CONSTRAINT letter_drafts_schedule_order
    CHECK (mail_on IS NULL OR mail_on <= arrive_by);

ALTER TABLE letters
  ADD COLUMN arrive_by DATE,
  ADD COLUMN mail_on DATE,
  ADD CONSTRAINT letters_schedule_pair
    CHECK ((arrive_by IS NULL) = (mail_on IS NULL)),
  ADD CONSTRAINT letters_schedule_order
    CHECK (mail_on IS NULL OR mail_on <= arrive_by);

-- Mail waiting for its date, for the dashboard and the operator views.
CREATE INDEX idx_letters_held_mail_on ON letters (mail_on)
  WHERE status = 'queued' AND mail_on IS NOT NULL;

COMMENT ON COLUMN letters.arrive_by IS 'The date the person asked the mail to arrive by (America/New_York); NULL when sent as soon as possible';
COMMENT ON COLUMN letters.mail_on IS 'The date the mail goes to the printer, held in the outbox until then (America/New_York)';
