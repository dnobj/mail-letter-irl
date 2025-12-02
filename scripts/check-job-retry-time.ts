#!/usr/bin/env tsx
import 'dotenv/config';
import { query, closePool } from '../src/db/index.js';

const jobId = process.argv[2] || 'b82723b6-5244-409e-8b4c-7f42adc6cab5';

(async () => {
  const result = await query(`
    SELECT id, name, state, retry_count, start_after, NOW() as current_time
    FROM pgboss.job
    WHERE id = $1
  `, [jobId]);

  if (result.rows.length === 0) {
    console.log('Job not found');
    await closePool();
    return;
  }

  const job = result.rows[0];
  const startAfter = new Date(job.start_after);
  const now = new Date(job.current_time);
  const secondsUntilRetry = Math.round((startAfter - now) / 1000);

  console.log('Job ID:', job.id);
  console.log('Job State:', job.state);
  console.log('Retry Count:', job.retry_count);
  console.log('Current Time:', now.toISOString());
  console.log('Next Retry:', startAfter.toISOString());
  console.log('Seconds until retry:', secondsUntilRetry);

  if (secondsUntilRetry < 0) {
    console.log('❗ Job is past its retry time, should be processing now');
  } else {
    console.log(`⏰ Job will retry in ${secondsUntilRetry} seconds`);
  }

  await closePool();
})();
