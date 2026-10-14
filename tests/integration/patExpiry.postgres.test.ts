import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Every personal access token expires (migration 057, #730). Tokens made
 * before the expiry rule were stored with none; the migration gives each one,
 * 90 days after it was made but never sooner than 30 days from the migration,
 * then holds the column NOT NULL with a 90-day default.
 *
 * Against real PostgreSQL, stopping at 056: the rows have to exist, without an
 * expiry, when 057 runs, and the NOT NULL and default are the migration's
 * whole content.
 */

const { Pool } = pg;
const enabled = process.env.LIRL_RUN_POSTGRES_INTEGRATION === 'true';
const describePostgres = enabled ? describe : describe.skip;
const USER_ID = 'auth0|pat-expiry';
const DAY_MS = 24 * 60 * 60 * 1000;

function schemaName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function databaseUrlForSchema(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl);
  // UTC, so INTERVAL '90 days' is exactly 90 x 24 hours: in a zone with daylight
  // saving a clock change inside the window moves it by an hour (CI and Neon are UTC).
  url.searchParams.set('options', `-c search_path=${schema},public -c TimeZone=UTC`);
  return url.toString();
}

describePostgres('migration 057 on tokens with no expiry', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let root: string;
  let scoped: string;
  let directory: string;
  let migration057: string;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_pat_expiry');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    scoped = databaseUrlForSchema(baseUrl, schema);

    // Every migration before 057, into a directory of its own.
    root = await mkdtemp(path.join(os.tmpdir(), 'lirl-057-'));
    directory = path.join(root, 'migrations');
    await mkdir(directory, { recursive: true });
    const files = (await readdir(repositoryMigrations)).filter((file) => file.endsWith('.sql'));
    const found = files.find((file) => file.startsWith('057_'));
    if (!found) throw new Error('migration 057 is missing');
    migration057 = found;
    for (const file of files) {
      if (file >= migration057) continue;
      await copyFile(path.join(repositoryMigrations, file), path.join(directory, file));
    }
    await migrate({ connectionString: scoped, migrationsDirectory: directory });

    pool = new Pool({ connectionString: scoped, max: 2 });
    await pool.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used) VALUES ($1, $2, 0, 0, 0)`,
      [USER_ID, 'pat-expiry@example.invalid']
    );
    // Made a year ago with no expiry; made ten days ago with no expiry; and one with its own.
    await pool.query(
      `INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix, created_at, expires_at)
       VALUES ($1, 'Old', 'hash-old', 'old1', NOW() - INTERVAL '365 days', NULL),
              ($1, 'Recent', 'hash-recent', 'rec1', NOW() - INTERVAL '10 days', NULL),
              ($1, 'Dated', 'hash-dated', 'dat1', NOW() - INTERVAL '10 days', NOW() + INTERVAL '200 days')`,
      [USER_ID]
    );

    // Now 057.
    await copyFile(path.join(repositoryMigrations, migration057), path.join(directory, migration057));
    await migrate({ connectionString: scoped, migrationsDirectory: directory });
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function expiryOf(name: string): Promise<{ expires: Date; created: Date }> {
    const { rows } = await pool.query<{ expires_at: Date; created_at: Date }>(
      'SELECT expires_at, created_at FROM personal_access_tokens WHERE name = $1',
      [name]
    );
    return { expires: rows[0].expires_at, created: rows[0].created_at };
  }

  it('gives an old token 30 days from now, never an expiry already past', async () => {
    const { expires } = await expiryOf('Old');
    expect(Math.abs(expires.getTime() - (Date.now() + 30 * DAY_MS))).toBeLessThan(60 * 60 * 1000);
  });

  it('gives a recent token 90 days from when it was made', async () => {
    const { expires, created } = await expiryOf('Recent');
    expect(expires.getTime() - created.getTime()).toBe(90 * DAY_MS);
  });

  it('keeps a token that already had an expiry as it was', async () => {
    const { expires, created } = await expiryOf('Dated');
    expect(expires.getTime() - created.getTime()).toBe(210 * DAY_MS);
  });

  it('refuses a token with no expiry from now on, and gives one inserted without it 90 days', async () => {
    await expect(
      pool.query(
        `INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix, expires_at)
         VALUES ($1, 'Never', 'hash-never', 'nev1', NULL)`,
        [USER_ID]
      )
    ).rejects.toMatchObject({ code: '23502' });
    await pool.query(
      `INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix) VALUES ($1, 'Default', 'hash-default', 'def1')`,
      [USER_ID]
    );
    const { expires, created } = await expiryOf('Default');
    expect(Math.abs(expires.getTime() - created.getTime() - 90 * DAY_MS)).toBeLessThan(60 * 1000);
  });
});
