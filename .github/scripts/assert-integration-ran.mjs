#!/usr/bin/env node
/**
 * Fail the build if the PostgreSQL integration suites did not actually execute.
 *
 * Why this exists: every Postgres suite in this repository is opt-in and
 * fail-closed. `LIRL_RUN_POSTGRES_INTEGRATION` must be 'true', and
 * `LIRL_TEST_DATABASE_URL` must name a local database containing "test" or
 * "acid". If any of that is wrong, the suites skip silently and vitest exits 0.
 *
 * A green job would then be indistinguishable from a job that proved nothing.
 * That exact ambiguity - a check that passes whether or not the thing it
 * watches is working - has already cost this project real time in production.
 * So a skipped required suite is a build failure, not a quiet pass.
 */

import { readFileSync } from 'node:fs';

/** Suites that must execute. A skip here means CI is lying about its coverage. */
const REQUIRED = [
  'commerceAcid.postgres.test.ts',
  'migrateConcurrency.postgres.test.ts',
  'adminFoundationDatabase.test.ts',
  'adminMigrationOrder.test.ts',
];

/**
 * Suites allowed to skip, with the reason. Listed explicitly so an absent suite
 * is a visible, deliberate gap rather than an unnoticed one.
 */
const OPTIONAL = {
  'migratePooled.postgres.test.ts':
    'needs LIRL_TEST_PGBOUNCER_URL; no PgBouncer service is provisioned in CI yet',
};

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('usage: assert-integration-ran.mjs <vitest-json-report>');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`Could not read the vitest report at ${reportPath}.`);
  console.error('If the test step failed before writing it, fix that first - this');
  console.error('assertion cannot vouch for a run that produced no report.');
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
}

const files = Array.isArray(report.testResults) ? report.testResults : [];

/** Count assertions that genuinely executed, i.e. were not skipped or todo. */
function executedCount(file) {
  const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
  return assertions.filter((a) => a.status !== 'skipped' && a.status !== 'pending' && a.status !== 'todo').length;
}

function findFile(needle) {
  return files.find((f) => typeof f.name === 'string' && f.name.replace(/\\/g, '/').includes(needle));
}

const missing = [];
const empty = [];
const ran = [];

for (const needle of REQUIRED) {
  const file = findFile(needle);
  if (!file) {
    missing.push(needle);
    continue;
  }
  const executed = executedCount(file);
  if (executed === 0) {
    empty.push(needle);
  } else {
    ran.push(`${needle} (${executed} executed)`);
  }
}

console.log('PostgreSQL integration coverage:');
for (const line of ran) console.log(`  ran      ${line}`);
for (const [needle, reason] of Object.entries(OPTIONAL)) {
  const file = findFile(needle);
  const executed = file ? executedCount(file) : 0;
  console.log(executed > 0 ? `  ran      ${needle} (${executed} executed)` : `  skipped  ${needle} - ${reason}`);
}

const failed = Number(report.numFailedTests ?? 0);
console.log(`\ntotals: ${report.numPassedTests ?? 0} passed, ${report.numPendingTests ?? 0} skipped, ${failed} failed`);

let bad = false;

if (missing.length) {
  console.error(`\nFAIL: required suite(s) absent from the report: ${missing.join(', ')}`);
  console.error('The file was never collected. Check the test glob and that the file still exists.');
  bad = true;
}

if (empty.length) {
  console.error(`\nFAIL: required suite(s) present but every test skipped: ${empty.join(', ')}`);
  console.error('This is the silent-skip failure. Almost always one of:');
  console.error('  - LIRL_RUN_POSTGRES_INTEGRATION is not exactly "true"');
  console.error('  - LIRL_TEST_DATABASE_URL is missing, non-local, or its database name');
  console.error('    lacks "test"/"acid" (the suite guard refuses it fail-closed)');
  console.error('  - LETTER_IRL_ADMIN_TEST_DATABASE_URL is unset for the admin suites');
  bad = true;
}

if (failed > 0) {
  console.error(`\nFAIL: ${failed} integration test(s) failed.`);
  bad = true;
}

if (bad) process.exit(1);

console.log('\nOK: every required PostgreSQL suite executed with no failures.');
