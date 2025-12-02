#!/usr/bin/env tsx
import 'dotenv/config';
import { query, closePool } from '../src/db/index.js';

async function main() {
  const userId = process.argv[2] || 'google-oauth2|107751181207466431005';

  console.log(`\nChecking data for user: ${userId}\n`);

  // Check user exists
  const userResult = await query('SELECT * FROM users WHERE user_id = $1', [userId]);
  console.log('User record:');
  if (userResult.rows[0]) {
    console.table([userResult.rows[0]]);
  } else {
    console.log('  NOT FOUND');
  }

  // Check letters for this user
  const letterResult = await query(
    'SELECT letter_id, status, credits_cost, created_at, provider FROM letters WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  console.log(`\nLetters for this user: ${letterResult.rows.length}`);
  if (letterResult.rows.length > 0) {
    console.table(letterResult.rows);
  }

  // Check all letters in system
  const allLetters = await query(
    'SELECT letter_id, user_id, status, created_at FROM letters ORDER BY created_at DESC LIMIT 10'
  );
  console.log(`\nAll letters in system (last 10): ${allLetters.rows.length}`);
  if (allLetters.rows.length > 0) {
    console.table(allLetters.rows);
  }

  // Check all users
  const allUsers = await query('SELECT user_id, email, credits FROM users ORDER BY created_at DESC LIMIT 10');
  console.log(`\nAll users in system (last 10): ${allUsers.rows.length}`);
  if (allUsers.rows.length > 0) {
    console.table(allUsers.rows);
  }

  await closePool();
}

main();
