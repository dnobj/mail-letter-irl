-- Migration: 044_stationery.sql
-- Purpose: a draft records the stationery its preview was drawn in (#563).
--
-- letter_drafts.stationery holds a theme and the slot text it prints, as JSON:
-- {"theme": "monogram" | "botanical" | "celebration", "dateLine"?, "monogram"?,
-- "headline"?}. NULL is Classic, today's page, so every existing draft reads as
-- before. The send copies it into letters.content.stationery, and the print
-- draws it (src/render/stationery.ts).
--
-- A themed preview records renderer version 'pdf-2', which the check now admits
-- beside 'pdf-1'; Classic keeps 'pdf-1'. A build that cannot draw themes (an
-- older deploy, or a rollback) cannot print 'pdf-2', so it holds such a letter
-- for an operator instead of printing it as Classic. The pair is held together:
-- stationery exactly when 'pdf-2'.
--
-- Redaction keeps a draft's theme and drops its slot text (the content), so the
-- pair check holds on redacted rows too (retentionService DRAFT_REDACTION_SET).
--
-- letter_drafts predates 022 and 023, so the legacy-scenario replay needs no
-- guard here.

ALTER TABLE letter_drafts
  ADD COLUMN stationery JSONB,
  ADD CONSTRAINT letter_drafts_stationery_theme_known
    CHECK (stationery IS NULL OR stationery->>'theme' IN ('monogram', 'botanical', 'celebration'));

ALTER TABLE letter_drafts
  DROP CONSTRAINT letter_drafts_renderer_version_known,
  ADD CONSTRAINT letter_drafts_renderer_version_known
    CHECK (renderer_version IS NULL OR renderer_version IN ('pdf-1', 'pdf-2')),
  ADD CONSTRAINT letter_drafts_stationery_drawn_by_pdf_2
    CHECK ((stationery IS NOT NULL) = (renderer_version IS NOT DISTINCT FROM 'pdf-2'));
