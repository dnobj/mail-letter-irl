import { randomUUID } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Issue #608 - a saved signature, against real PostgreSQL (migration 050).
 *
 * What matters is what the table and the statements hold: one signature per
 * account, replaced in place with the remembered choice turned back on; only
 * a PNG, of a size the renderer can place; nothing saved onto an erased
 * account; and the row gone with the account. A mocked query() accepts any
 * of these broken.
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

/** A real grayscale PNG, as the cleaning writes one. */
async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).toColourspace('b-w').png().toBuffer();
}

describePostgres('saved signatures (#608)', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let service: typeof import('../../src/services/signatureService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_signatures');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 4 });

    process.env.DATABASE_URL = scoped;
    service = await import('../../src/services/signatureService.js');
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
    await pool.query(`TRUNCATE user_signatures, users RESTART IDENTITY CASCADE`);
  });

  async function seedUser(): Promise<string> {
    const userId = `auth0|${randomUUID()}`;
    await pool.query(`INSERT INTO users (user_id, email, credits) VALUES ($1, $2, 0)`, [userId, `${randomUUID()}@test.invalid`]);
    return userId;
  }

  it('saves one signature per account, and replaces it in place with the choice turned back on', async () => {
    const userId = await seedUser();
    const first = await png(300, 90);
    const saved = await service.saveSignature(userId, { png: first, width: 300, height: 90 });
    expect(saved).toMatchObject({ ok: true, replaced: false, signature: { width: 300, height: 90, useByDefault: true } });

    // The person turned it off on a preview (#608's later parts), then saves a new one.
    await pool.query(`UPDATE user_signatures SET use_by_default = FALSE WHERE user_id = $1`, [userId]);
    const second = await png(600, 200);
    const replaced = await service.saveSignature(userId, { png: second, width: 600, height: 200 });
    expect(replaced).toMatchObject({ ok: true, replaced: true, signature: { width: 600, height: 200, useByDefault: true } });

    const rows = await pool.query(`SELECT image_png, width, height, created_at, updated_at FROM user_signatures WHERE user_id = $1`, [userId]);
    expect(rows.rows).toHaveLength(1);
    expect(Buffer.compare(rows.rows[0].image_png, second)).toBe(0);
    expect(rows.rows[0].updated_at.getTime()).toBeGreaterThanOrEqual(rows.rows[0].created_at.getTime());

    const read = await service.getSignature(userId);
    expect(read).toMatchObject({ width: 600, height: 200, useByDefault: true });
    expect(Buffer.compare(read!.png, second)).toBe(0);
    expect(await service.getSignature(await seedUser())).toBeNull();
  });

  it('removes it, and says whether there was one', async () => {
    const userId = await seedUser();
    await service.saveSignature(userId, { png: await png(300, 90), width: 300, height: 90 });
    expect(await service.clearSignature(userId)).toBe(true);
    expect(await service.clearSignature(userId)).toBe(false);
    expect(await service.getSignature(userId)).toBeNull();
  });

  it('saves nothing onto an erased account, or one that is gone', async () => {
    const userId = await seedUser();
    // Migration 035's tombstone CHECK holds the email to the placeholder whenever erased_at is set.
    await pool.query(
      `UPDATE users SET erased_at = NOW(), email = 'erased-' || gen_random_uuid()::text || '@erased.invalid' WHERE user_id = $1`,
      [userId]
    );
    expect(await service.saveSignature(userId, { png: await png(300, 90), width: 300, height: 90 })).toEqual({
      ok: false,
      refusal: 'account_closed'
    });
    expect(await service.saveSignature(`auth0|${randomUUID()}`, { png: await png(300, 90), width: 300, height: 90 })).toEqual({
      ok: false,
      refusal: 'account_closed'
    });
    expect((await pool.query(`SELECT 1 FROM user_signatures`)).rowCount).toBe(0);
  });

  it('keeps only a PNG, of a size the renderer can place', async () => {
    const userId = await seedUser();
    const insert = (bytes: Buffer, width = 300, height = 90) =>
      pool.query(`INSERT INTO user_signatures (user_id, image_png, width, height) VALUES ($1, $2, $3, $4)`, [userId, bytes, width, height]);
    const jpeg = await sharp({ create: { width: 30, height: 10, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    await expect(insert(jpeg)).rejects.toMatchObject({ constraint: 'valid_user_signature_png' });
    await expect(insert(Buffer.from('89504e47', 'hex'))).rejects.toMatchObject({ constraint: 'valid_user_signature_png' });
    await expect(insert(Buffer.alloc(1048577, 0x89))).rejects.toMatchObject({ constraint: 'valid_user_signature_png' });
    const ok = await png(10, 10);
    for (const [width, height] of [[0, 90], [1201, 90], [300, 0], [300, 401]]) {
      await expect(insert(ok, width, height), `${width}x${height}`).rejects.toMatchObject({ constraint: 'valid_user_signature_size' });
    }
    await insert(ok, 1200, 400);
    await expect(
      pool.query(`UPDATE user_signatures SET updated_at = created_at - INTERVAL '1 second' WHERE user_id = $1`, [userId])
    ).rejects.toMatchObject({ constraint: 'valid_user_signature_times' });
  });

  it('goes with the account: the row cascades when a users row is deleted', async () => {
    const userId = await seedUser();
    await service.saveSignature(userId, { png: await png(300, 90), width: 300, height: 90 });
    await pool.query(`DELETE FROM users WHERE user_id = $1`, [userId]);
    expect((await pool.query(`SELECT 1 FROM user_signatures WHERE user_id = $1`, [userId])).rowCount).toBe(0);
  });
});
