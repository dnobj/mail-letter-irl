# Infrastructure Overview

**Last Updated:** September 16, 2026
**Purpose:** Source of truth for Letter IRL's cloud topology

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
| API URL | `https://api.letterirl.com` | `https://letter-irl-api-development.up.railway.app` |
| Website URL | `https://letterirl.com` | `https://mail-letter-irl-website-development.up.railway.app` |

Railway project ID: `b31314d8-fd09-4582-9c0d-52a36f879228`

- Production environment ID: `039f596b-5510-4b0c-b4de-34cf2e99d1dd`
- Development environment ID: `37c9dbe4-696f-422c-866e-470010ca8949`
- API service: `letter-irl-api`
- Website service: `mail-letter-irl-website`
- Maintenance services: `letter-irl-maintenance` (production) and `letter-irl-maintenance-dev` (development), hourly cron
- Admin panel services: `letter-irl-admin` (development) and `letter-irl-admin-prod` (production), both tailnet-only
- Private temporary-image bucket: `letter-irl-images`

Neon project ID: `summer-band-85969681`. Both Railway environments must use the Neon pooled hostname for their own database branch. Production and development data must never share a connection string.

Each environment also has a dedicated Auth0 MCP API identifier equal to its
canonical `/mcp` endpoint and a separate ChatGPT public CIMD application.
Website/REST audiences are not changed in place. Startup issuer allowlists and
exact audience/resource validation prevent development/production crossover.
Claude and PAT authentication remain separate from ChatGPT CIMD.

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

A Pay & Send order's letter and outbox row are created by the payment webhook instead, and the next
hourly maintenance run submits them.

The stable provider `Idempotency-Key` is the Letter IRL `letter_id`. A process crash or timeout can therefore be retried without intentionally creating a second provider order. The database enforces one outbox row per letter.

An hourly, short-lived Railway cron process runs `npm run maintenance` (`src/cli/runMaintenance.ts`).
In order, it:

- puts back quarantined content the admin panel queued for restore (`retention-restores`, #153),
  first, so a copy queued for restore is never purged by the same run;
- runs the content retention pass once a day. By default this only **reports** what the letter and
  draft sweep would clear (`content-retention-report`); it clears content only when
  `CONTENT_RETENTION_MODE=enforce`, which is switched on in development first, then production
  (#153). `CONTENT_RETENTION_ENABLED=false` skips the pass entirely;
- deletes the link to a user's uploaded image 24 hours after their last upload (`recent-uploads-sweep`, #282);
- deletes feature requests 12 months after they were submitted (`feature-requests-sweep`, #393);
- carries out the account erasures queued from the admin panel (`account-erasures`, #289,
  [account-erasure.md](account-erasure.md));
- retries due or stale outbox rows;
- reconciles commerce: fulfils paid Pay & Send orders that were not fulfilled, settles pending checkouts
  against Stripe (paid or expired), cancels orphaned checkouts, and retries `refund_pending` refunds;
- reconciles proportional pack refunds whose Stripe outcome is unknown or still pending (#323);
- recovers stale image-generation reservations;
- removes expired temporary images;
- synchronizes provider status when six hours have elapsed;
- once a day, expires credit lots, reconciles cached balances, expires and cleans drafts, reconciles
  the last 7 days of Stripe payments, and recalculates user tiers;
- closes S3 and PostgreSQL clients, then exits.

The first three passes are wrapped so that a failure in one cannot skip mail dispatch.

While `LETTER_IRL_OUTBOX_DISPATCH_ENABLED=false` pauses the outbox (#444,
[operational-acceptance.md](operational-acceptance.md)), the outbox pass claims nothing and logs
`outbox.dispatch_paused` with the number of letters waiting. Its two crash sweeps still run, so a send
interrupted mid-dispatch, the redeploy that sets the switch included, is still settled: held for an
operator if the provider may have it, or failed and refunded if it never reached the provider on its last
attempt. While letters are waiting, the run withholds its heartbeat, so the external monitor alerts until
the outbox is switched back on.

Generated images are stored in a private Railway bucket for 15 minutes. Production must not fall back to process memory. Development may use memory only for local execution; deployed development uses the bucket so restart behavior matches production.

## Database Connectivity

- Use a pooled Neon connection string (`-pooler` hostname) in both Railway environments.
- The API pool is capped at five clients with a ten-second idle timeout.
- The maintenance command uses the same pool and closes it before exit.
- The application retries a recognized Neon wake-up connection error once.
- Neon computes remain at `0.25-0.5 CU` with five-minute scale-to-zero enabled.
- There is no separate pg-boss pool and no two-second polling connection.

The admin panel is a separate Railway service in each environment: `letter-irl-admin` in development
and `letter-irl-admin-prod` in production, which has passed all three owner gates and runs in full
mode. It has no public domain: the container runs
`tailscaled` in userspace mode and publishes the panel to the owner's tailnet with Tailscale Serve, and
the application listens on loopback only. It connects as the environment's `letter_irl_admin_reader_<env>`
role (and, in full mode, the operator role), never as the API's owner role. Public API/MCP processes still
return 404 for every legacy `/admin*` and `/api/admin*` path. See
[admin-panel-guide.md](admin-panel-guide.md).

## Runtime Commands

| Process | Build | Start | Schedule |
| --- | --- | --- | --- |
| API | `npm ci && npm run build` | `npm start` | continuous/warm in prod; Serverless in dev |
| Maintenance | same backend build | `npm run maintenance` | `0 * * * *` |
| Database migration | same backend build | `npm run db:migrate:prod` | pre-deploy, both services (`railway.toml`, which Railway stops reading on 2026-12-01; see [deployment.md](deployment.md)) |
| Website | `npm ci && npm run build` | `npm start` | continuous/warm in prod; Serverless in dev |
| Admin panel | `Dockerfile.admin`, selected by the service's `RAILWAY_DOCKERFILE_PATH` variable; settings in the dashboard, no pre-deploy migration | `node dist/admin/server.js` | continuous; never Serverless; no public domain; volume at `/data` |

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

The Railway `$7` alert and `$20` hard limit and the Neon `$10` email-only limit were verified active on July 16, 2026, when Serverless was enabled for both development web services. Production runs the same outbox architecture; the temporary ten-minute polling safeguard it used during that rollout no longer exists.

See [deployment.md](deployment.md), [railway-setup.md](railway-setup.md), and [idle-cost-operations.md](idle-cost-operations.md).
