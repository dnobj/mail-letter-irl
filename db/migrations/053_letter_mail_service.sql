-- Migration: 053_letter_mail_service.sql
-- Purpose: a letter records how it travelled, and the carrier's tracking number
-- (#625, certified mail).
--
-- The draft already records the service (052). The send copies it to the
-- letter, which is what the print reads: the letter outlives its draft, and a
-- sent letter's content is cleared by the retention sweep while its status
-- and number stay readable, so the service is a column, not a key in content.
-- Every letter so far travelled standard first-class mail: the default.
--
-- carrier_tracking_number is the USPS number PostGrid sets some time after it
-- accepts a certified letter (PostGrid's own letter id stays in tracking_id).
-- Only a letter that travelled with an extra service has one, and the status
-- sync writes it.
--
-- PostGrid sells the service for letters only, and certified mail is paid per
-- send with Pay & Send (#579): never a pack and never a gift letter. A letter
-- that travels as anything but standard mail is a letter, funded by an order
-- (funding_type jit_order); the checks hold any writer to that.
--
-- letters predates 022 and 023, so the legacy-scenario replay needs no guard
-- here.

ALTER TABLE letters
  ADD COLUMN mail_service TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN carrier_tracking_number TEXT,
  ADD CONSTRAINT letters_mail_service_known
    CHECK (mail_service IN ('standard', 'certified', 'certified_return_receipt')),
  ADD CONSTRAINT letters_mail_service_letters_paid_per_send
    CHECK (mail_service = 'standard' OR (mail_type = 'letter' AND funding_type = 'jit_order')),
  ADD CONSTRAINT letters_carrier_tracking_certified_only
    CHECK (carrier_tracking_number IS NULL OR mail_service <> 'standard'),
  ADD CONSTRAINT letters_carrier_tracking_length
    CHECK (carrier_tracking_number IS NULL OR char_length(carrier_tracking_number) BETWEEN 1 AND 64);

COMMENT ON COLUMN letters.mail_service IS
  'How the letter travelled (#625): standard, certified, or certified_return_receipt. Copied from the draft by the send.';
COMMENT ON COLUMN letters.carrier_tracking_number IS
  'The USPS tracking number of a certified letter (#625), set by the status sync once PostGrid has it; NULL until then and for standard mail.';
