import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';

const { Pool } = pg;

export interface MigrationOptions {
  connectionString?: string;
  migrationsDirectory?: string;
}

export function writeMigrationFailure(error: unknown): void {
  writeDiagnostic('error', 'database.migration_failed', {
    errorClass: classifyDiagnosticError(error, 'database_error')
  });
}

export async function migrate(options: MigrationOptions = {}): Promise<void> {
  const pool = new Pool({
    connectionString: options.connectionString || process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    max: 1,
    connectionTimeoutMillis: 5_000,
  });
  const migrationsDirectory =
    options.migrationsDirectory || path.resolve(process.cwd(), 'db', 'migrations');

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const executed = await pool.query<{ name: string }>('SELECT name FROM migrations');
    const executedNames = new Set(executed.rows.map((row) => row.name));
    const files = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (executedNames.has(file)) continue;
      const sql = await readFile(path.join(migrationsDirectory, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[Migrate] Applied ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate().catch((error) => {
    writeMigrationFailure(error);
    process.exitCode = 1;
  });
}
