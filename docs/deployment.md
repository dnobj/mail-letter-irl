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

Apply forward migration `023_jit_recovery_state_machines.sql` before running
the issue #69 application revision. Migration 021 is already applied in
development, and issue #162 owns migration 022. The repository migration runner
records filenames and applies every unrecorded file, including a lower-numbered
file that arrives later. The current disposable-PostgreSQL test uses a synthetic
022 probe because the real `022_admin_audit.sql` is not present on this branch;
that proves runner ordering only, not compatibility with issue #162. Before both
changes integrate or deploy, rerun the test with the real 022 in both
`021 -> 023 -> 022` and `021 -> 022 -> 023` order and require identical schema
fingerprints and migration ledgers. Do not apply 023 ahead of that gate if the
real migrations fail to converge.

Configure development and production independently:

- `STRIPE_JIT_LETTER_PRICE_ID` and `STRIPE_JIT_POSTCARD_PRICE_ID`
- `JIT_LETTER_AMOUNT_CENTS`, `JIT_POSTCARD_AMOUNT_CENTS`, and `JIT_CURRENCY`
- `JIT_CHECKOUT_EXPIRY_MINUTES`, `JIT_REFUND_RETRY_LIMIT`, and
  `JIT_REFUND_RETRY_DELAY_SECONDS` (minimum 30; default 300)
- `IMAGE_ENTITLEMENTS_PER_PACK_LETTER` and `IMAGE_ENTITLEMENTS_PER_JIT_ORDER`
- `IMAGE_RESERVATION_PRE_DISPATCH_TIMEOUT_MINUTES` (default 15) and
  `IMAGE_RESERVATION_PROVIDER_TIMEOUT_MINUTES` (default 30)
- `LETTER_IRL_PACKS_URL`

The configured cent amounts must exactly match their Stripe Prices. A paid
amount or currency mismatch is quarantined as `refund_pending`; it is never
fulfilled. Keep Stripe test/live keys, Price IDs, webhook secrets, Railway URLs,
Neon databases, and PostGrid environments separated as described in
`docs/infrastructure.md`.

## Ambiguous image-reservation operator procedure

Keep `JIT_PURCHASE_ENABLED=false` and `IMAGE_TRIAL_ENABLED=false` while validating
this recovery path. The routes below use the existing `/api/admin` authentication
and authorization boundary; never expose them through a public or user token.
This change does not enable cloud admin access. If `ADMIN_ENABLED` remains false,
the route correctly returns not found and JIT/image-funded generation must remain
disabled until the owner approves an environment-specific authenticated operator
control (including the eventual issue #162 admin integration).

1. With an authenticated admin token, request
   `GET /api/admin/image-generation/ambiguous?limit=50`. Record the reservation,
   bound account, provider request reference, and timestamps in the restricted
   incident record. These identifiers are intentionally returned to the operator
   but must never be pasted into application logs.
2. Reconcile the provider request reference with authoritative provider evidence.
   Choose `consume` only with `provider_confirmed_succeeded`. Choose `release`
   only with `provider_confirmed_failed`, or with `customer_compensation` after an
   explicit owner-approved fairness decision. Never release an unknown outcome
   merely because it is old.
3. Submit
   `POST /api/admin/image-generation/ambiguous/{reservationId}/resolve` with a
   JSON body containing the exact `userId`, a unique operator-controlled
   `idempotencyKey`, the `decision`, and the matching `resolution` classification.
   The server derives the actor from the authenticated identity; an actor in the
   request body is ignored.
4. Require HTTP 200 and verify `resultingStatus` plus `replayed`. Retry only with
   the exact same body and idempotency key; an exact retry returns
   `replayed: true`, while a reused key with changed inputs returns a conflict.
   A mismatched account returns not found and cannot mutate another user's row.
5. Verify exactly one matching `image_generation_resolution_audit` row and the
   corresponding reservation/entitlement counters. Confirm application logs
   contain only the stable decision/status classifications and no reservation,
   account, provider, address, or image identifiers.

After the migration and disabled deployment are healthy, validate both mail
types in Stripe test mode, enable only internal development accounts, and then
set `JIT_PURCHASE_ENABLED=true` for the intended environment. Do not enable the
production flag until the manual Pay & Send matrix passes on desktop and Android.
