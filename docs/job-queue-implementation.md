# Job Queue Implementation Guide

**Status:** Phase 4 - In Progress
**Last Updated:** November 15, 2025
**Technology:** pg-boss (PostgreSQL-backed job queue)

---

## 📋 Overview

Implement a robust background job queue for letter printing and mailing using `pg-boss`, a PostgreSQL-backed job queue that provides:

- **Reliability**: Jobs persisted in database
- **Retry Logic**: Automatic retries with exponential backoff
- **Priority**: Queue jobs by priority
- **Monitoring**: Track job status and failures
- **Scalability**: Multiple workers can process jobs concurrently

---

## 🎯 Goals

1. **Queue letters for processing** after credits are deducted
2. **Process jobs asynchronously** via background worker
3. **Handle failures gracefully** with retry logic
4. **Track job status** for user visibility
5. **Integrate with print/mail API** (stubbed for now)

---

## 📊 Architecture

```
User → send_letter → Deduct Credits → Create Job → Database
                                            ↓
                                       pg-boss queue
                                            ↓
                                      Background Worker
                                            ↓
                                  Print/Mail API (stub)
                                            ↓
                                   Update Letter Status
```

---

## 🗄️ Database Schema

pg-boss automatically creates its own tables for job management:
- `pgboss.job` - Job queue
- `pgboss.archive` - Completed jobs
- `pgboss.schedule` - Scheduled jobs
- `pgboss.subscription` - Worker subscriptions
- `pgboss.version` - Schema version

Our existing `letters` and `letter_jobs` tables track application-level data:

### `letters` table (already exists)
```sql
- letter_id (PK)
- user_id
- recipient_name
- recipient_address
- message
- status ('pending', 'queued', 'processing', 'sent', 'failed')
- created_at
- updated_at
```

### `letter_jobs` table (already exists)
```sql
- job_id (PK)
- letter_id (FK)
- pgboss_job_id (references pg-boss job)
- status ('pending', 'active', 'completed', 'failed', 'retry')
- attempts
- last_error
- created_at
- updated_at
- completed_at
```

---

## 🔧 Implementation Steps

### Step 1: Initialize pg-boss

Create `src/services/jobQueue.ts`:

```typescript
import PgBoss from 'pg-boss';

const DATABASE_URL = process.env.DATABASE_URL;

let boss: PgBoss | null = null;

/**
 * Initialize and start pg-boss
 */
export async function initializeJobQueue(): Promise<PgBoss> {
  if (boss) {
    return boss;
  }

  boss = new PgBoss({
    connectionString: DATABASE_URL,
    schema: 'pgboss',
    max: 10, // Max pool connections
    retryLimit: 3, // Max retries per job
    retryDelay: 60, // Seconds between retries
    retryBackoff: true, // Exponential backoff
    expireInHours: 24 * 7 // Keep jobs for 7 days
  });

  await boss.start();
  console.log('✅ pg-boss job queue started');

  return boss;
}

/**
 * Get the job queue instance
 */
export function getJobQueue(): PgBoss {
  if (!boss) {
    throw new Error('Job queue not initialized. Call initializeJobQueue() first.');
  }
  return boss;
}

/**
 * Stop the job queue (for graceful shutdown)
 */
export async function stopJobQueue(): Promise<void> {
  if (boss) {
    await boss.stop();
    boss = null;
    console.log('✅ pg-boss job queue stopped');
  }
}
```

### Step 2: Create Letter Job Service

Create `src/services/letterJobService.ts`:

```typescript
import { query } from '../db/index.js';
import { getJobQueue } from './jobQueue.js';
import type { Letter, LetterJob } from './types.js';

const LETTER_QUEUE = 'send-letter';

interface LetterJobPayload {
  letterId: string;
  userId: string;
  recipientName: string;
  recipientAddress: string;
  message: string;
}

/**
 * Create a job to send a letter
 */
export async function createLetterJob(letter: Letter): Promise<LetterJob> {
  const boss = getJobQueue();

  // Create payload for pg-boss
  const payload: LetterJobPayload = {
    letterId: letter.letter_id,
    userId: letter.user_id,
    recipientName: letter.recipient_name,
    recipientAddress: letter.recipient_address,
    message: letter.message
  };

  // Send job to pg-boss
  const pgbossJobId = await boss.send(LETTER_QUEUE, payload, {
    priority: 0, // Normal priority
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true
  });

  // Record job in our database
  const result = await query<LetterJob>(
    `INSERT INTO letter_jobs (
      letter_id, pgboss_job_id, status, attempts
    ) VALUES ($1, $2, $3, $4)
    RETURNING *`,
    [letter.letter_id, pgbossJobId, 'pending', 0]
  );

  // Update letter status
  await query(
    `UPDATE letters SET status = $1, updated_at = NOW() WHERE letter_id = $2`,
    ['queued', letter.letter_id]
  );

  console.log(`📬 Created letter job: ${pgbossJobId} for letter ${letter.letter_id}`);

  return result.rows[0];
}

/**
 * Update job status
 */
export async function updateJobStatus(
  jobId: string,
  status: string,
  error?: string
): Promise<void> {
  await query(
    `UPDATE letter_jobs
     SET status = $1,
         last_error = $2,
         attempts = attempts + 1,
         updated_at = NOW(),
         completed_at = CASE WHEN $1 IN ('completed', 'failed') THEN NOW() ELSE completed_at END
     WHERE job_id = $3`,
    [status, error || null, jobId]
  );
}

/**
 * Get job by letter ID
 */
export async function getJobByLetterId(letterId: string): Promise<LetterJob | null> {
  const result = await query<LetterJob>(
    'SELECT * FROM letter_jobs WHERE letter_id = $1',
    [letterId]
  );
  return result.rows[0] || null;
}
```

### Step 3: Create Job Worker

Create `src/workers/letterWorker.ts`:

```typescript
import { getJobQueue } from '../services/jobQueue.js';
import { query } from '../db/index.js';
import { updateJobStatus } from '../services/letterJobService.js';

const LETTER_QUEUE = 'send-letter';

interface LetterJobPayload {
  letterId: string;
  userId: string;
  recipientName: string;
  recipientAddress: string;
  message: string;
}

/**
 * Process a letter job
 */
async function processLetterJob(job: any): Promise<void> {
  const payload: LetterJobPayload = job.data;
  const { letterId, recipientName, recipientAddress, message } = payload;

  console.log(`📨 Processing letter job: ${job.id} for letter ${letterId}`);

  try {
    // TODO: Replace with actual print/mail API call
    // For now, simulate processing
    await simulatePrintAndMail(recipientName, recipientAddress, message);

    // Update letter status to 'sent'
    await query(
      `UPDATE letters SET status = $1, updated_at = NOW() WHERE letter_id = $2`,
      ['sent', letterId]
    );

    // Update job status
    const jobResult = await query(
      'SELECT job_id FROM letter_jobs WHERE letter_id = $1',
      [letterId]
    );
    if (jobResult.rows[0]) {
      await updateJobStatus(jobResult.rows[0].job_id, 'completed');
    }

    console.log(`✅ Letter ${letterId} sent successfully`);
  } catch (error) {
    console.error(`❌ Failed to process letter ${letterId}:`, error);

    // Update letter status to 'failed'
    await query(
      `UPDATE letters SET status = $1, updated_at = NOW() WHERE letter_id = $2`,
      ['failed', letterId]
    );

    // Update job status
    const jobResult = await query(
      'SELECT job_id FROM letter_jobs WHERE letter_id = $1',
      [letterId]
    );
    if (jobResult.rows[0]) {
      await updateJobStatus(jobResult.rows[0].job_id, 'failed', error.message);
    }

    throw error; // Re-throw for pg-boss retry logic
  }
}

/**
 * Simulate print and mail (replace with actual API)
 */
async function simulatePrintAndMail(
  name: string,
  address: string,
  message: string
): Promise<void> {
  // Simulate network delay
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log(`📮 Simulated printing and mailing letter to ${name} at ${address}`);
  console.log(`📄 Message length: ${message.length} characters`);

  // Simulate 5% failure rate for testing retry logic
  if (Math.random() < 0.05) {
    throw new Error('Simulated print/mail API failure');
  }
}

/**
 * Start the letter worker
 */
export async function startLetterWorker(): Promise<void> {
  const boss = getJobQueue();

  await boss.work(
    LETTER_QUEUE,
    {
      teamSize: 5, // Process up to 5 jobs concurrently
      teamConcurrency: 2 // Each worker can handle 2 jobs
    },
    processLetterJob
  );

  console.log('✅ Letter worker started, listening for jobs...');
}
```

### Step 4: Update send_letter Tool

Update `src/tools/sendLetter.ts` to create jobs instead of sending directly:

```typescript
// After deducting credits...

// Create letter record
const letterResult = await query<Letter>(
  `INSERT INTO letters (
    user_id, recipient_name, recipient_address, message, status
  ) VALUES ($1, $2, $3, $4, $5)
  RETURNING *`,
  [userId, recipientName, recipientAddress, message, 'pending']
);

const letter = letterResult.rows[0];

// Queue the letter for processing
await createLetterJob(letter);

return {
  content: [
    {
      type: "text",
      text: `Letter queued successfully!\n\n` +
            `Letter ID: ${letter.letter_id}\n` +
            `Status: Queued for processing\n` +
            `Your letter will be printed and mailed within 1-2 business days.`
    }
  ]
};
```

### Step 5: Start Worker on Server Startup

Update `src/mcp/httpServer.ts`:

```typescript
import { initializeJobQueue } from '../services/jobQueue.js';
import { startLetterWorker } from '../workers/letterWorker.js';

// During server initialization
await initializeJobQueue();
await startLetterWorker();

console.log('✅ Job queue and workers initialized');
```

---

## 🧪 Testing

Create `scripts/test-job-queue.ts`:

```typescript
import 'dotenv/config';
import { initializeJobQueue, stopJobQueue } from '../src/services/jobQueue.js';
import { createLetterJob } from '../src/services/letterJobService.js';
import { query, closePool } from '../src/db/index.js';

async function testJobQueue() {
  console.log('🧪 Testing Job Queue...\n');

  try {
    // Initialize job queue
    await initializeJobQueue();

    // Create test letter
    const letterResult = await query(
      `INSERT INTO letters (
        user_id, recipient_name, recipient_address, message, status
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING *`,
      [
        'test-user-123',
        'Test Recipient',
        '123 Test St, Test City, TS 12345',
        'This is a test letter for the job queue',
        'pending'
      ]
    );

    const letter = letterResult.rows[0];
    console.log(`✅ Created test letter: ${letter.letter_id}`);

    // Queue job
    const job = await createLetterJob(letter);
    console.log(`✅ Job queued: ${job.pgboss_job_id}`);

    console.log('\n✅ Test complete! Check worker logs for processing.');
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await stopJobQueue();
    await closePool();
  }
}

testJobQueue();
```

---

## 📊 Monitoring

### View Job Status

```typescript
const boss = getJobQueue();

// Get job by ID
const job = await boss.getJobById(jobId);

// Get jobs by status
const activeJobs = await boss.fetch('send-letter', 10);
const failedJobs = await boss.fetchFailed('send-letter', 10);
const completedJobs = await boss.fetchCompleted('send-letter', 10);
```

### Admin API Extensions

Add to `src/api/adminApiHandler.ts`:

```typescript
// GET /api/admin/jobs
async function handleGetJobs(res: ServerResponse) {
  const boss = getJobQueue();

  const [active, failed, completed] = await Promise.all([
    boss.fetch('send-letter', 10),
    boss.fetchFailed('send-letter', 10),
    boss.fetchCompleted('send-letter', 10)
  ]);

  sendJson(res, 200, {
    active: active?.length || 0,
    failed: failed?.length || 0,
    completed: completed?.length || 0,
    jobs: {
      active,
      failed,
      completed
    }
  });
}

// POST /api/admin/jobs/:id/retry
async function handleRetryJob(res: ServerResponse, jobId: string) {
  const boss = getJobQueue();
  await boss.resume([jobId]);

  sendJson(res, 200, {
    success: true,
    message: `Job ${jobId} queued for retry`
  });
}
```

---

## 🚀 Deployment

### Production Considerations

1. **Separate Worker Process**: Run workers in separate process/container
2. **Scaling**: Add more workers for higher throughput
3. **Monitoring**: Set up alerts for failed jobs
4. **Cleanup**: Archive old jobs periodically
5. **Dead Letter Queue**: Handle permanently failed jobs

### Environment Variables

```bash
# Job Queue Configuration
PGBOSS_RETRY_LIMIT=3
PGBOSS_RETRY_DELAY=60
PGBOSS_EXPIRE_HOURS=168  # 7 days
PGBOSS_MAX_CONNECTIONS=10
```

---

## ✅ Success Criteria

- [x] pg-boss installed and configured
- [ ] Jobs created successfully from send_letter tool
- [ ] Worker processes jobs asynchronously
- [ ] Failed jobs retry automatically
- [ ] Letter status updates correctly
- [ ] Job monitoring via admin API
- [ ] End-to-end test passes

---

## 📚 Resources

- [pg-boss Documentation](https://github.com/timgit/pg-boss)
- [PostgreSQL Connection Pooling](https://node-postgres.com/features/pooling)
- [Job Queue Best Practices](https://blog.logrocket.com/job-queues-node-js/)

---

**Next Steps:**
1. Implement job queue initialization
2. Create letter job service
3. Update send_letter tool
4. Create and start worker process
5. Test end-to-end flow
6. Add admin monitoring endpoints
