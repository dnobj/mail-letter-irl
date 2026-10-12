#!/usr/bin/env tsx
/**
 * Database migration runner (development entry point)
 *
 * Usage:
 *   npm run db:migrate          # Run all pending migrations
 *
 * There are no down migrations, so there is no rollback command: a schema is
 * rolled forward by a new migration (db/README.md).
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
import { migrate as runMigrations } from '../src/cli/migrate.js';

// ES modules don't have __dirname, so we create it
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

migrate();
