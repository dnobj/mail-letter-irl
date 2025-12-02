#!/usr/bin/env npx tsx
import { query } from '../src/db/index.js';

async function main() {
  const result = await query('SELECT user_id, email FROM users LIMIT 5');
  console.log('Users:');
  for (const row of result.rows) {
    console.log(row);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
