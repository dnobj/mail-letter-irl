-- Migration: 054_stationery_designs.sql
-- Purpose: an account's saved stationery designs (#649), and the one it
-- remembers.
--
-- A design is a name the person gives it and four choices, each made of what
-- the built-in themes already draw (src/render/stationery.ts): the body's face,
-- the corner's ornament, rules under the lines, and the ornament's grey. No
-- picture: the owner chose parameters only for the first version (#657 is the
-- later step). A letter draws a design from its own copy, taken into its draft
-- when it is previewed, so changing or deleting a design here never changes a
-- letter already previewed or sent.
--
-- An account holds at most ten (the service counts them under the account's
-- row lock); a name is the account's own, in any case, once. The name is never
-- printed: it is how the person and the chat tell their designs apart.
--
-- users.stationery_design_id is the account's remembered design, as
-- users.stationery_theme is its remembered theme: a preview that asks for no
-- stationery is drawn in it. Deleting the design forgets it (ON DELETE SET
-- NULL). The service writes it only with a design of the same account; the
-- composite foreign key holds any writer to that.
--
-- Designs are the account's own data, kept until the person deletes them or
-- the account is erased. Erasure keeps the users row, so it deletes the rows
-- explicitly (accountErasureService), as it does saved signatures.
--
-- users predates 022 and 023, so the legacy-scenario replay needs no guard.
-- Safe for the running image: it creates a table and a column nothing reads yet,
-- and widens a CHECK to a theme nothing writes yet.

CREATE TABLE stationery_designs (
  design_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  face TEXT NOT NULL,
  ornament TEXT NOT NULL,
  ruled BOOLEAN NOT NULL,
  tone TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stationery_designs_name_length CHECK (char_length(name) BETWEEN 1 AND 40),
  CONSTRAINT stationery_designs_name_trimmed CHECK (name = btrim(name)),
  CONSTRAINT stationery_designs_face_known CHECK (face IN ('serif', 'typewriter', 'handwritten')),
  CONSTRAINT stationery_designs_ornament_known CHECK (ornament IN ('none', 'monogram', 'sprig', 'confetti')),
  CONSTRAINT stationery_designs_tone_known CHECK (tone IN ('black', 'dark', 'medium', 'light')),
  CONSTRAINT stationery_designs_times CHECK (updated_at >= created_at),
  -- The target of users' composite foreign key below.
  CONSTRAINT stationery_designs_owned UNIQUE (design_id, user_id)
);

-- One design per name in an account, whatever its case.
CREATE UNIQUE INDEX stationery_designs_user_name ON stationery_designs (user_id, lower(name));

ALTER TABLE users
  ADD COLUMN stationery_design_id UUID,
  -- Only a design of this account. MATCH SIMPLE: with no design remembered
  -- (NULL) the key is not checked. Deleting the design sets only the design
  -- column back to NULL (PostgreSQL 15's column list), never the user_id.
  ADD CONSTRAINT users_stationery_design_owned
    FOREIGN KEY (stationery_design_id, user_id)
    REFERENCES stationery_designs (design_id, user_id)
    ON DELETE SET NULL (stationery_design_id);

-- A draft drawn in a design records it as the 'custom' theme with the design
-- and its name, its own copy (src/render/stationery.ts, stationeryOf). The
-- renderer version stays pdf-2 (or pdf-4 with a signature), as for any theme.
ALTER TABLE letter_drafts
  DROP CONSTRAINT letter_drafts_stationery_theme_known,
  ADD CONSTRAINT letter_drafts_stationery_theme_known
    CHECK (
      stationery IS NULL
      OR COALESCE(stationery->>'theme', '') IN ('monogram', 'botanical', 'celebration', 'typewriter', 'handwritten', 'custom')
    );

COMMENT ON TABLE stationery_designs IS
  'Saved stationery designs (#649): a name and four choices per row, at most ten per account, kept until deleted or the account is erased.';
COMMENT ON COLUMN users.stationery_design_id IS
  'The account''s remembered stationery design (#649), NULL for none; cleared when the design is deleted.';
