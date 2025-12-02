import { query } from '../src/db/index.js';

async function checkLetter() {
  const letterId = 'ca6f7fab-6991-4fa8-a9e7-c6bd47a117c6';
  console.log(`Checking letter ${letterId}...\n`);

  // Get letter details
  const letterResult = await query(`
    SELECT
      letter_id,
      sender_address,
      recipient_address,
      status,
      created_at
    FROM letters
    WHERE letter_id = $1
  `, [letterId]);

  if (letterResult.rows.length > 0) {
    const letter = letterResult.rows[0];
    console.log('LETTER DETAILS:');
    console.log('Status:', letter.status);
    console.log('\nSender Address:');
    console.log(JSON.stringify(letter.sender_address, null, 2));
    console.log('\nRecipient Address:');
    console.log(JSON.stringify(letter.recipient_address, null, 2));
  }

  // Get job details
  const jobResult = await query(`
    SELECT
      id,
      letter_id,
      status,
      attempts,
      error_message,
      created_at
    FROM letter_jobs
    WHERE letter_id = $1
    ORDER BY created_at DESC
    LIMIT 5
  `, [letterId]);

  console.log('\n\nJOB DETAILS:');
  jobResult.rows.forEach((job, idx) => {
    console.log(`\n--- Job ${idx + 1} ---`);
    console.log('Status:', job.status);
    console.log('Attempts:', job.attempts);
    console.log('Created:', job.created_at);
    console.log('Error:', job.error_message);
  });

  process.exit(0);
}

checkLetter().catch(console.error);
