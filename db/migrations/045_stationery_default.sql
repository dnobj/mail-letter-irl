-- Migration: 045_stationery_default.sql
-- Purpose: an account remembers the stationery it last chose (#563).
--
-- users.stationery_theme is the theme the account last chose explicitly: a
-- preview's `stationery`, set_stationery, or the letter card's Style control.
-- A letter preview that asks for none is drawn in it. NULL until a theme is
-- chosen; 'classic' is a choice like any other, so it is stored, not NULL.
-- Only the theme: the initials and a headline belong to one letter.
--
-- Nothing reads or writes it while LETTER_IRL_STATIONERY_ENABLED is off.
-- Account erasure clears it with the return address.
--
-- users predates 022 and 023, so the legacy-scenario replay needs no guard.

ALTER TABLE users
  ADD COLUMN stationery_theme TEXT,
  ADD CONSTRAINT users_stationery_theme_known
    CHECK (stationery_theme IS NULL OR stationery_theme IN ('classic', 'monogram', 'botanical', 'celebration'));
