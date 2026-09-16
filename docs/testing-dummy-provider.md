# Testing the DummyProvider

Quick guide to test letter sending with the DummyProvider (no real API costs!).

## Prerequisites

1. **Server running** on port 8788
2. **DummyProvider configured** (should be default)
3. **Worker process running** to process jobs

---

## Step 1: Verify DummyProvider is Configured

Check environment (DummyProvider is default):

```bash
echo ${LETTER_PROVIDER:-dummy}
# Should output: dummy
```

Or configure explicitly:

```bash
export LETTER_PROVIDER=dummy
export LETTER_PROVIDER_CONFIG='{"delayMs":1000,"failureRate":0.05,"costCents":100,"deliveryDays":3,"verbose":true}'
```

---

## Step 2: Start the Worker

The worker processes letter jobs from the queue:

```bash
cd /mnt/c/letter-irl

# Option A: Start worker standalone
npx tsx -e "
import { initializeJobQueue } from './src/services/jobQueue.js';
import { startLetterWorker } from './src/workers/letterWorker.js';
await initializeJobQueue();
await startLetterWorker();
console.log('Worker running... Press Ctrl+C to stop');
await new Promise(() => {}); // Keep running
"

# Option B: Worker should auto-start with server (if integrated)
npm run mcp:http
```

You should see:
```
✅ DummyProvider initialized
   Delay: 1000ms
   Failure Rate: 5.0%
   Cost: $1.00
   Delivery Time: 3 days
✅ Letter provider validated: Dummy Provider (Testing)
✅ Letter worker started, listening for jobs on queue: send-letter
```

---

## Step 3: Send a Test Letter via ChatGPT

1. Open ChatGPT with Letter IRL connected
2. Send a message like:

```
Send a test letter to:
John Doe
123 Main St
San Francisco, CA 94102

Message: This is a test letter to verify the DummyProvider works!
```

---

## Step 4: Watch the Logs

You should see:

```
📨 Processing letter job: abc-123 for letter xyz-456
   Letter ID: xyz-456
   User ID: google-oauth2|...
   Recipient: John Doe
📤 Sending letter via provider: Dummy Provider (Testing)
   Tracking ID: DUMMY-abc-123
📤 [DummyProvider] Sending letter to John Doe
   Tracking ID: DUMMY-abc-123
✅ [DummyProvider] Letter queued successfully
   Expected delivery: 2025-11-20
✅ Letter sent via Dummy Provider (Testing)
   Tracking ID: DUMMY-abc-123
   Cost: $1.00
   Expected Delivery: 11/20/2025
✅ Database updated for letter xyz-456
✅ Letter xyz-456 sent successfully (user: google-oauth2|...)
```

---

## Step 5: Verify in Admin Panel

Open http://localhost:8788/admin and:

1. **Load Jobs** - Should show your letter job as "completed"
2. **Load Users** - Should show credit deduction
3. **User Lookup** - Enter your user ID to see transaction history

---

## Testing Different Scenarios

### Fast Testing (No Delay)
```bash
export LETTER_PROVIDER_CONFIG='{"delayMs":0,"failureRate":0,"costCents":100}'
```

### Test Failures (High Failure Rate)
```bash
export LETTER_PROVIDER_CONFIG='{"delayMs":500,"failureRate":0.5,"costCents":100}'
```
Jobs will fail 50% of the time and retry automatically!

### Test Retries
```bash
export LETTER_PROVIDER_CONFIG='{"failureRate":0.8}'
```
Most jobs will fail and trigger pg-boss retry logic.

---

## Checking Letter Status

### Via Database Query
```bash
cd /mnt/c/letter-irl
npx tsx -e "
import { query } from './src/db/index.js';
const result = await query('SELECT letter_id, status, tracking_id, provider, cost_cents, expected_delivery FROM letters ORDER BY created_at DESC LIMIT 5');
console.table(result.rows);
process.exit(0);
"
```

### Via Admin API
```bash
curl -H "Authorization: Bearer YOUR_JWT" \
  http://localhost:8788/api/admin/jobs?limit=10 | jq '.'
```

---

## Troubleshooting

### "No worker picking up jobs"

**Check if worker is running:**
```bash
ps aux | grep letterWorker
```

**Check pg-boss queue:**
```bash
npx tsx -e "
import { query } from './src/db/index.js';
const jobs = await query('SELECT id, name, state, created_on FROM pgboss.job ORDER BY created_on DESC LIMIT 10');
console.table(jobs.rows);
process.exit(0);
"
```

### "Provider not found"

Make sure LETTER_PROVIDER is set:
```bash
export LETTER_PROVIDER=dummy
```

### "Jobs failing immediately"

Check failure rate isn't too high:
```bash
export LETTER_PROVIDER_CONFIG='{"failureRate":0}'
```

---

## Expected Results

✅ Letter job created in `letter_jobs` table
✅ Job picked up by worker within seconds
✅ DummyProvider processes letter (simulated)
✅ Letter status updated to "sent"
✅ Tracking ID assigned (DUMMY-...)
✅ Cost recorded ($1.00 default)
✅ Expected delivery date set
✅ Job marked as "completed"

---

## Next Steps

Once DummyProvider testing works:

1. Research real providers (Lob, PostGrid, Click2Mail)
2. Get API keys
3. Implement provider class (follow DummyProvider pattern)
4. Register provider in `src/services/providers/index.ts`
5. Update environment: `LETTER_PROVIDER=lob`
6. Test with real provider (costs money!)

---

**Happy testing!** 📬
