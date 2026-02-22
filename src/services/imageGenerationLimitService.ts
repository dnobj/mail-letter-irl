/**
 * Image Generation Limit Service
 *
 * Ties AI image generation allowance to letter purchases:
 * - 5 generations per letter purchased (configurable via env var)
 * - Only actual purchases count (credits_purchased), not signup/promo credits
 * - Formula: allowance = floor(credits_purchased / 2) * GENERATIONS_PER_LETTER
 *   (2 internal credits = 1 user-facing letter)
 */

import { query } from '../db/index.js';

// 5 generations per letter purchased, overridable via env var
const GENERATIONS_PER_LETTER = parseInt(
  process.env.IMAGE_GENERATION_LIMIT_PER_LETTER || '5',
  10
);

// Internal credits per user-facing letter
const CREDITS_PER_LETTER = 2;

export interface GenerationQuota {
  used: number;
  allowance: number;
  remaining: number;
}

export interface GenerationLimitCheck extends GenerationQuota {
  allowed: boolean;
}

/**
 * Get the current generation quota for a user.
 *
 * Reads credits_purchased and image_generations_used from the users table.
 * Allowance is computed from credits_purchased (only real purchases count).
 */
export async function getGenerationQuota(userId: string): Promise<GenerationQuota> {
  const result = await query<{ credits_purchased: number; image_generations_used: number }>(
    'SELECT credits_purchased, image_generations_used FROM users WHERE user_id = $1',
    [userId]
  );

  if (result.rows.length === 0) {
    // User doesn't exist yet — no purchases, no allowance
    return { used: 0, allowance: 0, remaining: 0 };
  }

  const { credits_purchased, image_generations_used } = result.rows[0];
  const lettersPurchased = Math.floor(credits_purchased / CREDITS_PER_LETTER);
  const allowance = lettersPurchased * GENERATIONS_PER_LETTER;
  const remaining = Math.max(0, allowance - image_generations_used);

  return { used: image_generations_used, allowance, remaining };
}

/**
 * Check whether the user is allowed to generate another image.
 */
export async function checkGenerationLimit(userId: string): Promise<GenerationLimitCheck> {
  const quota = await getGenerationQuota(userId);
  return { ...quota, allowed: quota.remaining > 0 };
}

/**
 * Record one image generation for the user (increment counter by 1).
 */
export async function recordGeneration(userId: string): Promise<void> {
  await query(
    'UPDATE users SET image_generations_used = image_generations_used + 1 WHERE user_id = $1',
    [userId]
  );
}
