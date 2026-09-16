# Environment Configuration Files

**Last Updated:** September 16, 2026
**Purpose:** Every `.env` file used locally, what reads it, and what must never go in one

This document describes all environment configuration files used in the Letter IRL project.

## Quick Reference

| File | Purpose | Command |
|------|---------|---------|
| `.env` | Production config (Railway) | `npm start` |
| `.env.dev` | Development server | `npm run dev:env` |
| `.env.local` | Local overrides | `npm run dev:local` |
| `.env.test` | Test settings, loaded by `tests/setup.ts` | `npm test` |
| `.env.admin.local` | Local admin panel (development reader role only) | `npm run admin:dev` |
| `.env.integration.local` | Local PostgreSQL URLs for the integration suites | `npm run test:integration:local` |

## File Details

### `.env` - Local Server Configuration

Read by `npm start` and `npm run dev` through `dotenv`. Railway does **not** use a `.env` file; each
service's variables are set in Railway ([railway-setup.md](railway-setup.md)). Copy `.env.example`
and point it at a development database, test-mode Stripe keys and a test or dummy mail provider.
Never put production credentials in a workstation `.env`.

**Used by:** `npm start`, `npm run dev`

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
| `.env.admin.example` | `.env.admin.local` |
| `.env.dev.example` | `.env.dev` |
| `.env.test.example` | `.env.test` |

## Database Branches

Letter IRL uses [Neon PostgreSQL branching](https://neon.tech/docs/introduction/branching):

| Branch | Purpose | Used By |
|--------|---------|---------|
| `production` | Live user data | Railway service variables only; never a workstation file |
| `dev` | Development/testing | `.env.dev` for the public development server |

### Do not copy production into dev

There is no prod-to-dev sync. The `dev:sync` script that used to live here
recreated the dev Neon branch from production and imported production Auth0
users into the development tenant, which needed a production Neon API key and a
production Auth0 Management API secret in a workstation `.env.dev` - the exact
thing the rule above forbids. It also made development, where authentication can
be relaxed and the dummy provider is normal, hold a copy of every letter,
recipient address and customer record in production.

The Auth0 applications it authenticated as no longer have Management API access
(revoked 2026-09-14). If a workstation `.env.dev` still holds
`AUTH0_PROD_CLIENT_ID`, `AUTH0_PROD_CLIENT_SECRET`, `AUTH0_DEV_CLIENT_ID` or
`AUTH0_DEV_CLIENT_SECRET`, delete those lines.

Seed development from fixtures, or work against an empty dev branch created in
the Neon console. If a production-shaped dataset is ever genuinely needed, build
it from anonymised data rather than copying the real one.

---

## Common Tasks

### Local admin panel

Copy `.env.admin.example` to `.env.admin.local`, fill in the development reader URL and a session
secret, and run `npm run admin:dev`. The panel starts in `local-dev` mode on `http://localhost:8790`
and refuses that mode on Railway, under `NODE_ENV=production`, and outside the development
environment. Database grant provisioning is a separate, explicit operation; see
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
- [Admin Panel Guide](admin-panel-guide.md) - Operator panel setup and features
- [Development Guide](development.md) - Local development workflow
