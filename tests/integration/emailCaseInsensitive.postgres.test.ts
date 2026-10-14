import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * One account per address, whatever its case (migration 058, #730).
 *
 * Against real PostgreSQL, stopping at 057: the rows that would stop the
 * migration have to exist when 058 runs. Two accounts differing only in case
 * must stop it with a message rather than a bare 23505, and leave the schema
 * as it was (the runner applies everything in one transaction); once they are
 * gone, it must apply, and refuse a new spelling of an address it holds.
 */

const { Pool } = pg;
const enabled = process.env.LIRL_RUN_POSTGRES_INTEGRATION === 'true';
const describePostgres = enabled ? describe : describe.skip;

function schemaName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function databaseUrlForSchema(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  return url.toString();
}

describePostgres('migration 058 on addresses that differ only in case', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let root: string;
  let scoped: string;
  let directory: string;
  let migration058: string;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_email_case');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    scoped = databaseUrlForSchema(baseUrl, schema);

    // Every migration before 058, into a directory of its own.
    root = await mkdtemp(path.join(os.tmpdir(), 'lirl-058-'));
    directory = path.join(root, 'migrations');
    await mkdir(directory, { recursive: true });
    const files = (await readdir(repositoryMigrations)).filter((file) => file.endsWith('.sql'));
    const found = files.find((file) => file.startsWith('058_'));
    if (!found) throw new Error('migration 058 is missing');
    migration058 = found;
    for (const file of files) {
      if (file >= migration058) continue;
      await copyFile(path.join(repositoryMigrations, file), path.join(directory, file));
    }
    await migrate({ connectionString: scoped, migrationsDirectory: directory });
    pool = new Pool({ connectionString: scoped, max: 2 });
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function indexesOnUsers(): Promise<string[]> {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'users' ORDER BY indexname`,
      [schema]
    );
    return rows.map((row) => row.indexname);
  }

  it('stops on two accounts with one address, names the problem, and changes nothing; then applies once they are one', async () => {
    await pool.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used)
       VALUES ('auth0|case-upper', 'Case@example.invalid', 0, 0, 0),
              ('google-oauth2|case-lower', 'case@example.invalid', 0, 0, 0)`
    );

    await copyFile(path.join(repositoryMigrations, migration058), path.join(directory, migration058));
    await expect(migrate({ connectionString: scoped, migrationsDirectory: directory })).rejects.toThrow(
      /differ only in case/
    );
    const before = await indexesOnUsers();
    expect(before).toContain('users_email_key');
    expect(before).toContain('idx_users_email');
    expect(before).not.toContain('users_email_lower_key');

    // An operator joins them; the migration then applies.
    await pool.query(`DELETE FROM users WHERE user_id = 'google-oauth2|case-lower'`);
    await migrate({ connectionString: scoped, migrationsDirectory: directory });
    const after = await indexesOnUsers();
    expect(after).toContain('users_email_lower_key');
    expect(after).not.toContain('users_email_key');
    expect(after).not.toContain('idx_users_email');

    // A new spelling of an address already held is refused, on the index the code names.
    await expect(
      pool.query(
        `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used)
         VALUES ('apple|case-shout', 'CASE@EXAMPLE.INVALID', 0, 0, 0)`
      )
    ).rejects.toMatchObject({ code: '23505', constraint: 'users_email_lower_key' });
    // The address is kept as it was given.
    const { rows } = await pool.query(`SELECT email FROM users WHERE user_id = 'auth0|case-upper'`);
    expect(rows[0].email).toBe('Case@example.invalid');
  });
});
