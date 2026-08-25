# Deployment Guide

Last updated: August 24, 2026

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

Most environment verification is executable (issue #155). Three layers, in the
order they catch problems:

1. **Before deploying — the preflight parity check.** With a Railway API token:

   ```bash
   RAILWAY_API_TOKEN=... npm run preflight:cutover -- --env production
   ```

   It diffs each service's variable *names* (never values) against
   `ENV_VAR_MANIFEST` in `src/config/deploymentConfig.ts` and exits non-zero on
   gaps. Run it against `development` after environment changes and against
   `production` before every promotion. Committed Railway variables do not
   reach a running instance until the service is explicitly **redeployed**
   (Deployments → ⋮ → Redeploy); a variable that looks set in the UI can still
   be absent from the running process (issue #213).

2. **At boot — the deployment validator.** `validateEnvironment()` asserts
   `src/config/deploymentConfig.ts` rules before the server accepts traffic,
   and the maintenance entrypoint asserts the same before touching anything.
   In production it refuses: a missing/unapproved `LETTER_PROVIDER` (the
   implicit dummy default included), test-mode PostGrid or Stripe keys,
   `LETTER_PROVIDER_CONFIG` without `"mode": "live"`, missing pack
   price ids (amounts resolve from the Prices themselves, #275), incomplete JIT config while `JIT_PURCHASE_ENABLED=true`,
   memory image storage or incomplete bucket credentials, and
   placeholder-shaped credentials. Outside production it refuses live-mode
   keys. A failed validation exits non-zero, so Railway keeps the previous
   image serving.

3. **After deploying — `/readyz`.** Returns `200` with
   `{"ready":true,"mode":...,"provider":...}` when configuration is valid, the
   database answers, and every enabled `provider_routing` row names a
   registered (in production: non-dummy) provider; `503` with check names
   otherwise. Detail is in the server log under `readiness.failed`.

   The `prices` check reports whether every enabled product's Stripe price has
   resolved, and it is a **failure only in production** — mirroring the
   validator, which requires `STRIPE_PRICE_*` in production and downgrades them
   to a warning elsewhere. Outside production an unresolved price shows as
   `"prices":"degraded"` in an otherwise-`200` body, with the product codes and
   rules in the log under `readiness.prices_unresolved`. Immediately after a
   restart the catalog may briefly be cold; that verdict is held for about a
   second, not the usual five, so a healthy instance stops reporting itself
   unready almost at once.

**Rollout ordering warning:** set an environment's variables *before* deploying
code that validates them. New variables are inert to a running image, but a
crash-restart of an already-running service whose config has become invalid
will boot-loop. In particular, `LETTER_IRL_DEPLOYMENT_ENVIRONMENT` must be set
on every deployed service (`development` on dev API and maintenance,
`production` on their production counterparts) **before** the validator ships
there: both Railway environments run `NODE_ENV=production`, and an unlabeled
environment resolves to production mode.

Still verified by a human, without printing secret values:

- `DATABASE_URL` points to the correct environment's Neon pooled hostname
  (the validator checks presence, not which environment it belongs to).
- `TEMP_IMAGE_STORE=bucket` is set in **deployed development** too: the boot
  validator and preflight enforce bucket config only in production mode, so a
  development gap would otherwise surface at the first image operation.
- Bucket variables reference the private `letter-irl-images` service.
- Public base URLs, Auth0 issuer/audience, CORS origins, and Stripe webhook
  URLs match the environment.
- `LETTER_IRL_OAUTH_CIMD_ENFORCEMENT=true` only after all exact CIMD values are
  present in that environment.
- `ADMIN_ENABLED` is unset or `false` in cloud environments; `true` is a startup error and cannot
  enable legacy public routes. While this is in force the issue #69 ambiguous-image operator
  recovery routes under `/api/admin/image-generation/*` are unreachable, so `JIT_PURCHASE_ENABLED`
  and `IMAGE_TRIAL_ENABLED` must stay `false` until a later issue #162 slice ships the replacement
  operator control.

`WORKER_POLLING_SECONDS` and `WORKER_TRIGGER_ON_SEND` are legacy rollout safeguards. The compiled API ignores them after the transactional-outbox release; remove them after the new maintenance service is verified.

As of July 16, 2026, development has the transactional-outbox release and hourly maintenance service deployed. Production remains on the previous release with `WORKER_POLLING_SECONDS=600` and `WORKER_TRIGGER_ON_SEND=true` until the remaining manual acceptance checks pass.

## Development Release Procedure

1. Merge backend and website feature PRs into their `dev` branches.
2. Confirm Railway deploys the development API, maintenance service, and website successfully.
3. Confirm `021_jit_commerce_foundation.sql` is recorded before `022_admin_audit.sql` on the Neon
   development branch. Do not apply 022 as a substitute for or copy of issue #69's migration 021.
   Confirm the migration content identities in
   [Migration 021/022/023 integration gate](#migration-021022023-integration-gate) still match.
4. Check `/healthz`, `/readyz`, OAuth metadata, manifest, MCP connection, and website `/api/health`.
   `/healthz` still returns `200` with body `ok`, and additionally carries `X-Build-Commit` and
   `X-Build-Branch` from Railway's injected git variables. Assert those against the commit you
   expect: a successful HTTP response proves the service is up, not that your deployment replaced
   the previous image. A failed pre-deploy leaves the old build serving and every other check green.
   `/readyz` must return `200` with `"mode":"development"` — a `503` names the failing check
   (config, database, routing, prices) and the detail is in the deploy log under `readiness.failed`.
   Outside production `prices` never fails the probe; check the body for
   `"prices":"degraded"` instead.
5. Run the automated suites in both repositories.
6. Run the manual checks in [manual-tests.md](manual-tests.md), including zero balance, simulated purchase, confirmed send, status retrieval, image generation, and restart persistence.
7. Confirm Serverless is enabled, leave development idle for more than ten minutes, and confirm both API and website sleep.
8. Measure first-use recovery. Roll back Serverless if it exceeds three seconds or a widget/MCP flow fails.
9. Leave Neon idle for more than five minutes and confirm the development compute suspends.

## Migration 021/022/023 integration gate

Issue #69 owns `021_jit_commerce_foundation.sql` and `023_jit_recovery_state_machines.sql`. Issue #162
owns `022_admin_audit.sql`, which refuses to apply unless 021 is already recorded. Because 022 cannot
exist on `dev` before 021 does, a gate phrased as "rerun the proof against issue #162's final merged
commit" can never be satisfied before issue #69 merges. It is replaced by a **content-identity gate**.

### Reviewed migration content identity

Identity is the Git blob ID, which is line-ending normalized. Do not use a workstation file hash: this
repository checks out with `core.autocrlf=true` on Windows, so the on-disk SHA-256 differs per host.

| Migration | Git blob ID | Blob SHA-256 (LF canonical) |
|-----------|-------------|------------------------------|
| `021_jit_commerce_foundation.sql` | `47ad1a799e913cff8364fb19cc6197cd7aac04a4` | `d6f9a11b74fa745f0b3fc34b27a496e5c6e2245a96a9c34a77c1b289c7b46056` |
| `022_admin_audit.sql` | `6200c2660ef97ce9902d62bde7c75312b5beff8a` | `b13ddc770e80049d01ef3a88c1c0374408da04f0dc43ccff781322e5472fb0eb` |
| `023_jit_recovery_state_machines.sql` | `cb1fb0d57cf272e54f1e3f547b7060303926b652` | `3080bdfaad673dc51ba5fb32f0d813059dac1285a024c7d1324e84f6a0af38b8` |

Verify with:

```bash
git rev-parse HEAD:db/migrations/022_admin_audit.sql
git cat-file -p HEAD:db/migrations/022_admin_audit.sql | sha256sum
```

### Gate

The proven arrival orders may be relied on only while all three blob IDs above are unchanged. If any of
them differs at merge or deploy time, rerun the arrival-order proof before integration or deployment and
republish this table. The proof is durable and rerunnable:

```bash
LETTER_IRL_ADMIN_TEST_DATABASE_URL=postgresql://postgres:<local>@127.0.0.1:<port>/letter_irl_admin_test \
  npx vitest run tests/integration/admin/adminMigrationOrder.test.ts
```

It applies the real repository migrations with the real migrator and compares columns, constraints,
defaults, indexes, triggers, functions, and table privileges across `001-020 -> 021 -> 022`,
`001-020 -> 021 -> 023 -> 022`, and `001-020 -> 021 -> 022 -> 023`.

### Safe merge sequence

1. Merge issue #69 (PR #164) into `dev` first. It carries 021 and 023 and does not depend on 022.
2. Confirm the three blob IDs above are unchanged on the merged `dev` and on the issue #162 branch.
3. Rebase issue #162 (PR #165) onto the merged `dev`. Its diff collapses to the admin foundation only.
4. Merge PR #165 into `dev`.
5. Apply migrations to the Neon development branch in recorded order, then deploy.

If PR #165 must merge before PR #164, migration 022 will refuse to apply until 021 is recorded, and the
development database would be left without the admin foundation. Do not attempt that order.

### Operator recovery interaction

Migration 022's branch also forces every public `/admin*` and `/api/admin*` request to a no-store 404 and
makes `ADMIN_ENABLED=true` a startup error. Issue #69's ambiguous-image operator recovery routes under
`/api/admin/image-generation/*` are therefore unreachable in deployed environments once both land. Keep
`JIT_PURCHASE_ENABLED=false` and `IMAGE_TRIAL_ENABLED=false` until a later issue #162 slice ships the
replacement operator control.

## Concurrent deploy safety (migration advisory lock)

Railway runs `npm run db:migrate:prod` as a pre-deploy command. When two PRs merge back to back it
queues two deploys at once, so two migrator processes from **different images** can run against the same
Neon database simultaneously. That is what happened when PRs #164 and #165 merged together: #164's image
had 021 and 023 pending, #165's had 021, 022 and 023 pending, and #165's deploy failed after 8 seconds
with `Pre-deploy command failed`, leaving DEV on #164's code until a manual redeploy.

The migrator now serialises itself. **The whole run is a single transaction**:

```
BEGIN
  SET LOCAL lock_timeout = 60000
  SELECT pg_advisory_xact_lock(7252245186587111069)
  CREATE TABLE IF NOT EXISTS migrations (...)
  SELECT name FROM migrations              -- read AFTER the lock, see below
  <apply each pending file, insert each ledger row>
COMMIT
```

- The lock is **transaction-scoped** (`pg_advisory_xact_lock`), not session-scoped. This is not a
  stylistic choice and must not be changed. `DATABASE_URL` is a Neon **pooled** hostname in both
  environments (see the environment checks above and `docs/infrastructure.md`), and Neon's `-pooler`
  is PgBouncer in **transaction pooling** mode. A session-level `pg_advisory_lock()` issued outside an
  explicit transaction is its own implicit transaction, so the pooler hands the server backend to
  another client the instant it returns — while the lock is still held on it. The paired
  `pg_advisory_unlock()` then lands on a different backend, returns `false` rather than raising, and
  the lock is orphaned until that server process dies. Ending the client pool does not help: it closes
  the socket to PgBouncer, never the backend holding the lock. The failure mode is that **every
  subsequent deploy blocks forever at lock acquisition and redeploying does not clear it**. A
  transaction-scoped lock is immune by construction: the pooler pins the backend for the transaction
  and `COMMIT`/`ROLLBACK` releases the lock on that same backend. Every other advisory lock in this
  codebase is transaction-scoped for the same reason.
- The key is a hardcoded constant derived from `sha256('letter-irl:db-migrations')`, precisely so that
  old and new deploy images contend for the same key.
- It reads the executed-migration ledger **after** acquiring the lock. This is the actual correctness
  fix: a process that queued on the lock must observe the winner's committed work, otherwise it would
  re-run migrations it had already listed as pending before it waited.
- The ledger insert uses `ON CONFLICT (name) DO NOTHING` as defence in depth only. It cannot prevent a
  duplicate apply on its own, because the migration body has already run by the time it executes.

The lock is database-scoped, not schema-scoped, so migrators targeting different schemas of one database
serialise against each other. Production runs a single schema, so this costs nothing there.

### Migrations are all-or-nothing (behaviour change)

Because the run is one transaction, **a failure rolls the entire run back**. This changed the recovery
story, so read this before responding to a failed pre-deploy:

- Previously each migration file committed on its own. A run that died on file 5 of 8 left files 1–4
  applied and recorded, and the fix was to repair the database and rerun to pick up where it stopped.
- Now nothing is applied unless everything applies. A run that dies on file 5 leaves the database
  exactly as it was — on a fresh database not even the `migrations` ledger table exists afterwards.
- **Recovery is therefore: fix the broken migration and redeploy.** There is no partially-migrated
  intermediate state to reconcile, and no manual cleanup step before retrying. Do not "resume" a failed
  run; there is nothing to resume from.
- The trade-off is that all DDL locks taken by the run are held until `COMMIT` rather than released
  per file. Migration runs are short (seconds), and Railway keeps the old image serving during the
  pre-deploy command, so this is not a live-traffic concern at current migration sizes.
- This design requires every migration to be transaction-safe. See [`db/README.md`](../db/README.md)
  for the constraint this places on new migrations.

### Bounded wait (`lock_timeout`)

`SET LOCAL lock_timeout = 60000` bounds how long a queued migrator waits for the lock. Without it a
migrator behind a stuck run blocks until the platform's own deploy timeout kills it, producing a dead
deploy with no diagnostic. With it the loser gives up in a known time and logs
`{"errorClass":"55P03","lockTimeoutMs":60000,"event":"database.migration_lock_timeout"}`.

60s is roughly an order of magnitude above the realistic worst case it waits on (a single pending
migration commits in well under a second; a full 23-file bootstrap takes a few seconds), while staying
far inside any deploy window so *we* emit the error rather than the platform emitting a SIGKILL.

`SET LOCAL` persists for the transaction, so the same bound also applies to the migration DDL's own lock
waits. That is deliberate — a migration blocked behind a long-running application query should fail
loudly rather than hold the migration lock open while the deploy hangs — but it does mean a migration
that genuinely needs to wait more than 60s for a table lock will fail.

**`database.migration_lock_timeout` is not a broken migration.** It means another migrator held the
lock. Redeploying is the correct response.

### Failure diagnostics

A failed migration still exits non-zero and still fails the deploy. The diagnostic names the failing
migration file alongside the redacted error class, e.g.
`{"errorClass":"42P01","migrationFile":"022_admin_audit.sql","event":"database.migration_failed"}`.
Filenames are repository-public and carry no user data; the underlying PostgreSQL message stays redacted
under the issue #160 policy. A `ROLLBACK` that itself fails is reported separately as
`database.migration_rollback_failed` rather than being swallowed, and the original error still
propagates.

### Proof

Two suites, both rerunnable. The first races two real `node dist/cli/migrate.js` processes against a
fresh database, directly connected:

```bash
LIRL_RUN_POSTGRES_INTEGRATION=true \
LIRL_TEST_DATABASE_URL=postgresql://postgres:<local>@127.0.0.1:<port>/letterirl_migrate_test \
  npx vitest run tests/integration/migrateConcurrency.postgres.test.ts
```

The second runs the migrator through a **real PgBouncer in transaction pooling mode**, i.e.
production's actual topology, and is what guards the lock-scope property above. A directly-connected
test cannot observe it — a session-level lock passes every direct-connection test and still breaks
production:

```bash
LIRL_RUN_POSTGRES_INTEGRATION=true \
LIRL_TEST_DATABASE_URL=postgresql://postgres:<local>@127.0.0.1:<pg-port>/letterirl_migrate_test \
LIRL_TEST_PGBOUNCER_URL=postgresql://postgres:<local>@127.0.0.1:<pgbouncer-port>/letterirl_pooled_test \
  npx vitest run tests/integration/migratePooled.postgres.test.ts
```

See [`tests/integration/README.md`](../tests/integration/README.md) for how to stand the pooler up.

## Production Promotion

1. Run the preflight against production and close every gap it reports **before**
   merging: `RAILWAY_API_TOKEN=... npm run preflight:cutover -- --env production`.
   Setting the variables now is safe — the old image ignores variables it never
   reads — and the new image **refuses to boot** while any boot-required one is
   missing. (The one preflight-only case: with `JIT_PURCHASE_ENABLED` present but
   `false`, the preflight still demands the JIT variables — it reads names, not
   values — while boot tolerates their absence; close those gaps anyway.) The
   requirements include `LETTER_IRL_DEPLOYMENT_ENVIRONMENT=production` on both
   the API and maintenance services; an unlabeled service resolves to production
   mode (fail-closed) and the missing label is itself a fatal validation error,
   regardless of how correct the other variables are.
2. Review the `dev` to `master` backend diff and the `dev` to `main` website diff.
3. Confirm no development URLs, test keys, or dummy-provider settings enter production.
   The boot validator enforces the key-mode and provider rules; the review still
   catches URLs and anything outside the validator's reach.
4. Merge backend `dev` into `master` and website `dev` into `main` through reviewed PRs.
5. Confirm migrations complete before the new API deployment becomes active.
6. Confirm `/readyz` returns `200` with `"mode":"production","provider":"postgrid"` on the
   new image (`X-Build-Commit` proves which image answered).
7. Run production smoke tests without creating a real charge or real mail order unless explicitly planned.
8. Confirm API and website remain warm and the hourly maintenance run exits cleanly —
   the maintenance entrypoint now validates configuration first, so a config gap
   shows up as `maintenance.run_failed` with `errorClass:"configuration_error"`.
9. Observe errors, memory, CPU, and Neon activity for at least one hour after release.

## Rollback

- Application rollback: redeploy the previous successful Railway deployment.
- Serverless rollback: disable Serverless for the affected development service.
- Database rollback: migrations are forward-only by default; do not drop outbox data. Deploy a corrective migration.
- Admin foundation rollback: retain migration 022 plus marker, command, operation, and audit evidence; revoke
  environment-specific role access separately if access was provisioned.
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
- `JIT_CURRENCY` (amounts come from the Stripe Prices above, not from variables).
  Pay & Send may use a different currency from the packs; each product's Price
  is validated against its own expected currency.
- `JIT_CHECKOUT_EXPIRY_MINUTES`, `JIT_REFUND_RETRY_LIMIT`, and
  `JIT_REFUND_RETRY_DELAY_SECONDS` (minimum 30; default 300)
- `IMAGE_ENTITLEMENTS_PER_PACK_LETTER` and `IMAGE_ENTITLEMENTS_PER_JIT_ORDER`
- `IMAGE_RESERVATION_PRE_DISPATCH_TIMEOUT_MINUTES` (default 15) and
  `IMAGE_RESERVATION_PROVIDER_TIMEOUT_MINUTES` (default 30)
- `LETTER_IRL_PACKS_URL`

Amounts are read from the Stripe Prices themselves - there are no configured
cent amounts to keep in step (#275). A paid amount or currency mismatch against
the order row is quarantined as `refund_pending`; it is never fulfilled. Keep Stripe test/live keys, Price IDs, webhook secrets, Railway URLs,
Neon databases, and PostGrid environments separated as described in
`docs/infrastructure.md`.

## Ambiguous image-reservation operator procedure

> **Currently unreachable in deployed environments.** The issue #162 admin
> foundation forces every public `/admin*` and `/api/admin*` request to a no-store
> 404 and makes `ADMIN_ENABLED=true` a startup error, so the routes below cannot
> be served once both changes are on `dev`. Keep `JIT_PURCHASE_ENABLED=false` and
> `IMAGE_TRIAL_ENABLED=false` until a later issue #162 slice ships the replacement
> operator control. See
> [Operator recovery interaction](#operator-recovery-interaction). This procedure
> is retained as the authoritative decision and evidence contract for that
> replacement.

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

Pack amounts are **not** environment variables. They are resolved from the
Stripe Price itself at startup (#275): a second copy in the environment could
drift from the figure Stripe actually charges, and did so silently, with a
refund as the discovery event. Set the price in Stripe and point
`STRIPE_PRICE_*` at it; there is nothing to mirror.

An unresolved price disables checkout for that product and makes `/readyz`
report `prices` failing in production (`degraded` elsewhere). There are no
runtime price fallbacks.

A price must be **active**, **one-time** (a recurring Price cannot be used with
a `payment`-mode Checkout Session), denominated in its product's expected
currency, and within a sanity band — by default 50 to 100,000 minor units, i.e.
$0.50 to $1,000.00. Pack tiers must also **order sanely against each other**:
more credits must cost strictly more in total and never more per credit. This
is the two-source check that replaces the deleted `STRIPE_*_AMOUNT_CENTS`
comparison — a transposed pair of `STRIPE_PRICE_*` values passes every
per-price rule, and the amount comparisons downstream now compare the resolved
price against itself, so tier ordering against the static credits table is the
only thing that can catch it. Both members of a violating pair are refused. Two products may share a Price only when both are Pay &
Send; any other sharing is refused for **every** product involved, because it
would sell one of them at the other's price. A deployment in a zero- or
three-decimal currency, or one selling a tier above the ceiling, must set
`STRIPE_PRICE_MIN_UNIT_AMOUNT` and `STRIPE_PRICE_MAX_UNIT_AMOUNT`: the band is
in minor units and cannot be converted across currencies without an exchange
rate. Both take positive whole numbers only — `100_000` parses as `100`, which would
refuse every real price, so the validator warns on separators and on zero, and
a discarded bound is logged under `stripe.price_band_ignored`. The validator
finding is always a **warning**, never a boot error: the catalog falls back
gracefully, and a formatting slip must not take `/healthz` down with it. If
exactly one bound is set and it contradicts the other side's default, the
configured bound wins and the default falls away; only a contradictory
configured *pair* is reverted. Both appear in the manifest
as **advisory**: `npm run preflight:cutover` lists them when unset so a parity
gap is visible before promotion, without failing the gate on a deployment that
correctly relies on the defaults — which is also how `STRIPE_CURRENCY` and
`JIT_CURRENCY` are listed.

Resolution failures carry two things: the **class** (the Stripe error's own
code, e.g. `resource_missing` for a typo'd id, or `configuration_error` for a
rule this code enforces) and whether it is **terminal** — whether a human must
act. Terminal faults (an archived or recurring Price, the wrong currency, an id
pointing at nothing, a revoked or restricted key, a shared Price, a Price
below Stripe's own per-currency minimum) start their retry ladder at 30
seconds and back off toward a 15-minute ceiling; they cancel the affected
order. Transient ones start at **2 seconds** — so a warmup blip self-heals on
the first purchase moments later — and back off toward a 5-minute ceiling,
leave the order pending, and make a *paid* legacy webhook retry rather than
book the payment as unmatched money. An
unpaid event — an expired session — is never retried on a pricing fault,
because there is no money at stake.

Historical migration-021 rows whose one-cent value cannot be distinguished from its placeholder are marked `amount_known=false` by migration
023 and excluded from revenue totals while retaining their audit value.

After the migration and disabled deployment are healthy, validate both mail
types in Stripe test mode, enable only internal development accounts, and then
set `JIT_PURCHASE_ENABLED=true` for the intended environment. Do not enable the
production flag until the manual Pay & Send matrix passes on desktop and Android.

### Hybrid image generation (Aug 2026)

`generate_image_for_mail` generates server-side only against user credits.
Env: `OPENAI_API_KEY` (absence degrades to the redirect card - never
boot-fails), `OPENAI_IMAGE_MODEL`/`OPENAI_IMAGE_QUALITY` (cost dials),
`LETTER_IRL_IMAGE_STARTER_CREDITS` (default 3, one-time per user),
`LETTER_IRL_IMAGE_DAILY_CEILING` (default 200; **0 is a kill switch that
blocks all generation**), `LETTER_IRL_IMAGE_GEN_MODE` (`on` | `off` |
`mobile_only`, default `on` - the product switch for whether @Letter IRL
requests may generate server-side at all; `mobile_only` limits spend to the
surface where built-in generation is genuinely unavailable). Redirect responses
are surface-aware on every path: confirmed desktop gets a "handoff" card
(the model generates in the same turn when built-in generation is present;
on mention-scoped turns it tells the user a bare "go ahead" reply
completes it), while mobile and unknown surfaces get the resend card with
the copy-ready prompt,
`IMAGE_ENTITLEMENTS_PER_JIT_ORDER` (default 2).
The temp-image store (TEMP_IMAGE_* vars) is a hard dependency of the
generated path and is preflighted before any credit is reserved.

