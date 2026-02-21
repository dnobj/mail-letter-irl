# Environment Configuration Files

This document describes all environment configuration files used in the Letter IRL project.

## Quick Reference

| File | Purpose | Command |
|------|---------|---------|
| `.env` | Production config (Railway) | `npm start` |
| `.env.admin` | Admin panel (prod DB) | `npm run admin` |
| `.env.admin.dev` | Admin panel (dev DB) | `npm run admin:dev` |
| `.env.dev` | Development server | `npm run dev:env` |
| `.env.local` | Local overrides | `npm run dev:local` |
| `.env.test` | Test database | `npm test` |

## File Details

### `.env` - Production Configuration

Main configuration file used by Railway deployment. Contains:
- Production Neon database URL
- Production Auth0 tenant credentials
- Live Stripe keys
- PostGrid API keys
- Production CORS/host settings

**Used by:** `npm start`, Railway deployment

**Never commit:** This file contains secrets and is gitignored.

---

### `.env.admin` - Admin Panel (Production)

Minimal config for running the admin panel locally against the **production** database.

```bash
npm run admin
# Visit http://localhost:8788/admin
```

**Key settings:**
- `ADMIN_ENABLED=true` - Enables admin routes
- `ADMIN_LOCAL_ONLY=true` - Restricts access to localhost
- `DISABLE_WORKERS=true` - Prevents competing with Railway workers
- `DATABASE_URL` - Production Neon database

**Use case:** View production data, manually trigger syncs, debug issues.

---

### `.env.admin.dev` - Admin Panel (Development)

Same as `.env.admin` but connects to the **development** Neon branch.

```bash
npm run admin:dev
# Visit http://localhost:8788/admin
```

**Key settings:**
- `DATABASE_URL` - Neon **dev branch** connection string
- `LETTER_PROVIDER_API_KEY` - PostGrid test key (for status sync)

**Use case:** Test admin features, sync dev letter statuses, verify dashboard changes.

---

### `.env.dev` - Development Server

Full development configuration for running the complete server locally.

```bash
npm run dev:env
```

**Key settings:**
- Neon dev branch database
- Auth0 dev tenant (separate from production)
- Stripe test mode keys (`sk_test_...`)
- Dummy letter provider (no real mail sent)
- Workers enabled
- Optional `DEBUG=true` to enable extra diagnostics (defaults to false when unset)

**Use case:** Local development with full functionality.

---

### `.env.local` - Local Overrides

Lightweight file for quick local testing with minimal config.

```bash
npm run dev:local
```

**Use case:** Quick iteration without full dev setup.

---

### `.env.test` - Test Database

Configuration for running automated tests.

```bash
npm test
npm run test:run
```

**Key settings:**
- Test database URL
- Mocked external services

**Use case:** Vitest unit and integration tests.

---

## Example Files

Each environment file has a corresponding `.example` template:

| Template | Copy to |
|----------|---------|
| `.env.example` | `.env` |
| `.env.admin.example` | `.env.admin` |
| `.env.dev.example` | `.env.dev` |
| `.env.test.example` | `.env.test` |

## Database Branches

Letter IRL uses [Neon PostgreSQL branching](https://neon.tech/docs/introduction/branching):

| Branch | Purpose | Used By |
|--------|---------|---------|
| `production` | Live user data | `.env`, `.env.admin` |
| `dev` | Development/testing | `.env.dev`, `.env.admin.dev` |

### Sync Dev from Production

To refresh the dev branch with production data:

```bash
npm run dev:sync
```

This script:
1. Deletes the existing dev branch
2. Creates a new dev branch from production
3. Exports/imports Auth0 users (preserving user IDs)

---

## Common Tasks

### Run Admin Panel Against Dev Database

```bash
npm run admin:dev
# Open http://localhost:8788/admin
```

### Trigger PostGrid Status Sync (Dev)

```bash
# Start admin server
npm run admin:dev

# In another terminal, or via browser:
curl -X POST http://localhost:8788/api/admin/sync/statuses
```

### Switch Between Production and Dev Admin

```bash
# Production database
npm run admin

# Development database
npm run admin:dev
```

---

## Security Notes

1. **Never commit `.env` files** - All are gitignored
2. **Use `.example` templates** - Safe to commit, contain no secrets
3. **Admin is localhost-only** - `ADMIN_LOCAL_ONLY=true` blocks remote access
4. **Separate Auth0 tenants** - Dev and prod users are isolated
5. **Stripe test keys** - Dev uses `sk_test_*`, prod uses `sk_live_*`

---

## Related Documentation

- [Infrastructure Setup](infrastructure.md) - External service configuration
- [Admin Panel Guide](admin-panel-guide.md) - Admin dashboard features
- [Development Guide](development.md) - Local development workflow
