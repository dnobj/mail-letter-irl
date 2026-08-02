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
file that arrives later. The disposable-PostgreSQL test loads the exact issue
#162 `022_admin_audit.sql` (from this checkout once merged, otherwise from its
pinned remote branch) and compares defaults, constraints, indexes,
triggers/functions, and privileges. Because 022 is not yet on `dev`, rerun the
proof after its final merge commit. Test both
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
5. Verify exactly one matching `commerce_operator_audit_events` row and the
   corresponding reservation/entitlement counters. Confirm application logs
   contain only the stable decision/status classifications and no reservation,
   account, provider, address, or image identifiers.

All temporary admin requests must originate from the exact
`ADMIN_ALLOWED_ORIGIN`, target its exact Host on loopback without forwarding
headers, include `X-Letter-IRL-Admin: local-operator`, and use an authenticated
allow-listed bearer identity. Mutations additionally require
`Content-Type: application/json` and the `X-CSRF-Token` matching the local
operator bootstrap secret. The server emits no admin CORS or preflight grant.

## Commerce operational-alert procedure

Use the same hardened local admin boundary for financial/provider recovery.
`GET /api/admin/alerts` includes unresolved `commerce_operational_alerts` in the
`commerce_operations` group. Treat the returned order and job references as
restricted operator evidence; do not paste them into application logs.

To record review without closing the work, send
`PATCH /api/admin/commerce-alerts/{alertId}` with JSON `status` set to
`acknowledged` and a new operator-controlled `idempotencyKey`. Resolve only after
the provider/payment evidence is conclusive: send `status: resolved`, a stable
non-PII `resolutionCode`, and a new key. The authenticated bearer identity—not a
request-body actor—provides attribution. An exact retry returns `replayed: true`;
reusing a key with a different actor, alert, state, or resolution fails closed.
The alert transition and privacy-minimized append-only audit record commit in
one transaction. Stripe dispute-close events automatically resolve only the
matching dispute-created alert and persist a safe provider-status resolution
code in that same webhook transaction.

For `mail_provider_outcome_ambiguous`, first reconcile the job against the
provider using its restricted operator evidence. Then send
`POST /api/admin/jobs/{jobId}/resolve-ambiguous` with the exact bound `userId`, a
new `idempotencyKey`, the known `providerName`, and one conclusive pair:

- `accepted` / `provider_confirmed_accepted`, including the provider tracking
  reference; this records acceptance and completes eligible JIT fulfillment
  without another provider call.
- `retry` / `provider_confirmed_rejected_retry`, with no tracking reference;
  this proves the ambiguous request was rejected, clears the hold, and queues
  the same job with the same provider idempotency key. Eligible JIT funding
  returns from `held` to `fulfillment_pending` in the same transaction.
- `rejected` / `provider_confirmed_rejected_refund`, with no tracking
  reference; this makes the job terminal and exhausted, and moves an eligible
  JIT order to refund recovery.

Never use this endpoint while evidence is inconclusive. It never submits mail,
and refund-resolved or accepted ambiguous work cannot be sent through the admin
retry endpoint. The explicit retry outcome is the only way to resume a held
provider dispatch, and it is bounded to one audited recovery decision.
The order, letter, job, matching operational alert, and append-only audit are
locked and committed together; provider references are stored where required
for fulfillment but only hashed in the operator audit and never logged.

An authoritative provider rejection or terminal failure before dispatch may be
retried only with `POST /api/admin/jobs/{jobId}/retry`, including the exact
bound `userId`, a non-PII reason, and a new idempotency key. For JIT mail this
atomically restores `refund_pending` to `fulfillment_pending` only while no
refund attempt has started and no Stripe refund ID exists. It then queues the
same outbox job with the same provider idempotency key. Refund/dispute state,
ambiguous outcomes, accepted mail, resolved ambiguity, and cross-account input
all fail closed.

Provider submission outcomes are classified on one axis only: whether the
provider authoritatively refused the piece. A non-ambiguous 4xx comes from
PostGrid's own request validation and proves no mail exists, so it is a definite
rejection and is eligible for refund compensation and audited operator retry.
Everything else is ambiguous and is held for reconciliation: 5xx (a shared edge,
proxy, or gateway can answer 500/502/503/504 after the origin already accepted
and queued the piece), 408/409/425/429, transport loss and timeouts, an
unreadable response body, and any 2xx that lacks a usable provider id/status.
Ambiguous mail is never refunded and never automatically or manually
re-dispatched: `POST /api/admin/jobs/{jobId}/retry` rejects it, and only
`resolve-ambiguous` with conclusive provider evidence can finish it. Each
ambiguous outcome raises a durable `mail_provider_outcome_ambiguous` alert.

`stripe_money_event_unmatched` covers two different situations, and they have
different recovery paths.

**A refund or dispute arrived before an authoritative order relation existed.**
This is a genuine race, so a later checkout with the same payment intent/order
relation resolves the alert automatically and moves the order directly to
`refund_pending` or `disputed` before mail creation.

**A paid Checkout Session could not be bound to any order** — the amount was
not configured, or the session carried no usable identity. Here the checkout has
already happened, so **no later checkout is coming and nothing auto-recovers
it**. Manual Stripe redelivery does not help either: the replayed event is
deduplicated by its event ID and returns before the recovery sweep. The critical
alert *is* the recovery path. An operator must reconcile the payment by hand,
after fixing the configuration that caused the refusal.

Events without enough provider references remain open for operator
reconciliation and must never be dismissed merely because replay is
deduplicated.

Pack amount variables (`STRIPE_*_AMOUNT_CENTS`) are required alongside price
IDs. Missing amounts disable checkout/reconciliation; there are no runtime
price fallbacks. Historical migration-021 rows whose one-cent value cannot be
distinguished from its placeholder are marked `amount_known=false` by migration
023 and excluded from revenue totals while retaining their audit value.

After the migration and disabled deployment are healthy, validate both mail
types in Stripe test mode, enable only internal development accounts, and then
set `JIT_PURCHASE_ENABLED=true` for the intended environment. Do not enable the
production flag until the manual Pay & Send matrix passes on desktop and Android.
