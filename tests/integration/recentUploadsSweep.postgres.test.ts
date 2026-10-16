import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Issue #282 - an uploaded image's capability URL must not outlive its use.
 *
 *   a read returns a row for at most the TTL (default one hour, capped at six)
 *   purgeExpiredRecentUploads deletes it 24 hours after its last update
 *
 * These run against real PostgreSQL because every property that matters is a
 * property of the statements: the boundary, the direction of each comparison,
 * and the interval casts. A mocked query() accepts a predicate that deletes
 * every row, or none.
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

const UPLOAD_URL = 'https://files.example.invalid/uploaded-photo.png';

describePostgres('recent uploads sweep', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let store: typeof import('../../src/services/recentUploadStore.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_uploads');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 4 });

    process.env.DATABASE_URL = scoped;
    store = await import('../../src/services/recentUploadStore.js');
    closeServicePool = (await import('../../src/db/index.js')).closePool;
  }, 180_000);

  afterAll(async () => {
    store?.clearRecentUploadedImages();
    await closeServicePool?.();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  beforeEach(async () => {
    vi.unstubAllEnvs();
    // The in-process copy would otherwise answer a read before the database.
    store.clearRecentUploadedImages();
    await pool.query(`TRUNCATE recent_uploads, users RESTART IDENTITY CASCADE`);
  });

  async function seedUser(): Promise<string> {
    const userId = `user_${randomUUID()}`;
    await pool.query(`INSERT INTO users (user_id, email, credits) VALUES ($1, $2, 0)`, [
      userId,
      `${userId}@test.invalid`
    ]);
    return userId;
  }

  /** An INSERT with an explicit clock: the updated_at trigger fires only on UPDATE. */
  async function seedUpload(userId: string, age: string): Promise<void> {
    await pool.query(
      `INSERT INTO recent_uploads (user_id, image_url, context, created_at, updated_at)
       VALUES ($1, $2, 'postcard', NOW() - $3::interval, NOW() - $3::interval)`,
      [userId, UPLOAD_URL, age]
    );
  }

  async function uploadExists(userId: string): Promise<boolean> {
    const result = await pool.query(`SELECT 1 FROM recent_uploads WHERE user_id = $1`, [userId]);
    return result.rows.length === 1;
  }

  it('deletes a row just past 24 hours and keeps one just inside', async () => {
    const inside = await seedUser();
    const outside = await seedUser();
    await seedUpload(inside, '23 hours 59 minutes');
    await seedUpload(outside, '24 hours 1 minute');

    await expect(store.purgeExpiredRecentUploads()).resolves.toBe(1);

    expect(await uploadExists(inside)).toBe(true);
    expect(await uploadExists(outside)).toBe(false);
  });

  it('leaves recent rows alone, and a second run deletes nothing', async () => {
    const stale = await seedUser();
    const fresh = await seedUser();
    const other = await seedUser();
    await seedUpload(stale, '3 days');
    await seedUpload(fresh, '5 minutes');
    await seedUpload(other, '2 hours');

    await expect(store.purgeExpiredRecentUploads()).resolves.toBe(1);
    await expect(store.purgeExpiredRecentUploads()).resolves.toBe(0);

    expect(await uploadExists(stale)).toBe(false);
    expect(await uploadExists(fresh)).toBe(true);
    expect(await uploadExists(other)).toBe(true);
  });

  it('never deletes a row a read can still return, even at the longest allowed window', async () => {
    vi.stubEnv('LETTER_IRL_RECENT_UPLOAD_TTL_MS', String(6 * 60 * 60 * 1000));
    const userId = await seedUser();
    await seedUpload(userId, '5 hours 59 minutes');

    await store.purgeExpiredRecentUploads();

    await expect(store.getRecentUploadedImage(userId, 'postcard')).resolves.toMatchObject({
      imageUrl: UPLOAD_URL
    });
  });

  it('reads with the configured window, which proves the interval cast on real PostgreSQL', async () => {
    const userId = await seedUser();
    await seedUpload(userId, '90 minutes');

    // The default one-hour window: too old to read.
    await expect(store.getRecentUploadedImage(userId, 'postcard')).resolves.toBeNull();

    vi.stubEnv('LETTER_IRL_RECENT_UPLOAD_TTL_MS', String(2 * 60 * 60 * 1000));
    store.clearRecentUploadedImages();
    await expect(store.getRecentUploadedImage(userId, 'postcard')).resolves.toMatchObject({
      imageUrl: UPLOAD_URL
    });
  });

  it('keeps a row that a fresh upload refreshed just before the sweep', async () => {
    const userId = await seedUser();
    await seedUpload(userId, '25 hours');

    await store.setRecentUploadedImage(userId, UPLOAD_URL, 'postcard');

    await expect(store.purgeExpiredRecentUploads()).resolves.toBe(0);
    expect(await uploadExists(userId)).toBe(true);
  });

  it('removes the row when the user is deleted', async () => {
    const userId = await seedUser();
    await seedUpload(userId, '5 minutes');

    await pool.query(`DELETE FROM users WHERE user_id = $1`, [userId]);

    expect(await uploadExists(userId)).toBe(false);
  });
});
