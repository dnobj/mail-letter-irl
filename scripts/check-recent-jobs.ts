import 'dotenv/config';
import { query } from '../src/db/index.js';

async function checkRecentJobs() {
  const result = await query(`
    SELECT
      job_id,
      letter_id,
      status,
      attempts,
      error_message,
      created_at
    FROM letter_jobs
    WHERE status = 'completed'
    ORDER BY created_at DESC
    LIMIT 5
  `);

  console.log('Recent Completed Jobs:\n');
  result.rows.forEach(job => {
    console.log(`Job: ${job.job_id}`);
    console.log(`  Letter: ${job.letter_id}`);
    console.log(`  Status: ${job.status}`);
    console.log(`  Attempts: ${job.attempts}`);
    console.log(`  Created: ${job.created_at}`);
    if (job.error_message) {
      console.log(`  Last Error: ${job.error_message.substring(0, 200)}`);
    }
    console.log('');
  });

  process.exit(0);
}

checkRecentJobs();
