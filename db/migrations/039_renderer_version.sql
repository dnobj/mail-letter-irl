-- 039: which renderer a letter draft was previewed with (#534).
--
-- The new print renderer (src/render) lays a letter out once and draws both
-- the PDF sent to PostGrid and the preview from that layout. A draft records
-- the renderer that drew its preview, and the send copies it into
-- letters.content, so a letter prints with the renderer it was previewed
-- with, however long it waits in the outbox (arrive-by, #535) and whatever
-- LETTER_IRL_PRINT_RENDERER says by then. NULL is the legacy HTML path;
-- 'pdf-1' is the first version of the new one. A new version extends the
-- constraint in its own migration.
--
-- letter_drafts predates 022 and 023, so the legacy-scenario replay (which
-- stages every migration except those two) needs no guard here.

ALTER TABLE letter_drafts
  ADD COLUMN renderer_version VARCHAR(16),
  ADD CONSTRAINT letter_drafts_renderer_version_known
    CHECK (renderer_version IS NULL OR renderer_version = 'pdf-1');
