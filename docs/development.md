# Development Guide

**Last Updated:** December 18, 2025

This document provides context for developers and AI agents working on Letter IRL.

---

## Project Overview

Letter IRL is an MCP (Model Context Protocol) server that enables AI assistants to send real, physical letters. It integrates with:
- **Auth0** for authentication (OAuth 2.1)
- **Stripe** for payments
- **PostGrid** for letter fulfillment
- **Neon** for PostgreSQL database

### Repositories

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
│  Git Branch: master                                              │
│  Auth0: dev-ky21dxn3qmi71hjl.us.auth0.com                       │
│  Neon: main branch                                               │
│  Railway: api.letterirl.com                                      │
│  Stripe: live mode                                               │
│  PostGrid: live mode                                             │
└─────────────────────────────────────────────────────────────────┘
           │
           │ npm run dev:sync
           ▼
┌─────────────────────────────────────────────────────────────────┐
│  DEVELOPMENT                                                     │
├─────────────────────────────────────────────────────────────────┤
│  Git Branch: dev                                                 │
│  Auth0: letter-irl-dev.us.auth0.com (separate tenant)           │
│  Neon: dev branch (copy of production)                          │
│  Railway: letter-irl-dev-xxx.up.railway.app                     │
│  Stripe: test mode                                               │
│  PostGrid: dummy provider                                        │
└─────────────────────────────────────────────────────────────────┘
```

### Git Branching Strategy

```
master (production) ──────────────────────────────
    └── dev (development) ────────────────────────
            └── feature/issue-xxx
            └── feature/issue-yyy
```

- **master**: Production code, auto-deploys to `api.letterirl.com`
- **dev**: Development code, auto-deploys to Railway dev environment
- **feature/\***: Feature branches, created from `dev`, merged back to `dev`

### Environment Differences

| Aspect | Production | Development |
|--------|------------|-------------|
| Git Branch | `master` | `dev` |
| Auth0 Tenant | `dev-ky21dxn3qmi71hjl` | `letter-irl-dev` |
| Neon Branch | `main` | `dev` |
| Stripe Mode | Live (`sk_live_`) | Test (`sk_test_`) |
| PostGrid | Live (real mail) | Dummy (no mail) |
| Admin Routes | Disabled | Enabled |
| URL | `api.letterirl.com` | `xxx.up.railway.app` |

---

## Development Environment Setup

### Prerequisites

- Node.js 20+
- npm
- Auth0 CLI (`npm install -g auth0-cli`)
- Stripe CLI (`brew install stripe/stripe-cli/stripe`)
- Neon CLI (`npm install -g neonctl`) - optional

### 1. Create Auth0 Development Tenant

1. Go to [Auth0](https://auth0.com) and create a new tenant: `letter-irl-dev`
2. Configure connections (same as production): Google, Microsoft, Apple, GitHub, Username-Password
3. Enable DCR: Settings → Advanced → OIDC Dynamic Application Registration
4. Create API: `https://letter-irl-dev/api`
5. Set Default Audience: Settings → General → API Authorization Settings
6. Create M2M Application for sync script with Management API access

### 2. Create Neon Development Branch

1. Go to [Neon Console](https://console.neon.tech/)
2. Navigate to your project → Branches
3. Create new branch: `dev` from `main`
4. Copy the connection string

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

## Syncing from Production

The `dev:sync` command refreshes development from production:

```bash
npm run dev:sync
```

This performs:
1. Recreates Neon dev branch from main
2. Exports Username-Password users from production Auth0
3. Imports users to development Auth0 (preserving user_ids)

### User ID Strategy

Social login users (Google, GitHub, etc.) automatically have matching IDs across tenants because the ID comes from the provider.

Username-Password users (`auth0|xxx`) need to be imported to preserve IDs.

---

## Local Setup

### Prerequisites

- Node.js 20+
- PostgreSQL (or use Neon cloud)
- Stripe CLI (for webhook testing)

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Database
DATABASE_URL=postgres://...

# Auth0
LETTER_IRL_OAUTH_ISSUER=https://letterirl.auth0.com/
LETTER_IRL_OAUTH_JWKS_URI=https://letterirl.auth0.com/.well-known/jwks.json
LETTER_IRL_OAUTH_AUDIENCE=https://api.letterirl.com

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# PostGrid
POSTGRID_API_KEY=test_...
```

### Running Locally

```bash
# Install dependencies
npm install

# Run database migrations
npm run db:migrate

# Start the server (development mode with hot reload)
npm run dev

# Server runs on http://localhost:3000
```

### Running Tests

```bash
# Run all tests
npm run test:run

# Run in watch mode
npm test

# Run with coverage
npm run test:coverage
```

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
│   ├── api/           # REST API handlers
│   ├── auth/          # Token validation
│   ├── db/            # Database queries
│   ├── mcp/           # MCP server (httpServer.ts, stdioServer.ts)
│   ├── services/      # Business logic
│   ├── tools/         # MCP tool implementations
│   └── workers/       # Background jobs
├── db/
│   └── migrations/    # SQL migrations (001_, 002_, etc.)
├── tests/
│   ├── fixtures/      # Test data
│   ├── mocks/         # Database mocks
│   └── unit/          # Unit tests
├── docs/              # Documentation
└── public/            # Static files (admin panel)
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

# Rollback last migration
npm run db:migrate:rollback
```

### Creating a Migration

1. Create file: `db/migrations/007_description.sql`
2. Write SQL (include both up and rollback sections)
3. Run migration
4. Update `database-schema.md` if needed

---

## Deployment

### Environments

| Environment | URL | Branch | Auto-deploy |
|-------------|-----|--------|-------------|
| Production | api.letterirl.com | `master` | Yes |
| Development | xxx.up.railway.app | `dev` | Yes |

### Railway Configuration

**Production Environment:**
- Branch: `master`
- URL: `api.letterirl.com`
- All production credentials (live Stripe, live PostGrid)

**Development Environment:**
- Branch: `dev`
- URL: obscure Railway URL
- Test credentials (test Stripe, dummy PostGrid)
- Admin routes enabled

### Environment Variables on Railway

Production and development environments have different values:
- Different Auth0 tenants
- Different Neon branches
- Different Stripe modes (live vs test)
- Different PostGrid modes (live vs dummy)

---

## Common Tasks

### Adding a New MCP Tool

1. Create tool in `src/tools/myTool.ts`
2. Register in `src/mcp/httpServer.ts`
3. Add tests in `tests/unit/tools/myTool.test.ts`
4. Update tool documentation

### Adding an API Endpoint

1. Add handler in `src/api/` (or extend existing handler)
2. Register route in `src/mcp/httpServer.ts`
3. Add tests

### Adding a Database Table

1. Create migration in `db/migrations/`
2. Run `npm run db:migrate`
3. Update `database-schema.md`
4. Add queries in `src/db/`

---

## Troubleshooting

### Common Issues

**"OAuth validation not configured"**
- Check `LETTER_IRL_OAUTH_ISSUER` and `LETTER_IRL_OAUTH_JWKS_URI` are set

**"Stripe webhook signature verification failed"**
- Ensure `STRIPE_WEBHOOK_SECRET` matches your webhook endpoint
- For local testing, use Stripe CLI: `stripe listen --forward-to localhost:3000/api/stripe/webhook`

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
- Database queries in `src/db/`, business logic in `src/services/`

---

## Security Notes

- Never commit `.env` files
- Admin routes are disabled in production (`ADMIN_ENABLED=false`)
- All MCP tools require authentication
- Stripe webhooks verified via signature
- PostGrid API key is test mode in development
