# Deployment Guide

Last updated: July 16, 2026

Letter IRL deploys development first. Production is promoted only after automated and manual verification succeeds in development.

## Branch and Environment Mapping

| Repository | Development | Production |
| --- | --- | --- |
| `letter-irl` backend | `dev` -> Railway development | `master` -> Railway production |
| `letter-irl-website` | `dev` -> Railway development | `main` -> Railway production |

Feature branches target `dev`. Do not merge feature branches directly to `master` or `main`.

## Backend Release Settings

Railway builds the backend once with Node 22 and these commands:

```text
Install: npm ci
Build: npm run build
Pre-deploy: npm run db:migrate:prod
API start: npm start
Cron start: npm run maintenance
```

`npm start` runs `node dist/mcp/httpServer.js`. The API process must not start workers or recurring maintenance timers.

The maintenance service uses the same repository and environment variables, runs on `0 * * * *`, and must exit after each run. A cron execution that overlaps the next schedule is an operational failure.

## Website Release Settings

The website uses:

```text
Install: npm ci
Build: npm run build
Start: npm start
```

The build produces Next.js standalone output and copies `public` plus `.next/static` into the standalone tree. Set `NEXT_TELEMETRY_DISABLED=1` in both Railway environments even though the build also records telemetry opt-out.

## Required Environment Checks

Before every deployment, verify without printing secret values:

- `DATABASE_URL` points to the correct environment and contains a Neon pooled hostname.
- Production uses PostGrid live mode and Stripe live mode.
- Development uses PostGrid test/dummy mode and Stripe test mode.
- `TEMP_IMAGE_STORE=bucket` is set in deployed environments.
- Bucket variables reference the private `letter-irl-images` service.
- Public base URLs, Auth0 issuer/audience, CORS origins, and Stripe webhook URLs match the environment.
- `ADMIN_ENABLED=false` in cloud environments.

`WORKER_POLLING_SECONDS` and `WORKER_TRIGGER_ON_SEND` are legacy rollout safeguards. The compiled API ignores them after the transactional-outbox release; remove them after the new maintenance service is verified.

## Development Release Procedure

1. Merge backend and website feature PRs into their `dev` branches.
2. Confirm Railway deploys the development API, maintenance service, and website successfully.
3. Confirm migration `020_transactional_outbox.sql` applied to the Neon development branch.
4. Check `/healthz`, OAuth metadata, manifest, MCP connection, and website `/api/health`.
5. Run the automated suites in both repositories.
6. Run the manual checks in [manual-tests.md](manual-tests.md), including zero balance, simulated purchase, confirmed send, status retrieval, image generation, and restart persistence.
7. Leave development idle for more than ten minutes and confirm both API and website sleep.
8. Measure first-use recovery. Roll back Serverless if it exceeds three seconds or a widget/MCP flow fails.
9. Leave Neon idle for more than five minutes and confirm the development compute suspends.

## Production Promotion

1. Review the `dev` to `master` backend diff and the `dev` to `main` website diff.
2. Confirm no development URLs, test keys, or dummy-provider settings enter production.
3. Merge backend `dev` into `master` and website `dev` into `main` through reviewed PRs.
4. Confirm migrations complete before the new API deployment becomes active.
5. Run production smoke tests without creating a real charge or real mail order unless explicitly planned.
6. Confirm API and website remain warm and the hourly maintenance run exits cleanly.
7. Observe errors, memory, CPU, and Neon activity for at least one hour after release.

## Rollback

- Application rollback: redeploy the previous successful Railway deployment.
- Serverless rollback: disable Serverless for the affected development service.
- Database rollback: migrations are forward-only by default; do not drop outbox data. Deploy a corrective migration.
- Mail safety: retain `letter_jobs` rows and stable idempotency keys during every rollback.
- Image safety: keep the bucket and credentials in place while any 15-minute image URL may still be active.

Never point development at production Neon to work around a deployment problem.
