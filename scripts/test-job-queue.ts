#!/usr/bin/env tsx
/**
 * Test Job Queue
 *
 * Tests the complete job queue flow:
 * 1. Initialize pg-boss
 * 2. Create a test letter in database
 * 3. Queue the letter for processing
 * 4. Start worker to process the job
 * 5. Verify letter status updates
 *
 * Note: This script tests the job system directly without HTTP/MCP
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { initializeJobQueue, stopJobQueue } from '../src/services/jobQueue.js';
import { createLetterJob, getJobByLetterId } from '../src/services/letterJobService.js';
import { startLetterWorker, stopLetterWorker } from '../src/workers/letterWorker.js';
import { query, closePool } from '../src/db/index.js';
import type { Letter } from '../src/services/types.js';

const TEST_USER_ID = 'test-user-123';

async function testJobQueue() {
  console.log('🧪 Testing Job Queue System...\n');

  try {
    // Step 1: Initialize job queue
    console.log('1️⃣  Initializing job queue...');
    await initializeJobQueue();
    console.log('   ✅ Job queue initialized\n');

    // Step 2: Create test letter in database
    console.log('2️⃣  Creating test letter...');
    const letterId = randomUUID();
    const letterResult = await query<Letter>(
      `INSERT INTO letters (
        letter_id, user_id, content, recipient, credits_cost, status
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        letterId,
        TEST_USER_ID,
        JSON.stringify({
          bodyText: 'This is a test letter for the job queue system.',
          signOff: 'Best regards,\nJob Queue Test',
          sender: { name: 'Test Sender' }
        }),
        JSON.stringify({
          name: 'Test Recipient',
          address: '123 Test Street',
          city: 'Test City',
          state: 'TS',
          zipCode: '12345'
        }),
        5,
        'draft'
      ]
    );

    const letter = letterResult.rows[0];
    console.log(`   ✅ Letter created: ${letter.letter_id}`);
    console.log(`   📊 Status: ${letter.status}\n`);

    // Step 3: Queue the letter for processing
    console.log('3️⃣  Queueing letter for processing...');
    const job = await createLetterJob(letter);
    console.log(`   ✅ Job created: ${job.job_id}`);
    console.log(`   📊 Job status: ${job.status}`);
    console.log(`   📊 Attempts: ${job.attempts}/${job.max_attempts}\n`);

    // Step 4: Start worker to process the job
    console.log('4️⃣  Starting worker to process job...');
    await startLetterWorker();
    console.log('   ✅ Worker started\n');

    // Step 5: Wait for job to complete (with timeout)
    console.log('5️⃣  Waiting for job to complete (max 30 seconds)...');
    const maxWaitTime = 30000; // 30 seconds
    const checkInterval = 1000; // Check every second
    let elapsed = 0;
    let jobCompleted = false;

    while (elapsed < maxWaitTime && !jobCompleted) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      elapsed += checkInterval;

      // Check letter status
      const letterCheck = await query<Letter>(
        'SELECT * FROM letters WHERE letter_id = $1',
        [letterId]
      );

      const currentLetter = letterCheck.rows[0];
      const currentJob = await getJobByLetterId(letterId);

      console.log(`   ⏱️  ${elapsed / 1000}s - Letter: ${currentLetter.status}, Job: ${currentJob?.status}`);

      if (currentLetter.status === 'sent' || currentLetter.status === 'failed') {
        jobCompleted = true;
      }
    }

    console.log('');

    // Step 6: Verify final status
    console.log('6️⃣  Verifying final status...');
    const finalLetterResult = await query<Letter>(
      'SELECT * FROM letters WHERE letter_id = $1',
      [letterId]
    );
    const finalLetter = finalLetterResult.rows[0];
    const finalJob = await getJobByLetterId(letterId);

    console.log(`   📄 Letter Status: ${finalLetter.status}`);
    console.log(`   📄 Letter Sent At: ${finalLetter.sent_at || 'N/A'}`);
    console.log(`   📝 Job Status: ${finalJob?.status}`);
    console.log(`   📝 Job Attempts: ${finalJob?.attempts}`);
    console.log(`   📝 Job Completed At: ${finalJob?.completed_at || 'N/A'}`);

    if (finalJob?.error_message) {
      console.log(`   ⚠️  Error: ${finalJob.error_message}`);
    }

    console.log('');

    // Summary
    if (finalLetter.status === 'sent' && finalJob?.status === 'completed') {
      console.log('✅ Job queue test PASSED!');
      console.log('   - Letter was created ✓');
      console.log('   - Job was queued ✓');
      console.log('   - Worker processed the job ✓');
      console.log('   - Letter status updated to "sent" ✓');
      console.log('   - Job status updated to "completed" ✓');
    } else if (finalLetter.status === 'failed') {
      console.log('⚠️  Job queue test completed with FAILURE');
      console.log('   - Job was retried but failed');
      console.log(`   - Error: ${finalJob?.error_message || 'Unknown'}`);
    } else {
      console.log('❌ Job queue test FAILED or TIMEOUT');
      console.log('   - Job may still be processing or failed to start');
    }

    console.log('\n📊 Test complete!\n');

    // Show cleanup instructions
    console.log('🧹 Cleanup (optional):');
    console.log(`   DELETE FROM letters WHERE letter_id = '${letterId}';`);
    console.log(`   DELETE FROM letter_jobs WHERE letter_id = '${letterId}';\n`);

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    // Cleanup
    console.log('🛑 Stopping worker and job queue...');
    try {
      await stopLetterWorker();
    } catch (error) {
      console.error('Error stopping worker:', error.message);
    }
    await stopJobQueue();
    await closePool();
    console.log('✅ Cleanup complete\n');
    process.exit(0);
  }
}

// Run tests
testJobQueue();
