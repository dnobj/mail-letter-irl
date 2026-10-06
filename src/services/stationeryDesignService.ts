/**
 * An account's saved stationery designs (#649, migration 054).
 *
 * A design is a name the person gives it and four choices
 * (src/render/stationery.ts: face, ornament, ruled, tone). An account holds
 * at most MAX_STATIONERY_DESIGNS, one per name whatever its case. A letter
 * draws a design from its own copy, taken into its draft when it is
 * previewed, so changing or deleting one here never changes a letter already
 * previewed. The account remembers one design (users.stationery_design_id),
 * as it remembers a theme.
 *
 * Designs are the account's own data, kept until the person deletes them or
 * the account is erased (accountErasureService deletes them).
 */

import type { PoolClient } from 'pg';
import { query, transaction } from '../db/index.js';
import { designOf, type StationeryDesign } from '../render/stationery.js';

// A design's name is kept as the renderer reads one back (src/render/stationery.ts), so no saved name is ever dropped.
export { designNameOf } from '../render/stationery.js';

/** The most designs an account may hold. */
export const MAX_STATIONERY_DESIGNS = 10;

export interface SavedDesign {
  designId: string;
  /** The account's own name for it, never printed. */
  name: string;
  design: StationeryDesign;
  createdAt: string;
  updatedAt: string;
}

interface DesignRow {
  design_id: string;
  name: string;
  face: string;
  ornament: string;
  ruled: boolean;
  tone: string;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'design_id, name, face, ornament, ruled, tone, created_at, updated_at';

/** A row as a design, or null for one this build does not draw (a later build's choices). */
function savedOf(row: DesignRow): SavedDesign | null {
  const design = designOf({ face: row.face, ornament: row.ornament, ruled: row.ruled, tone: row.tone });
  if (!design) return null;
  return {
    designId: row.design_id,
    name: row.name,
    design,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether text is a design id at all: anything else names no design, and is never handed to PostgreSQL's uuid parser. */
export function isDesignId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** The account's designs, oldest first. */
export async function listDesigns(userId: string): Promise<SavedDesign[]> {
  const result = await query<DesignRow>(
    `SELECT ${COLUMNS} FROM stationery_designs WHERE user_id = $1 ORDER BY created_at, design_id`,
    [userId]
  );
  return result.rows.map(savedOf).filter((saved): saved is SavedDesign => saved !== null);
}

/** One of the account's designs, or null: another account's, or no design, is none. */
export async function getDesign(userId: string, designId: string): Promise<SavedDesign | null> {
  if (!isDesignId(designId)) return null;
  const result = await query<DesignRow>(
    `SELECT ${COLUMNS} FROM stationery_designs WHERE user_id = $1 AND design_id = $2`,
    [userId, designId]
  );
  const row = result.rows[0];
  return row ? savedOf(row) : null;
}

export type SaveDesignResult =
  | { ok: true; saved: SavedDesign; replaced: boolean }
  | { ok: false; refusal: 'account_closed' | 'limit' };

/**
 * Saves a design under a name: the account's design of that name, in any
 * case, is replaced (and takes the name as written now); otherwise a new one
 * is added, while the account holds fewer than MAX_STATIONERY_DESIGNS. The
 * account row is locked first, so two saves count one after the other, and
 * an erasure that commits while this waits leaves nothing to save onto:
 * erasure locks the same row. `name` is as designNameOf keeps it.
 */
export async function saveDesign(userId: string, name: string, design: StationeryDesign): Promise<SaveDesignResult> {
  return transaction(async client => {
    const account = await lockAccount(client, userId);
    if (!account || account.erased_at) return { ok: false, refusal: 'account_closed' } as const;
    const replaced = await client.query<DesignRow>(
      `UPDATE stationery_designs
          SET name = $2, face = $3, ornament = $4, ruled = $5, tone = $6, updated_at = NOW()
        WHERE user_id = $1 AND lower(name) = lower($2)
        RETURNING ${COLUMNS}`,
      [userId, name, design.face, design.ornament, design.ruled, design.tone]
    );
    if (replaced.rows[0]) return { ok: true, saved: savedOf(replaced.rows[0])!, replaced: true } as const;
    const held = await client.query<{ count: string }>(
      'SELECT count(*) AS count FROM stationery_designs WHERE user_id = $1',
      [userId]
    );
    if (Number(held.rows[0].count) >= MAX_STATIONERY_DESIGNS) return { ok: false, refusal: 'limit' } as const;
    const inserted = await client.query<DesignRow>(
      `INSERT INTO stationery_designs (user_id, name, face, ornament, ruled, tone)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${COLUMNS}`,
      [userId, name, design.face, design.ornament, design.ruled, design.tone]
    );
    return { ok: true, saved: savedOf(inserted.rows[0])!, replaced: false } as const;
  });
}

/**
 * Locks the account's row, as a save and an erasure do first: deleting a
 * remembered design writes the account's row too (ON DELETE SET NULL), so
 * every writer takes the account before a design, and none waits on another
 * the other way round (#649 part 2 review round 1). The row as locked, or
 * undefined when there is no account.
 */
async function lockAccount(client: PoolClient, userId: string): Promise<{ erased_at: Date | null } | undefined> {
  const account = await client.query<{ erased_at: Date | null }>('SELECT erased_at FROM users WHERE user_id = $1 FOR UPDATE', [userId]);
  return account.rows[0];
}

/** Deletes one of the account's designs; the account forgets it if it remembered it. True when there was one. */
export async function deleteDesign(userId: string, designId: string): Promise<boolean> {
  if (!isDesignId(designId)) return false;
  return transaction(async client => {
    await lockAccount(client, userId);
    const result = await client.query('DELETE FROM stationery_designs WHERE user_id = $1 AND design_id = $2', [userId, designId]);
    return (result.rowCount ?? 0) > 0;
  });
}

/** The account's remembered design, or null for none (or one this build does not draw). */
export async function rememberedDesign(userId: string): Promise<SavedDesign | null> {
  const result = await query<DesignRow>(
    `SELECT d.design_id, d.name, d.face, d.ornament, d.ruled, d.tone, d.created_at, d.updated_at
       FROM users u
       JOIN stationery_designs d ON d.design_id = u.stationery_design_id AND d.user_id = u.user_id
      WHERE u.user_id = $1`,
    [userId]
  );
  const row = result.rows[0];
  return row ? savedOf(row) : null;
}

/**
 * Remembers one of the account's designs for its next previews, or none
 * (null). A remembered design comes before the remembered theme, and
 * remembering a theme forgets it (rememberStationery), so the last choice is
 * the one remembered. Under the account's lock, so a design deleted meanwhile
 * is simply not found. Never on an erased account or one that is gone, and
 * never another account's design: nothing changes. True when the account now
 * remembers what was asked.
 */
export async function rememberDesign(userId: string, designId: string | null): Promise<boolean> {
  if (designId !== null && !isDesignId(designId)) return false;
  return transaction(async client => {
    const account = await lockAccount(client, userId);
    if (!account || account.erased_at) return false;
    if (designId === null) {
      await client.query('UPDATE users SET stationery_design_id = NULL WHERE user_id = $1', [userId]);
      return true;
    }
    const result = await client.query(
      `UPDATE users u SET stationery_design_id = d.design_id
         FROM stationery_designs d
        WHERE u.user_id = $1 AND d.user_id = u.user_id AND d.design_id = $2`,
      [userId, designId]
    );
    return (result.rowCount ?? 0) > 0;
  });
}
