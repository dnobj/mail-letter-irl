# Deployment Guide

Last updated: July 16, 2026

Letter IRL deploys development first. Production is promoted only after automated and manual verification succeeds in development.

For the Auth0 CIMD migration, code deployment and tenant/app configuration are
separate gates. The owner first configures only DEV: exact DEV `/mcp` API
identifier, three product scopes, public CIMD import, eligible connections, and
resource compatibility. Browser validation and rollback then run in DEV.
Production Auth0, OpenAI, Railway, and the `master` branch remain unchanged
until the soak is clean and the owner explicitly approves promotion.

The code may be deployed before the tenant cutover with
`LETTER_IRL_OAUTH_CIMD_ENFORCEMENT=false` (or unset). This is a staging state,
not migration acceptance. At the coordinated DEV cutover, set the exact issuer,
endpoints, resource/audience, RS256 algorithm, scopes, and environment issuer
allowlist first; then set `LETTER_IRL_OAUTH_CIMD_ENFORCEMENT=true` in the same
Railway change. A process with enforcement enabled fails startup on a mismatch.

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
- `LETTER_IRL_OAUTH_CIMD_ENFORCEMENT=true` only after all exact CIMD values are
  present in that environment.
- `ADMIN_ENABLED=false` in cloud environments.

`WORKER_POLLING_SECONDS` and `WORKER_TRIGGER_ON_SEND` are legacy rollout safeguards. The compiled API ignores them after the transactional-outbox release; remove them after the new maintenance service is verified.

As of July 16, 2026, development has the transactional-outbox release and hourly maintenance service deployed. Production remains on the previous release with `WORKER_POLLING_SECONDS=600` and `WORKER_TRIGGER_ON_SEND=true` until the remaining manual acceptance checks pass.

## Development Release Procedure

1. Merge backend and website feature PRs into their `dev` branches.
2. Confirm Railway deploys the development API, maintenance service, and website successfully.
3. Confirm migration `020_transactional_outbox.sql` applied to the Neon development branch.
4. Check `/healthz`, OAuth metadata, manifest, MCP connection, and website `/api/health`.
5. Run the automated suites in both repositories.
6. Run the manual checks in [manual-tests.md](manual-tests.md), including zero balance, simulated purchase, confirmed send, status retrieval, image generation, and restart persistence.
7. Confirm Serverless is enabled, leave development idle for more than ten minutes, and confirm both API and website sleep.
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

# Pay & Send rollout (issue #69)

Apply migration `021_jit_commerce_foundation.sql` before deploying code that can
receive the new Stripe events. Deploy with `JIT_PURCHASE_ENABLED=false` first.
The migration is backward compatible with prepaid sends and migrates recoverable
historical pack purchases into the authoritative `orders` model.

Configure development and production independently:

- `STRIPE_JIT_LETTER_PRICE_ID` and `STRIPE_JIT_POSTCARD_PRICE_ID`
- `JIT_LETTER_AMOUNT_CENTS`, `JIT_POSTCARD_AMOUNT_CENTS`, and `JIT_CURRENCY`
- `JIT_CHECKOUT_EXPIRY_MINUTES`, `JIT_REFUND_RETRY_LIMIT`, and
  `JIT_REFUND_RETRY_DELAY_SECONDS` (minimum 30; default 300)
- `IMAGE_ENTITLEMENTS_PER_PACK_LETTER` and `IMAGE_ENTITLEMENTS_PER_JIT_ORDER`
- `LETTER_IRL_PACKS_URL`

The configured cent amounts must exactly match their Stripe Prices. A paid
amount or currency mismatch is quarantined as `refund_pending`; it is never
fulfilled. Keep Stripe test/live keys, Price IDs, webhook secrets, Railway URLs,
Neon databases, and PostGrid environments separated as described in
`docs/infrastructure.md`.

After the migration and disabled deployment are healthy, validate both mail
types in Stripe test mode, enable only internal development accounts, and then
set `JIT_PURCHASE_ENABLED=true` for the intended environment. Do not enable the
production flag until the manual Pay & Send matrix passes on desktop and Android.
