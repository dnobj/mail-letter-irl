-- 051: a letter draft keeps its own copy of the person's signature (#608,
-- concept 3 in docs/letter-creator-vision.md).
--
-- A letter previewed with a signature keeps the picture as it was when the
-- letter was previewed, a PNG data URI like the draft's other images: replacing
-- or removing the saved signature (user_signatures, migration 050) never
-- changes a letter already previewed. The send copies it into the letter's
-- content, and the print draws it from there.
--
-- Such a letter records renderer version pdf-4: pdf-1 or pdf-2 with a
-- signature. A build that cannot draw signatures refuses pdf-4, so a rollback
-- holds the letter instead of printing it unsigned, as pdf-2 does for themes
-- (044) and pdf-3 for postcard fronts (048).
--
-- So 044's pairing of stationery with pdf-2 widens: a theme may be drawn by
-- pdf-2 or pdf-4, and pdf-2 always has one. A theme with no version, which
-- 044 refused, is still refused: the COALESCE keeps the IN from reading a
-- NULL version as unknown, which a CHECK would pass (#612 review round 1).
-- The signature pairs with pdf-4
-- exactly. Retention empties the copy to '' rather than NULL, as it does the
-- draft's other images, which keeps the pair.
--
-- Every object named here comes from 001, 039 or 044, so the commerce ACID
-- legacy replay, which runs later migrations without 022 and 023, needs no
-- to_regclass guard.
--
-- Safe for the running image: a new nullable column, and CHECKs every
-- existing row meets (none has a signature or pdf-4).

ALTER TABLE letter_drafts
  ADD COLUMN signature_image TEXT,
  ADD CONSTRAINT letter_drafts_signature_letters_only
    CHECK (signature_image IS NULL OR mail_type = 'letter');

ALTER TABLE letter_drafts
  DROP CONSTRAINT letter_drafts_renderer_version_known,
  ADD CONSTRAINT letter_drafts_renderer_version_known
    CHECK (renderer_version IS NULL OR renderer_version IN ('pdf-1', 'pdf-2', 'pdf-3', 'pdf-4')),
  DROP CONSTRAINT letter_drafts_stationery_drawn_by_pdf_2,
  ADD CONSTRAINT letter_drafts_stationery_drawn_by_pdf_2
    CHECK (
      (stationery IS NULL OR COALESCE(renderer_version, '') IN ('pdf-2', 'pdf-4'))
      AND (renderer_version IS DISTINCT FROM 'pdf-2' OR stationery IS NOT NULL)
    ),
  ADD CONSTRAINT letter_drafts_signature_drawn_by_pdf_4
    CHECK ((signature_image IS NOT NULL) = (renderer_version IS NOT DISTINCT FROM 'pdf-4'));

COMMENT ON COLUMN letter_drafts.signature_image IS
  'The person''s signature as this letter was previewed with it (#608): a PNG data URI, emptied to '''' by retention.';
