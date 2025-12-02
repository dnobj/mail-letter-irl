#!/usr/bin/env tsx
import 'dotenv/config';
import { query, closePool } from '../src/db/index.js';

async function main() {
  const result = await query(`
    SELECT letter_id, status, recipient, content
    FROM letters
    ORDER BY created_at DESC
    LIMIT 1
  `);

  if (result.rows.length === 0) {
    console.log('No letters found');
    return;
  }

  const letter = result.rows[0];
  console.log('Most recent letter:\n');
  console.log('Letter ID:', letter.letter_id);
  console.log('Status:', letter.status);
  console.log('\nRecipient data:');
  console.log(JSON.stringify(letter.recipient, null, 2));
  console.log('\nContent data:');
  console.log(JSON.stringify(letter.content, null, 2));

  await closePool();
}

main();
