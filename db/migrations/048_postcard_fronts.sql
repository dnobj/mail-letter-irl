-- Migration: 048_postcard_fronts.sql
-- Purpose: a postcard draft records its front's layout (#594).
--
-- letter_drafts.postcard_front holds the front as JSON:
-- {"layout": "border", "caption"?} (the photo in a white border over its
-- caption) or {"layout": "greetings", "place"} ("Greetings from" a place over
-- the photo). NULL is full bleed, every postcard's front before, so every
-- existing draft reads as before. The send copies it into
-- letters.content.postcardFront, and the print draws it (src/render/postcard.ts).
--
-- A postcard with a front records renderer version 'pdf-3', which the check
-- now admits beside 'pdf-1' and 'pdf-2'; a full-bleed postcard keeps 'pdf-1'.
-- A build that cannot draw fronts (an older deploy, or a rollback) cannot
-- print 'pdf-3', so it holds such a postcard for an operator instead of
-- printing it full bleed. The pair is held together: a front exactly when
-- 'pdf-3'. Only a postcard has a front.
--
-- Redaction keeps a draft's layout and drops its caption and place (the
-- content), so the pair check holds on redacted rows too (retentionService
-- DRAFT_REDACTION_SET).
--
-- letter_drafts predates 022 and 023, so the legacy-scenario replay needs no
-- guard here.

-- The layout check COALESCEs: `->>` gives NULL for JSON that is not an object,
-- has no layout or a null one, and a CHECK passes on NULL.
ALTER TABLE letter_drafts
  ADD COLUMN postcard_front JSONB,
  ADD CONSTRAINT letter_drafts_postcard_front_layout_known
    CHECK (postcard_front IS NULL
           OR (mail_type = 'postcard' AND COALESCE(postcard_front->>'layout', '') IN ('border', 'greetings')));

ALTER TABLE letter_drafts
  DROP CONSTRAINT letter_drafts_renderer_version_known,
  ADD CONSTRAINT letter_drafts_renderer_version_known
    CHECK (renderer_version IS NULL OR renderer_version IN ('pdf-1', 'pdf-2', 'pdf-3')),
  ADD CONSTRAINT letter_drafts_postcard_front_drawn_by_pdf_3
    CHECK ((postcard_front IS NOT NULL) = (renderer_version IS NOT DISTINCT FROM 'pdf-3'));
