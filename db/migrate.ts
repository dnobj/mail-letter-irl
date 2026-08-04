#!/usr/bin/env tsx
/**
 * Database migration runner (development entry point)
 *
 * Usage:
 *   npm run db:migrate          # Run all pending migrations
 *   npm run db:migrate:rollback # Rollback last migration
 *
 * This file is a THIN WRAPPER. The migration algorithm itself lives in
 * `src/cli/migrate.ts`, which is also what production runs via
 * `npm run db:migrate:prod` (`node dist/cli/migrate.js`).
 *
 * Why converged rather than fixed twice: this file previously carried its own
 * copy of the apply loop with exactly the same concurrency defect — a stale
 * pre-loop snapshot of the executed-migration set, a bare ledger INSERT, and no
 * serialisation. Two copies of a subtle locking protocol is two places for it
 * to rot, and they had ALREADY drifted (this one created `executed_at` as
 * TIMESTAMP, production creates it as TIMESTAMPTZ). Converging means the
 * advisory lock, the post-lock ledger re-read, and the ON CONFLICT guard can
 * only ever be tested and fixed in one place, and the dev path now exercises
 * the exact code production runs.
 */

import 'dotenv/config';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { migrate as runMigrations } from '../src/cli/migrate.js';

// ES modules don't have __dirname, so we create it
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { Pool } = pg;

const migrationsDirectory = join(__dirname, 'migrations');

async function migrate() {
  try {
    console.log('🔄 Running database migrations...\n');
    await runMigrations({ migrationsDirectory });
    console.log('\n✨ All migrations completed successfully!\n');
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  }
}

async function rollback() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });
  try {
    console.log('🔄 Rolling back last migration...\n');

    const executed = await pool.query<{ name: string; executed_at: Date }>(
      'SELECT name, executed_at FROM migrations ORDER BY id ASC'
    );
    if (executed.rows.length === 0) {
      console.log('No migrations to rollback.\n');
      return;
    }

    const lastMigration = executed.rows[executed.rows.length - 1];

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
