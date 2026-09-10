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

### Admin panel configuration

`.env.admin` and `.env.admin.dev` are unsupported. Public admin routes are forced off, and
`ADMIN_ENABLED=true` fails public-server startup. The admin panel is a separate tailnet-only Railway
service configured by its own variables ([admin-panel-guide.md](admin-panel-guide.md)); for local
development copy `.env.admin.example` to `.env.admin.local` (git-ignored) and run `npm run admin:dev`.
Never store a production database URL or an admin role credential in a workstation `.env` file.

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
