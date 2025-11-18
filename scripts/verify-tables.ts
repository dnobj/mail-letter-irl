#!/usr/bin/env tsx
import 'dotenv/config';
import { pool } from '../src/db/index.js';

async function verifyTables() {
  try {
    const result = await pool.query(`
      SELECT
        table_name,
        (SELECT COUNT(*)
         FROM information_schema.columns
         WHERE table_schema = 'public'
         AND columns.table_name = tables.table_name) as column_count
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    console.log('\n📊 Database Tables:\n');
    console.log('Table Name              Columns');
    console.log('───────────────────────────────────');
    result.rows.forEach(row => {
      console.log(`${row.table_name.padEnd(22)} ${row.column_count}`);
    });
    console.log('');

    await pool.end();
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

verifyTables();
