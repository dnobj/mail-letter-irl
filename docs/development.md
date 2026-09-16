# Development Guide

**Last Updated:** September 16, 2026
**Purpose:** Context, local setup, workflow, and common tasks for developers and AI agents

This document provides context for developers and AI agents working on Letter IRL.

---

## Project Overview

Letter IRL is an MCP (Model Context Protocol) server that enables AI assistants to send real, physical letters. It integrates with:
- **Auth0** for authentication (OAuth 2.1)
- **Stripe** for payments
- **PostGrid** for letter fulfillment
- **Neon** for PostgreSQL database

### Repositories

Both repositories use the same branching strategy: `feature/*` → `dev` → `main/master`

| Repo | Purpose | Deployed To |
|------|---------|-------------|
| `letter-irl` | MCP server (this repo) | Railway → api.letterirl.com |
| `letter-irl-website` | Marketing site + dashboard | Railway → letterirl.com |

---

## Development Environment Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  PRODUCTION                                                      │
├─────────────────────────────────────────────────────────────────┤
│  Git Branch: master (API) / main (Website)                       │
│  Auth0: dev-njmdyqf8n25rqgy7.us.auth0.com (prod tenant)         │
│         Account: dnicholl@letterirl.com                          │
│  Neon: production branch                                         │
│  Railway API: api.letterirl.com                                  │
│  Railway Website: letterirl.com                                  │
│  Stripe: live mode                                               │
│  PostGrid: live mode                                             │
└─────────────────────────────────────────────────────────────────┘
           │
           │ code promotion only; no data flows this way
           ▼
┌─────────────────────────────────────────────────────────────────┐
│  DEVELOPMENT                                                     │
├─────────────────────────────────────────────────────────────────┤
│  Git Branch: dev (both repos)                                    │
│  Auth0: dev-ky21dxn3qmi71hjl.us.auth0.com (dev tenant)          │
│         Account: dnicholl@objective.works                        │
│  Neon: dev branch (independent; never copied from production)   │
│  Railway API: letter-irl-api-development.up.railway.app          │
│  Railway Website: mail-letter-irl-website-development...        │
│  Stripe: test mode                                               │
│  PostGrid: test mode                                             │
└─────────────────────────────────────────────────────────────────┘
```

### Git Branching Strategy

Both repositories (`letter-irl` and `letter-irl-website`) use the same strategy:

```
master/main (production) ──────────────────────────────
    └── dev (development) ────────────────────────
            └── feature/issue-xxx
            └── feature/issue-yyy
```

- **master/main**: Production code, auto-deploys to production Railway environment
- **dev**: Development code, auto-deploys to Railway dev environment
- **feature/\***: Feature branches, created from `dev`, merged back to `dev`

### Environment Differences

| Aspect | Production | Development |
|--------|------------|-------------|
| Git Branch (API) | `master` | `dev` |
| Git Branch (Website) | `main` | `dev` |
| Auth0 Tenant | `dev-njmdyqf8n25rqgy7` (dnicholl@letterirl.com) | `dev-ky21dxn3qmi71hjl` (dnicholl@objective.works) |
| Neon Branch | `production` | `dev` (independent; never copied from production) |
| Stripe Mode | Live (`sk_live_`) | Test (`sk_test_`) |
| PostGrid | Live (real mail) | Test mode (no real mail) |
| Admin Panel | `letter-irl-admin-prod` (tailnet-only) | `letter-irl-admin` (tailnet-only) |
| API URL | `api.letterirl.com` | `letter-irl-api-development.up.railway.app` |
| Website URL | `letterirl.com` | `mail-letter-irl-website-development.up.railway.app` |

---

## Development Environment Setup

### Prerequisites

- Node.js 22
- npm
- Auth0 CLI (`npm install -g auth0-cli`)
- Stripe CLI (`brew install stripe/stripe-cli/stripe`)
- Neon CLI (`npm install -g neonctl`) - optional

### 1. Use Existing Auth0 Development Tenant

The development tenant is already configured:
- **Tenant**: `dev-ky21dxn3qmi71hjl.us.auth0.com`
- **Account**: dnicholl@objective.works
- **Connections**: Google, Microsoft, Apple, GitHub, Username-Password
- **DCR**: Enabled today (Settings → Advanced → OIDC Dynamic Application Registration). It should be off: DCR is rollback inventory only
- **MCP API**: `https://letter-irl-api-development.up.railway.app/mcp`, also the website's audience
- **Website Client ID**: `ZQF6j9WoG0097thWKnCJwNyeJZtUlqOX`

If you need to configure a new development tenant, follow these steps:
1. Go to [Auth0](https://auth0.com) and create a new tenant
2. Configure connections (same as production): Google, Microsoft, Apple, GitHub, Username-Password
3. Enable Client ID Metadata Document registration: Settings → Advanced (leave DCR off)
4. Create the MCP API: identifier = the environment's canonical `/mcp` URL, permissions `mail:read`, `mail:draft`, `mail:send`
5. Set Default Audience to that API: Settings → General → API Authorization Settings
6. Create a Regular Web Application for the website, and authorize it for the MCP API with all three permissions

### 2. Create Neon Development Branch

1. Go to [Neon Console](https://console.neon.tech/)
2. Navigate to your project → Branches
3. Create a new, empty branch named `dev`. Do not branch it from production: development never holds a
   copy of production data (see [Development data](#development-data))
4. Run `npm run db:migrate` against it, then copy the pooled connection string

### 3. Configure Environment

```bash
cp .env.dev.example .env.dev
# Edit .env.dev with your values
```

### 4. Create Stripe Test Products

```bash
stripe products list --limit=20  # Check if they exist
# If not, create them via Stripe CLI or dashboard
stripe prices list --limit=10    # Get price IDs for .env.dev
```

### 5. Run Development Server

```bash
# With dev environment config
npm run dev:env

# Or standard dev mode
npm run dev
```

---

## Development data

Development does not receive a copy of production. The `dev:sync` command was
removed on 2026-09-13: it recreated the dev Neon branch from production and
imported production Auth0 users into the development tenant, so development held
every letter, recipient address and customer record production held, and running
it needed production credentials on a workstation. Seed dev from fixtures or
work against an empty branch.

### User ID Strategy

Social login users (Google, GitHub, etc.) automatically have matching IDs across
tenants because the ID comes from the provider, so a subject created in one
tenant is recognisable in the other with no import.

Username-Password users (`auth0|xxx`) do not match across tenants. That is
accepted: create a test account in the development tenant instead of importing a
production one.

---

## Local Setup

### Prerequisites

- Node.js 22
- PostgreSQL (or use Neon cloud)
- Stripe CLI (for webhook testing)

### Environment Variables

Copy `.env.example` to `.env` and configure:

**Production (.env):**
```bash
# Database (production branch)
DATABASE_URL=postgres://...

# Auth0 (production tenant)
LETTER_IRL_OAUTH_ISSUER=https://dev-njmdyqf8n25rqgy7.us.auth0.com/
LETTER_IRL_OAUTH_JWKS_URI=https://dev-njmdyqf8n25rqgy7.us.auth0.com/.well-known/jwks.json
LETTER_IRL_MCP_RESOURCE=https://api.letterirl.com/mcp
LETTER_IRL_OAUTH_AUDIENCE=https://api.letterirl.com/mcp

# Stripe (live mode)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Mail provider (live mode)
# NOTE: the variable is LETTER_PROVIDER_API_KEY. POSTGRID_API_KEY satisfies no
# validator rule - provider.api_key_required checks LETTER_PROVIDER_API_KEY.
LETTER_PROVIDER=postgrid
LETTER_PROVIDER_API_KEY=live_sk_...
LETTER_PROVIDER_CONFIG={"mode":"live"}

# Required in production or the boot is refused
LETTER_IRL_DEPLOYMENT_ENVIRONMENT=production
LETTER_IRL_ALLOWED_HOSTS=<comma-separated public hostnames>
LETTER_IRL_ALLOWED_ORIGINS=<comma-separated allowed origins>
```

This block is illustrative, not exhaustive. `docs/railway-setup.md` carries the
full production variable list, and **Boot validation rules** in
`docs/deployment.md` names every rule a missing entry can trip.

**Development (.env):**
```bash
# Database (dev branch)
DATABASE_URL=postgres://...?options=branch%3Ddev

# Auth0 (dev tenant)
LETTER_IRL_OAUTH_ISSUER=https://dev-ky21dxn3qmi71hjl.us.auth0.com/
LETTER_IRL_OAUTH_JWKS_URI=https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/jwks.json
LETTER_IRL_MCP_RESOURCE=https://letter-irl-api-development.up.railway.app/mcp
LETTER_IRL_OAUTH_AUDIENCE=https://letter-irl-api-development.up.railway.app/mcp

# Stripe (test mode)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# PostGrid (dummy provider)
LETTER_PROVIDER=dummy
```

### Running Locally

```bash
# Install dependencies
npm install

# Run database migrations
npm run db:migrate

# Start the server (development mode with hot reload)
npm run dev

# Server runs on http://localhost:8090 by default
# (PORT or LETTER_IRL_HTTP_PORT override it; .env.example sets 8788)
```

### Running Tests

```bash
# Run all tests
npm run test:run

# Run in watch mode
npm test

# Run with coverage
npm run test:coverage

# Everything CI's first job runs: lint, build, unit, submission
npm run verify

# The PostgreSQL suites against a local database (CI's second job)
npm run test:integration:local
```

See [testing.md](testing.md) for the suites and their guards.

---

## Git Workflow

We use a **dev branch workflow** for testing before production.

### Branch Naming

```
feature/issue-xxx           # New features (include issue number)
fix/issue-xxx               # Bug fixes
docs/update-readme          # Documentation
refactor/credit-service     # Code improvements
```

### Workflow

1. **Create a feature branch** from `dev`:
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b feature/issue-xxx
   ```

2. **Make changes** and commit:
   ```bash
   git add .
   git commit -m "feat: Add feature X"
   ```

3. **Push and create PR to dev**:
   ```bash
   git push -u origin feature/issue-xxx
   gh pr create --base dev --title "Add feature X" --body "Description..."
   ```

4. **Merge to dev** - Triggers Railway dev environment deploy

5. **Test in dev environment** - Verify feature works

6. **Create PR from dev to master** - When ready for production
   ```bash
   gh pr create --base master --head dev --title "Release: Feature X"
   ```

7. **Merge to master** - Triggers production deploy

### Commit Messages

Format: `<type>: <description>`

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation
- `refactor:` Code refactoring
- `test:` Adding tests
- `chore:` Maintenance

---

## Project Structure

```
letter-irl/
├── src/
│   ├── admin/         # Tailnet-only operator panel (separate Railway service)
│   ├── api/           # REST API handlers and middleware
│   ├── auth/          # Token validation, scopes, beta access
│   ├── cli/           # migrate, runMaintenance, flow harness
│   ├── config/        # Deployment validation, product/price table
│   ├── content/       # Shared delivery wording
│   ├── contracts/     # Shared types and output-schema conformance
│   ├── db/            # Connection pool and Neon wake-up retry
│   ├── logging/       # Structured logger
│   ├── mcp/           # HTTP/stdio servers, tool and widget registration, manifest
│   ├── services/      # Business logic and the SQL that goes with it
│   ├── store/         # Account store used by the tool registry
│   ├── tools/         # MCP tool implementations
│   ├── utils/         # Diagnostics, env parsing, backoff
│   └── workers/       # Daily maintenance and compatibility wrappers
├── db/
│   └── migrations/    # Forward-only SQL migrations (001_ ... 032_)
├── tests/
│   ├── fixtures/      # Test data (personas, credits, letters, postcards, promos, tokens, admin)
│   ├── integration/   # Real-PostgreSQL suites (opt-in locally, always in CI)
│   ├── mocks/         # Database mocks
│   └── unit/          # Unit tests, grouped by subsystem
├── widgets/           # Apps SDK widget HTML
└── docs/              # Documentation
```

---

## Key Documentation

| Document | Purpose |
|----------|---------|
| [personas.md](personas.md) | User archetypes (Sarah, Marcus, Morgan, etc.) |
| [user-stories.md](user-stories.md) | Feature specs with acceptance criteria |
| [database-schema.md](database-schema.md) | Database structure |
| [letter-send-flow.md](letter-send-flow.md) | Letter sending implementation |
| [status.md](status.md) | Project status overview |

---

## Testing Conventions

### Test File Location

Tests mirror source structure:
- `src/services/creditLedgerService.ts` → `tests/unit/services/creditLedgerService.test.ts`

### Test Structure

```typescript
/**
 * Unit tests for [ServiceName]
 *
 * User Stories Covered:
 * - US-X.X: Story title
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('serviceName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('functionName', () => {
    it('should do expected behavior', async () => {
      // Arrange
      // Act
      // Assert
    });
  });
});
```

### Fixtures

Use test fixtures from `tests/fixtures/`:
- `users.ts` - Test users (Sarah, Marcus, Morgan, Jordan, etc.)
- `credits.ts` - Credit ledger entries
- `tokens.ts` - Personal access tokens
- `letters.ts` - Letter test data

---

## Database

### Migrations

Migrations are in `db/migrations/` with numeric prefixes:

```bash
# Run pending migrations
npm run db:migrate

# Prints the last applied migration and recovery guidance; it does not roll anything back
npm run db:migrate:rollback
```

### Creating a Migration

1. Create file: `db/migrations/NNN_description.sql`
2. Write the SQL. It runs inside one transaction with every other pending file, and while the
   previous image is still serving, so it must be safe for the code already deployed
3. Run migration: `npm run db:migrate`
4. Update `docs/database-schema.md` if schema changed

[db/README.md](../db/README.md) has the constraints (no `CONCURRENTLY`, never edit an applied file,
destructive changes take two deploys).

### Recovering from a bad migration

Migrations are forward-only; no migration file carries a down section. To undo a change, write a new
migration that reverses it. If data was damaged, restore from a Neon point-in-time branch. A failed
migration rolls back as a whole, and Railway keeps the previous image serving.

---

## Deployment

### Environments

| Environment | URL | Branch | Auto-deploy |
|-------------|-----|--------|-------------|
| Production | api.letterirl.com | `master` | Yes |
| Development | letter-irl-api-development.up.railway.app | `dev` | Yes |

### Railway Configuration

**Production Environment:**
- API Branch: `master`
- Website Branch: `main`
- API URL: `api.letterirl.com`
- Website URL: `letterirl.com`
- All production credentials (live Stripe, live PostGrid)
- Public admin routes return 404; operators use `letter-irl-admin-prod` over the tailnet

**Development Environment:**
- API Branch: `dev`
- Website Branch: `dev`
- API URL: `https://letter-irl-api-development.up.railway.app`
- Website URL: `https://mail-letter-irl-website-development.up.railway.app`
- Test credentials (test Stripe, PostGrid test mode)
- Public admin routes return 404; operators use `letter-irl-admin` over the tailnet

### Environment Variables on Railway

Production and development environments have different values:
- Different Auth0 tenants
- Different Neon branches
- Different Stripe modes (live vs test)
- Different PostGrid modes (live vs test)

---

## Common Tasks

### Adding a New MCP Tool

1. Create the tool in `src/tools/myTool.ts` and export it from `src/tools/index.ts`
2. Add it to the `tools` array in `src/server.ts`
3. Add its Zod input and output shapes to `src/zodSchemas.ts` and to both maps in
   `src/mcp/registerTools.ts`. **A tool missing from those maps is silently not registered**, and
   these shapes are what ChatGPT receives
4. Add its JSON schemas to `src/schemas.ts` (the manifest is generated from these) and its input schema
   to `src/mcp/toolSchemas.ts`
5. Add tests in `tests/unit/tools/myTool.test.ts`
6. Run `npm run manifest:generate` and `npm run test:submission`, and update
   [tool-apis.md](tool-apis.md)

### Adding an API Endpoint

1. Add handler in `src/api/` (or extend existing handler)
2. Register the route in `src/mcp/httpServer.ts`, add a new route family to `REST_API_PREFIXES` there so
   it is request-logged, and put it behind a rate limiter like its neighbours
3. Give it the scope its MCP twin requires (`src/auth/restScopes.ts`)
4. Add tests

### Adding a Database Table

1. Create migration in `db/migrations/`
2. Run `npm run db:migrate`
3. Update `database-schema.md`
4. Add queries in the service that owns the table (`src/services/`); admin read models live in
   `src/admin/queries/`
5. If operators should see it, decide its admin reader grants (`src/admin/provisioning.ts`)

---

## Troubleshooting

### Common Issues

**"Authentication is not configured on this server"** (503 from the REST routes and `/mcp`; checkout says "Authentication is not configured")
- Each refused request logs `auth.validation_not_configured`
- Check `LETTER_IRL_OAUTH_ISSUER` and `LETTER_IRL_OAUTH_JWKS_URI` are set
- Check `LETTER_IRL_OAUTH_AUDIENCE` names exactly one audience, the MCP resource

**"Stripe webhook signature verification failed"**
- Ensure `STRIPE_WEBHOOK_SECRET` matches your webhook endpoint
- For local testing, use Stripe CLI: `stripe listen --forward-to localhost:8090/webhooks/stripe`

**Database connection errors**
- Check `DATABASE_URL` is correct
- For Neon: ensure SSL is enabled (`?sslmode=require`)

### Logs

```bash
# Railway production logs
railway logs

# Local development
npm run dev  # Logs to stdout
```

---

## Code Style

- TypeScript strict mode
- ESLint + Prettier configured
- Run `npm run lint` before committing

### Conventions

- Use `async/await` over raw promises
- Prefer explicit return types on exported functions
- Use Zod for runtime validation
- Business logic and its SQL live in `src/services/`; `src/db/` holds only the pool and `query`/`transaction` helpers

---

## Security Notes

- Never commit `.env` files
- Legacy public admin routes are forced off in every environment; `ADMIN_ENABLED=true` fails startup.
  The operator panel is a separate tailnet-only service (`docs/admin-panel-guide.md`)
- All MCP tools require authentication
- Stripe webhooks verified via signature
- PostGrid API key is test mode in development
