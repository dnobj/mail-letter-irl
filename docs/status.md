# Letter IRL - Project Status

**Last Updated:** December 4, 2025
**Current Phase:** Production (MVP Complete)
**Overall Progress:** 95%

---

## Project Overview

Letter IRL is a **physical letter mailing service** integrated with ChatGPT via MCP (Model Context Protocol). Users compose letters through conversation and the system prints and mails them via PostGrid.

**Key Features:**
- Conversational letter composition via ChatGPT
- Credit-based billing with Stripe integration
- PostGrid for physical mail fulfillment
- Draft-based idempotency to prevent duplicate sends
- User tier system with rate limiting
- Admin dashboard for monitoring

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        PRODUCTION                                │
├─────────────────────────────────────────────────────────────────┤
│  Railway (api.letterirl.com)                                     │
│  ├── Git Branch: master                                          │
│  ├── MCP HTTP Server                                             │
│  ├── REST API (/api/*)                                           │
│  ├── Stripe Webhooks                                             │
│  ├── pg-boss Workers (job processing)                            │
│  └── Status Sync Worker (6h interval)                            │
├─────────────────────────────────────────────────────────────────┤
│  Neon PostgreSQL (main branch)                                   │
│  └── All tables (users, letters, credits, jobs, etc.)            │
├─────────────────────────────────────────────────────────────────┤
│  External Services                                               │
│  ├── Auth0: dev-njmdyqf8n25rqgy7.us.auth0.com (prod tenant)      │
│  ├── Stripe (live mode)                                          │
│  └── PostGrid (live mode)                                        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                       DEVELOPMENT                                │
├─────────────────────────────────────────────────────────────────┤
│  Railway (obscure URL)                                           │
│  ├── Git Branch: dev                                             │
│  ├── MCP HTTP Server                                             │
│  ├── REST API (/api/*)                                           │
│  ├── Stripe Webhooks                                             │
│  ├── pg-boss Workers (job processing)                            │
│  └── Status Sync Worker (6h interval)                            │
├─────────────────────────────────────────────────────────────────┤
│  Neon PostgreSQL (dev branch)                                    │
│  └── Copy of production data (sync via npm run dev:sync)         │
├─────────────────────────────────────────────────────────────────┤
│  External Services                                               │
│  ├── Auth0: dev-ky21dxn3qmi71hjl.us.auth0.com (dev tenant)       │
│  ├── Stripe (test mode)                                          │
│  └── PostGrid (dummy provider - no real mail)                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Development Environment

Letter IRL uses a **fully isolated development environment** that mirrors production architecture:

### Git Branching Strategy

Both repositories (`letter-irl` and `letter-irl-website`) use the same strategy:
- **`master/main`** - Production branch (auto-deploys to Railway production)
- **`dev`** - Development branch (auto-deploys to Railway dev environment)
- **`feature/*`** - Feature branches (branch from `dev`, merge to `dev`)

### Environment Isolation

| Component | Production | Development |
|-----------|------------|-------------|
| Git Branch (API) | `master` | `dev` |
| Git Branch (Website) | `main` | `dev` |
| Railway API | api.letterirl.com | Railway dev environment |
| Railway Website | letterirl.com | https://mail-letter-irl-website-development.up.railway.app |
| Neon | production branch | dev branch (synced via `npm run dev:sync`) |
| Auth0 Tenant | dev-njmdyqf8n25rqgy7.us.auth0.com (dnicholl@letterirl.com) | dev-ky21dxn3qmi71hjl.us.auth0.com (dnicholl@objective.works) |
| Stripe | Live mode | Test mode |
| PostGrid | Live mode | Dummy provider |

### Database Sync
Run `npm run dev:sync` to synchronize production data to development:
- Deletes and recreates Neon dev branch from production
- Exports/imports Username-Password users to preserve Auth0 user IDs
- One-way sync: Production → Dev only

### User ID Preservation
Social login IDs (Google, GitHub, etc.) automatically match across Auth0 tenants. Username-Password users require sync script to preserve IDs.

See [deployment.md](deployment.md) for detailed setup instructions.

---

## Technology Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20+ with TypeScript |
| Server | Custom HTTP (MCP SDK) |
| Database | PostgreSQL 17 (Neon serverless) |
| Job Queue | pg-boss (PostgreSQL-backed) |
| Auth | Auth0 OAuth 2.1 + PKCE |
| Payments | Stripe (Checkout, Webhooks) |
| Mail Provider | PostGrid (production), Dummy (testing) |
| Hosting | Railway |

---

## Database Schema

**12 Tables:**

| Table | Purpose |
|-------|---------|
| users | User accounts with credits and tier |
| credit_ledger | Credit entries with expiration (FIFO) |
| credit_transactions | Audit trail for all credit changes |
| credit_consumption | Links credit usage to ledger entries |
| letter_drafts | Temporary drafts for idempotent sends |
| letters | Sent letters with tracking |
| letter_jobs | Background job processing |
| orders | Stripe purchase records |
| promo_campaigns | Promo code campaigns |
| promo_redemptions | User promo code redemptions |
| stripe_disputes | Chargeback tracking |
| migrations | Migration tracking |

**8 Migrations:**
1. `001_initial_schema.sql` - Core tables
2. `002_add_provider_fields.sql` - PostGrid fields
3. `003_credit_ledger.sql` - Credit ledger, promos
4. `004_letter_drafts.sql` - Draft-based idempotency
5. `005_user_tiers.sql` - Tier system for rate limits
6. `006_stripe_disputes.sql` - Chargeback tracking
7. `007_seed_preview_promos.sql` - Preview access promo codes
8. `008_status_sync.sql` - Status sync tracking columns

See [database-schema.md](database-schema.md) for full schema details.

---

## MCP Tools

| Tool | Purpose |
|------|---------|
| `quote_and_preview_letter` | Creates draft, returns preview and cost |
| `send_letter` | Consumes draft, deducts credits, queues job |
| `get_order_status` | Check letter delivery status |
| `get_account_balance` | View credit balance |
| `switch_account` | Logout and re-authenticate |

See [letter-send-flow.md](letter-send-flow.md) for the complete send flow.

---

## API Endpoints

### Public API (Authenticated)
| Endpoint | Purpose |
|----------|---------|
| `GET /api/credits/balance` | Current credit balance |
| `GET /api/credits/transactions` | Transaction history |
| `GET /api/users/me` | User profile |
| `POST /api/checkout/create-session` | Create Stripe checkout |
| `POST /api/promo/redeem` | Redeem promo code |
| `GET /api/promo/validate/:code` | Validate promo code for user |

### Public API (No Auth)
| Endpoint | Purpose |
|----------|---------|
| `GET /api/public/promo/validate/:code` | Validate promo code (preview gate) |

### Dashboard API (Stripe Webhooks)
| Endpoint | Purpose |
|----------|---------|
| `POST /webhooks/stripe` | Stripe event handler |

### Admin API (Local Only)
| Endpoint | Purpose |
|----------|---------|
| `GET /api/admin/dashboard` | System stats |
| `GET /api/admin/alerts` | Active alerts |
| `GET /api/admin/users/search` | Search users |
| `GET /api/admin/letters` | List letters |
| `POST /api/admin/jobs/:id/retry` | Retry failed job |
| `POST /api/admin/credits/adjust` | Adjust user credits |
| `POST /api/admin/promo/create` | Create promo campaign |
| `GET /api/admin/sync/statuses` | Dry-run status sync |
| `POST /api/admin/sync/statuses` | Execute status sync |
| `GET /api/admin/sync/stuck` | List stuck letters |

---

## Security Model

### Admin Access
- **Railway (production):** `ADMIN_ENABLED=false` - Admin routes return 404
- **Local:** `ADMIN_ENABLED=true` + `ADMIN_LOCAL_ONLY=true` - Full access
- Real security: Neon DATABASE_URL credentials

### Rate Limiting
- Per-user, in-memory (IP-based fallback)
- Tier-based limits: standard vs trusted
- Trusted tier: 3+ purchases, oldest 120+ days ago

**Rate Limit Configuration:**
| Endpoint Type | Per-IP Limit | Global Limit | Window |
|---------------|--------------|--------------|--------|
| auth | 10/min | - | 1 min |
| send_letter | 20/hour | - | 1 hour |
| api | 100/min | - | 1 min |
| checkout | 10/min | - | 1 min |
| admin | 50/min | - | 1 min |
| mcp | 60/min | - | 1 min |
| promo_public | 10/min | 100/min | 1 min |

**Admin Monitoring:**
- `GET /api/admin/ratelimit/stats` - View rate limit statistics
- Console logging when rate limits are triggered

### User Tiers
| Tier | Criteria | Rate Limit |
|------|----------|------------|
| standard | Default | Lower limits |
| trusted | 3+ purchases, 120+ days history | Higher limits |

---

## Credit System

### Sources
- **purchase** - Stripe payments
- **promo** - Promo code redemption
- **signup_bonus** - New user welcome credits
- **adjustment** - Admin manual changes
- **refund** - Cancelled letter refunds

### Expiration
- Credits expire based on policy (90 days default for promos)
- FIFO consumption: Soonest-expiring credits used first
- Expiration tracked in `credit_ledger.expires_at`

### Flow
1. User buys credits via Stripe checkout
2. Webhook creates `credit_ledger` entry
3. On letter send, credits deducted from oldest entries first
4. Consumption tracked in `credit_consumption` table

---

## Letter Send Flow

```
quote_and_preview_letter → Creates draft (24h expiry)
         ↓
send_letter(draftId) → Consumes draft atomically
         ↓
         ├── Deducts credits (FIFO from ledger)
         ├── Creates letter record
         └── Queues job (pg-boss)
         ↓
letterWorker → Sends to PostGrid
         ↓
Letter printed and mailed
```

See [letter-send-flow.md](letter-send-flow.md) for details.

---

## Letter Status Lifecycle

### Database Statuses
Letters transition through these statuses in the database:
```
queued → processing → in_transit → delivered
                                 → returned (bad address)
                                 → failed (provider error)
                                 → cancelled
```

### PostGrid Status Mapping
| PostGrid Status | Database Status |
|-----------------|-----------------|
| `ready` | `queued` |
| `rendered` | `processing` |
| `processed` | `processing` |
| `printed` | `processing` |
| `mailed` | `in_transit` |
| `in_transit` | `in_transit` |
| `delivered` | `delivered` |
| `returned` | `returned` |
| `canceled` | `cancelled` |

### MCP Status Mapping (Simplified)
| Database Status | MCP Status |
|-----------------|------------|
| `queued`, `draft` | `queued_for_print` |
| `processing` | `printing` |
| `in_transit`, `delivered`, `returned`, `sent` | `mailed` |
| `failed`, `cancelled` | `queued_for_print` |

### Status Sync Worker
- Runs every 6 hours
- Checks letters in non-terminal status (`queued`, `processing`, `in_transit`)
- Only checks letters with `tracking_id` (successfully sent to provider)
- Only checks letters created within last 30 days
- Updates `status`, `status_updated_at`, and `provider_raw_status` columns

---

## Environment Variables

### Required
| Variable | Purpose |
|----------|---------|
| DATABASE_URL | Neon PostgreSQL connection |
| LETTER_IRL_OAUTH_JWKS_URI | Auth0 JWKS endpoint |
| LETTER_IRL_OAUTH_ISSUER | Auth0 issuer |
| LETTER_IRL_OAUTH_AUDIENCE | Auth0 API audience |
| STRIPE_SECRET_KEY | Stripe API key |
| STRIPE_WEBHOOK_SECRET | Webhook signing secret |
| POSTGRID_API_KEY | PostGrid API key |

### Optional
| Variable | Default | Purpose |
|----------|---------|---------|
| ADMIN_ENABLED | false | Enable admin routes |
| ADMIN_LOCAL_ONLY | false | Restrict admin to localhost |
| DISABLE_WORKERS | false | Disable job workers |
| ACTIVE_LETTER_PROVIDER | postgrid | Letter provider |

---

## Running Locally

### Development Server
```bash
npm run dev    # Watch mode
npm run start  # Production mode
```

### Admin Server (connects to production DB)
```bash
# 1. Copy and configure
cp .env.admin.example .env.admin
# Edit .env.admin with production DATABASE_URL

# 2. Run admin server
npm run admin

# 3. Visit http://localhost:8788/admin
```

### Database Migrations
```bash
npm run db:migrate          # Run pending migrations
npm run db:migrate:rollback # View rollback info
```

---

## Deployment

### Railway Environments
- **Production**: Auto-deploys from `master` branch → api.letterirl.com
- **Development**: Auto-deploys from `dev` branch → Obscure URL
- Uses Nixpacks for build
- Environment variables configured per environment in Railway dashboard
- Admin routes disabled in both production and development

### Key Files
- `railway.json` - Railway configuration
- `nixpacks.toml` - Build configuration

---

## What's Complete

- [x] MCP HTTP server with OAuth
- [x] Auth0 integration (5 providers)
- [x] Neon PostgreSQL database
- [x] Credit system with ledger and expiration
- [x] Stripe checkout and webhooks
- [x] Draft-based idempotency
- [x] pg-boss job queue
- [x] PostGrid integration
- [x] User tier system
- [x] Rate limiting
- [x] Admin dashboard (local only)
- [x] Promo code system
- [x] Chargeback tracking
- [x] Railway deployment
- [x] Letter status sync from PostGrid (6h worker)
- [x] Live development environment (isolated Auth0 tenant, Neon branch, test mode services)

---

## Known Issues / Future Work

### Critical to Fix
1. Undefined `STATIC_CLIENT_ID`/`STATIC_CLIENT_SECRET` in OAuth registration
2. Missing request body timeout in webhook handling
3. Missing env var validation at startup

### Improvements
- Redis-based rate limiting for multi-instance scaling
- More comprehensive address validation
- Webhook retry logic enhancement
- Email notifications for letter status

---

## File Structure

```
/mnt/c/letter-irl/
├── src/
│   ├── mcp/              # MCP server (httpServer.ts, stdioServer.ts)
│   ├── api/              # REST API handlers
│   ├── services/         # Business logic
│   ├── workers/          # Background jobs (letterWorker.ts, statusSyncWorker.ts)
│   ├── tools/            # MCP tools (sendLetter.ts, etc.)
│   └── db/               # Database utilities
├── db/
│   ├── migrations/       # SQL migrations (001-008)
│   └── migrate.ts        # Migration runner
├── docs/                 # Documentation
├── scripts/              # Test and utility scripts
└── .env.admin.example    # Admin environment template
```

---

## Documentation Index

- [letter-send-flow.md](letter-send-flow.md) - Complete letter flow with drafts
- [database-schema.md](database-schema.md) - Full database schema
- [user-flows.md](user-flows.md) - User interaction flows
- [deployment.md](deployment.md) - Deployment guide
- [infrastructure.md](infrastructure.md) - Infrastructure overview
