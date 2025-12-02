#!/usr/bin/env npx tsx
/**
 * Show credit_ledger table structure and data
 */

import { query } from '../src/db/index.js';

async function main() {
  // Get table structure
  const cols = await query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'credit_ledger'
    ORDER BY ordinal_position
  `);

  console.log('credit_ledger columns:');
  console.log('='.repeat(70));
  for (const col of cols.rows) {
    const c = col as { column_name: string; data_type: string; is_nullable: string };
    console.log(`${c.column_name.padEnd(25)} ${c.data_type.padEnd(25)} ${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
  }

  // Get sample data
  console.log('\nSample data:');
  console.log('='.repeat(70));
  const data = await query('SELECT * FROM credit_ledger LIMIT 5');
  for (const row of data.rows) {
    console.log(JSON.stringify(row, null, 2));
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
