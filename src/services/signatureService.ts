/**
 * A saved signature (#608, concept 3 in docs/letter-creator-vision.md).
 *
 * One cleaned picture of the person's handwritten signature per account
 * (migration 050, src/services/signatureImage.ts), kept until they remove it
 * or the account is erased. A letter draws it from its own copy, taken into
 * the draft when the letter is previewed, so replacing or removing it here
 * never changes a letter already previewed.
 */

import { query, transaction } from '../db/index.js';
import type { CleanedSignature } from './signatureImage.js';

export interface SavedSignature {
  width: number;
  height: number;
  /** The account's remembered choice: whether a preview prints it unless told otherwise. */
  useByDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SignatureWithImage extends SavedSignature {
  /** The cleaned grayscale PNG. */
  png: Buffer;
}

interface SignatureRow {
  image_png: Buffer;
  width: number;
  height: number;
  use_by_default: boolean;
  created_at: Date;
  updated_at: Date;
}

function signatureOf(row: Omit<SignatureRow, 'image_png'>): SavedSignature {
  return {
    width: row.width,
    height: row.height,
    useByDefault: row.use_by_default,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

/** The account's saved signature with its picture, or null when none is saved. */
export async function getSignature(userId: string): Promise<SignatureWithImage | null> {
  const result = await query<SignatureRow>(
    `SELECT image_png, width, height, use_by_default, created_at, updated_at
       FROM user_signatures
      WHERE user_id = $1`,
    [userId]
  );
  const row = result.rows[0];
  return row ? { ...signatureOf(row), png: row.image_png } : null;
}

export type SaveSignatureResult =
  | { ok: true; signature: SavedSignature; replaced: boolean }
  | { ok: false; refusal: 'account_closed' };

/**
 * Saves the account's signature, replacing any saved before, and turns it on
 * for the account's next previews: saving one is asking for it. The account
 * row is locked first, so an erasure that commits while this waits leaves
 * nothing to save onto: erasure locks the same row (the #449 race).
 */
export async function saveSignature(userId: string, image: CleanedSignature): Promise<SaveSignatureResult> {
  return transaction(async (client) => {
    const account = await client.query<{ erased_at: Date | null }>(
      'SELECT erased_at FROM users WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (!account.rows[0] || account.rows[0].erased_at) return { ok: false, refusal: 'account_closed' } as const;
    const before = await client.query('SELECT 1 FROM user_signatures WHERE user_id = $1', [userId]);
    const saved = await client.query<Omit<SignatureRow, 'image_png'>>(
      `INSERT INTO user_signatures (user_id, image_png, width, height)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET image_png = EXCLUDED.image_png,
             width = EXCLUDED.width,
             height = EXCLUDED.height,
             use_by_default = TRUE,
             updated_at = NOW()
       RETURNING width, height, use_by_default, created_at, updated_at`,
      [userId, image.png, image.width, image.height]
    );
    return { ok: true, signature: signatureOf(saved.rows[0]), replaced: before.rows.length > 0 } as const;
  });
}

/** Removes the account's saved signature. True when there was one. */
export async function clearSignature(userId: string): Promise<boolean> {
  const result = await query('DELETE FROM user_signatures WHERE user_id = $1', [userId]);
  return (result.rowCount ?? 0) > 0;
}
