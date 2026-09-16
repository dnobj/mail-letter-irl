# Letter IRL API

Letter IRL prints and mails real US letters and postcards that people compose in ChatGPT. This
repository is the production API: an MCP server for the OpenAI Apps SDK (22 tools, 6 widgets), the
REST API behind the letterirl.com dashboard, Stripe webhooks, and the hourly maintenance job.
PostGrid prints and mails; Neon PostgreSQL stores everything; Auth0 authenticates; Railway hosts.

The marketing site and dashboard live in the separate `letter-irl-website` repository.

## Where to start

- [docs/index.md](docs/index.md) - documentation index
- [docs/status.md](docs/status.md) - current state and architecture
- [docs/development.md](docs/development.md) - local setup, workflow, adding a tool
- [docs/deployment.md](docs/deployment.md) - release process and boot validation rules
- [AGENTS.md](AGENTS.md) - repository guidelines for contributors and coding agents

## Project structure

- `src/mcp/` - HTTP entry point (`httpServer.ts`), tool and widget registration, manifest, OAuth metadata
- `src/tools/` - one module per MCP tool
- `src/services/` - domain logic: credits and ledger, drafts, commerce, outbox, retention, providers
- `src/api/` - REST handlers for the dashboard
- `src/auth/` - token validation, scopes, beta access
- `src/admin/` - the tailnet-only operator panel (a separate Railway service)
- `src/cli/` - `migrate.ts`, `runMaintenance.ts`, the local flow harness
- `src/config/` - deployment validation and the product/price table
- `db/migrations/` - forward-only SQL migrations (see [db/README.md](db/README.md))
- `widgets/` - Apps SDK widget HTML, served as `ui://` MCP resources
- `tests/unit/`, `tests/integration/` - Vitest suites; the integration suites need PostgreSQL
- `manifest.json` - generated with `npm run manifest:generate`; do not edit by hand

## Getting started

Requires Node.js 22 and a PostgreSQL database (a Neon `dev` branch or a local server).

```bash
npm ci
cp .env.example .env        # then fill in the values; see docs/env-files.md
npm run db:migrate
npm run dev                 # tsx watcher on src/mcp/httpServer.ts
```

The server listens on `0.0.0.0:8090` unless `PORT` or `LETTER_IRL_HTTP_PORT` says otherwise
(`.env.example` sets 8788). The MCP endpoint is `/mcp`; `/healthz`, `/readyz` and `/manifest.json`
are served alongside it.

Other commands:

```bash
npm run build               # tsc to dist/
npm start                   # node dist/mcp/httpServer.js (build first)
npm run maintenance         # one hourly maintenance pass, then exit (build first)
npm run verify              # lint, build, unit and submission tests - mirrors CI
npm run test:integration:local   # PostgreSQL suites against a local database
npm run mcp:stdio           # stdio transport for local MCP clients
```

## Configuration

The full variable list and the rules the boot validator enforces are in
[docs/railway-setup.md](docs/railway-setup.md) and [docs/deployment.md](docs/deployment.md). The
HTTP and OAuth variables most often needed locally:

- `LETTER_IRL_HTTP_HOST` / `LETTER_IRL_HTTP_PORT` - bind address (default `0.0.0.0:8090`; Railway's `PORT` wins).
- `LETTER_IRL_ALLOWED_HOSTS` / `LETTER_IRL_ALLOWED_ORIGINS` - comma-delimited allowlists for Host and Origin headers. Required in production.
- `LETTER_IRL_WIDGET_PATH`, `LETTER_IRL_MANIFEST_ROUTE`, `LETTER_IRL_OPENID_ROUTE`, `LETTER_IRL_PROTECTED_RESOURCE_ROUTE` - override default routes (`/widgets`, `/manifest.json`, `/.well-known/openid-configuration`, `/.well-known/oauth-protected-resource`).
- `LETTER_IRL_PUBLIC_BASE_URL` - external HTTPS base URL used in the manifest and OAuth metadata.
- `LETTER_IRL_REQUIRE_AUTH` - `false` disables OAuth enforcement for local testing only; production refuses to boot with it.
- `LETTER_IRL_OAUTH_ISSUER`, `LETTER_IRL_OAUTH_JWKS_URI`, `LETTER_IRL_OAUTH_AUTH_ENDPOINT`, `LETTER_IRL_OAUTH_TOKEN_ENDPOINT` - the Auth0 tenant. Letter IRL publishes only protected-resource metadata in normal CIMD mode.
- `LETTER_IRL_MCP_RESOURCE` / `LETTER_IRL_OAUTH_AUDIENCE` - the same environment-specific HTTPS `/mcp` URL, which is also the Auth0 API identifier the website uses.
- `LETTER_IRL_OAUTH_SCOPES` - identity scopes plus `mail:read`, `mail:draft`, `mail:send`.
- `LETTER_IRL_OAUTH_ALLOWED_ALGORITHMS` - must be `RS256`.
- `LETTER_IRL_OAUTH_CIMD_ENFORCEMENT` - validates the OAuth configuration at boot; production refuses to start unless it is `true`.
- `LETTER_IRL_DEPLOYMENT_ENVIRONMENT` with `LETTER_IRL_OAUTH_PROD_ISSUER` / `LETTER_IRL_OAUTH_DEV_ISSUER` - prevent development/production tenant crossover at startup.
- `LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY` / `CHATGPT_STATIC_CLIENT_ID` - environment-specific rollback only; off in normal CIMD mode.
- `LETTER_IRL_DEFAULT_USER_ID` - fallback user ID when authentication is disabled locally.

See [docs/auth0-setup.md](docs/auth0-setup.md) for the ChatGPT/Auth0 architecture.
