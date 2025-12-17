# Infrastructure Overview

This document provides a central reference for all services and infrastructure used by Letter IRL.

## System Architecture

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
│                         MCP SERVER (Backend)                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │ MCP Tools   │  │ REST API    │  │ Dashboard   │  │ Admin API   │ │
│  │ (ChatGPT)   │  │ (Website)   │  │ API         │  │             │ │
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
│                        EXTERNAL SERVICES                             │
├─────────────────┬─────────────────┬─────────────────┬───────────────┤
│   Neon          │   Auth0         │   PostGrid      │   Stripe      │
│   (Database)    │   (Auth)        │   (Mail API)    │   (Payments)  │
└─────────────────┴─────────────────┴─────────────────┴───────────────┘
```

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

**Connection**:
```
DATABASE_URL=postgres://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require
```

**Key Features Used**:
- Connection pooling (recommended for serverless)
- Automatic backups
- Branch databases (for development)

**Relevant Docs**: `docs/database-schema.md`, `docs/database-setup.md`

---

### Auth0

**Purpose**: User authentication for both ChatGPT (OAuth) and website (session).

**Current Plan**: Free tier
- 7,500 monthly active users
- 2 social connections
- Unlimited applications

**Tenant**: `dev-ky21dxn3qmi71hjl.us.auth0.com`

**Applications**:
| Application | Type | Purpose |
|-------------|------|---------|
| Letter IRL MCP | Machine-to-Machine + Regular Web | ChatGPT OAuth flow |
| Letter IRL Website | Regular Web Application | Website auth |

**API Audience**: `https://letter-irl/api`

**Key Features Used**:
- OAuth 2.0 Authorization Code flow (ChatGPT)
- Session-based auth (Website via SDK v4)
- JWT access tokens
- User metadata

**Relevant Docs**: `docs/auth0-tenant-configuration.md`, `docs/chatgpt-auth0-oauth-learnings.md`

---

### PostGrid

**Purpose**: Send physical letters via USPS mail.

**Current Mode**: Test (switch to Live for production)

**Pricing** (approximate):
- Standard letter: ~$1.50
- Address validation: Free (included)
- Tracking: Included

**API Base**: `https://api.postgrid.com/print-mail/v1`

**Key Features Used**:
- Letter creation with HTML templates
- Address validation/autocorrection
- Delivery tracking
- Webhooks (for status updates)

**Relevant Docs**: `docs/postgrid-api-research.md`, `docs/testing-postgrid.md`, `docs/address-validation.md`

---

### Stripe

**Purpose**: Credit card payments for credit purchases.

**Current Mode**: Sandbox (switch to Live for production)

**Pricing**: 2.9% + $0.30 per transaction

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

**Services Deployed**:
| Service | Domain | Repository |
|---------|--------|------------|
| Backend (MCP Server) | api.letterirl.com | mail-letter-irl |
| Website (Next.js) | letterirl.com | mail-letter-irl-website |

**Key Features**:
- Automatic SSL certificates
- Git-based deployments (auto-deploy on push)
- Environment variable management
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
