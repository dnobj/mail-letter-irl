#!/usr/bin/env tsx
/**
 * Database migration runner
 *
 * Usage:
 *   npm run db:migrate          # Run all pending migrations
 *   npm run db:migrate:rollback # Rollback last migration
 */

import 'dotenv/config';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

// ES modules don't have __dirname, so we create it
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

interface Migration {
  id: number;
  name: string;
  executed_at: Date;
}

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}

async function getExecutedMigrations(): Promise<Migration[]> {
  const result = await pool.query<Migration>(
    'SELECT * FROM migrations ORDER BY id ASC'
  );
  return result.rows;
}

async function getMigrationFiles(): Promise<string[]> {
  const migrationsDir = join(__dirname, 'migrations');
  const files = await readdir(migrationsDir);
  return files
    .filter(f => f.endsWith('.sql'))
    .sort(); // Sort alphabetically (001, 002, etc.)
}

async function runMigration(filename: string) {
  const filepath = join(__dirname, 'migrations', filename);
  const sql = await readFile(filepath, 'utf-8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Execute migration SQL
    await client.query(sql);

    // Record migration
    await client.query(
      'INSERT INTO migrations (name) VALUES ($1)',
      [filename]
    );

    await client.query('COMMIT');
    console.log(`✅ Executed migration: ${filename}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`❌ Failed migration: ${filename}`);
    throw error;
  } finally {
    client.release();
  }
}

async function migrate() {
  try {
    console.log('🔄 Running database migrations...\n');

    await ensureMigrationsTable();

    const executedMigrations = await getExecutedMigrations();
    const executedNames = new Set(executedMigrations.map(m => m.name));

    const migrationFiles = await getMigrationFiles();
    const pendingMigrations = migrationFiles.filter(f => !executedNames.has(f));

    if (pendingMigrations.length === 0) {
      console.log('✨ No pending migrations. Database is up to date!\n');
      return;
    }

    console.log(`Found ${pendingMigrations.length} pending migration(s):\n`);
    pendingMigrations.forEach(m => console.log(`  - ${m}`));
    console.log('');

    for (const migration of pendingMigrations) {
      await runMigration(migration);
    }

    console.log('\n✨ All migrations completed successfully!\n');
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

async function rollback() {
  try {
    console.log('🔄 Rolling back last migration...\n');

    await ensureMigrationsTable();

    const executedMigrations = await getExecutedMigrations();
    if (executedMigrations.length === 0) {
      console.log('No migrations to rollback.\n');
      return;
    }

    const lastMigration = executedMigrations[executedMigrations.length - 1];

    console.log(`⚠️  WARNING: Rollback will drop all tables and data!`);
    console.log(`   Last migration: ${lastMigration.name}`);
    console.log(`   Executed at: ${lastMigration.executed_at}\n`);
    console.log(`   To rollback, you need to manually drop tables or write down migrations.`);
    console.log(`   For now, recommend: DROP SCHEMA public CASCADE; CREATE SCHEMA public;\n`);

  } catch (error) {
    console.error('❌ Rollback failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run migrations
const command = process.argv[2];

if (command === 'rollback') {
  rollback();
} else {
  migrate();
}
