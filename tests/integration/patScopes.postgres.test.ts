import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Personal access tokens carry scopes, and none sends (migration 037, #470).
 *
 *   every token reads and drafts, and nothing else: one made after 037, one
 *   inserted without naming scopes, and - the case production depends on - a
 *   row that already existed when 037 ran (the second describe)
 *   the column refuses a scope that does not exist, and a missing value
 *   validateToken and listTokens hand the scopes on
 *
 * Against real PostgreSQL because the default, the NOT NULL and the CHECK are
 * the migration's whole content, and a mocked query() honours none of them.
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

const USER_ID = 'auth0|pat-scopes';
const READ_AND_DRAFT = ['mail:read', 'mail:draft'];

describePostgres('personal access token scopes', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let patService: typeof import('../../src/services/patService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_pat_scopes');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 4 });

    process.env.DATABASE_URL = scoped;
    patService = await import('../../src/services/patService.js');
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
    await pool.query('TRUNCATE personal_access_tokens, users CASCADE');
    await pool.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used)
       VALUES ($1, $2, 0, 0, 0)`,
      [USER_ID, 'pat-scopes@example.invalid']
    );
  });

  it('gives a token made now read and draft, and hands them on', async () => {
    const created = await patService.createToken(USER_ID, 'Laptop');

    const validated = await patService.validateToken(created.token);
    expect(validated).toMatchObject({ valid: true, userId: USER_ID, scopes: READ_AND_DRAFT });

    const [listed] = await patService.listTokens(USER_ID);
    expect(listed.scopes).toEqual(READ_AND_DRAFT);
  });

  it('gives a row that names no scopes the same, as the rows before 037 got', async () => {
    await pool.query(
      `INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix)
       VALUES ($1, 'Old token', 'not-a-real-hash', 'abcd')`,
      [USER_ID]
    );
    const { rows } = await pool.query<{ scopes: string[] }>(
      'SELECT scopes FROM personal_access_tokens WHERE user_id = $1',
      [USER_ID]
    );
    expect(rows[0].scopes).toEqual(READ_AND_DRAFT);
  });

  it('refuses a scope that does not exist and a missing value, and takes an empty list as nothing', async () => {
    const created = await patService.createToken(USER_ID, 'Laptop');

    await expect(
      pool.query(`UPDATE personal_access_tokens SET scopes = ARRAY['mail:admin'] WHERE token_id = $1`, [created.tokenId])
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query('UPDATE personal_access_tokens SET scopes = NULL WHERE token_id = $1', [created.tokenId])
    ).rejects.toMatchObject({ code: '23502' });

    // mail:send stays an allowed value, for a later explicit grant.
    await pool.query(
      `UPDATE personal_access_tokens SET scopes = ARRAY['mail:read', 'mail:send'] WHERE token_id = $1`,
      [created.tokenId]
    );
    expect((await patService.validateToken(created.token)).scopes).toEqual(['mail:read', 'mail:send']);

    // An empty list is allowed and grants nothing, which fails closed.
    await pool.query(`UPDATE personal_access_tokens SET scopes = '{}' WHERE token_id = $1`, [created.tokenId]);
    expect((await patService.validateToken(created.token)).scopes).toEqual([]);
  });
});

/**
 * The case production depends on: a token row that exists when 037 runs. The
 * suite above migrates everything first, so its rows take the column default;
 * this one stops at 036, inserts a token, then applies 037 to it.
 */
describePostgres('migration 037 on tokens that already exist', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let root: string;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_pat_backfill');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);

    // Every migration but 037, into a directory of its own.
    root = await mkdtemp(path.join(os.tmpdir(), 'lirl-037-'));
    const directory = path.join(root, 'migrations');
    await mkdir(directory, { recursive: true });
    const files = (await readdir(repositoryMigrations)).filter((file) => file.endsWith('.sql'));
    const migration037 = files.find((file) => file.startsWith('037_'));
    if (!migration037) throw new Error('migration 037 is missing');
    for (const file of files) {
      if (file === migration037) continue;
      await copyFile(path.join(repositoryMigrations, file), path.join(directory, file));
    }
    await migrate({ connectionString: scoped, migrationsDirectory: directory });

    pool = new Pool({ connectionString: scoped, max: 2 });
    await pool.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used)
       VALUES ($1, $2, 0, 0, 0)`,
      [USER_ID, 'pat-backfill@example.invalid']
    );
    await pool.query(
      `INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix)
       VALUES ($1, 'Made before 037', 'not-a-real-hash', 'wxyz')`,
      [USER_ID]
    );

    // Now 037.
    await copyFile(path.join(repositoryMigrations, migration037), path.join(directory, migration037));
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

  it('gives the row that was already there read and draft, and holds it to the CHECK', async () => {
    const { rows } = await pool.query<{ token_id: number; scopes: string[] }>(
      'SELECT token_id, scopes FROM personal_access_tokens WHERE user_id = $1',
      [USER_ID]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].scopes).toEqual(READ_AND_DRAFT);
    await expect(
      pool.query(`UPDATE personal_access_tokens SET scopes = ARRAY['mail:admin'] WHERE token_id = $1`, [rows[0].token_id])
    ).rejects.toMatchObject({ code: '23514' });
  });
});
