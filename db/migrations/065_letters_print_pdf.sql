-- Purpose: held mail prints as previewed (#697, decision D3). A letter or
-- postcard sent to arrive by a date waits in the outbox until its mail date,
-- up to the schedule's horizon, and a renderer, font or layout change deployed
-- in between could move its line breaks. So the send records what the print
-- will draw, and the print checks it:
--
-- print_layout_fingerprint, print_layout_engine: what the print lays out
-- (src/render/fingerprint.ts), recorded at the send for mail our renderer
-- draws, and the layout engine that laid it out. The print lays the mail out
-- again and, when the fingerprint differs, holds it for an operator
-- (render_refused, layout_changed) rather than printing what nobody saw.
--
-- print_pdf_sha256: the SHA-256 of the PDF stored for held mail at
-- held-pdf/<letter_id>.pdf in the private bucket, set only once the upload has
-- succeeded. The print uploads those very bytes when they hash to this, and
-- lays the mail out again only when they do not or are gone. Null for mail
-- not held, and for held mail whose PDF could not be stored (the fingerprint
-- still guards it). The PDF is deleted once the provider accepts the mail, on
-- a cancel, by the hourly sweep, and on erasure; the retention sweeps clear
-- these columns with the content they derive from.
--
-- Safe for the running image: three nullable columns nothing reads yet, and
-- CHECKs a NULL always passes. letters is 001's, so no 022/023 guard is needed.

ALTER TABLE letters
  ADD COLUMN print_pdf_sha256 TEXT,
  ADD COLUMN print_layout_fingerprint TEXT,
  ADD COLUMN print_layout_engine TEXT;

ALTER TABLE letters
  ADD CONSTRAINT letters_print_pdf_sha256_shape
    CHECK (print_pdf_sha256 IS NULL OR print_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT letters_print_layout_fingerprint_shape
    CHECK (print_layout_fingerprint IS NULL OR print_layout_fingerprint ~ '^fp[1-9][0-9]{0,3}:[0-9a-f]{64}$'),
  ADD CONSTRAINT letters_print_layout_engine_shape
    CHECK (print_layout_engine IS NULL OR print_layout_engine ~ '^layout-[1-9][0-9]{0,5}$'),
  -- The engine is recorded exactly when a fingerprint is.
  ADD CONSTRAINT letters_print_layout_engine_with_fingerprint
    CHECK ((print_layout_fingerprint IS NULL) = (print_layout_engine IS NULL)),
  -- A stored PDF is always one whose layout was fingerprinted, of held mail.
  ADD CONSTRAINT letters_print_pdf_needs_fingerprint
    CHECK (print_pdf_sha256 IS NULL OR print_layout_fingerprint IS NOT NULL),
  ADD CONSTRAINT letters_print_pdf_held_only
    CHECK (print_pdf_sha256 IS NULL OR mail_on IS NOT NULL);

COMMENT ON COLUMN letters.print_pdf_sha256 IS
  'SHA-256 of the PDF stored for held mail at held-pdf/<letter_id>.pdf (#697), set once the upload succeeded; NULL otherwise.';
COMMENT ON COLUMN letters.print_layout_fingerprint IS
  'What the print draws, recorded at the send (src/render/fingerprint.ts, #697): the print holds the mail when it lays out differently.';
COMMENT ON COLUMN letters.print_layout_engine IS
  'The layout engine (LAYOUT_ENGINE_VERSION) that laid the mail out when it was fingerprinted (#697).';
