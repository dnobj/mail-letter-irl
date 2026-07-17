-- Convert letter_jobs into the durable transactional outbox used for mail sends.

ALTER TABLE letter_jobs
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_order_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE letter_jobs
SET idempotency_key = letter_id::text,
    next_attempt_at = COALESCE(scheduled_at, created_at, NOW()),
    locked_at = CASE WHEN status = 'processing' THEN COALESCE(started_at, NOW()) ELSE NULL END,
    provider_order_id = COALESCE(provider_order_id, letters.tracking_id),
    last_error = COALESCE(last_error, error_message),
    updated_at = NOW()
FROM letters
WHERE letters.letter_id = letter_jobs.letter_id;

-- Older pg-boss-backed sends could create more than one audit row. Keep the
-- most useful record before enforcing one outbox item per letter.
WITH ranked AS (
  SELECT job_id,
         ROW_NUMBER() OVER (
           PARTITION BY letter_id
           ORDER BY
             CASE status
               WHEN 'completed' THEN 1
               WHEN 'processing' THEN 2
               WHEN 'pending' THEN 3
               WHEN 'failed' THEN 4
               ELSE 5
             END,
             created_at DESC
         ) AS row_number
  FROM letter_jobs
)
DELETE FROM letter_jobs
WHERE job_id IN (SELECT job_id FROM ranked WHERE row_number > 1);

UPDATE letter_jobs
SET idempotency_key = letter_id::text
WHERE idempotency_key IS NULL;

UPDATE letter_jobs
SET next_attempt_at = COALESCE(scheduled_at, created_at, NOW())
WHERE next_attempt_at IS NULL;

ALTER TABLE letter_jobs
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN next_attempt_at SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_letter_jobs_letter_unique
  ON letter_jobs(letter_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_letter_jobs_idempotency_unique
  ON letter_jobs(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_letter_jobs_due
  ON letter_jobs(next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed', 'processing');

CREATE UNIQUE INDEX IF NOT EXISTS idx_letter_jobs_provider_order_unique
  ON letter_jobs(provider_order_id)
  WHERE provider_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS maintenance_tasks (
  task_name VARCHAR(100) PRIMARY KEY,
  last_started_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  last_status VARCHAR(20),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE letter_jobs IS
  'Durable transactional outbox for provider mail submissions. Claimed with row locks and retried by one-shot maintenance.';

COMMENT ON COLUMN letter_jobs.idempotency_key IS
  'Stable provider idempotency key. Letter IRL uses the letter_id value.';

COMMENT ON TABLE maintenance_tasks IS
  'Last-run and lock state for one-shot Railway cron maintenance tasks.';
