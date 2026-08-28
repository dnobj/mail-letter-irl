# Environment Configuration Files

This document describes all environment configuration files used in the Letter IRL project.

## Quick Reference

| File | Purpose | Command |
|------|---------|---------|
| `.env` | Production config (Railway) | `npm start` |
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

### Local admin configuration

`.env.admin` and `.env.admin.dev` are unsupported. Public admin routes are forced off, and
`ADMIN_ENABLED=true` fails public-server startup. Never store a production database URL or an admin role
credential in a workstation `.env` file.

The approved local operator runtime will read non-secret JSON from
`%LOCALAPPDATA%/LetterIRL/admin/<environment>.json` and retrieve credentials from an approved vault. Slice
1 provides strict parsing and a grant-provisioning command, but no local browser server or UI.

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

`.env.dev` is a local-development file, not the source of truth for deployed
development credentials. It may still contain template or stale values. For
operations against the deployed development environment (including database
migrations), use the `letter-irl-api` variables from Railway's `development`
environment. Verify the Railway environment, pooled Neon hostname, and current
migration ledger before making changes. If `.env.dev` fails validation, never
fall back to `.env` or any production credential, and never persist a retrieved
Railway secret into the repository.

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
| `.env.admin.example` | Legacy tombstone; do not copy |
| `.env.dev.example` | `.env.dev` |
| `.env.test.example` | `.env.test` |

## Database Branches

Letter IRL uses [Neon PostgreSQL branching](https://neon.tech/docs/introduction/branching):

| Branch | Purpose | Used By |
|--------|---------|---------|
| `production` | Live user data | Railway `.env` only; no workstation admin `.env` |
| `dev` | Development/testing | `.env.dev` for the public development server |

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

### Local admin status

There is no supported local admin browser workflow until issue #162 slices 2 and 3 land. Do not use the
legacy page or `/api/admin` handlers. Database grant provisioning is a separate, explicit operation; see
[admin-panel-guide.md](admin-panel-guide.md).

---

## Security Notes

1. **Never commit `.env` files** - All are gitignored
2. **Use `.example` templates** - Safe to commit, contain no secrets
3. **Legacy admin is disabled** - public admin routes return 404 in every environment
4. **Separate Auth0 tenants** - Dev and prod users are isolated
5. **Stripe test keys** - Dev uses `sk_test_*`, prod uses `sk_live_*`

---

## Related Documentation

- [Infrastructure Setup](infrastructure.md) - External service configuration
- [Admin Panel Guide](admin-panel-guide.md) - Admin dashboard features
- [Development Guide](development.md) - Local development workflow
