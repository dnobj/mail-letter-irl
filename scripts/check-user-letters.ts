#!/usr/bin/env tsx
import 'dotenv/config';
import { query, closePool } from '../src/db/index.js';

/**
 * Print one account and its letters, by identity-provider subject.
 *
 * The subject is a required argument, never a constant: this repository is
 * public, and a Google `sub` is a stable identifier for a real person across
 * every service they sign into with that account. The two unbounded dumps that
 * used to follow (the last ten letters and the last ten users, system-wide)
 * are gone; against production they printed other people's data to the
 * terminal whatever account you asked about.
 */
async function main() {
  const userId = process.argv[2];
  if (!userId) {
    console.error('Usage: npx tsx scripts/check-user-letters.ts "<user_id>"');
    console.error('Example: npx tsx scripts/check-user-letters.ts "auth0|000000000000000000000000"');
    process.exitCode = 1;
    return;
  }

  console.log(`\nChecking data for user: ${userId}\n`);

  const userResult = await query('SELECT * FROM users WHERE user_id = $1', [userId]);
  console.log('User record:');
  if (userResult.rows[0]) {
    console.table([userResult.rows[0]]);
  } else {
    console.log('  NOT FOUND');
    await closePool();
    process.exitCode = 1;
    return;
  }

  const letterResult = await query(
    'SELECT letter_id, status, credits_cost, created_at, provider FROM letters WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  console.log(`\nLetters for this user: ${letterResult.rows.length}`);
  if (letterResult.rows.length > 0) {
    console.table(letterResult.rows);
  }

  await closePool();
}

main();
