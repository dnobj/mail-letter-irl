-- Migration: 052_mail_service.sql
-- Purpose: a letter draft records how it travels (#625, certified mail).
--
-- A letter may go as USPS Certified Mail, or as Certified Mail with an
-- electronic return receipt, paid per send with Pay & Send at its own price
-- (#578's proposal, #579's pack rule). The draft records the service, so the
-- send, the checkout and the confirmation page price and refuse it by what the
-- draft holds, and the send carries it to the provider. Every draft so far is
-- standard first-class mail: the default.
--
-- PostGrid sells the service for letters (and cheques) only, so a postcard is
-- never certified, and never a gift send, whose free letter pays for standard
-- mail only (#579). The second check holds any writer to that. Pages are
-- already held to one to three by 047.
--
-- letter_drafts predates 022 and 023, so the legacy-scenario replay needs no
-- guard here.

ALTER TABLE letter_drafts
  ADD COLUMN mail_service TEXT NOT NULL DEFAULT 'standard',
  ADD CONSTRAINT letter_drafts_mail_service_known
    CHECK (mail_service IN ('standard', 'certified', 'certified_return_receipt')),
  ADD CONSTRAINT letter_drafts_mail_service_paid_per_send
    CHECK (mail_service = 'standard' OR (mail_type = 'letter' AND NOT is_gift_send));

COMMENT ON COLUMN letter_drafts.mail_service IS
  'How a letter travels (#625): standard, certified, or certified_return_receipt. Only a letter that is not a gift send is ever certified.';
