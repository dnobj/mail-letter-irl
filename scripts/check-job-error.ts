#!/usr/bin/env tsx
import 'dotenv/config';
import { query, closePool } from '../src/db/index.js';

const jobId = process.argv[2] || 'b82723b6-5244-409e-8b4c-7f42adc6cab5';

(async () => {
  const result = await query(`
    SELECT id, name, state, retry_count, retry_limit, data, output
    FROM pgboss.job
    WHERE id = $1
  `, [jobId]);

  if (result.rows.length === 0) {
    console.log('Job not found');
    await closePool();
    return;
  }

  const job = result.rows[0];
  console.log('Job ID:', job.id);
  console.log('Name:', job.name);
  console.log('State:', job.state);
  console.log('Retry count:', `${job.retry_count}/${job.retry_limit}`);
  console.log('\nJob Data:');
  console.log(JSON.stringify(job.data, null, 2));
  console.log('\nJob Output (error):');
  console.log(JSON.stringify(job.output, null, 2));

  await closePool();
})();
