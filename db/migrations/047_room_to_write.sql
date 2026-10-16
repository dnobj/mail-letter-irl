-- Migration: 047_room_to_write.sql
-- Purpose: a letter draft records how many pages it prints on (#586, room to write).
--
-- A letter may run to two or three pages, printed on both sides of the paper
-- and paid per send with Pay & Send at its own price (#578's prices, #579's
-- pack rule). The draft records its page count, so the send, the checkout and
-- the confirmation page price and refuse it by what the draft holds, and the
-- print lays it out on that many pages. Every draft so far is one page: the
-- default.
--
-- Only a letter our renderer drew prints more than one page, and never a gift
-- send, whose free letter pays for one page only (#579). The second check
-- holds any writer to that.
--
-- letter_drafts predates 022 and 023, so the legacy-scenario replay needs no
-- guard here.

ALTER TABLE letter_drafts
  ADD COLUMN pages SMALLINT NOT NULL DEFAULT 1,
  ADD CONSTRAINT letter_drafts_pages_known CHECK (pages BETWEEN 1 AND 3),
  ADD CONSTRAINT letter_drafts_pages_paid_per_send
    CHECK (pages = 1 OR (mail_type = 'letter' AND renderer_version IS NOT NULL AND NOT is_gift_send));
