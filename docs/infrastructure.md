# Infrastructure Overview

This document provides a central reference for all services and infrastructure used by Letter IRL.

## System Architecture

### Production Environment

```
┌─────────────────────────────────────────────────────────────────────┐
│                           USER INTERFACES                            │
├─────────────────┬─────────────────┬─────────────────────────────────┤
│   ChatGPT       │   Website       │   Admin Panel                   │
│   (MCP Client)  │   (Next.js)     │   (Static HTML/JS)              │
│                 │   letterirl.com │                                 │
└────────┬────────┴────────┬────────┴────────────────┬────────────────┘
         │                 │                          │
         ▼                 ▼                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   MCP SERVER - PRODUCTION (Backend)                  │
│  Git Branch: master → Railway: api.letterirl.com                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │ MCP Tools   │  │ REST API    │  │ Dashboard   │  │ Admin API   │ │
│  │ (ChatGPT)   │  │ (Website)   │  │ API         │  │ (Disabled)  │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘ │
│                                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │
│  │ Job Queue   │  │ Letter      │  │ Credit      │                  │
│  │ Processor   │  │ Service     │  │ Service     │                  │
│  └─────────────┘  └─────────────┘  └─────────────┘                  │
└─────────────────────────────────────────────────────────────────────┘
         │                 │                          │
         ▼                 ▼                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   EXTERNAL SERVICES - PRODUCTION                     │
├─────────────────┬─────────────────┬─────────────────┬───────────────┤
│   Neon          │   Auth0         │   PostGrid      │   Stripe      │
│   (main branch) │   (prod tenant) │   (live mode)   │   (live mode) │
└─────────────────┴─────────────────┴─────────────────┴───────────────┘
```

### Development Environment

```
┌─────────────────────────────────────────────────────────────────────┐
│                           USER INTERFACES                            │
├─────────────────┬─────────────────┬─────────────────────────────────┤
│   ChatGPT       │   Website       │   Admin Panel                   │
│   (MCP Client)  │   (Next.js)     │   (Static HTML/JS)              │
│                 │   (dev deploy)  │                                 │
└────────┬────────┴────────┬────────┴────────────────┬────────────────┘
         │                 │                          │
         ▼                 ▼                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                 MCP SERVER - DEVELOPMENT (Backend)                   │
│  Git Branch: dev → Railway: obscure URL                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │ MCP Tools   │  │ REST API    │  │ Dashboard   │  │ Admin API   │ │
│  │ (ChatGPT)   │  │ (Website)   │  │ API         │  │ (Disabled)  │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘ │
│                                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │
│  │ Job Queue   │  │ Letter      │  │ Credit      │                  │
│  │ Processor   │  │ Service     │  │ Service     │                  │
│  └─────────────┘  └─────────────┘  └─────────────┘                  │
└─────────────────────────────────────────────────────────────────────┘
         │                 │                          │
         ▼                 ▼                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  EXTERNAL SERVICES - DEVELOPMENT                     │
├─────────────────┬─────────────────┬─────────────────┬───────────────┤
│   Neon          │   Auth0         │   PostGrid      │   Stripe      │
│   (dev branch)  │   (dev tenant)  │   (dummy mode)  │   (test mode) │
└─────────────────┴─────────────────┴─────────────────┴───────────────┘
```

## Environment Overview

Letter IRL uses a **fully isolated development environment** that mirrors production:

| Component | Production | Development |
|-----------|------------|-------------|
| **Git Branch** | `master` | `dev` |
| **Railway** | api.letterirl.com | Obscure URL |
| **Neon Database** | main branch | dev branch (synced copy) |
| **Auth0 Tenant** | dev-ky21dxn3qmi71hjl.us.auth0.com | letter-irl-dev.us.auth0.com |
| **Stripe** | Live mode (real charges) | Test mode (no charges) |
| **PostGrid** | Live mode (real mail) | Dummy provider (no mail) |

### Key Design Decisions

1. **Separate Auth0 Tenant**: Complete isolation between environments, prevents accidental cross-environment access
2. **Neon Branching**: Copy production data to development via `npm run dev:sync`
3. **User ID Preservation**: Social logins (Google, GitHub, etc.) IDs match across tenants; Username-Password users synced via script
4. **Auto-Deploy**: Railway automatically deploys `dev` and `master` branches to respective environments

## Services Summary

| Service | Purpose | Pricing | Dashboard |
|---------|---------|---------|-----------|
| **Neon** | PostgreSQL database | Free tier: 0.5GB | [console.neon.tech](https://console.neon.tech) |
| **Auth0** | Authentication | Free: 7,500 MAU | [manage.auth0.com](https://manage.auth0.com) |
| **PostGrid** | Physical mail API | Pay per letter (~$1.50) | [dashboard.postgrid.com](https://dashboard.postgrid.com) |
| **Stripe** | Payment processing | 2.9% + $0.30/txn | [dashboard.stripe.com](https://dashboard.stripe.com) |
| **Railway** | Backend + Website hosting | $5/mo + usage | [railway.app](https://railway.app) |

## Detailed Service Information

### Neon (PostgreSQL)

**Purpose**: Stores all application data - users, letters, credits, transactions, jobs.

**Current Plan**: Free tier
- 0.5 GB storage
- 190 compute hours/month
- Automatic suspend after 5 min inactivity

**Environments**:
| Environment | Branch | Purpose |
|-------------|--------|---------|
| Production | `main` | Live user data |
| Development | `dev` | Synced copy of production for testing |

**Connection**:
```
# Production
DATABASE_URL=postgres://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require

# Development
DATABASE_URL=postgres://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require&options=branch%3Ddev
```

**Key Features Used**:
- Connection pooling (recommended for serverless)
- Automatic backups
- Branch databases (for development environment isolation)
- Branch reset via API (for `npm run dev:sync`)

**Database Sync**: Run `npm run dev:sync` to reset dev branch from production main branch.

**Relevant Docs**: `docs/database-schema.md`, `docs/database-setup.md`

---

### Auth0

**Purpose**: User authentication for both ChatGPT (OAuth) and website (session).

**Current Plan**: Free tier
- 7,500 monthly active users
- 2 social connections
- Unlimited applications

**Tenants**:
| Environment | Tenant | Purpose |
|-------------|--------|---------|
| Production | `dev-ky21dxn3qmi71hjl.us.auth0.com` | Live user authentication |
| Development | `letter-irl-dev.us.auth0.com` | Isolated dev authentication |

**Why Separate Tenants?**
- Complete isolation: Users cannot accidentally access wrong environment
- Different callback URLs for dev/prod
- Prevents credential leakage between environments
- Social login provider IDs automatically match across tenants

**Applications** (per tenant):
| Application | Type | Purpose |
|-------------|------|---------|
| Letter IRL MCP | Machine-to-Machine + Regular Web | ChatGPT OAuth flow |
| Letter IRL Website | Regular Web Application | Website auth |

**API Audience**: `https://letter-irl/api`

**User ID Matching**:
Social login IDs (Google, GitHub, Microsoft, Apple) are identical across tenants. Username-Password users have different IDs and require sync via `npm run dev:sync`.

**Key Features Used**:
- OAuth 2.0 Authorization Code flow (ChatGPT)
- Session-based auth (Website via SDK v4)
- JWT access tokens
- User metadata
- User import/export for dev sync

**Relevant Docs**: `docs/auth0-tenant-configuration.md`, `docs/chatgpt-auth0-oauth-learnings.md`

---

### PostGrid

**Purpose**: Send physical letters via USPS mail.

**Environments**:
| Environment | Mode | API Key | Behavior |
|-------------|------|---------|----------|
| Production | Live | `live_sk_...` | Real letters mailed |
| Development | Dummy | (not used) | Dummy provider (no API calls) |

**Pricing** (approximate):
- Standard letter: ~$1.50
- Address validation: Free (included)
- Tracking: Included

**API Base**: `https://api.postgrid.com/print-mail/v1`

**Development Mode**: Uses dummy provider that simulates PostGrid API without making real API calls or mailing letters. Useful for testing letter flow without costs.

**Key Features Used**:
- Letter creation with HTML templates
- Address validation/autocorrection
- Delivery tracking
- Webhooks (for status updates)

**Relevant Docs**: `docs/postgrid-api-research.md`, `docs/testing-postgrid.md`, `docs/address-validation.md`

---

### Stripe

**Purpose**: Credit card payments for credit purchases.

**Environments**:
| Environment | Mode | API Key | Behavior |
|-------------|------|---------|----------|
| Production | Live | `sk_live_...` | Real charges |
| Development | Test | `sk_test_...` | No charges, test cards only |

**Pricing**: 2.9% + $0.30 per transaction (production only)

**Key Features Used**:
- Checkout Sessions (hosted payment page)
- Webhooks (payment confirmation)
- Customer records

**Credit Packages**:
| Package | Credits | Price | Per Letter |
|---------|---------|-------|------------|
| Starter | 4 | $9.99 | $2.50 |
| Standard | 10 | $19.99 | $2.00 |
| Bulk | 100 | $149.99 | $1.50 |

**Relevant Docs**: `docs/credit-packages-spec.md`, `docs/credit-purchase-flow.md`, `docs/acp-stripe-integration.md`

---

### Railway

**Purpose**: Host both the MCP backend (api.letterirl.com) and website (letterirl.com).

**Current Plan**: Hobby ($5/month + usage)

**Pricing**:
| Plan | Price | Use Case |
|------|-------|----------|
| Hobby | $5/mo + usage | Small projects, development |
| Pro | $20/mo + usage | Production workloads |

**Deployments**:
| Service | Environment | Branch | Domain |
|---------|-------------|--------|--------|
| Backend | Production | `master` | api.letterirl.com |
| Backend | Development | `dev` | Obscure URL (auto-generated) |
| Website | Production | `main` | letterirl.com |
| Website | Development | `dev` | Obscure URL (auto-generated) |

Both repositories use the same workflow: feature branches → `dev` → `main/master`

**Auto-Deploy Behavior**:
- API: Push to `master` → Deploys to production environment
- API: Push to `dev` → Deploys to development environment
- Website: Push to `main` → Deploys to production environment
- Website: Push to `dev` → Deploys to development environment
- Each environment has separate Railway project with isolated env vars

**Key Features**:
- Automatic SSL certificates
- Git-based deployments (auto-deploy on push)
- Environment variable management per environment
- Logging and metrics
- Nixpacks for automatic build detection

---

## Repository Structure

```
/mnt/c/letter-irl/           # Backend (MCP server, API, services)
├── src/
│   ├── mcp/                 # MCP server and tools
│   ├── api/                 # REST API handlers
│   ├── services/            # Business logic
│   └── db/                  # Database queries
├── db/migrations/           # SQL migrations
├── docs/                    # Documentation
├── scripts/                 # Utility scripts
└── public/                  # Static files (mcp-setup.html)

/mnt/c/letter-irl-website/   # Website (Next.js)
├── app/                     # Next.js app router
│   ├── (marketing)/         # Public pages
│   ├── (dashboard)/         # Protected pages
│   └── api/                 # API routes (proxy)
├── components/              # React components
└── lib/                     # Auth0, API client
```

## Environment Variables

### Backend (.env)

```env
# Database
DATABASE_URL=postgres://...

# Auth0
AUTH0_DOMAIN=dev-ky21dxn3qmi71hjl.us.auth0.com
AUTH0_AUDIENCE=https://letter-irl/api
AUTH0_CLIENT_ID=...
AUTH0_CLIENT_SECRET=...

# PostGrid
POSTGRID_API_KEY=test_sk_... (or live_sk_...)

# Stripe
STRIPE_SECRET_KEY=sk_test_... (or sk_live_...)
STRIPE_WEBHOOK_SECRET=whsec_...

# Admin
ADMIN_JWT_SECRET=...
```

### Website (.env.local)

```env
# Auth0
AUTH0_SECRET=...
AUTH0_DOMAIN=dev-ky21dxn3qmi71hjl.us.auth0.com
AUTH0_CLIENT_ID=...
AUTH0_CLIENT_SECRET=...
APP_BASE_URL=http://localhost:3000
AUTH0_AUDIENCE=https://letter-irl/api

# Backend
LETTER_IRL_API_URL=http://localhost:8788

# Stripe
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

## Monitoring & Observability

### Current State
- Basic logging to console
- Neon dashboard for database metrics
- PostGrid dashboard for mail tracking
- Stripe dashboard for payment monitoring

### Recommended Additions
1. **Sentry** - Error tracking
2. **Vercel Analytics** - Website metrics
3. **Custom dashboard** - Business metrics (letters sent, revenue, etc.)

## Backup & Recovery

### Database (Neon)
- Automatic point-in-time recovery (7 days on free tier)
- Manual exports via `pg_dump`

### Code
- Git repositories on GitHub
- Vercel maintains deployment history

### No Backup Needed
- Auth0: Managed service, no user data to back up
- PostGrid: Transaction history in their dashboard
- Stripe: Payment history in their dashboard

## Security Considerations

1. **Secrets Management**: All sensitive values in environment variables
2. **Authentication**: JWT tokens validated on every request
3. **Authorization**: User can only access their own data
4. **HTTPS**: Enforced on all endpoints
5. **CORS**: Configured to allow only known origins

## Cost Estimation (Monthly)

### Development/Testing
| Service | Cost |
|---------|------|
| Neon | $0 (free tier) |
| Auth0 | $0 (free tier) |
| PostGrid | ~$0 (test mode) |
| Stripe | $0 (no transactions) |
| Railway | $5 (Hobby plan) |
| **Total** | **~$5/month** |

### Production (Estimated)
| Service | Cost |
|---------|------|
| Neon | $0-19 (depends on usage) |
| Auth0 | $0 (under 7,500 MAU) |
| PostGrid | Variable (~$1.50/letter) |
| Stripe | 2.9% + $0.30 per transaction |
| Railway | $5-20 + usage |
| **Fixed costs** | **~$5-40/month** |

## Quick Links

| Resource | URL |
|----------|-----|
| Neon Console | https://console.neon.tech |
| Auth0 Dashboard | https://manage.auth0.com |
| PostGrid Dashboard | https://dashboard.postgrid.com |
| Stripe Dashboard | https://dashboard.stripe.com |
| Railway Dashboard | https://railway.app |
| GitHub (Backend) | https://github.com/dnobj/mail-letter-irl |
| GitHub (Website) | https://github.com/dnobj/mail-letter-irl-website |
