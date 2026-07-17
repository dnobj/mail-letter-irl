# Infrastructure Overview

Last updated: July 16, 2026

This file is the source of truth for Letter IRL's cloud topology. Keep secrets and private billing records out of Git.

## Topology

Letter IRL uses one Railway project with two isolated Railway environments and one Neon project with isolated production and development database branches.

| Layer | Production | Development |
| --- | --- | --- |
| Backend branch | `master` | `dev` |
| Website branch | `main` | `dev` |
| Railway environment | `production` | `development` |
| Neon branch/database | primary production branch | isolated `dev` branch |
| Auth0 | production tenant | development tenant |
| Stripe | live mode | test mode |
| PostGrid | live mode | test/dummy mode |
| Runtime policy | API and website stay warm | API and website use Railway Serverless (health acceptance passed) |

Railway project ID: `b31314d8-fd09-4582-9c0d-52a36f879228`

- Production environment ID: `039f596b-5510-4b0c-b4de-34cf2e99d1dd`
- Development environment ID: `37c9dbe4-696f-422c-866e-470010ca8949`
- API service: `letter-irl-api`
- Website service: `mail-letter-irl-website`
- Maintenance service: `letter-irl-maintenance`
- Private temporary-image bucket: `letter-irl-images`

Neon project ID: `summer-band-85969681`. Both Railway environments must use the Neon pooled hostname for their own database branch. Production and development data must never share a connection string.

## Runtime Architecture

The API is request-driven. It starts no mail worker, status-sync loop, credit-cleanup loop, or other database polling schedule.

Confirmed sends use a transactional outbox:

1. Lock the draft.
2. Create the letter/postcard order.
3. Deduct credits.
4. Consume the draft.
5. Insert one `letter_jobs` outbox row.
6. Commit all five database effects atomically.
7. Claim the new outbox row and submit it immediately to PostGrid.

The stable provider `Idempotency-Key` is the Letter IRL `letter_id`. A process crash or timeout can therefore be retried without intentionally creating a second provider order. The database enforces one outbox row per letter.

An hourly, short-lived Railway cron process runs `npm run maintenance`. It:

- retries due or stale outbox rows;
- removes expired temporary images;
- synchronizes provider status when six hours have elapsed;
- performs credit, draft, Stripe, and tier cleanup when one day has elapsed;
- closes S3 and PostgreSQL clients, then exits.

Generated images are stored in a private Railway bucket for 15 minutes. Production must not fall back to process memory. Development may use memory only for local execution; deployed development uses the bucket so restart behavior matches production.

## Database Connectivity

- Use a pooled Neon connection string (`-pooler` hostname) in both Railway environments.
- The API pool is capped at five clients with a ten-second idle timeout.
- The maintenance command uses the same pool and closes it before exit.
- The application retries a recognized Neon wake-up connection error once.
- Neon computes remain at `0.25-0.5 CU` with five-minute scale-to-zero enabled.
- There is no separate pg-boss pool and no two-second polling connection.

## Runtime Commands

| Process | Build | Start | Schedule |
| --- | --- | --- | --- |
| API | `npm ci && npm run build` | `npm start` | continuous/warm in prod; Serverless in dev |
| Maintenance | same backend build | `npm run maintenance` | `0 * * * *` |
| Database migration | same backend build | `npm run db:migrate:prod` | API pre-deploy command |
| Website | `npm ci && npm run build` | `npm start` | continuous/warm in prod; Serverless in dev |

The backend executes compiled JavaScript with Node. The website uses Next.js standalone output and disables Next telemetry during production builds.

## Cost Controls

| Platform | Control |
| --- | --- |
| Railway | Email alert at `$7`; hard usage limit at `$20` |
| Neon | Email spending limit at `$10`; do not automatically suspend production |
| Production services | Keep warm until measurements show a meaningful benefit with acceptable latency |
| Development services | Serverless enabled; cold health responses accepted under `1.4s` |
| Temporary images | Private bucket with 15-minute application TTL and hourly cleanup |

Idle target: Railway near its Hobby minimum and Neon approximately `$2-4/month`, with less than `1 CU-hour/day` combined during a seven-day idle observation.

The July 16, 2026 development rollout has the Railway `$7` alert and `$20` hard limit, the Neon `$10` email-only limit, and Serverless for both development web services enabled. Production still uses the temporary ten-minute polling safeguard until the accepted `dev` release is promoted.

See [deployment.md](deployment.md), [railway-setup.md](railway-setup.md), and [idle-cost-operations.md](idle-cost-operations.md).
