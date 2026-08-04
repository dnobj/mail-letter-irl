/**
 * Run the PostgreSQL integration suite locally, the same way CI does.
 *
 *   npm run test:integration:local
 *
 * Removes the two things that make this annoying by hand: remembering the
 * environment variable names, and creating the databases first.
 *
 * Connection details come from the environment, or from a gitignored
 * `.env.integration.local` at the repo root (the repo's .gitignore already
 * covers `.env*`). Nothing about a specific machine is hardcoded here, so this
 * works equally against Docker, a native install, or a WSL cluster.
 *
 * Example `.env.integration.local`:
 *
 *   LIRL_TEST_DATABASE_URL=postgres://postgres:PASSWORD@127.0.0.1:5432/letterirl_test
 *   LETTER_IRL_ADMIN_TEST_DATABASE_URL=postgres://postgres:PASSWORD@127.0.0.1:5432/letterirl_admin_test
 *
 * The suite's own guard refuses any non-local host and any database name
 * without "test" or "acid" in it, so it cannot be pointed at a shared
 * environment even by accident.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;

const ENV_FILE = path.resolve(process.cwd(), '.env.integration.local');
const MAIN_KEY = 'LIRL_TEST_DATABASE_URL';
const ADMIN_KEY = 'LETTER_IRL_ADMIN_TEST_DATABASE_URL';

function loadEnvFile(): void {
  if (!existsSync(ENV_FILE)) return;
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue; // a real environment variable wins
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
  console.log(`Loaded ${path.basename(ENV_FILE)}`);
}

function explainAndExit(): never {
  console.error(`\nBoth ${MAIN_KEY} and ${ADMIN_KEY} must be set.`);
  console.error(`\nEasiest: create ${path.basename(ENV_FILE)} at the repo root (gitignored):\n`);
  console.error(`  ${MAIN_KEY}=postgres://postgres:PASSWORD@127.0.0.1:5432/letterirl_test`);
  console.error(`  ${ADMIN_KEY}=postgres://postgres:PASSWORD@127.0.0.1:5432/letterirl_admin_test`);
  console.error('\nYou need a PostgreSQL 17 reachable locally. Any of these work:');
  console.error('  docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17');
  console.error('  a native install, or an existing local cluster on any port');
  console.error('\nDatabase names must contain "test" or "acid" and the host must be local:');
  console.error('  the suite refuses anything else, so it can never hit a shared environment.');
  process.exit(1);
}

/** Create the target database if it is missing. Connects to the server's `postgres` database. */
async function ensureDatabase(connectionString: string): Promise<void> {
  const url = new URL(connectionString);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!databaseName) throw new Error(`No database name in ${MAIN_KEY}/${ADMIN_KEY}`);

  const adminUrl = new URL(connectionString);
  adminUrl.pathname = '/postgres';

  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (existing.rowCount) {
      console.log(`  exists  ${databaseName}`);
      return;
    }
    // Identifier cannot be parameterised; quote it rather than interpolate raw.
    await client.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
    console.log(`  created ${databaseName}`);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  loadEnvFile();

  const main = process.env[MAIN_KEY];
  const admin = process.env[ADMIN_KEY];
  if (!main || !admin) explainAndExit();

  console.log('Preparing databases:');
  try {
    await ensureDatabase(main);
    await ensureDatabase(admin);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nCould not reach PostgreSQL: ${message}`);
    console.error('Check the server is running and the credentials in the URLs are correct.');
    process.exit(1);
  }

  console.log('\nRunning integration suite (this takes ~75s; one test deliberately');
  console.log('waits out a 60s lock_timeout, which is not a hang)\n');

  const reportPath = path.join(os.tmpdir(), 'lirl-integration-report.json');

  const testCode = await run('npx', [
    'vitest',
    'run',
    'tests/integration',
    '--reporter=default',
    '--reporter=json',
    `--outputFile=${reportPath}`,
  ]);

  // Every Postgres suite here is opt-in and fail-closed, so a misconfigured run
  // skips everything and still exits 0. Without this check a green local run
  // would be indistinguishable from one that proved nothing.
  console.log('');
  const assertCode = await run('node', ['.github/scripts/assert-integration-ran.mjs', reportPath]);

  process.exit(testCode !== 0 ? testCode : assertCode);
}

/** Run a command with inherited stdio and resolve its exit code. */
function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, LIRL_RUN_POSTGRES_INTEGRATION: 'true' },
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
