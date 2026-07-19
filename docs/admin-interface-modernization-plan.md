# Admin Interface Modernization Plan

**Status:** Approved implementation plan as of July 19, 2026

**Selected architecture:** Candidate A, a hardened local-only operator application

**Tracking issue:** [#162](https://github.com/dnobj/mail-letter-irl/issues/162)
**Initial audit:** [PR #161](https://github.com/dnobj/mail-letter-irl/pull/161)

## Decision record

The owner selected a hardened local design because Letter IRL currently has one trusted operator, the
admin surface is used intermittently, and a permanently deployed browser-facing admin service would add
cost and attack surface without a current multi-operator or remote-access requirement.

This decision approves implementation work against development. It does **not** authorize connecting a
workstation to production, provisioning a production credential, or enabling production mutations.
Those remain explicit rollout gates after the development implementation and full manual suite pass.

The approved boundary is:

```text
Windows operator account
  -> dedicated Letter IRL admin launcher
  -> one-time local bootstrap + short-lived browser session
  -> admin server bound only to 127.0.0.1
  -> typed query/command services
  -> environment-scoped, least-privilege Neon role
  -> Letter IRL development or production database

External Stripe/PostGrid work
  -> audited admin operation row
  -> deployed environment worker
  -> provider test/live API
```

The admin process is separate from the MCP/API server. No admin page or admin JSON route is added to a
Railway service. The local browser never connects to Neon, Stripe, PostGrid, Railway, or a public Letter
IRL endpoint directly.

## Scope

This plan will:

- replace the unauthenticated legacy localhost page with a dedicated authenticated local runtime;
- make Windows and PowerShell the first-class operator path while keeping scripts cross-platform where
  practical;
- separate development and production credentials, modes, banners, data, and activation gates;
- make production read-only by default and require deliberate launch-time elevation for mutations;
- replace ad hoc SQL and HTTP handlers with typed query and command services;
- add consistent validation, confirmation, concurrency control, idempotency, and append-only auditing;
- fix known admin data, provider-routing, outbox, accessibility, and documentation drift;
- add automated coverage, per-PR manual tests, and full-suite checkpoints.

This plan will not:

- create a Railway admin service, Auth0 admin application, public admin hostname, or signed internal HTTP
  proxy;
- treat localhost, an unadvertised URL, a database password, or an environment variable as sufficient
  authorization;
- put a general production `DATABASE_URL`, Stripe secret, or PostGrid secret in a repository file or
  workstation `.env` file;
- allow the local process to send mail, create charges, or call live providers directly;
- create a second source of truth for balances, letters, promotions, routing, outbox state, or purchases;
- claim revenue totals are complete until the purchase source-of-truth work is complete.

## Current-state audit

### Runtime and launch behavior

- `admin-panel.html` is a roughly 70 KB root-level HTML/CSS/JavaScript file served by
  `src/mcp/httpServer.ts` at `/admin`, `/admin.html`, and `/admin-panel.html`.
- The shared MCP/API process dispatches `/api/admin/*` to the monolithic
  `src/api/adminApiHandler.ts`.
- `src/api/middleware/adminAuth.ts` grants non-proxied loopback requests full access without identity,
  session expiry, or action authorization.
- The shared server binds to `0.0.0.0` by default even though the admin flow is described as local-only.
- `npm run admin` and `npm run admin:dev` use Unix `env`/`grep`/`xargs` syntax and fail in PowerShell.
- The `import.meta.url` entry-point comparison in `httpServer.ts` prevents the documented direct
  TypeScript start from auto-starting reliably on Windows.
- `.env.admin.example` encourages a locally stored production Neon URL and does not satisfy the shared
  server's unrelated startup validation without inheriting more configuration.
- Documentation alternates between ports `8090` and `8788`; the documented `file://` path does not work.

### Live browser baseline

A July 18, 2026 browser review reached the legacy page locally on port `8788` after working around the
launcher failures. It confirmed:

- Dashboard, Users, Letters, Jobs, Letter Balance, Promos, and Provider Routing are present;
- no persistent environment, database, Stripe mode, or mail-provider banner is shown;
- provider routing can display PostGrid as selected while provider status says it is not configured and
  Dummy is configured;
- changing a routing select immediately sends a `PUT`, with no staged review or consistent confirmation;
- interactive `div` elements and weak focus behavior make keyboard and assistive use unreliable;
- representative dashboard requests took about 312-426 ms and have inconsistent loading, stale-data,
  partial-failure, and retry treatment.

### Security and correctness findings

- Admin responses reflect arbitrary origins or allow `*`; simple cross-origin requests can reach local
  handlers because content type and browser request provenance are not consistently enforced.
- User emails, addresses, letter content, provider messages, job errors, promotion data, and API errors
  are inserted through `innerHTML`, creating stored-XSS paths in a privileged page.
- Inline scripts/styles/handlers prevent a strict Content Security Policy. Responses lack a dedicated
  no-store policy, frame restriction, and complete security headers.
- Mutation handlers use ad hoc parsing, inconsistent confirmations, raw exception messages, and no
  normalized actor or durable outcome record.
- User search is shadowed by the `/users/:id` route; metrics, revenue, delivery states, and outbox alerts
  use overlapping or stale definitions.
- `letter_jobs` is now a transactional outbox, but retry behavior and labels still partly assume pg-boss.
  The legacy retry can reset attempts and conflict with backoff and terminal-failure rules.
- Routing accepts providers that are not registered/configured and runtime creation can silently fall back
  to another provider.
- The backup page is stale, references missing assets, uses localStorage bearer tokens, and calls obsolete
  endpoints.
- No Vitest suite directly covers the admin authentication, HTTP routes, page, redaction, auditing, or
  command composition. The one-off admin script performs destructive database changes and is not a test.

## Approved hardened-local architecture

### Process and network boundary

Create a dedicated entry point at `src/admin/localServer.ts`. It must not import or start MCP transport,
OAuth metadata, workers, public REST routes, or maintenance jobs.

The process must:

- bind explicitly to IPv4 `127.0.0.1`; no `0.0.0.0`, LAN address, wildcard, proxy trust, or remote mode;
- choose an unused high port by default, with an explicit `--port` override restricted to loopback;
- accept only the exact `Host` value printed by the launcher;
- reject `Forwarded`, `X-Forwarded-*`, non-local socket addresses, unexpected `Origin`, and cross-site
  `Sec-Fetch-Site` before routing;
- provide no CORS headers and reject all cross-origin API requests;
- cap request bodies, require `application/json` for JSON APIs, enforce request timeouts, and return stable
  public error codes without raw SQL/provider messages;
- shut down sessions and database pools on Ctrl+C, browser logout, or configured inactivity when no
  request is active.

Legacy `/admin*` and `/api/admin*` routes in `src/mcp/httpServer.ts` must remain disabled during the
transition and be removed after feature parity. Railway startup must fail if a legacy admin flag tries to
enable them.

### Local identity, bootstrap, and session

Localhost is transport, not authentication. Each launch must:

1. Resolve the signed-in Windows account SID and username through the OS, not from a browser field.
2. Compare the SID to the environment-specific allowlist stored in non-secret local admin configuration.
3. Generate a cryptographically random, single-use 256-bit bootstrap secret held only in memory.
4. Open or print a loopback URL whose fragment contains the bootstrap secret. Fragments are not sent in
   HTTP or referrer data; bootstrap JavaScript removes it with `history.replaceState` immediately, before
   any app API call, navigation, analytics, or error reporting.
5. Exchange the secret once through same-origin `POST /auth/bootstrap`; invalidate it on first attempt or
   after 60 seconds.
6. Set a random opaque session cookie with `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`, and a
   server-side session record. `Secure` is omitted only because the connection is loopback HTTP; the
   binding, Host, Origin, and fetch-metadata checks are mandatory compensating controls.
7. Expire sessions after 15 minutes idle or 60 minutes absolute, rotate the session identifier after
   bootstrap/elevation, and support explicit logout that clears all in-memory grants.

The browser holds a separate CSRF value in memory and sends it in `X-CSRF-Token` for every state-changing
request. The server checks the session, CSRF value, exact Origin, Host, socket address, and fetch metadata.
No token, credential, PII, or provider response may be written to localStorage, sessionStorage, URL query
strings, console output, access logs, crash dumps, or analytics.

The immutable audit actor is the OS SID plus username captured at launch. Display names and free-form
request fields cannot override it.

### Browser security and accessibility

Split the legacy page into a small HTML shell and TypeScript modules built as external hashed assets. The
server must send:

- `Content-Security-Policy` allowing only self-hosted scripts/styles and denying objects, frames, base URI,
  forms outside self, and all non-self connections;
- `Cache-Control: no-store`, `Pragma: no-cache`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, and a restrictive `Permissions-Policy`;
- `frame-ancestors 'none'` and no inline script, inline event handler, or unreviewed dynamic HTML sink.

Render untrusted data with text nodes or framework escaping only. Letter body/preview content remains
redacted until a separately audited reveal; if HTML preview is ever supported it must render in a
sandboxed, origin-isolated document after sanitization, never in the privileged app DOM.

Use semantic links, buttons, tables, forms, status regions, and dialogs; logical tab order; visible focus;
focus trapping/restoration; keyboard-complete navigation; accessible labels; color-independent status;
200% zoom; reduced motion; and a usable 320 px viewport.

### Environment and credential boundary

The launcher requires an explicit `--environment development|production`. It loads only non-secret
configuration from `%LOCALAPPDATA%/LetterIRL/admin/<environment>.json`, including:

- expected database hostname, database name, and `admin_environment_marker` value;
- the Windows SID allowlist;
- credential secret names, never secret values;
- display name and integration expectations;
- allowed modes and session/port bounds.

Database credentials are separate per environment and role:

- `letter_irl_admin_reader_<env>` receives only the SELECT privileges needed by approved admin read
  models plus INSERT permission for sensitive-reveal audit requests;
- `letter_irl_admin_operator_<env>` is a distinct credential used only in full mode and receives narrowly
  scoped read/write/execute privileges needed by typed command services and admin operation records;
- neither role owns schema objects, creates roles, runs migrations, bypasses row security, or receives a
  general application-owner credential;
- development and production roles, passwords, hostnames, and vault entries must never be copied or
  reused.

On Windows, secrets are retrieved at launch by name through Microsoft PowerShell SecretManagement backed
by an approved local vault. The Node process captures the value through a private child-process pipe,
never echoes it, and retains it only for the database pool lifetime. Development may also accept an
ephemeral child-process environment value for automated tests; production must fail if a database URL is
provided through `.env`, a command-line argument, or the generic `DATABASE_URL` name.

Migration `021_admin_audit.sql` adds an `admin_environment_marker` singleton. Provisioning sets it
explicitly in each Neon branch. After connecting, the local process compares the marker, URL hostname,
database name, role name, and requested environment and exits on any mismatch. The UI then shows an
unmissable persistent banner containing Development/Production, Read-only/Full, database identifier,
Stripe test/live expectation, and PostGrid dummy/test/live expectation.

No production vault entry or database role is provisioned during ordinary implementation. That requires
an owner-approved production-access operation after development acceptance.

### Modes and elevation

Supported modes are `read-only` and `full`; default is always `read-only`.

- Development read-only requires an explicit development launch and reader credential.
- Development full requires `--mode full`, a fresh bootstrap session, a second launcher confirmation that
  spells `DEVELOPMENT FULL`, and the operator credential.
- Production read-only additionally requires the separately provisioned production reader role and a
  launcher confirmation that spells the displayed production database identifier.
- Production full is unavailable unless non-secret production policy explicitly enables it after owner
  approval. Every launch then requires `--mode full`, a fresh bootstrap, a 10-minute elevation grant, the
  exact database identifier, and the phrase `PRODUCTION FULL`.

Elevation is stored only in server memory and a rotated HttpOnly session. It expires after ten minutes,
on logout, on environment change, or after five failed command confirmations. Individual commands still
require preview, typed confirmation for production, a non-empty reason, and an idempotency key. The UI
must not render enabled mutation controls unless both server mode and session elevation allow them; the
server remains authoritative.

## Target capability model

All routes live only in the loopback process under `/local-admin/v1`. Static routes are registered before
parameter routes, share Zod request/response contracts, and return bounded results.

| Area | Read operations | Commands and safeguards |
| --- | --- | --- |
| Session/environment | session, mode, database marker, integration expectations | bootstrap, elevate, logout |
| Overview | documented user/letter/outbox/balance counts, maintenance freshness | none; incomplete revenue is hidden or explicitly unavailable |
| Users | bounded search/list/detail with redacted email/account data | audited sensitive reveal only |
| Letters | bounded search/list/detail, history, outbox, provider status; addresses/body redacted | timed audited reveal; no direct status edit |
| Outbox | bounded filters/detail using transactional-outbox terminology | retry preview/confirm; preserve row, attempt history, backoff, terminal rules, and provider idempotency key |
| Balances | balance and immutable transaction history | adjustment preview/confirm/reason/idempotency; no overwrite |
| Promotions | list/detail/redemptions | create, status/end, and delete/deactivate with validation and optimistic concurrency |
| Routing/providers | configured providers, effective runtime route, configuration health | reject unregistered/unconfigured targets; preview/confirm/reason/version check |
| Stripe reconciliation | prior run/results and source-of-truth limitations | enqueue dry run; separately confirm corrective operation; deployed worker owns Stripe secret |
| Status sync | stuck-letter candidates and prior run/results | enqueue dry run/apply; deployed worker owns provider secret |
| Audit | actor, time, environment, mode, action, target, reason, outcome, correlation ID | append-only; no UI update/delete |

Rate-limit statistics are excluded from v1 because state is process-local to deployed API instances and a
local process cannot report it truthfully. PAT statistics may be added only when their definitions and
privacy treatment are documented. Provider dashboards and direct SQL remain break-glass diagnostic tools,
not normal operator commands.

### Query and command rules

- Put business reads in typed admin query services, not inline route SQL.
- Reuse authoritative balance, promotion, routing, reconciliation, status-sync, and outbox services after
  extracting database dependencies where needed; do not fork business rules into the UI.
- Validate path, query, and body input with strict Zod schemas; reject unknown fields and bound every
  limit, offset/cursor, text length, enum, and amount.
- Database-only commands commit the mutation, command record, and audit outcome in one transaction.
- Commands that require Stripe or PostGrid insert an idempotent `admin_operations` row. An
  environment-local deployed worker claims it, calls the provider using existing service credentials, and
  writes sanitized success/failure. The local process never receives the provider secret.
- Preview responses include a short-lived digest of normalized inputs and current row version. Confirm
  must send the digest, reason, idempotency key, and expected version; stale previews return `409`.
- Repeated idempotency keys return the original command outcome. Concurrent conflicting writes fail
  deterministically instead of silently winning.
- Sensitive reveal requires a target, purpose/reason, and fresh session; it returns the minimum field set,
  uses no-store responses, auto-conceals in the UI, and writes an audit event even when denied or failed.
- Every error maps to a stable code and correlation ID; logs and UI never expose raw SQL, credentials,
  full addresses, letter bodies, tokens, or provider payloads.

### Audit and operation schema

Migration `021_admin_audit.sql` adds:

- `admin_environment_marker(environment primary key, configured_at, configured_by)` with exactly one
  environment row;
- `admin_audit_events(id, occurred_at, actor_sid, actor_name, environment, mode, session_id_hash,
  correlation_id, action, target_type, target_id, reason, input_summary_json, before_summary_json,
  after_summary_json, outcome, error_code, command_id)`;
- `admin_command_runs(id, idempotency_key, actor_sid, environment, action, target_type, target_id,
  preview_digest, expected_version, status, requested_at, started_at, completed_at, correlation_id,
  sanitized_result_json, error_code)`;
- `admin_operations(id, command_id, operation_type, environment, payload_json, status, attempts,
  available_at, locked_at, locked_by, completed_at, sanitized_result_json, error_code)` for provider-backed
  work.

Use UUID identifiers, UTC timestamps, unique `(environment, idempotency_key)`, bounded JSON, and indexes
for actor/time, target/time, correlation ID, command status, and claimable operations. Application roles
receive no UPDATE/DELETE on `admin_audit_events`. Retention and archival policy must be documented before
production access; implementation must never make the audit trail mutable from the admin UI.

## Exact implementation map

### Add

- `src/admin/localServer.ts`: loopback-only entry point, shutdown, port selection, and route composition.
- `src/admin/config.ts`: strict launch/config parsing, Windows identity, environment marker checks, and
  fail-closed legacy/generic credential checks.
- `src/admin/credentials.ts` and `scripts/getAdminSecret.ps1`: credential-provider interface and Windows
  SecretManagement adapter with redacted errors.
- `src/admin/session.ts`: one-time bootstrap, server-side sessions, CSRF, rotation, expiry, and elevation.
- `src/admin/httpSecurity.ts`: socket/Host/Origin/fetch-metadata/content-type/size checks and headers.
- `src/admin/router.ts`, `src/admin/contracts.ts`, `src/admin/errors.ts`: exact routes, shared Zod contracts,
  response envelopes, and stable error mapping.
- `src/admin/queries/`: overview, users, letters, outbox, balances, promotions, routing, operations, and
  audit read models.
- `src/admin/commands/`: common preview/confirm policy and adapters for balance, promotion, routing,
  outbox retry, sensitive reveal, reconciliation, and status sync.
- `src/admin/auditService.ts`: append-only event and command-run writer with redacted summaries.
- `src/admin/ui/index.html` and `src/admin/ui/*.ts`: semantic shell, safe rendering, page modules, dialogs,
  persistent banner, and browser session client.
- `scripts/buildAdminUi.ts`: deterministic TypeScript asset build with hashed output and CSP manifest.
- `src/workers/adminOperationsWorker.ts`: claims environment-local provider operations and delegates to
  existing Stripe/PostGrid services with idempotent outcomes.
- `db/migrations/021_admin_audit.sql`: additive audit, command, operation, environment marker, indexes, and
  grants needed by provisioned roles.
- `scripts/provisionAdminDatabaseAccess.ts`: explicit environment-aware role/grant setup; prints no
  credential and refuses production without a separate confirmation flag.
- unit specs under `tests/unit/admin/` and `tests/unit/workers/`; integration specs under
  `tests/integration/admin/`; browser specs under `tests/browser/admin/`.

### Change

- `package.json`: replace Unix legacy launchers with cross-platform `admin:build`, `admin:dev:read`, and
  argument-forwarding `admin:start`; never load `.env.admin`.
- existing credit, promotion, routing, outbox, reconciliation, and status-sync services: expose typed
  transactional operations without changing public behavior.
- worker registration: enable `adminOperationsWorker` only in the matching deployed environment and only
  when the migration/config are present.
- `src/mcp/httpServer.ts`: remove admin static/API dispatch and fix the platform-safe entry-point check as
  an independently tested cleanup.
- `.gitignore`: ignore generated admin assets and local non-secret operator configuration if it can appear
  inside the repository.

### Remove after development parity

- `admin-panel.html`, `admin-panel.html.backup`;
- `src/api/adminApiHandler.ts`, `src/api/middleware/adminAuth.ts`;
- `.env.admin.example` and obsolete `ADMIN_ENABLED`, `ADMIN_LOCAL_ONLY`, `DISABLE_WORKERS` admin guidance;
- `scripts/test-admin-api.ts` and all direct-file/Unix launcher instructions.

Keep legacy routes disabled throughout the slices. Remove files only after browser tests prove supported
read and command parity in development.

## Performance and UX targets

- Every list query has server-enforced pagination, a default of 25, and a maximum of 100.
- Search requires normalized bounded input and indexed query plans; no unbounded `%term%` table scan is
  accepted without a documented small-table exception.
- Using representative development fixtures, dashboard and first-page read APIs target p95 at or below
  500 ms, grounded in the observed 312-426 ms baseline. Queries above 750 ms require an explained plan or
  index before production read-only approval.
- The UI displays a loading state within 100 ms, distinguishes empty/error/stale/partial states, supports
  retry, preserves filters during pagination, and never presents partial revenue as total revenue.
- Commands show pending/succeeded/failed/unknown outcomes and remain safely resumable by idempotency key
  after browser or worker interruption.

## Automated test plan

### Unit

Cover:

- loopback binding; Host, Origin, fetch metadata, proxy headers, CORS absence, body limits, content type,
  timeouts, and security headers;
- bootstrap single use/expiry, Windows SID allowlist, session rotation/idle/absolute expiry/logout, CSRF,
  elevation expiry, and failed-confirmation lockout;
- rejection of production `.env`, generic `DATABASE_URL`, wrong role/host/name/marker, copied dev secrets,
  invalid modes, and legacy route flags;
- strict schemas, bounded pagination, exact route precedence, stable error codes, and malicious strings;
- redaction/reveal/audit summaries and absence of secrets/PII in logs;
- metric definitions, delivery states, incomplete revenue, scheduled versus terminal outbox failures, and
  maintenance freshness;
- preview digest, reason, expected version, transactionality, idempotency, concurrent conflicts, and role
  checks for every command;
- routing rejection and truthful effective-provider reporting;
- operation worker claim/retry/backoff/idempotency and sanitized results.

### Integration

Use an isolated migrated PostgreSQL database and mocked Stripe/PostGrid endpoints to cover:

- launcher identity -> bootstrap -> reader query and full-mode elevation -> command;
- development/production marker and database-role mismatch failure;
- database mutation, command run, and audit event atomic commit/rollback;
- provider-backed operation pending/succeeded/failed recovery without duplicate external work;
- reader/operator database grants, including denied arbitrary writes and denied audit update/delete;
- outbox retry preserving one row, stable provider idempotency key, attempt/backoff, and terminal policy;
- concurrent balances, promotions, and routing commands returning deterministic outcomes;
- migration 021 applying after migration 020 and old application code starting against additive tables;
- public `/admin*` and `/api/admin*` returning 404 while the loopback process works.

### Browser and static security

Use Playwright for bootstrap, logout, expired session, read-only/full controls, persistent environment
banner, searches, pagination, filters, loading/error/stale states, redaction/reveal, every command flow,
audit history, keyboard/focus/dialog behavior, zoom/narrow viewport/reduced motion, and malicious stored-data
fixtures.

Add static checks that fail on direct `innerHTML`, `dangerouslySetInnerHTML`, inline event handlers, inline
scripts, legacy admin assets, or unreviewed HTML sinks. Verify the generated CSP manifest and confirm no
credential or PII appears in browser storage, cacheable responses, URLs, console, or server logs.

Each implementation PR must run the relevant Vitest/integration/browser subset plus `npm run lint`,
`npx tsc --noEmit`, and `npm run test:run`. Existing unrelated failures must be recorded with evidence;
new failures are not accepted.

## Manual test policy

The browser-test task creates or updates a named manual case for every implementation PR and executes it
against development before merge. Store durable cases and evidence in the repository's manual-test
documentation. A full admin suite runs after PRs 3 and 5 below, before any production connection, and
between any later major PR group.

Minimum full-suite sequence:

1. Launch from PowerShell with no secret modules/config and verify a redacted fail-closed error.
2. Launch development read-only; verify loopback-only socket, clean bootstrap URL, cookie/session settings,
   exact banner, database marker, and no mutation controls.
3. Attempt LAN, proxy-header, wrong Host/Origin, cross-site, missing CSRF, invalid content type, oversized,
   expired-session, and replay requests; verify denial and no data leakage.
4. Compare dashboard/read models to controlled fixtures; exercise pagination, special characters, malicious
   content, loading, slow, partial-failure, empty, and retry states.
5. Perform and verify an audited reveal; confirm minimum data, reason, no-store, auto-conceal, and denied
   attempt audit.
6. Launch development full and run balance, promotion, routing, outbox retry, reconciliation dry run/apply,
   and status-sync dry run/apply. Verify previews, typed confirmation, reasons, row versions, idempotency,
   actor/outcome audits, and test-provider behavior.
7. Verify routing cannot choose Lob/unconfigured PostGrid and displayed routing equals effective runtime
   routing. Verify outbox retry cannot reset scheduled backoff or duplicate a letter/provider request.
8. Interrupt browser, local server, and operation worker at safe points; restart with the same idempotency
   keys and verify deterministic recovery.
9. Test keyboard-only use, screen-reader names/status, focus restoration, 200% zoom, 320 px viewport, reduced
   motion, and session expiry while a dialog is open.
10. Verify public dev and production MCP/API services return 404 for all legacy admin paths and normal
    public health/flows are unchanged.
11. Before production read-only, verify separately provisioned role/vault entry, production marker, hostname,
    database name, banner, live/test integration expectations, and read-only enforcement without revealing
    PII or running a command.
12. Before production full, repeat the security suite and run only one reversible, pre-approved command.
    Never create a real charge or real mail order as a smoke test.

## Delivery slices

All PRs target `dev`, link #162, include automated evidence and a PR-specific manual case, and keep
production unprovisioned unless a later explicit permission is recorded.

1. **Audit, configuration, and database foundation:** migration 021, environment marker, role provisioning
   script, query/command contracts, audit service, legacy routes forced off, and unit/integration tests.
2. **Hardened local session and read API:** launcher, Windows identity/vault provider, loopback server,
   bootstrap/session/CSRF/security policy, reader queries, and read-only tests.
3. **Read-only operator UI:** safe asset build, environment banner, overview/search/detail/pagination,
   redaction/reveal, accessibility, Playwright, per-PR manual case, then the first full manual suite.
4. **Audited database commands:** balances, promotions, routing, and outbox retry with preview/confirm,
   optimistic concurrency, idempotency, and audit outcomes.
5. **Provider-backed operations and legacy retirement:** operation worker, reconciliation/status sync,
   recovery tests, remove legacy files/routes/scripts, update all docs, then the second full manual suite.
6. **Production read-only gate:** only after owner approval, provision the production reader role/vault
   entry, validate identity/environment and execute the production read-only suite.
7. **Production full gate:** only after a separate owner approval and observation period, provision the
   operator credential, enable non-secret full-mode policy, repeat security tests, and execute one
   reversible approved command.

No single PR combines local authentication, all business commands, legacy removal, and production
activation. Production access is an operation with explicit approval, not a side effect of merging code.

## Rollout and rollback

### Development rollout

1. Merge additive audit/config foundations with legacy routes still disabled.
2. Provision development-only reader/operator roles and local vault entries.
3. Ship read-only runtime and UI; run the first full manual suite.
4. Enable development full mode and land commands in bounded slices.
5. Run the second full suite, security review, performance check, documentation review, and rollback drill.
6. Present evidence before requesting any production connection.

### Production gates

Production reader provisioning, the first production connection, production full-mode policy, production
operator provisioning, and the first production command each require explicit owner approval. Credentials
must be unique, stored in the approved vault, and revocable independently. No implementation session may
infer those permissions from this plan, a merged PR, or access to the repository.

### Rollback

- Stop the local process; its sessions, bootstrap, elevation, and in-memory database credentials disappear.
- Revoke the affected reader/operator role password and remove its vault entry if a workstation or
  credential is suspect.
- Disable full mode in non-secret local policy and database grants independently; read-only can remain.
- Disable the deployed `adminOperationsWorker` to stop new provider work while preserving queued/complete
  operation and audit records.
- Redeploy the previous API/worker commit if a shared command-service regression affects public behavior.
- Keep migration 021 and all audit/command/operation records during application rollback; do not drop or
  rewrite evidence.
- For an uncertain external command, stop new commands and inspect the command run, operation row, audit,
  outbox, and provider dashboard before retrying with the same idempotency key.
- Direct SQL is break glass only, requires an incident record, and is not the documented normal rollback.

## Considered alternatives

### Candidate B: admin routes in the existing Railway backend

Rejected for now because it would combine public MCP/API and privileged operator attack surfaces in one
internet-facing process. It avoids local database credentials but needs deployed authentication,
authorization, browser security, and careful resource isolation. Reconsider if remote access becomes
necessary and service count must remain minimal.

### Candidate C: dedicated Railway admin service

Rejected for now because a separate service, Auth0 application, internal authenticated protocol, secret
rotation, private-network wiring, and per-environment deployment are disproportionate for one intermittent
operator. It remains the preferred direction if multiple operators, remote access, centralized MFA,
central session revocation, or workstation-data restrictions become requirements.

Choosing A does not claim that a workstation is inherently safer than deployed infrastructure. Its safety
depends on loopback-only transport, authenticated short sessions, OS-vault credentials, least-privilege
database roles, read-only production defaults, strict browser controls, and audited command services.

## Documentation updates during implementation

- `README.md` and `docs/index.md`: describe the supported hardened-local flow and production gates.
- `docs/admin-panel-guide.md`: replace legacy instructions with launcher, modes, banner, redaction,
  commands, audit, incident, and rollback runbooks.
- `docs/env-files.md`: remove production `.env.admin` guidance and document non-secret local configuration
  plus vault secret names.
- `docs/development.md`: document Windows/PowerShell setup, development roles, asset build, and tests.
- `docs/database-schema.md`: document environment marker, audit, command, operation, grants, retention, and
  indexes.
- `docs/deployment.md`, `docs/infrastructure.md`, and `docs/railway-setup.md`: document only the operation
  worker and production permission gates; do not add an admin web service.
- `docs/security-and-policy.md` and `docs/privacy-policy.md`: document workstation PII handling, reveal
  audit, retention, credential rotation, and incident response.
- `docs/manual-tests.md` and `docs/testing.md`: add the cases, per-PR policy, and full-suite checkpoints.
- `docs/status.md`, `docs/user-stories.md`, `docs/personas.md`, and `docs/user-flows.md`: align operator,
  outbox, routing, and environment terminology.
- `docs/implementation-roadmap.md`: update or clearly archive its obsolete admin status.

## Acceptance criteria

The implementation is complete only when:

- the admin runtime is a separate process bound exclusively to `127.0.0.1` and all public legacy paths
  return 404;
- every browser session has verified OS identity, single-use bootstrap, expiry, logout, CSRF, exact-origin,
  fetch-metadata, no-CORS, no-store, and strict CSP protections;
- no production database/provider secret is stored in a repository or `.env`, and database roles are
  environment-specific, least privilege, independently revocable, and verified against the marker;
- production launches read-only by default and production connection/full mutation remain separately
  approved and deliberately confirmed;
- the banner makes environment, mode, database, Stripe expectation, and provider expectation unmistakable;
- all reads are typed, validated, bounded, redacted by default, and meet the documented performance/error
  behavior;
- all commands use preview/confirm/reason, actor attribution, optimistic concurrency, idempotency,
  transactions or durable operation state, and append-only outcome auditing;
- external provider work runs in the matching deployed environment without exposing provider secrets to
  the workstation;
- routing truth, outbox retry semantics, metric definitions, and incomplete revenue behavior match the
  authoritative services/data model;
- malicious stored content cannot execute and the UI passes the keyboard, focus, zoom, narrow viewport,
  reduced-motion, and semantic-label checks;
- unit, integration, browser, static-security, lint, type-check, and regression evidence are attached;
- every implementation PR has a durable manual test and evidence, both full-suite checkpoints pass, and
  rollout/rollback drills are documented;
- all named documentation is updated and the legacy page, backup, handler, middleware, launchers, and
  destructive one-off script are removed.

With this approved design and conservative defaults, issue #162 can move to `status: ready`. Production
credential provisioning and activation remain permission gates, not unresolved implementation design.
