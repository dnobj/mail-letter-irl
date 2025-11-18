import { query } from '../src/db/index.js';

async function compareJobTables() {
  console.log('=== letter_jobs table ===');
  const letterJobs = await query(`
    SELECT job_id, letter_id, status, attempts, created_at
    FROM letter_jobs
    ORDER BY created_at DESC
    LIMIT 10
  `);
  console.table(letterJobs.rows);

  console.log('\n=== pgboss.job table ===');
  const pgBossJobs = await query(`
    SELECT id, name, state, retry_count, created_on
    FROM pgboss.job
    ORDER BY created_on DESC
    LIMIT 10
  `);
  console.table(pgBossJobs.rows);

  console.log('\n=== Summary ===');
  const letterCount = await query('SELECT COUNT(*) as count FROM letter_jobs');
  const pgBossCount = await query('SELECT COUNT(*) as count FROM pgboss.job');
  console.log('letter_jobs count:', letterCount.rows[0].count);
  console.log('pgboss.job count:', pgBossCount.rows[0].count);

  console.log('\n=== States ===');
  const letterStates = await query(`
    SELECT status, COUNT(*) as count
    FROM letter_jobs
    GROUP BY status
  `);
  console.log('letter_jobs by status:');
  console.table(letterStates.rows);

  const pgBossStates = await query(`
    SELECT state, COUNT(*) as count
    FROM pgboss.job
    GROUP BY state
  `);
  console.log('pgboss.job by state:');
  console.table(pgBossStates.rows);

  process.exit(0);
}

compareJobTables().catch(console.error);
