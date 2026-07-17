# Idle-Cost Operations

Last updated: July 16, 2026

This runbook keeps idle infrastructure inexpensive without adding production cold starts.

## Expected Baseline

- Railway should remain close to the Hobby plan minimum while production stays warm.
- Neon should normally suspend five minutes after the last database activity.
- The hourly maintenance run will wake its environment briefly.
- Combined Neon usage should remain below `1 CU-hour/day` during a seven-day idle observation.
- Initial combined idle target is approximately `$7-10/month` across Railway and Neon.

Do not record invoice screenshots, payment methods, account recovery data, or credentials in Git.

## Rollout Checkpoint

Verified in development on July 16, 2026:

- the transactional-outbox migration is applied;
- normal API and website health checks pass;
- the one-shot maintenance service completes successfully and exits with its database pool closed;
- the API and maintenance service use the Neon pooled development hostname;
- the Railway `$7` email alert and `$20` hard limit are active;
- the Neon `$10` email-only spending limit is active;
- both Neon computes use `0.25-0.5 CU` and five-minute scale-to-zero;
- the development Neon compute has suspended while idle;
- Railway Serverless is enabled for the development API and website only.

Still required before production promotion:

- prove a generated image remains available through an API restart;
- observe both development Railway services sleeping for more than ten minutes and measure their first responses;
- render an MCP widget and generate or reuse an image after wake-up;
- complete the zero-balance, simulated-purchase, send, and status manual flow;
- observe combined Neon usage for seven idle days.

Production still runs the pre-outbox release with a temporary ten-minute polling safeguard. Its compute can suspend between polls but will continue to wake periodically until the accepted development release is promoted.

## Why the Previous Idle Cost Was High

The API previously ran a PostgreSQL-backed queue poll every two seconds. That traffic prevented Neon from reaching its scale-to-zero window. The API now performs normal mail submission during the confirmed request and relies on an hourly, one-shot maintenance process only for recovery and periodic tasks.

## Daily Checks During Rollout

For seven days after enabling the new architecture, record these values outside the repository:

- Railway API and website memory by environment;
- Railway service active/sleep state;
- maintenance duration and exit status;
- Neon compute active time and CU-hours by branch;
- count of pending, processing, failed, and completed outbox rows;
- first-use recovery time for sleeping development services;
- MCP, widget, image, and website errors after wake-up.

## Outbox Health

Healthy behavior:

- normal confirmed mail is submitted immediately;
- one `letter_jobs` row exists per letter;
- completed jobs contain one provider order ID;
- transient failures become pending with a future `next_attempt_at`;
- a processing row locked for more than 15 minutes is reclaimed by maintenance;
- repeated sends of the same draft return the existing order without another credit deduction.

Investigate immediately if:

- the same letter has multiple provider orders;
- a user's credits are deducted more than once for one draft;
- pending jobs remain due after two hourly maintenance runs;
- maintenance remains running near its next schedule;
- the hourly command exits without closing PostgreSQL clients.

## Image Health

Cloud deployments must use the private bucket. Verify that:

1. Generate an image and note its temporary URL.
2. Restart the development API.
3. Retrieve the image before 15 minutes have elapsed.
4. Run maintenance after expiry and confirm the object is removed.
5. Confirm bucket credentials never appear in logs or tool responses.

## Serverless Acceptance

Development API and website use Railway Serverless. Keep it enabled only while the following acceptance checks pass:

1. Leave both services without traffic for more than ten minutes.
2. Confirm Railway reports them asleep.
3. Measure the first API health request and first website request.
4. Connect the ChatGPT app, render a widget, and generate/reuse an image.
5. Disable Serverless if first-use latency exceeds three seconds or any MCP/widget flow fails.

Production remains warm initially. Revisit production Serverless only with measured traffic and an explicit user-experience review.

## Database Acceptance

- Both Railway `DATABASE_URL` values use Neon pooled hostnames.
- Production and development point to different Neon branches/databases.
- Both computes use `0.25-0.5 CU` and a five-minute scale-to-zero window.
- No `pg-boss` connection or API polling loop remains.
- A recognized wake-up connection failure is retried once, not indefinitely.

If an environment never suspends, inspect Railway deployment logs and Neon query activity before changing the scale-to-zero setting. Common causes are application polling, long-lived database sessions, external monitoring queries, and manual console sessions.

## Budgets and Limits

- Railway email alert: `$7`
- Railway hard usage limit: `$20`
- Neon email spending limit: `$10`
- Neon automatic production suspension: disabled

Keep Neon Launch for one measured billing cycle. Consider Free only if monthly usage remains below `50 CU-hours` and storage below `0.25 GB`, with at least 50% headroom against the then-current Free limits.

## Rollback Triggers

Roll back the affected optimization when:

- first-use recovery exceeds three seconds;
- an MCP or widget flow fails after wake-up;
- generated images fail after an API restart;
- duplicate provider orders or credit deductions are observed;
- hourly recovery does not process due rows;
- production availability is reduced.

Disable Serverless first when the problem is wake latency. Redeploy the previous application version for a code regression, but retain outbox rows, idempotency keys, migrations, and bucket objects so retries remain safe.
