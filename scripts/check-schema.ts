#!/usr/bin/env tsx
import 'dotenv/config';
import { query, closePool } from '../src/db/index.js';

async function main() {
  const result = await query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'letters'
    ORDER BY ordinal_position
  `);

  console.log('\nLetters table columns:');
  console.table(result.rows);

  await closePool();
}

main();
