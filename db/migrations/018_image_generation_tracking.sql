-- Migration 018: Add image generation tracking
-- Purpose: Track how many AI image generations a user has consumed.
-- Allowance is computed from credits_purchased (5 generations per letter purchased).

ALTER TABLE users
  ADD COLUMN image_generations_used INTEGER NOT NULL DEFAULT 0;
