-- Migration: 046_stationery_faces.sql
-- Purpose: drafts and accounts admit Typewriter and Handwritten (#563 PR 8).
--
-- The renderer draws two more themes, each setting the whole letter in a face
-- of its own: typewriter (Cousine) and handwritten (Caveat). A draft records
-- them as it records the others (044: stationery with renderer version
-- 'pdf-2'), and an account may remember either (045). Both checks name the
-- themes, so each is replaced with the longer list.
--
-- A build from before these themes cannot read them back: it refuses such a
-- letter as drawn in stationery it cannot read, and holds it, never printing
-- it as Classic (src/services/providers/PostGridProvider.ts).
--
-- letter_drafts and users predate 022 and 023, so the legacy-scenario replay
-- needs no guard here.

ALTER TABLE letter_drafts
  DROP CONSTRAINT letter_drafts_stationery_theme_known,
  ADD CONSTRAINT letter_drafts_stationery_theme_known
    CHECK (
      stationery IS NULL
      OR COALESCE(stationery->>'theme', '') IN ('monogram', 'botanical', 'celebration', 'typewriter', 'handwritten')
    );

ALTER TABLE users
  DROP CONSTRAINT users_stationery_theme_known,
  ADD CONSTRAINT users_stationery_theme_known
    CHECK (
      stationery_theme IS NULL
      OR stationery_theme IN ('classic', 'monogram', 'botanical', 'celebration', 'typewriter', 'handwritten')
    );
