# Admin Interface Modernization Plan

Last updated: July 18, 2026

Status: planning; architecture selection and any production activation require explicit owner approval. No runtime changes are included in this document.

## Decision required

The current local-only admin panel needs a supported security, deployment, and operator model. Three viable directions remain: harden it as a local-only operator tool, secure an admin surface inside the existing backend, or deploy a dedicated environment-scoped Railway admin service. The detailed reference architecture below develops the third option because it currently offers the strongest isolation and auditability, but it is a planning recommendation rather than an approved implementation decision.

No implementation issue may move to `status: ready`, and no runtime, configuration, infrastructure, or production change may begin, until the owner explicitly selects an architecture. Regardless of selection, the existing unauthenticated localhost trust boundary, documentation drift, unsafe browser rendering, ambiguous environment identity, and unaudited mutations must be addressed.

Production activation is a separate approval gate. Architecture approval does not authorize creating production credentials, connecting to production data, provisioning or enabling a production service, or changing a production mode. Those actions require development acceptance evidence and explicit owner approval at the rollout stage.

## Scope and non-goals

This plan covers the admin entry points, API, UI, authentication and authorization, sensitive-data handling, database behavior, deployment model, operator workflow, tests, documentation, rollout, and rollback.

The implementation must not:

- merge directly to `master` or alter production before development acceptance and explicit production approval;
- reuse a production database URL, Auth0 client, session secret, or internal signing secret in development;
- make admin capability available as an MCP tool or normal user API;
- move customer-facing dashboard behavior into this admin surface;
- add a second source of truth for credits, letters, outbox state, promotions, routing, or reconciliation;
- rely on an unadvertised URL, localhost, proxy-header absence, or possession of a database password as authorization.

## Current-state findings

### Actual entry points and launch model

The current implementation is not a separate admin application:

- `admin-panel.html` is a 70 KB static HTML/CSS/JavaScript file at the repository root.
- `src/mcp/httpServer.ts` serves it at `/admin`, `/admin.html`, and `/admin-panel.html` from `process.cwd()` when `ADMIN_ENABLED=true` and the socket appears local.
- The same MCP/API process dispatches `/api/admin*` to `src/api/adminApiHandler.ts`, a roughly 60 KB monolithic route and query handler.
- `src/api/middleware/adminAuth.ts` grants every non-proxied loopback request full admin access without authentication. Remote requests can use an Auth0 JWT allowlist only when the API is enabled and not local-only, but the current UI never sends a token and the static page route is always loopback-only.
- `npm run admin` and `npm run admin:dev` use Unix `env $(grep ... | xargs)` shell syntax and start the TypeScript MCP server through `tsx`. This does not match the compiled Node process deployed on Railway and is not portable to PowerShell.
- On Windows, the documented launcher fails on the Unix-only `env`/`grep`/`xargs` command. Starting the TypeScript file directly also does not auto-start the server because its `import.meta.url` entry-point comparison does not match the Windows invocation URL.
- `.env.admin.example` instructs the operator to copy a production Neon URL locally. It omits OAuth variables that `validateEnvironment()` still requires, so a fresh minimal admin environment does not satisfy startup validation without inheriting another `.env`.
- The server binds to `0.0.0.0` by default even though access is described as local-only.
- The guide alternates between ports `8090` and `8788`. Its direct `file://` option is broken because the current UI derives `API_BASE` from `window.location.origin`, which is `null` for a local file.
- `DISABLE_WORKERS` remains in the admin template and docs, but the current API process already starts no background maintenance. The variable no longer defines an admin-only runtime.

### Live browser findings

A July 18, 2026 local browser review confirmed the code and documentation drift from an operator's perspective:

- After working around the Windows launcher and entry-point failures, the panel was reachable through the shared server on localhost port `8788`, including `/admin`, `/admin.html`, and `/admin-panel.html`, with its data requests under `/api/admin/*`.
- The browser received full local admin access without sign-in because loopback requests bypass authentication. The server was listening on `0.0.0.0`, not only the loopback interface.
- The visible navigation contained Dashboard, Users, Letters, Jobs, Letter Balance, Promos, and Provider Routing. It had no persistent development/production banner or reliable display of the database, Stripe mode, and mail-provider environment in use.
- Provider information was contradictory: the UI could show PostGrid routing while other status text indicated Dummy behavior. This is consistent with the backend's silent provider fallback and means the displayed route cannot be trusted as proof of the provider that will run.
- Provider routing issued an immediate `PUT` when a select value changed. Other mutations used a mix of native `confirm()` prompts, custom forms, previews, or no equivalent review step, so risk and confirmation behavior were inconsistent.
- Navigation and other interactive controls use clickable `div` elements in places instead of semantic links/buttons, creating keyboard, focus, and assistive-technology gaps.
- Representative dashboard requests took approximately 312-426 ms locally. The UI has no consistent slow-query, loading, stale-data, partial-failure, or retry treatment.
- The operator documentation alternates between Admin Panel/Admin Dashboard naming, ports `8090` and `8788`, and server routes versus opening the HTML file directly. The direct `file://` instructions do not work because the UI derives its API origin from `window.location.origin`.

### Access-control and browser-security findings

The current local-only model is not an adequate security boundary for production data:

- Loopback access bypasses identity, role, MFA, session expiry, and per-action authorization.
- `src/api/adminApiHandler.ts` reflects arbitrary request origins on actual admin responses and permits `*` when no origin is supplied. A hostile browser origin can read simple GET responses from localhost. Because request content type is not enforced, simple cross-origin POSTs can also reach JSON-parsing mutation handlers without a preflight.
- Global preflight behavior and handler response CORS behavior disagree, producing both security risk and confusing failures.
- The UI interpolates user emails, recipient/sender fields, provider statuses, job errors, promotion names/codes, audit descriptions, and API errors into `innerHTML`. Only a small subset of letter content is escaped. This creates stored-XSS paths in a page that can perform privileged mutations and read full PII.
- Inline scripts, inline handlers, and inline styles prevent a strong Content Security Policy. No CSP, frame-ancestor restriction, no-store policy, or dedicated admin security headers are set.
- `confirm()` dialogs are the only confirmation for retry and status-sync actions. Provider routing changes immediately on a select event. There is no reauthentication or production-specific confirmation.
- Authentication configuration is read into module-level constants at import time, complicating safe configuration reload and isolated tests.
- Error responses frequently return raw exception messages, which can expose query, schema, or provider details.
- Request bodies have no admin-specific byte limit, timeout, or content-type enforcement, and most query/body values use ad hoc parsing rather than shared schemas.

### Authorization and audit gaps

The API treats every administrator as all-powerful and records the actor inconsistently:

- Balance adjustment embeds an actor string in the credit transaction description but has no normalized admin action ID.
- Job retry and provider routing include partial actor metadata.
- Promotion deletion/status changes, status sync, and other commands do not consistently persist the initiating admin.
- Stripe reconciliation logs the actor to process output but has no durable action record.
- Sensitive letter-content and address reads are not audited.
- There is no append-only admin audit table, request correlation ID, outcome record, or consistent before/after metadata.

### Route and behavior inventory

The current handler exposes the following capability groups:

| Capability | Current routes | Behavior and concerns |
| --- | --- | --- |
| Overview | `GET /api/admin/dashboard`, `/alerts`, `/stats` | Multiple overlapping metric definitions. Revenue uses `orders`, which is not authoritative for every current Stripe pack purchase. “Sent” counts only exact `sent`, excluding later delivery states. |
| Users | `GET /users`, `/users/search`, `/users/:id` | `/users/:id` is registered before `/users/search`, so the search route is shadowed and the UI search is broken. Full email and account data are returned without read auditing. |
| Letters | `GET /letters`, `/letters/search`, `/letters/:id` | Detail returns full sender, recipient, body text, sign-off, preview HTML, jobs, and status history in one response. List/search render recipient data unsafely. |
| Outbox/jobs | `GET /jobs`, `/jobs/:id`, `/jobs/user/:id`, `/outbox/jobs`, legacy `/pgboss/jobs`; `POST /jobs/:id/retry` | `letter_jobs` is now the transactional outbox, not pg-boss. Retry resets attempts to zero and can override the service's backoff/terminal-failure semantics. Retryable scheduled failures are reported as critical failed jobs. |
| Balances | `POST /credits/adjust` | Converts the UI's “letters” to internal credits, while route/docs retain mixed credit/letter terminology. Actor and reason are stored only as description text. |
| Promotions | list/get/create/delete/status/redemptions | UI covers most commands, but status/delete do not persist a normalized actor. Pagination inputs are not bounded consistently. |
| Stripe | `GET /stripe/reconcile`, `POST /stripe/reconcile/fix` | UI has no reconciliation screen despite documentation. An external reconciliation run is modeled as GET. Apply has dry-run protection but no durable review/approval record. |
| Status sync | `GET`/`POST /sync/statuses`, `GET /sync/stuck` | UI exposes preview/apply but docs are incomplete. Commands run provider work in an operator request and do not persist the actor. |
| PAT/rate-limit stats | `GET /tokens/stats`, `/ratelimit/stats` | Implemented but absent from the UI and admin guide. Rate-limit state is process-local, so a separate local admin process cannot describe the deployed API. |
| Routing/providers | `GET /routing`, `PUT /routing/:mailType`, `GET /providers` | UI exposes `lob`, although no Lob provider is registered. Provider creation silently falls back to the default when a selected provider cannot be created, making the visible routing value potentially false. |

### UI and asset drift

- The current page contains seven sections: Dashboard, Users, Letters, Jobs, Letter Balance, Promos, and Provider Routing.
- It does not expose Stripe reconciliation, stuck-letter review, PAT statistics, rate-limit statistics, audit history, environment identity, or modern outbox semantics.
- Letter list/search functions are defined and then overwritten in a second script block.
- `admin-panel.html.backup` is a stale duplicate that references missing `admin-token.js`, uses localStorage for bearer tokens, calls pg-boss-era endpoints, and hard-codes port `8788`.
- The UI hard-codes five image generations per purchased letter rather than using the configured value returned by the backend.
- Many tables have no pagination controls even where the API accepts offsets.
- Status, provider, and monetary labels do not consistently use the current database/provider definitions.

### Database and runtime drift

- The admin handler queries and mutates application tables directly instead of using a typed admin application layer.
- Dashboard totals combine cached columns, `credit_transactions`, `orders`, `letters`, and outbox rows with inconsistent semantics.
- The just-in-time purchase plan already records that `orders` is not authoritative for every current Stripe pack purchase, so current revenue totals are incomplete.
- `letter_jobs` was converted by migration `020_transactional_outbox.sql` to a durable outbox with stable idempotency keys, row locking, backoff, terminal failure rules, and one row per letter. The admin route names, UI labels, alert rules, docs, and retry command still partly assume the old generic/pg-boss queue.
- Provider routing permits values not backed by a registered provider and can fall back at send time without reconciling the stored route.
- Mutations and external actions are not connected by a durable, normalized admin audit event.

### Documentation drift

- `docs/admin-panel-guide.md`, `docs/env-files.md`, `docs/manual-tests.md`, `.env.admin.example`, and `docs/index.md` endorse local unauthenticated access to production data.
- `.env.dev.example` enables admin routes while `docs/deployment.md` requires `ADMIN_ENABLED=false` in both cloud environments.
- `docs/admin-panel-guide.md` documents Stripe routes but no UI, omits later status-sync/routing/PAT/rate-limit behavior, calls the outbox pg-boss, and says the database password is the “real security.”
- `docs/implementation-roadmap.md` still says the admin API is unimplemented.
- `docs/development.md` describes a `public/` static admin location that does not match the repository.
- The admin index links `dashboard-implementation.md` as if current, although the file lives under `docs/archive/` and describes a different customer dashboard.

### Coverage findings

- No Vitest files directly cover `adminAuth.ts`, `adminApiHandler.ts`, the admin routes in `httpServer.ts`, or the static UI.
- Service tests cover some underlying credit, promotion, reconciliation, status-sync, and outbox logic, but not HTTP authorization, routing precedence, validation, redaction, actor attribution, or command composition.
- `scripts/test-admin-api.ts` is a destructive one-off database script. It bypasses HTTP/auth, creates a fixed test user, changes balances, and prints stale curl examples; it is not part of the test suite.
- The manual checklist has only broad local-only checks and does not cover environment isolation, MFA/session behavior, CSRF, XSS, redaction, audit events, route compatibility, outbox backoff, reconciliation approval, or rollback modes.

## Architecture alternatives and approval gate

The owner must select one of the following before implementation begins. Cost and effort are relative planning estimates and must be validated against the chosen framework and Railway/Auth0 configuration.

| Criterion | A. Hardened local-only operator tool | B. Secured admin surface in existing backend | C. Dedicated environment-scoped Railway admin service |
| --- | --- | --- | --- |
| Security boundary | Authenticated process bound strictly to loopback; browser-origin and CSRF defenses still required. Workstation compromise reaches the operator surface. | Auth and authorization live in the existing internet-facing backend; fewer network hops, but admin and public attack surfaces share a process. | Separate browser-facing process plus authenticated internal API; strongest isolation if both service and internal protocol fail closed. |
| PII handling | Production PII reaches an operator workstation and browser directly; local cache, logs, screenshots, and malware are material risks. | PII stays in deployed infrastructure until sent to the authenticated browser; redaction and audited reveal can use backend services. | Same deployed-data advantage as B, with a narrower service contract and least-data responses between services. |
| Credentials | Safest form would use a short-lived, least-privilege brokered credential; distributing a production `DATABASE_URL` is unacceptable. Windows credential storage and rotation need a supported design. | Reuses backend database/provider credentials and adds admin session/Auth0 configuration to the public service. | Admin service holds session/Auth0 and internal-signing secrets but no database/provider secrets; backend keeps its existing credentials. Requires distinct dev/prod secrets. |
| Auditability | Must add identity before local access and send append-only events to the selected environment. Offline/local failure can leave incomplete evidence. | Can write audit and mutation in the same backend transaction, but admin traffic shares public logs and operational concerns. | Backend remains authoritative for audit and commands; signed actor/request context crosses the private link. Strong separation, with more protocol states to audit. |
| Ongoing cost | Lowest cloud cost; operator workstation time and support are the hidden cost. | Lowest incremental Railway cost because it reuses the current service; may increase resource sizing and security-review scope. | Adds one admin service per enabled environment plus Auth0 applications; Serverless/on-demand behavior may limit idle cost but must be measured. |
| Operations | Requires version matching, local setup, secure updates, credential rotation, and a supportable runbook on every operator machine. | One deployable service and familiar backend operations, but admin failures or dependencies can affect the public service and vice versa. | Independent deploy/disable/rollback and clearer ownership; adds service wiring, private networking, secret rotation, and cross-service observability. |
| Windows support | Must replace Unix launch syntax, fix `import.meta.url` startup behavior, bind to loopback, and test PowerShell/Windows paths as first-class acceptance criteria. | Browser-only operator workflow is platform-neutral; backend build/deploy remains unchanged. | Browser-only operator workflow is platform-neutral; local development launcher still needs cross-platform scripts. |
| Implementation effort | Medium: smaller deployment change, but secure identity, credential brokering, browser security, audit, and cross-platform packaging are still substantial. | Medium-high: auth/session/UI/audit work plus careful isolation inside a large public process. | Highest: dedicated service, signed protocol, Auth0 apps, deployment wiring, audit foundation, and UI work. |
| Rollout | Ship development-only read-only mode first; production access remains unavailable until the credential and audit model is approved. | Deploy routes disabled, then development read-only/full; public route and resource regression testing is critical. | Deploy internal API and development admin service disabled/read-only, then full after acceptance; production remains separately disabled until approved. |
| Rollback | Stop the local process, revoke its short-lived access, and remove cached state; cannot un-expose PII already copied locally. | Disable admin routes/session configuration or redeploy the previous backend; rollback shares the public service's release path. | Disable the admin surface and internal API independently, rotate signing/session secrets if needed, and redeploy either service without dropping audit data. |
| Planning assessment | Viable only if local production credentials are eliminated and Windows/security support is accepted as an ongoing product obligation. | Viable when lowest service count is more important than process isolation and the shared blast radius is explicitly accepted. | Current recommendation because it best separates public traffic, credentials, PII contracts, audit, rollout, and rollback; not approved yet. |

A CLI using the same approved command services may remain a narrow break-glass mechanism under any option. Provider dashboards and ad hoc SQL are not a complete replacement for correlated user, letter, outbox, balance, routing, and audit workflows.

### Approval record required

Before changing the GitHub issue to `status: ready`, record the selected option and rationale in both this plan and the issue. The record must explicitly accept its security/PII boundary, credential model, recurring cost, Windows/operator support obligation, rollout, and rollback. If A or B is selected, revise the file-level plan and tests below before implementation; do not implement C's design by default.

## Candidate C reference architecture (conditional)

The remainder of this document specifies Candidate C deeply enough to estimate and review it. It becomes the target architecture only if the owner approves C. Shared requirements such as environment isolation, authentication, redaction, audit, safe mutations, accessibility, automated tests, and manual browser acceptance apply to whichever option is selected.

### Request path

```text
Operator browser
  -> environment-specific letter-irl-admin Railway service
     -> Auth0 Authorization Code + PKCE login
     -> HttpOnly same-origin admin session + CSRF validation
     -> role/mode/reauth checks
     -> HMAC-signed request over Railway private networking
        -> matching letter-irl-api environment /internal/admin/v1/*
           -> typed query/command services
           -> matching Neon branch and matching Stripe/PostGrid mode
           -> append-only admin audit event
```

If Candidate C is approved, there will be one `letter-irl-admin` service in Railway `development` and one in Railway `production`. Each uses the Auth0 tenant and backend private URL from its own environment. Shared secrets must be unique per environment. The service URL is not a security control.

The public API keeps its normal start command. The new admin service uses a separate compiled entry point and never loads database, Stripe, PostGrid, MCP, widget, or webhook credentials. The browser never receives the internal signing secret or an Auth0 access/refresh token.

### Environment behavior

| Environment | Initial mode | Data/integrations | Activation rule |
| --- | --- | --- | --- |
| Local development | `read_only` by default; optional `full` | Development backend only | Refuse production backend URLs and production Auth0 issuer; no local bypass |
| Railway development | `full` after auth tests | Dev Neon, Stripe test, PostGrid test/dummy | Required implementation and browser acceptance environment |
| Railway production | `disabled`, then `read_only`, then `full` | Production Neon, Stripe live, PostGrid live | Explicit owner approval after dev acceptance, security review, MFA proof, backup/rollback proof |

Both the admin service and internal API must compare an explicit `LETTER_IRL_ENVIRONMENT` value carried in the signed protocol. A mismatch fails closed before any query or external call. Config validation must also reject a development admin service pointed at the production API hostname or Auth0 issuer.

### Authentication, session, and authorization model

- Use separate Auth0 Regular Web Applications for development and production admin services.
- Use Authorization Code with PKCE, state, and nonce. Callback URLs must be exact and environment-specific.
- Keep Auth0 tokens server-side only. Set an opaque or authenticated-encrypted session cookie with `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, an idle timeout of 30 minutes, and absolute lifetime of 8 hours.
- Rotate the session identifier after login and reauthentication. Logout invalidates the server session and clears the cookie.
- Require an allowlisted Auth0 subject. A normal Letter IRL account is not an admin by default.
- Support `viewer` and `operator` roles. `viewer` can use redacted reads; `operator` can run approved commands. Production mutations also require recent reauthentication (15 minutes), MFA evidence, a reason, and an explicit production confirmation.
- Require MFA for production. If the production Auth0 tenant cannot produce verifiable MFA/`acr` evidence, production must remain `disabled` or `read_only`.
- Denied requests use stable 401/403 responses on the admin service. Public legacy admin paths remain stealth 404.

### Browser and HTTP security model

- Serve UI and browser API from one origin. Do not enable CORS for the admin service.
- Validate `Host`, `Origin`, and `Sec-Fetch-Site` where present. Reject cross-site mutation requests.
- Require a synchronizer CSRF token on every non-GET request and use only JSON content types.
- Enforce strict request-body limits, timeouts, schema validation, and bounded pagination.
- Set CSP without `unsafe-inline`, `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, a strict referrer policy, permissions policy, HSTS in deployed HTTPS, and `Cache-Control: no-store` on authenticated HTML/API responses.
- Use framework escaping and text nodes for untrusted data. Prohibit `dangerouslySetInnerHTML`/raw `innerHTML` outside a reviewed, sanitized helper. Never render stored `preview_html` directly.
- Return stable public error codes and correlation IDs; log detailed errors server-side with secret and PII redaction.
- Do not place admin identifiers, tokens, full addresses, full letter bodies, or temporary image capability URLs in analytics.

### Internal service authentication

- The admin service signs each internal request with an environment-specific HMAC secret, timestamp, nonce, method, canonical path/query, body hash, actor subject, role, session authentication time, and request ID.
- The backend rejects missing/invalid signatures, clock skew over 60 seconds, reused nonces, environment mismatch, unrecognized roles, and unsigned actor fields.
- Nonces are stored briefly in the environment's database or another shared backend store so replay protection works across API instances.
- The internal route is not browser-CORS enabled and accepts only the signed service protocol. Railway private networking is defense in depth, not the sole authorization control.
- Rotate development and production internal secrets independently. Support current and next secret during a bounded rotation window.

### Sensitive-data model

- Overview and list endpoints return only fields required by the screen.
- Mask user emails by default outside the selected user detail view.
- Mask street lines and letter body in lists and normal detail responses.
- A separate sensitive reveal command requires `operator`, MFA, recent reauthentication, a reason, and an audit event. The UI automatically hides revealed data after five minutes.
- Never return `preview_html`, provider credentials, payment secrets, raw Auth0 tokens, or internal capability URLs.
- Audit metadata may include stable record IDs and redacted before/after summaries, but not full letter bodies or addresses.

## Target capability and API model

Use versioned internal routes under `/internal/admin/v1`. A central router must match exact/static routes before parameter routes and share Zod contracts with the admin client.

| Area | Target operations |
| --- | --- |
| Session | admin-service `/auth/login`, `/auth/callback`, `/auth/reauth`, `/auth/logout`, `/admin/api/session` |
| Overview | `GET /overview`, `GET /alerts` with documented metric definitions and data freshness |
| Users | `GET /users`, `GET /users/:id`; bounded search; no shadowed route |
| Letters | `GET /letters`, `GET /letters/:id`; `POST /letters/:id/reveal` for audited sensitive access |
| Outbox | `GET /outbox/jobs`, `GET /outbox/jobs/:id`, `POST /outbox/jobs/:id/retry` using outbox eligibility/backoff rules |
| Balances | `POST /balance-adjustments` with internal credit units in the contract and user-facing letters in the UI |
| Promotions | list/get/create/status/end; prefer ending over deletion; deletion limited to never-redeemed drafts |
| Reconciliation | `POST /reconciliation/stripe/runs` for dry-run; `POST /reconciliation/stripe/runs/:id/apply` after reviewing a persisted result |
| Status sync | `POST /status-sync/runs` with explicit `dryRun`; persist run and actor summaries |
| Routing | `GET /routing`, `PATCH /routing/:mailType`; accept only providers registered and configured in that environment |
| Operational stats | PAT aggregate and environment-appropriate rate-limit/maintenance state from the deployed API, not a local process |
| Audit | `GET /audit-events` with bounded filters; no mutation/delete API |

All commands require an idempotency key. Commands return an admin action ID and current resource version. Conflicting/stale updates return 409 instead of silently overwriting.

## Database changes

Add one forward-only migration, expected to be `db/migrations/021_admin_operations.sql`, after reconciling its number with the branch at implementation time.

The migration will add:

1. `admin_audit_events`
   - UUID primary key/action ID;
   - environment, request ID, actor subject/email snapshot/role;
   - action, target type/ID, reason, outcome, error code;
   - redacted `before_summary` and `after_summary` JSONB;
   - created/completed timestamps and command idempotency key;
   - indexes on time, actor, action, target, and idempotency key;
   - no foreign key to Auth0 users and no full letter/address content.
2. `admin_command_runs`
   - command/action ID, type, state (`pending`, `succeeded`, `failed`, `partially_succeeded`), environment, request payload hash, redacted result summary, started/completed timestamps;
   - unique environment + idempotency key;
   - used for reconciliation and status-sync review/apply workflows.
3. `admin_request_nonces`
   - nonce hash, environment, expiry, and one-time uniqueness for internal HMAC replay defense;
   - maintenance cleanup through the existing one-shot maintenance command.

Mutation services must write the audit event in the same database transaction as database-only changes. For Stripe/PostGrid operations, persist `pending` before the external call and finalize the outcome afterward. A crash leaves an inspectable incomplete event. Do not introduce destructive migration rollback; rollback keeps these tables and ignores them from older application code.

Metric queries need named definitions and tests:

- available balance comes from the current authoritative balance/ledger reconciliation contract;
- purchased/used/promo/adjustment categories are separate, not inferred only from amount sign;
- sent mail includes agreed lifecycle states rather than only exact `sent`;
- revenue uses the authoritative purchase records established by the just-in-time purchase implementation and must display “incomplete” until that source is available;
- outbox alerts distinguish scheduled retry, stale processing lock, and terminal/manual-attention failure;
- rate-limit and maintenance data comes from the deployed environment and states whether values are process-local or durable.

## Exact file-level implementation plan

File names may be adjusted only to match an intervening repository convention; responsibilities and boundaries below are acceptance requirements.

### New shared admin protocol

- `src/adminProtocol/contracts.ts`: request/response types, roles, modes, action names, stable error codes.
- `src/adminProtocol/schemas.ts`: Zod schemas for all query parameters, bodies, and signed actor assertions.
- `src/adminProtocol/signing.ts`: canonicalization, HMAC signing/verification, key rotation support, body hashing.
- `src/adminProtocol/redaction.ts`: PII masking and audit-summary helpers.

### New dedicated admin service

- `src/admin/httpServer.ts`: minimal admin HTTP entry point; no MCP, payment webhook, widget, provider, maintenance, or DB initialization.
- `src/admin/config.ts`: fail-closed environment parsing and dev/prod mismatch checks.
- `src/admin/auth/auth0.ts`: Authorization Code + PKCE, state, nonce, callback, MFA claim validation.
- `src/admin/auth/session.ts`: secure session creation/rotation/expiry and role resolution.
- `src/admin/auth/csrf.ts`: same-origin and synchronizer-token validation.
- `src/admin/internalAdminClient.ts`: signed private-network client with timeout, retry classification for safe reads only, and correlation IDs.
- `src/admin/securityHeaders.ts`: CSP and authenticated no-store headers.
- `src/admin/staticAssets.ts`: safe serving of the built UI asset manifest only.
- `src/admin/breakGlass.ts`: shared command invocation policy used by the Railway one-off CLI; it must not accept a raw database URL.
- `src/cli/adminCommand.ts`: explicit environment, action, reason, idempotency key, and typed production confirmation; intended for `railway run` only.

### New admin UI

- `admin-ui/index.html`: CSP-compatible application shell.
- `admin-ui/vite.config.ts`: deterministic build into `dist/admin-ui` with no source maps in production unless access-controlled.
- `admin-ui/src/main.tsx` and `admin-ui/src/App.tsx`: application bootstrap, session gate, navigation, error boundary.
- `admin-ui/src/api/client.ts`: same-origin typed API client, CSRF token handling, stable error mapping.
- `admin-ui/src/components/EnvironmentBanner.tsx`: persistent environment/mode/data-source identity.
- `admin-ui/src/components/MutationDialog.tsx`: reason, preview, reauth, production confirmation, and idempotency handling.
- `admin-ui/src/components/SensitiveReveal.tsx`: audited reveal with five-minute automatic concealment.
- `admin-ui/src/views/Overview.tsx`, `Users.tsx`, `Letters.tsx`, `Outbox.tsx`, `Promotions.tsx`, `Reconciliation.tsx`, `Routing.tsx`, and `Audit.tsx`: bounded, accessible screens using shared contracts.
- `admin-ui/src/styles.css`: responsive layout, visible focus, reduced-motion support, semantic status colors with text/icons.

Use Preact + TypeScript + Vite unless implementation evidence shows the existing companion website should own the UI before coding starts. This plan intentionally keeps the surface in this repository so one deployment artifact and one issue own the migration. Framework rendering must auto-escape all values; raw HTML rendering is prohibited.

### Backend internal API refactor

- `src/api/internalAdmin/router.ts`: exact/versioned internal routes only.
- `src/api/internalAdmin/serviceAuth.ts`: HMAC, nonce, time, actor, role, and environment verification.
- `src/api/internalAdmin/queries.ts`: typed, bounded read models and metric definitions.
- `src/api/internalAdmin/commands.ts`: command authorization, idempotency, transaction boundaries, external-run state.
- `src/api/internalAdmin/audit.ts`: append-only audit and command-run persistence.
- `src/api/internalAdmin/outboxCommands.ts`: retry eligibility using `letterJobService` semantics; never reset attempts blindly.
- `src/api/internalAdmin/response.ts`: stable errors, correlation IDs, and redacted logging.
- `src/services/letterJobService.ts`: expose a single audited retry operation that preserves terminal/backoff/idempotency rules.
- `src/services/providers/index.ts`: expose registered/configured provider capabilities; remove silent routing fallback for explicitly configured invalid providers.
- `src/services/stripeReconciliationService.ts` and `src/services/statusSyncService.ts`: accept action/run context and return persistable redacted summaries.
- `src/cli/runMaintenance.ts`: clean expired admin nonces/command records according to retention policy.
- `src/mcp/httpServer.ts`: register signed `/internal/admin/v1/*` routes, remove static admin serving and browser `/api/admin*` dispatch, and keep legacy public paths at 404.

### Remove or retire

- Delete `admin-panel.html` after the new UI reaches production full mode.
- Delete `admin-panel.html.backup` immediately in the first runtime PR; it is not a supported fallback.
- Delete `src/api/middleware/adminAuth.ts` after the signed internal API and Auth0 admin service replace it.
- Split and then delete `src/api/adminApiHandler.ts`; do not keep a second legacy route implementation.
- Replace `scripts/test-admin-api.ts` with automated tests and the guarded Railway one-off CLI.
- Remove `.env.admin.example`, local production `.env.admin` guidance, and the Unix shell-based `admin` script.
- Remove the `/api/admin/pgboss/jobs` compatibility alias and document `letter_jobs` as the transactional outbox.

### Build and package changes

- `package.json`: add `build:admin-ui`, `start:admin`, `dev:admin`, guarded `admin:command`, and browser-test scripts; use cross-platform environment loading.
- `package-lock.json`: capture Preact/Vite and test dependencies.
- `tsconfig.json`: include the dedicated service/protocol while keeping browser compilation in Vite.
- Add `playwright.config.ts` and a deterministic admin test-server fixture.
- Ensure `npm run build` builds TypeScript and admin assets and that the public API image contains only the intended built assets.

## Configuration contract

All variables are environment-specific. Secret values stay in Railway/Auth0 and never enter Git, logs, screenshots, or issue bodies.

| Variable | Service | Secret | Purpose/default |
| --- | --- | --- | --- |
| `LETTER_IRL_ENVIRONMENT` | both | no | Required `development` or `production`; signed into every internal request |
| `ADMIN_SURFACE_MODE` | admin | no | Required `disabled`, `read_only`, or `full`; default/fallback is `disabled` |
| `ADMIN_PUBLIC_BASE_URL` | admin | no | Exact HTTPS origin and callback base |
| `ADMIN_AUTH0_ISSUER` | admin | no | Environment-specific Auth0 tenant |
| `ADMIN_AUTH0_CLIENT_ID` | admin | no | Dedicated Regular Web Application client |
| `ADMIN_AUTH0_CLIENT_SECRET` | admin | yes | Server-side callback exchange |
| `ADMIN_SESSION_SECRET` | admin | yes | Cookie/session authentication and rotation |
| `ADMIN_VIEWER_USER_IDS` | admin | sensitive config | Auth0 subjects with redacted read access |
| `ADMIN_OPERATOR_USER_IDS` | admin | sensitive config | Auth0 subjects allowed to run commands |
| `ADMIN_REQUIRE_MFA` | admin | no | Must be `true` in production |
| `ADMIN_SESSION_IDLE_MINUTES` | admin | no | Default `30` |
| `ADMIN_SESSION_MAX_MINUTES` | admin | no | Default `480` |
| `ADMIN_REAUTH_MAX_MINUTES` | admin | no | Default `15` for sensitive reads/mutations |
| `ADMIN_INTERNAL_API_URL` | admin | sensitive config | Matching Railway private backend URL |
| `ADMIN_INTERNAL_HMAC_SECRET` | both | yes | Unique per environment; current signing key |
| `ADMIN_INTERNAL_HMAC_SECRET_NEXT` | both | yes | Optional bounded rotation key |
| `INTERNAL_ADMIN_API_ENABLED` | API | no | Default `false`; enabled only with valid secret/config |
| `INTERNAL_ADMIN_MAX_CLOCK_SKEW_SECONDS` | API | no | Default `60` |

`ADMIN_ENABLED`, `ADMIN_LOCAL_ONLY`, and `LETTER_IRL_ADMIN_USER_IDS` become deprecated. During one release they may trigger a startup warning, but they must not enable any route. Cloud startup must fail if legacy admin flags are `true` after the cutover. `DISABLE_WORKERS` must not be documented as an admin control.

## Compatibility and migration behavior

- Existing `/admin*` and `/api/admin*` public paths return 404 throughout rollout. Do not redirect to the new service because redirects disclose the operator surface and can leak paths through referrers.
- No external customer or MCP contract is expected to depend on admin routes. Search and access logs must be reviewed before removal; any unknown caller is investigated, not preserved automatically.
- The new internal API is versioned. The admin client and backend deploy from the same commit, but one prior internal protocol version may be accepted during rolling deploys when schemas are backward compatible.
- Database migration 021 is additive. Old public API deployments ignore its tables, allowing application rollback without dropping audit data.
- `letter_jobs` IDs and provider idempotency keys are preserved. Admin retry never creates another outbox row or provider order.
- Promotion, balance, routing, reconciliation, and status-sync services remain authoritative; the admin UI is only an adapter.
- Revenue UI remains explicitly unavailable/incomplete until the purchase source-of-truth work identified by the just-in-time purchase plan is present. Do not display a known partial number as total revenue.

## Automated test plan

### Unit tests

Add tests under `tests/unit/admin/` and `tests/unit/api/` for:

- config fails closed for missing mode, environment mismatch, production issuer/API in development, missing secrets, and MFA disabled in production;
- Auth0 state/nonce/PKCE, callback error handling, allowlist roles, MFA claims, session rotation, idle/absolute expiry, logout, and reauth freshness;
- CSRF, Host/Origin/Sec-Fetch-Site checks and strict security headers;
- HMAC canonicalization, body tampering, wrong actor/environment, clock skew, replay, and current/next key rotation;
- exact route precedence, especially user search versus `:id`;
- every Zod schema's happy path, missing fields, bounds, enum validation, unknown fields, and invalid content type;
- PII redaction and audit summaries, including malicious HTML/script strings;
- metric definitions for delivered/sent states, balance categories, incomplete revenue, scheduled retry versus terminal failure, and maintenance freshness;
- command role/mode/reauth checks and idempotency;
- balance adjustment, promotion status/end/delete, routing, reconciliation, status sync, and outbox retry audit attribution;
- provider routing rejects unregistered/unconfigured providers and never silently reports a different provider than runtime will use;
- stable public error codes do not expose raw SQL/provider messages.

### Integration tests

Add `tests/integration/admin/` using an isolated migrated PostgreSQL database and mocked Auth0/Stripe/PostGrid endpoints:

- admin service login -> session -> signed internal query happy path;
- normal user and viewer/operator authorization boundaries;
- database-only command and audit event commit atomically; forced failure rolls both back;
- external command records pending/succeeded/failed outcomes without duplicating on idempotent retry;
- nonce replay is rejected across separate backend server instances;
- development service cannot reach a production-marked backend and vice versa;
- outbox retry preserves one row, stable idempotency key, attempt/backoff rules, and terminal failure policy;
- concurrent balance/promotion/routing commands return deterministic results and audit events;
- migration 021 applies to a migration-020 fixture and old application code still starts against the additive schema;
- legacy public admin paths remain 404 while signed private routes work.

### Browser tests

Add Playwright tests under `tests/browser/admin/` for:

- login, logout, expired session, reauth, viewer/operator UI differences, and disabled/read-only/full modes;
- persistent environment banner and production confirmation wording;
- overview, bounded search, pagination, filters, empty/loading/error/stale states;
- redacted letter/user views and timed sensitive reveal;
- balance, promotion, outbox retry, routing, reconciliation review/apply, status sync, and audit history flows;
- keyboard navigation, visible focus, semantic labels, dialog focus trapping, reduced motion, narrow viewport, and color-independent status meaning;
- malicious email, recipient, job error, promotion, provider, and API error strings render as text and cannot execute;
- no bearer tokens in localStorage/sessionStorage, no sensitive response caching, no mixed environment requests, and no cross-origin API calls.

### Static and security checks

- Add a test that fails on `dangerouslySetInnerHTML`, direct `innerHTML`, inline event handlers, or legacy admin asset references outside an explicit reviewed allowlist.
- Validate CSP against the built asset manifest.
- Run dependency audit, lint, TypeScript build, Vitest, integration tests, and Playwright in the implementation PRs.
- Add a contract snapshot/table proving every target route's method, minimum role, mode, reauth requirement, sensitive-data class, and audit requirement.

## Manual browser and operator acceptance

Run all mutation tests in Railway development first with Stripe test and PostGrid test/dummy modes.

1. Open the development admin URL from a signed-out browser. Confirm no admin data or asset shell is available before login.
2. Sign in with a non-admin development Auth0 user; confirm 403 and no internal request reaches the API.
3. Sign in with the allowlisted operator, complete MFA, and confirm the banner names Development, the development API, and non-live integrations.
4. Inspect browser storage, cookies, network responses, cache, referrers, and console. Confirm only the protected session/CSRF model exists and no OAuth/internal secrets or PII are cached/logged.
5. Verify overview metrics against controlled development fixtures and documented SQL definitions.
6. Search users/letters with special characters and malicious HTML fixtures. Confirm text-only rendering and bounded results.
7. Confirm list/detail redaction, perform an audited sensitive reveal with a reason, and verify automatic concealment.
8. Run a balance adjustment, promotion lifecycle command, provider-routing update, outbox retry, status-sync dry run/apply, and Stripe reconciliation dry run/apply. Confirm previews, idempotency, actor/reason/outcome audit, and test-mode external behavior.
9. Confirm a scheduled-retry outbox row cannot be misclassified or reset as a terminal manual retry. Confirm a terminal retry keeps the same letter, outbox row, and provider idempotency key.
10. Attempt cross-site requests, missing/wrong CSRF, stale session, stale reauth, wrong role, replayed signed request, altered body, wrong environment, and direct public `/api/admin` access. Confirm fail-closed behavior.
11. Test keyboard-only, screen-reader names, 200% zoom, 320 px viewport, reduced motion, slow API, partial failure, cold start, and session expiry while a dialog is open.
12. Leave the development service idle, wake it, and confirm Railway Serverless behavior stays within the accepted recovery target or document a separate admin-specific threshold.
13. Deploy production in `disabled`; confirm public/legacy paths are 404 and normal MCP/API/website health is unchanged.
14. Enable production `read_only` after owner approval. Verify Auth0 tenant, actor subject, backend private URL, Neon branch, Stripe mode, PostGrid mode, and audit destination without running a mutation.
15. Enable production `full` only after the go-live checklist is signed. Run one reversible, pre-approved command and verify its audit record. Do not create a real charge or real mail order as a smoke test.

## Rollout plan

0. Obtain explicit owner approval for A, B, or C and revise this conditional file-level plan if A or B is selected. Architecture approval authorizes planning the selected implementation; it does not authorize production activation.
1. For Candidate C, merge the additive protocol, audit migration, internal API, and tests to `dev` with all public legacy routes still disabled.
2. Provision only the development Auth0 admin application and Railway `letter-irl-admin` service. Generate development-only session and HMAC secrets.
3. Deploy development in `read_only`, validate authentication/security/queries, then enable development `full` and run the complete acceptance suite.
4. Land the new UI and command workflows in slices. Keep incomplete commands hidden server-side and client-side.
5. Remove legacy local files/scripts/docs only after the development service covers their supported capability set.
6. Stop and present development acceptance, security, cost/cold-start, rollback, and manual-test evidence to the owner. Obtain a new, explicit production-provisioning approval.
7. Only after that approval, provision the production Auth0 application and Railway service with distinct secrets and `ADMIN_SURFACE_MODE=disabled`. Do not copy variables between Railway environments.
8. Promote the accepted `dev` commit through the normal `dev` -> `master` PR. Confirm migration and API health. Obtain explicit owner approval before changing production from `disabled` to `read_only`.
9. Observe production authentication, audit, errors, and environment identity in `read_only`. Obtain another explicit owner approval before enabling `full`.
10. Monitor admin auth failures, command failures, audit completeness, latency, and unexpected legacy-route traffic. Retain the old local workflow as unsupported code only until production read-only acceptance, then delete it before full-mode acceptance.

## Rollback plan

- UI/admin-service rollback: set `ADMIN_SURFACE_MODE=disabled`, then redeploy the previous admin service build. This does not affect MCP/API routes.
- Internal API rollback: set `INTERNAL_ADMIN_API_ENABLED=false`. Keep public legacy routes at 404.
- Secret incident: disable the surface, rotate the affected environment's Auth0 client secret, session secret, and HMAC key independently, revoke active sessions, then review audit/security logs.
- Application rollback: redeploy the previous successful API/admin pair. Migration 021 remains; do not drop audit, command-run, nonce, outbox, or idempotency data.
- Command uncertainty: stop further commands and inspect `admin_command_runs`, audit state, Stripe/PostGrid dashboards, and the outbox before retrying with the same idempotency key.
- Break glass: use the guarded `railway run` command in the explicitly selected environment. It must use the same command services, authorization policy, idempotency, and audit writer; direct SQL or a local production `DATABASE_URL` is not the documented rollback.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| New public admin service increases attack surface | Separate process, Auth0 + MFA + allowlist, no DB/provider secrets, strict same-origin/session policy, disabled/read-only modes, public URL not treated as security |
| Admin service can forge operator actions if compromised | Environment-specific HMAC, least data in service, short sessions, actor/role signing, backend policy recheck, replay protection, full audit |
| Signed internal protocol drifts during deploy | Shared versioned schemas, rolling compatibility window, deploy same commit, contract tests |
| Environment miswiring impacts production | Explicit signed environment, config hostname/issuer checks, distinct secrets, persistent banner, production confirmation, dev-first rollout |
| Audit event and mutation diverge | Same transaction for DB commands; pending/final state for external calls; idempotency keys and incomplete-run recovery |
| UI exposes stored PII/XSS | Server redaction, framework escaping, no raw HTML, strict CSP, malicious-fixture browser tests, timed audited reveal |
| Outbox retry duplicates mail | Reuse service-level eligibility, one row/letter, stable provider idempotency key, no attempt reset, concurrency tests |
| Revenue remains incomplete | Hide/label unavailable until authoritative purchase work lands; do not claim partial totals |
| Added service cost/cold start | Railway Serverless/on-demand evaluation in development; admin-specific latency acceptance; no warm-production assumption without measurement |
| Auth0 MFA feature or claim unavailable | Production stays disabled/read-only; resolve tenant policy before full activation rather than weakening the requirement |

## Decisions and permission gates

### Constraints shared by every option

- No unauthenticated localhost bypass or possession-of-database-password authorization model.
- No production database URL distributed to an operator workstation.
- Explicit identity, role, environment, redaction, confirmation, and durable audit behavior.
- Development-first delivery with production disabled until separately approved.
- No destructive audit rollback and no direct SQL/provider dashboards as the normal operator workflow.
- Cross-platform operator support, including Windows, is documented and tested for any local commands.

### Open owner decisions

1. Select A (hardened local-only), B (secured existing backend), or C (dedicated Railway service). The planning recommendation is C.
2. If C is selected, confirm that this repository owns the UI and accept one additional Railway service and Auth0 Regular Web Application per enabled environment.
3. Confirm the production identity policy: allowlisted viewer/operator roles, MFA evidence, reauthentication window, and sensitive-reveal rules.
4. Confirm the audit/command retention period and whether sensitive reveals require a second approver in production.
5. Confirm the accepted development cold-start/slow-query target after measuring the observed 312-426 ms baseline.
6. Later, after development acceptance, separately approve production provisioning, `read_only` activation, and `full` activation. None is implied by the architecture decision or a merged implementation PR.

### External permission gates

These remain rollout gates after an architecture is selected; they are not authorized by this planning PR:

- Objective Works/Auth0 owner access is required to create two Regular Web Applications, exact callbacks, logout URLs, and production MFA policy.
- Railway owner access is required to add one admin service per environment, private backend URLs, environment-specific variables, domains, and Serverless settings.
- Neon/Railway migration authority is required for development migration 021 and later production promotion.
- The organization owner must approve production `read_only` and later `full`; Codex must not toggle either during a code-only implementation session without explicit authorization.
- If the GitHub project board rather than labels is required for backlog state, the current CLI token needs `read:project`/project write scopes. Repository `status:*` labels remain available without that scope.

## Suggested PR slicing

Do not start these implementation PRs until the architecture approval record is complete and the issue is intentionally moved from `status: planning` to `status: ready`. The following slices assume Candidate C; A or B requires a revised slice plan.

1. **Admin protocol and audit foundation**: migration 021, contracts/schemas/signing/redaction, config, tests; no enabled routes.
2. **Signed internal read API**: service authentication, overview/users/letters/outbox read models, redaction, metric fixes, public legacy 404 tests.
3. **Admin auth shell and read-only UI**: dedicated service, Auth0 session/CSRF/security headers, environment banner, read-only screens, Playwright.
4. **Audited commands**: balance, promotions, routing, outbox retry, status sync, reconciliation, reauth/MFA/idempotency, command-run recovery.
5. **Development deployment and acceptance**: Railway/Auth0 dev config, manual evidence, security review, cold-start measurement.
6. **Legacy retirement and documentation**: remove root HTML/backup/old handler/middleware/script/env scripts; update all operator, infrastructure, schema, security, status, and test docs.
7. **Production promotion**: provision disabled production service, dev -> master PR, read-only approval, observation, full-mode approval, one reversible smoke action.

Each PR must target `dev`, preserve production/development separation, include test evidence, and leave unavailable capabilities disabled server-side. Production promotion is a separate approval-bearing PR/operation.

## Documentation updates required during implementation

- `README.md`: replace local admin references with the deployed operator-service overview.
- `docs/admin-panel-guide.md`: replace with an operator guide or rename to `docs/admin-operations.md`; include roles, modes, redaction, commands, audit, and break-glass.
- `docs/infrastructure.md`: add `letter-irl-admin` to both Railway environments and the private signed request path.
- `docs/deployment.md`: add admin build/start/provisioning, mode gates, secret rotation, and promotion/rollback checks.
- `docs/railway-setup.md`: exact service commands, private backend URL, Serverless evaluation, and environment variable ownership.
- `docs/env-files.md`: remove local production `.env.admin`; document dev-only local admin and Railway-owned production config.
- `.env.example` and `.env.dev.example`: replace legacy flags with safe, disabled defaults and non-secret descriptions.
- `.env.admin.example`: delete; if needed, replace with `.env.admin.dev.example` that rejects production configuration.
- `docs/development.md`: correct file locations and the local development-only workflow.
- `docs/database-schema.md`: document audit/command/nonce tables and retention.
- `docs/security-and-policy.md` and `docs/privacy-policy.md`: add operator access, sensitive reveal, audit, retention, and incident requirements.
- `docs/manual-tests.md` and `docs/testing.md`: add the automated/manual matrices above.
- `docs/status.md`, `docs/user-stories.md`, `docs/personas.md`, and `docs/user-flows.md`: align the operator model, outbox terminology, roles, and production gates.
- `docs/index.md`: point to the implemented operator guide and archive/supersede this plan when complete.
- `docs/implementation-roadmap.md`: either update the admin phase to current reality or clearly archive the obsolete roadmap.

## Acceptance criteria

The implementation is complete only when all of the following are true:

- [ ] The owner-selected architecture and rationale are recorded in this plan and the linked issue before implementation begins.
- [ ] Public MCP/API services do not serve admin HTML or browser `/api/admin*` capability.
- [ ] The local unauthenticated production-DB workflow, root admin assets/backup, stale script, and legacy flags are removed.
- [ ] Development and production have distinct admin services, Auth0 clients, secrets, backend private URLs, and data/provider/payment environments.
- [ ] Missing/invalid config, cross-environment wiring, absent MFA in production, and unknown roles fail closed.
- [ ] The browser uses secure server-side sessions, CSRF protection, strict security headers, no CORS, no token web storage, and no raw stored HTML.
- [ ] Normal reads are redacted; sensitive reveals are authorized, reasoned, time-limited, and audited.
- [ ] Every mutation/external admin run has actor, role, environment, reason, idempotency key, target, outcome, and redacted audit data.
- [ ] Metric definitions are authoritative and tested; incomplete revenue is not presented as total.
- [ ] Outbox terminology and retry behavior match migration 020 and preserve one row/letter plus provider idempotency.
- [ ] Routing exposes only registered/configured providers and cannot silently fall back after an explicit admin choice.
- [ ] User search route precedence, validation bounds, pagination, error redaction, and malicious-content rendering are covered by tests.
- [ ] Vitest unit/integration suites, build, lint, dependency audit, and Playwright browser tests pass.
- [ ] The complete manual development acceptance record is attached to the implementation PRs.
- [ ] Production is first deployed disabled, then explicitly approved read-only, then explicitly approved full; no code merge alone changes production mode.
- [ ] Rollback disables the admin surface/internal API without dropping audit, command, nonce, outbox, or idempotency data.
- [ ] All listed documentation reflects the shipped architecture and no longer calls a database password or localhost the security model.
