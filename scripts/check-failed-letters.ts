#!/usr/bin/env tsx
import 'dotenv/config';
import { query, closePool } from '../src/db/index.js';

async function main() {
  console.log('Checking recent letters...\n');

  const letters = await query(`
    SELECT letter_id, user_id, status, tracking_id, provider,
           created_at, sent_at, updated_at
    FROM letters
    ORDER BY created_at DESC
    LIMIT 5
  `);

  console.log('Recent Letters:');
  console.log(JSON.stringify(letters.rows, null, 2));

  console.log('\nChecking letter jobs...\n');

  const jobs = await query(`
    SELECT job_id, letter_id, status, attempts, error_message,
           created_at, updated_at
    FROM letter_jobs
    ORDER BY created_at DESC
    LIMIT 5
  `);

  console.log('Recent Jobs:');
  console.log(JSON.stringify(jobs.rows, null, 2));

  await closePool();
}

main();
