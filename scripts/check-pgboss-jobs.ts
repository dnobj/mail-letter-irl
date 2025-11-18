#!/usr/bin/env tsx
import 'dotenv/config';
import { query, closePool } from '../src/db/index.js';

(async () => {
  const result = await query(`
    SELECT id, name, state, priority, retry_limit, retry_count, start_after, created_on
    FROM pgboss.job
    ORDER BY created_on DESC
    LIMIT 10
  `);

  console.log('Recent pg-boss jobs:');
  console.table(result.rows);

  await closePool();
})();
