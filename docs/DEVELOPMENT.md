# Development Guide

**Last Updated:** December 15, 2025

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

We use **GitHub Flow** - simple branch-based workflow.

### Branch Naming

```
feature/add-pat-support     # New features
fix/address-validation      # Bug fixes
docs/update-readme          # Documentation
refactor/credit-service     # Code improvements
```

### Workflow

1. **Create a branch** from `main`:
   ```bash
   git checkout main
   git pull
   git checkout -b feature/my-feature
   ```

2. **Make changes** and commit:
   ```bash
   git add .
   git commit -m "Add feature X"
   ```

3. **Push and create PR**:
   ```bash
   git push -u origin feature/my-feature
   gh pr create --title "Add feature X" --body "Description..."
   ```

4. **PR Review** - Railway creates preview environment automatically

5. **Merge to main** - Triggers production deploy

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
| [PERSONAS.md](PERSONAS.md) | User archetypes (Sarah, Marcus, Morgan, etc.) |
| [USER-STORIES.md](USER-STORIES.md) | Feature specs with acceptance criteria |
| [DATABASE-SCHEMA.md](DATABASE-SCHEMA.md) | Database structure |
| [LETTER-SEND-FLOW.md](LETTER-SEND-FLOW.md) | Letter sending implementation |
| [STATUS.md](STATUS.md) | Project status overview |

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
4. Update `DATABASE-SCHEMA.md` if needed

---

## Deployment

### Environments

| Environment | URL | Branch | Auto-deploy |
|-------------|-----|--------|-------------|
| Production | api.letterirl.com | `main` | Yes |
| PR Preview | *.up.railway.app | PR branches | Yes |

### Railway Configuration

- Service: `letter-irl`
- Build: Nixpacks (auto-detected)
- Start: `npm start`
- Health check: `/health`

### Environment Variables on Railway

Same as local, but with production values. Secrets managed in Railway dashboard.

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
3. Update `DATABASE-SCHEMA.md`
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
