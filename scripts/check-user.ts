#!/usr/bin/env tsx
import 'dotenv/config';
import { query, closePool } from '../src/db/index.js';

/**
 * Print one account row, by identity-provider subject.
 *
 * The subject is an argument, never a constant: this repository is public, and
 * a Google `sub` is a stable identifier for a real person across every service
 * they sign into with that account. There is also no "list every user"
 * fallback here any more, because against production that printed a customer
 * list to the terminal and into the shell's scrollback.
 */
async function main() {
  const userId = process.argv[2];
  if (!userId) {
    console.error('Usage: npx tsx scripts/check-user.ts "<user_id>"');
    console.error('Example: npx tsx scripts/check-user.ts "auth0|000000000000000000000000"');
    process.exitCode = 1;
    return;
  }

  const result = await query('SELECT * FROM users WHERE user_id = $1', [userId]);

  if (result.rows.length > 0) {
    console.log('User record:');
    console.log(JSON.stringify(result.rows[0], null, 2));
  } else {
    console.log('User not found.');
    process.exitCode = 1;
  }

  await closePool();
}

main();
