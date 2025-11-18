#!/usr/bin/env tsx
import 'dotenv/config';
import { query, closePool } from '../src/db/index.js';

const userId = 'google-oauth2|100183416573162262799';

async function main() {
  console.log('Querying for specific user...\n');
  const result = await query('SELECT * FROM users WHERE user_id = $1', [userId]);

  if (result.rows.length > 0) {
    console.log('User record:');
    console.log(JSON.stringify(result.rows[0], null, 2));
  } else {
    console.log('❌ User not found\n');
    console.log('Listing all users in database:\n');
    const allUsers = await query('SELECT user_id, email, credits FROM users');
    console.log(JSON.stringify(allUsers.rows, null, 2));
  }

  await closePool();
}

main();
