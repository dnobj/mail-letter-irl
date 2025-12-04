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
│  ├── MCP HTTP Server                                             │
│  ├── REST API (/api/*)                                           │
│  ├── Stripe Webhooks                                             │
│  └── pg-boss Workers (job processing)                            │
├─────────────────────────────────────────────────────────────────┤
│  Neon PostgreSQL                                                 │
│  └── All tables (users, letters, credits, jobs, etc.)            │
├─────────────────────────────────────────────────────────────────┤
│  External Services                                               │
│  ├── Auth0 (OAuth 2.1 + PKCE, 5 identity providers)              │
│  ├── Stripe (payments, webhooks)                                 │
│  └── PostGrid (letter printing/mailing)                          │
└─────────────────────────────────────────────────────────────────┘
```

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

**7 Migrations:**
1. `001_initial_schema.sql` - Core tables
2. `002_add_provider_fields.sql` - PostGrid fields
3. `003_credit_ledger.sql` - Credit ledger, promos
4. `004_letter_drafts.sql` - Draft-based idempotency
5. `005_user_tiers.sql` - Tier system for rate limits
6. `006_stripe_disputes.sql` - Chargeback tracking
7. `007_seed_preview_promos.sql` - Preview access promo codes

See [DATABASE-SCHEMA.md](DATABASE-SCHEMA.md) for full schema details.

---

## MCP Tools

| Tool | Purpose |
|------|---------|
| `quote_and_preview_letter` | Creates draft, returns preview and cost |
| `send_letter` | Consumes draft, deducts credits, queues job |
| `get_order_status` | Check letter delivery status |
| `get_account_balance` | View credit balance |
| `switch_account` | Logout and re-authenticate |

See [LETTER-SEND-FLOW.md](LETTER-SEND-FLOW.md) for the complete send flow.

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

See [LETTER-SEND-FLOW.md](LETTER-SEND-FLOW.md) for details.

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

### Railway
- Auto-deploys from GitHub master branch
- Uses Nixpacks for build
- Environment variables configured in Railway dashboard
- Admin routes disabled in production

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
│   ├── workers/          # Background jobs (letterWorker.ts)
│   ├── tools/            # MCP tools (sendLetter.ts, etc.)
│   └── db/               # Database utilities
├── db/
│   ├── migrations/       # SQL migrations (001-006)
│   └── migrate.ts        # Migration runner
├── docs/                 # Documentation
├── scripts/              # Test and utility scripts
└── .env.admin.example    # Admin environment template
```

---

## Documentation Index

- [LETTER-SEND-FLOW.md](LETTER-SEND-FLOW.md) - Complete letter flow with drafts
- [DATABASE-SCHEMA.md](DATABASE-SCHEMA.md) - Full database schema
- [user-flows.md](user-flows.md) - User interaction flows
- [DEPLOYMENT.md](DEPLOYMENT.md) - Deployment guide
- [INFRASTRUCTURE.md](INFRASTRUCTURE.md) - Infrastructure overview
