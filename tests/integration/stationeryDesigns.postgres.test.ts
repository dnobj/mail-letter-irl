import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import type { StationeryDesign } from '../../src/render/stationery.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Issue #649 - saved stationery designs, against real PostgreSQL (migration 054).
 *
 * What matters is what the table and the statements hold: at most ten designs
 * per account, one per name in any case, replaced in place; only the choices
 * the renderer draws; nothing saved onto an erased account; another account's
 * design never read, deleted or remembered; a remembered design forgotten
 * when it is deleted, and only that column cleared. A mocked query() accepts
 * any of these broken.
 *
 * Each test truncates first, so none depends on another's leftovers.
 */

const { Pool } = pg;
const enabled = process.env.LIRL_RUN_POSTGRES_INTEGRATION === 'true';
const describePostgres = enabled ? describe : describe.skip;

function schemaName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function databaseUrlForSchema(baseUrl: string, schema: string): string {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}

const PLAIN: StationeryDesign = { face: 'serif', ornament: 'none', ruled: false, tone: 'black' };
const SPRIG: StationeryDesign = { face: 'handwritten', ornament: 'sprig', ruled: true, tone: 'medium' };

describePostgres('saved stationery designs (#649)', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let service: typeof import('../../src/services/stationeryDesignService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_designs');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 6 });

    process.env.DATABASE_URL = scoped;
    service = await import('../../src/services/stationeryDesignService.js');
    closeServicePool = (await import('../../src/db/index.js')).closePool;
  }, 180_000);

  afterAll(async () => {
    await closeServicePool?.();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE stationery_designs, users RESTART IDENTITY CASCADE`);
  });

  async function seedUser(): Promise<string> {
    const userId = `auth0|${randomUUID()}`;
    await pool.query(`INSERT INTO users (user_id, email, credits) VALUES ($1, $2, 0)`, [userId, `${randomUUID()}@test.invalid`]);
    return userId;
  }

  /**
   * Waits until `count` sessions wait behind `holder`, directly or behind
   * another waiter (a second FOR UPDATE waits on the first's tuple lock), so a
   * test starts the next step only once the race it sets up is really running.
   * Counted by who blocks whom, so no other suite's waiting counts.
   */
  async function lockWaiters(holder: pg.PoolClient, count: number): Promise<void> {
    const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    for (let tries = 0; tries < 200; tries += 1) {
      const waiting = await pool.query<{ n: number }>(
        `WITH RECURSIVE waiting(pid) AS (
           SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
           UNION
           SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))
         )
         SELECT count(*)::int AS n FROM waiting`,
        [pid]
      );
      if (waiting.rows[0].n >= count) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`fewer than ${count} sessions waited on the holder's lock`);
  }

  /** Gives a connection back without the transaction a failed test left open, so no lock outlives the test. */
  async function giveBack(client: pg.PoolClient): Promise<void> {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }

  async function saved(userId: string, name: string, design: StationeryDesign = PLAIN) {
    const result = await service.saveDesign(userId, name, design);
    if (!result.ok) throw new Error(`not saved: ${result.refusal}`);
    return result.saved;
  }

  it('saves a design, reads it back, and lists an account\'s own, oldest first', async () => {
    const userId = await seedUser();
    const first = await service.saveDesign(userId, 'Garden', SPRIG);
    expect(first).toMatchObject({ ok: true, replaced: false, saved: { name: 'Garden', design: SPRIG } });
    const second = await saved(userId, 'Plain');
    const other = await seedUser();
    await saved(other, 'Garden');

    expect((await service.listDesigns(userId)).map(design => design.name)).toEqual(['Garden', 'Plain']);
    expect(await service.getDesign(userId, second.designId)).toEqual(second);
    expect(second.createdAt).toBe(second.updatedAt);
    // Another account's design is no design.
    const theirs = (await service.listDesigns(other))[0];
    expect(await service.getDesign(userId, theirs.designId)).toBeNull();
    // Nor is text that is not an id, which never reaches PostgreSQL's uuid parser.
    expect(await service.getDesign(userId, 'not-a-uuid')).toBeNull();
    expect(await service.getDesign(userId, randomUUID())).toBeNull();
  });

  it('replaces the design of the same name, in any case, in place, and takes the name as written now', async () => {
    const userId = await seedUser();
    const first = await saved(userId, 'Garden');
    const again = await service.saveDesign(userId, 'GARDEN', SPRIG);
    expect(again).toMatchObject({ ok: true, replaced: true, saved: { designId: first.designId, name: 'GARDEN', design: SPRIG } });
    const rows = await pool.query(`SELECT name, created_at, updated_at FROM stationery_designs WHERE user_id = $1`, [userId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].updated_at.getTime()).toBeGreaterThanOrEqual(rows.rows[0].created_at.getTime());
  });

  it('holds at most ten designs, though one of a name it has is still replaced', async () => {
    const userId = await seedUser();
    for (let index = 1; index <= service.MAX_STATIONERY_DESIGNS; index += 1) await saved(userId, `Design ${index}`);
    expect(await service.saveDesign(userId, 'Eleventh', PLAIN)).toEqual({ ok: false, refusal: 'limit' });
    expect(await service.saveDesign(userId, 'design 3', SPRIG)).toMatchObject({ ok: true, replaced: true });
    expect(await service.listDesigns(userId)).toHaveLength(service.MAX_STATIONERY_DESIGNS);
    // Another account counts its own.
    expect(await service.saveDesign(await seedUser(), 'Eleventh', PLAIN)).toMatchObject({ ok: true });
  });

  it('counts two saves at once one after the other: never an eleventh', async () => {
    const userId = await seedUser();
    for (let index = 1; index < service.MAX_STATIONERY_DESIGNS; index += 1) await saved(userId, `Design ${index}`);
    // Both saves start while another transaction holds the account's row, so both reach their count at
    // the same moment unless each takes the row first: without the lock, both would count nine.
    const holder = await pool.connect();
    let results: Awaited<ReturnType<typeof service.saveDesign>>[];
    let both: Promise<unknown> = Promise.resolve();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM users WHERE user_id = $1 FOR UPDATE', [userId]);
      const saving = Promise.all([service.saveDesign(userId, 'Tenth', PLAIN), service.saveDesign(userId, 'Also tenth', PLAIN)]);
      both = saving;
      // Both wait: on the account's row with the lock, or, without it, after both counted nine.
      await lockWaiters(holder, 2);
      await holder.query('COMMIT');
      results = await saving;
    } finally {
      await giveBack(holder);
      // A failed step leaves no save running into the next test.
      await Promise.allSettled([both]);
    }
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, refusal: 'limit' }]);
    expect(await service.listDesigns(userId)).toHaveLength(service.MAX_STATIONERY_DESIGNS);
  });

  it('saves nothing onto an erased account, or one that is gone', async () => {
    const userId = await seedUser();
    // Migration 035's tombstone CHECK holds the email to the placeholder whenever erased_at is set.
    await pool.query(
      `UPDATE users SET erased_at = NOW(), email = 'erased-' || gen_random_uuid()::text || '@erased.invalid' WHERE user_id = $1`,
      [userId]
    );
    expect(await service.saveDesign(userId, 'Garden', PLAIN)).toEqual({ ok: false, refusal: 'account_closed' });
    expect(await service.saveDesign(`auth0|${randomUUID()}`, 'Garden', PLAIN)).toEqual({ ok: false, refusal: 'account_closed' });
    expect((await pool.query(`SELECT 1 FROM stationery_designs`)).rowCount).toBe(0);
  });

  it('keeps only the choices the renderer draws, and a trimmed name of one to forty characters', async () => {
    const userId = await seedUser();
    const insert = (name: string, face = 'serif', ornament = 'none', tone = 'black') =>
      pool.query(`INSERT INTO stationery_designs (user_id, name, face, ornament, ruled, tone) VALUES ($1, $2, $3, $4, false, $5)`, [
        userId, name, face, ornament, tone
      ]);
    for (const [label, attempt] of [
      ['an empty name', () => insert('')],
      ['a name of 41 characters', () => insert('x'.repeat(41))],
      ['an untrimmed name', () => insert(' Garden')],
      ['an unknown face', () => insert('A', 'script')],
      ['an unknown ornament', () => insert('B', 'serif', 'border')],
      ['an unknown tone', () => insert('C', 'serif', 'none', 'red')]
    ] as const) {
      await expect(attempt(), label).rejects.toMatchObject({ code: '23514' });
    }
    await insert('x'.repeat(40));
    // Forty characters as PostgreSQL counts them: code points.
    await insert('\u{1F600}'.repeat(40));
    await insert('Garden');
    await expect(insert('garden')).rejects.toMatchObject({ code: '23505' });
  });

  it('deletes only the account\'s own design, and says whether there was one', async () => {
    const userId = await seedUser();
    const mine = await saved(userId, 'Garden');
    const other = await seedUser();
    const theirs = await saved(other, 'Garden');
    expect(await service.deleteDesign(userId, theirs.designId)).toBe(false);
    expect(await service.deleteDesign(userId, 'not-a-uuid')).toBe(false);
    expect(await service.deleteDesign(userId, mine.designId)).toBe(true);
    expect(await service.deleteDesign(userId, mine.designId)).toBe(false);
    expect(await service.getDesign(other, theirs.designId)).toEqual(theirs);
  });

  it("remembers one of the account's own designs, never another's, and forgets it when it is deleted", async () => {
    const userId = await seedUser();
    const mine = await saved(userId, 'Garden', SPRIG);
    const other = await seedUser();
    const theirs = await saved(other, 'Theirs');

    expect(await service.rememberedDesign(userId)).toBeNull();
    expect(await service.rememberDesign(userId, theirs.designId)).toBe(false);
    expect(await service.rememberDesign(userId, 'not-a-uuid')).toBe(false);
    expect(await service.rememberedDesign(userId)).toBeNull();
    expect(await service.rememberDesign(userId, mine.designId)).toBe(true);
    expect(await service.rememberedDesign(userId)).toEqual(mine);

    // The composite key holds any writer to the account's own design.
    await expect(
      pool.query(`UPDATE users SET stationery_design_id = $2 WHERE user_id = $1`, [userId, theirs.designId])
    ).rejects.toMatchObject({ code: '23503' });

    // Deleting it forgets it, and clears only that column.
    await service.deleteDesign(userId, mine.designId);
    const row = await pool.query(`SELECT user_id, stationery_design_id FROM users WHERE user_id = $1`, [userId]);
    expect(row.rows).toEqual([{ user_id: userId, stationery_design_id: null }]);
    expect(await service.rememberedDesign(userId)).toBeNull();

    // And none is remembered on asking for none.
    const again = await saved(userId, 'Again');
    await service.rememberDesign(userId, again.designId);
    expect(await service.rememberDesign(userId, null)).toBe(true);
    expect(await service.rememberedDesign(userId)).toBeNull();
  });

  it("takes the account's row before the design's when it deletes one, as a save and an erasure do, so none waits on another the other way round", async () => {
    const userId = await seedUser();
    const mine = await saved(userId, 'Garden');
    await service.rememberDesign(userId, mine.designId);
    // Another transaction holds the design's row, so the delete stops at it.
    const designHolder = await pool.connect();
    let deleting: Promise<boolean> = Promise.resolve(false);
    try {
      await designHolder.query('BEGIN');
      await designHolder.query('SELECT 1 FROM stationery_designs WHERE design_id = $1 FOR UPDATE', [mine.designId]);
      deleting = service.deleteDesign(userId, mine.designId);
      await lockWaiters(designHolder, 1);
      // Stopped there, it already holds the account's row: nothing else can take it now.
      const probe = await pool.connect();
      try {
        await probe.query('BEGIN');
        await expect(probe.query('SELECT 1 FROM users WHERE user_id = $1 FOR UPDATE NOWAIT', [userId])).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await giveBack(probe);
      }
      await designHolder.query('COMMIT');
      expect(await deleting).toBe(true);
    } finally {
      await giveBack(designHolder);
      // A failed step leaves no delete running into the next test.
      await Promise.allSettled([deleting]);
    }
    expect(await service.rememberedDesign(userId)).toBeNull();
  });

  it('forgets a remembered design when the account remembers a theme: the last choice is the one remembered', async () => {
    const userId = await seedUser();
    const mine = await saved(userId, 'Garden');
    await service.rememberDesign(userId, mine.designId);
    const { rememberStationery } = await import('../../src/services/stationeryDefaultService.js');
    await rememberStationery(userId, 'botanical');
    const row = await pool.query('SELECT stationery_theme, stationery_design_id FROM users WHERE user_id = $1', [userId]);
    expect(row.rows).toEqual([{ stationery_theme: 'botanical', stationery_design_id: null }]);
    // The design itself stays.
    expect(await service.getDesign(userId, mine.designId)).toEqual(mine);
  });

  it("remembers a design a draft is restyled into, never another account's, and a theme after it forgets it (#649 part 3)", async () => {
    const drafts = await import('../../src/services/draftService.js');
    const address = { name: 'Pat Example', addressLine1: '350 Fifth Ave', city: 'New York', state: 'NY', postalCode: '10118', country: 'US' };
    const userId = await seedUser();
    const mine = await saved(userId, 'Garden', SPRIG);
    const other = await seedUser();
    const theirs = await saved(other, 'Theirs');
    const bodyText = 'Dear Sam,';
    const signOff = 'Pat';
    const { draftId } = await drafts.createDraft({
      userId, sender: address, recipient: { ...address, name: 'Sam Rivera' }, bodyText, signOff,
      requiredCredits: 2, previewHtml: '<svg></svg>', layoutType: 'text_only', rendererVersion: 'pdf-1'
    });
    const restyle = (stationery: Record<string, unknown>) =>
      drafts.setDraftStationery(draftId, userId, { stationery: stationery as never, previewHtml: '<svg></svg>', drawnFrom: { bodyText, signOff } });
    const remembered = async () =>
      (await pool.query('SELECT stationery_theme, stationery_design_id FROM users WHERE user_id = $1', [userId])).rows[0];
    const custom = (designId: string) => ({ theme: 'custom', design: SPRIG, name: 'Garden', designId, dateLine: 'October 1, 2026', source: 'asked' });

    await pool.query(`UPDATE users SET stationery_theme = 'typewriter' WHERE user_id = $1`, [userId]);
    expect(await restyle(custom(mine.designId))).toBeNull();
    expect(await remembered()).toEqual({ stationery_theme: 'typewriter', stationery_design_id: mine.designId });
    const stored = await pool.query('SELECT stationery, renderer_version FROM letter_drafts WHERE draft_id = $1', [draftId]);
    expect(stored.rows[0]).toEqual({
      stationery: { theme: 'custom', design: SPRIG, name: 'Garden', dateLine: 'October 1, 2026' },
      renderer_version: 'pdf-2'
    });

    // Another account's design id changes nothing the account remembers, and breaks no key.
    expect(await restyle(custom(theirs.designId))).toBeNull();
    expect((await remembered()).stationery_design_id).toBe(mine.designId);

    // A theme chosen after it is the account's choice now.
    expect(await restyle({ theme: 'botanical', dateLine: 'October 1, 2026', source: 'asked' })).toBeNull();
    expect(await remembered()).toEqual({ stationery_theme: 'botanical', stationery_design_id: null });
  });

  it('restyles a draft into a design deleted meanwhile without breaking a key: the design is simply not remembered (#649 part 3)', async () => {
    const drafts = await import('../../src/services/draftService.js');
    const address = { name: 'Pat Example', addressLine1: '350 Fifth Ave', city: 'New York', state: 'NY', postalCode: '10118', country: 'US' };
    const userId = await seedUser();
    const mine = await saved(userId, 'Garden', SPRIG);
    const bodyText = 'Dear Sam,';
    const signOff = 'Pat';
    const { draftId } = await drafts.createDraft({
      userId, sender: address, recipient: { ...address, name: 'Sam Rivera' }, bodyText, signOff,
      requiredCredits: 2, previewHtml: '<svg></svg>', layoutType: 'text_only', rendererVersion: 'pdf-1'
    });
    const custom = { theme: 'custom', design: SPRIG, name: 'Garden', designId: mine.designId, dateLine: 'October 1, 2026', source: 'asked' };
    // A delete in progress: it holds the account's row, as every design writer takes it first, and has deleted the design.
    const deleter = await pool.connect();
    let restyling: Promise<unknown> = Promise.resolve();
    try {
      await deleter.query('BEGIN');
      await deleter.query('SELECT 1 FROM users WHERE user_id = $1 FOR UPDATE', [userId]);
      await deleter.query('DELETE FROM stationery_designs WHERE design_id = $1', [mine.designId]);
      restyling = drafts.setDraftStationery(draftId, userId, { stationery: custom as never, previewHtml: '<svg></svg>', drawnFrom: { bodyText, signOff } });
      await lockWaiters(deleter, 1);
      await deleter.query('COMMIT');
      // The restyle finds the design gone and remembers nothing: no 23503 from a key to a deleted row.
      expect(await restyling).toBeNull();
    } finally {
      await giveBack(deleter);
      await Promise.allSettled([restyling]);
    }
    const row = await pool.query('SELECT stationery_design_id FROM users WHERE user_id = $1', [userId]);
    expect(row.rows[0].stationery_design_id).toBeNull();
    // The draft keeps its own copy of the design all the same.
    const stored = await pool.query('SELECT stationery FROM letter_drafts WHERE draft_id = $1', [draftId]);
    expect(stored.rows[0].stationery).toEqual({ theme: 'custom', design: SPRIG, name: 'Garden', dateLine: 'October 1, 2026' });
  });

  it('remembers nothing on an erased account', async () => {
    const userId = await seedUser();
    const mine = await saved(userId, 'Garden');
    await pool.query(
      `UPDATE users SET erased_at = NOW(), email = 'erased-' || gen_random_uuid()::text || '@erased.invalid' WHERE user_id = $1`,
      [userId]
    );
    expect(await service.rememberDesign(userId, mine.designId)).toBe(false);
    expect((await pool.query(`SELECT stationery_design_id FROM users WHERE user_id = $1`, [userId])).rows[0].stationery_design_id).toBeNull();
  });

  it('goes with the account when the account row is deleted', async () => {
    const userId = await seedUser();
    const mine = await saved(userId, 'Garden');
    await service.rememberDesign(userId, mine.designId);
    await pool.query(`DELETE FROM users WHERE user_id = $1`, [userId]);
    expect((await pool.query(`SELECT 1 FROM stationery_designs`)).rowCount).toBe(0);
  });

  it('reads past a row of choices this build does not draw, rather than fail the list', async () => {
    const userId = await seedUser();
    await saved(userId, 'Garden');
    // A later build's ornament, written past the CHECK as a later migration would widen it.
    await pool.query(`ALTER TABLE stationery_designs DROP CONSTRAINT stationery_designs_ornament_known`);
    try {
      await pool.query(`INSERT INTO stationery_designs (user_id, name, face, ornament, ruled, tone) VALUES ($1, 'Later', 'serif', 'border', false, 'black')`, [userId]);
      expect((await service.listDesigns(userId)).map(design => design.name)).toEqual(['Garden']);
    } finally {
      await pool.query(`DELETE FROM stationery_designs WHERE ornament = 'border'`);
      await pool.query(
        `ALTER TABLE stationery_designs ADD CONSTRAINT stationery_designs_ornament_known CHECK (ornament IN ('none', 'monogram', 'sprig', 'confetti'))`
      );
    }
  });
});
