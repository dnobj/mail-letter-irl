# Letter IRL - Implementation Roadmap

Last Updated: January 14, 2025

## Project Vision

Build Letter IRL as a **"hero app"** for the ChatGPT Apps SDK by implementing:
- Full Agentic Commerce Protocol (ACP) for credit purchases
- Conversational letter sending via ChatGPT
- Physical mail delivery through print/mail API
- Complete OAuth authentication with Auth0

## Overall Progress

```
Phase 1: Foundation          ████████████████████ 100% ✅
Phase 2: Database            ████████████████████ 100% ✅
Phase 3: Credit API          ░░░░░░░░░░░░░░░░░░░░   0% ← YOU ARE HERE
Phase 4: Job Queue           ░░░░░░░░░░░░░░░░░░░░   0%
Phase 5: Admin API           ░░░░░░░░░░░░░░░░░░░░   0%
Phase 6: ACP Integration     ░░░░░░░░░░░░░░░░░░░░   0%
Phase 7: Testing & Launch    ░░░░░░░░░░░░░░░░░░░░   0%
```

---

## Phase 1: Foundation ✅ COMPLETE

### MCP Server with Auth0 OAuth

**Status:** ✅ Deployed and working

**What's Working:**
- MCP server running on HTTP (Streamable HTTP + SSE fallback)
- Auth0 OAuth 2.1 + PKCE with 5 identity providers
- 4 MCP tools: `quote_and_preview_letter`, `send_letter`, `check_status`, `get_balance`
- Per-user authentication (JWT validation)
- Ngrok tunnel for external access

**Key Files:**
- `src/mcp/httpServer.ts` - Main HTTP server
- `src/mcp/registerTools.ts` - Tool registration with auth context
- `manifest.json` - ChatGPT MCP manifest
- `.env` - Configuration including Auth0

**Documentation:**
- `SETUP.md` - Complete setup guide
- `docs/auth0-tenant-configuration.md` - Auth0 config reference

**Next:** Database-backed credit system (Phase 2-3)

---

## Phase 2: Database Setup ✅ COMPLETE

### Neon PostgreSQL Database

**Status:** ✅ All tables created and verified

**Completed:**
- ✅ Neon project created (`letter-irl`)
- ✅ Connection string configured in `.env`
- ✅ Migration system implemented
- ✅ 6 tables created successfully
- ✅ Connection tested and verified

**Database Schema:**

| Table | Columns | Purpose |
|-------|---------|---------|
| `users` | 7 | User accounts & credit balances |
| `credit_transactions` | 9 | Complete audit trail of all credit changes |
| `orders` | 9 | Purchase history from ACP/Stripe |
| `letters` | 10 | Letter content & delivery status |
| `letter_jobs` | 11 | Background job queue for processing |
| `migrations` | 3 | Migration tracking |

**Key Files:**
- `db/migrations/001_initial_schema.sql` - Database schema
- `db/migrate.ts` - Migration runner
- `src/db/index.ts` - Database connection and utilities

**NPM Scripts:**
- `npm run db:test` - Test connection
- `npm run db:migrate` - Run migrations

**Documentation:**
- `docs/database-setup.md` - Complete setup guide with troubleshooting

**Next:** Build Credit API to use these tables (Phase 3)

---

## Phase 3: Credit API 🚧 IN PROGRESS

### User Credit Management System

**Status:** 📝 Ready to implement

**Goal:** Build APIs to manage user credits (add, deduct, balance, history)

### Implementation Steps

#### Step 1: User Service
Create `src/services/userService.ts`:
- `getOrCreateUser()` - Get user by Auth0 ID, create if new
- `getUser()` - Get existing user
- `updateUser()` - Update user info

#### Step 2: Credit Service
Create `src/services/creditService.ts`:
- `addCredits()` - Add credits from purchase (with transaction)
- `deductCredits()` - Deduct credits for letter (with balance check)
- `getBalance()` - Get current balance
- `getTransactions()` - Get transaction history
- `refundCredits()` - Refund cancelled orders

#### Step 3: TypeScript Types
Create `src/services/types.ts`:
- `User` interface
- `CreditTransaction` interface
- API request/response types

#### Step 4: Express Routes
Create `src/api/creditRoutes.ts`:
- `GET /api/credits/balance` - Get balance
- `GET /api/credits/transactions` - Get history
- `GET /api/users/me` - Get user info

#### Step 5: Auth Middleware
Create `src/api/middleware/auth.ts`:
- Extract JWT from Authorization header
- Validate with Auth0 JWKS
- Attach `authInfo` to request

#### Step 6: Integration
Update existing code:
- `src/acp/checkoutService.ts` - Call `addCredits()` after payment
- `src/mcp/registerTools.ts` - Call `deductCredits()` when sending letter
- `src/mcp/httpServer.ts` - Add credit API routes

### Success Criteria

- ✅ User can purchase credits (credits added to database)
- ✅ User balance persists across sessions
- ✅ Letter sending deducts correct credits
- ✅ Transaction history shows all operations
- ✅ Insufficient credits prevents letter sending
- ✅ All operations are atomic (use transactions)

**Documentation:**
- `docs/credit-api-implementation.md` - Complete implementation guide

**Estimated Time:** 2-3 days

**Next:** Job Queue for letter processing (Phase 4)

---

## Phase 4: Job Queue 📋 PLANNED

### Letter Processing Background Jobs

**Status:** 📝 Not started

**Goal:** Queue letters for printing/mailing with retry logic

### Key Components

1. **pg-boss Setup**
   - Install and configure pg-boss
   - Create job queue tables
   - Set up worker process

2. **Job Creation**
   - `createLetterJob()` - Queue letter after credits deducted
   - Job payload includes letter content, recipient, user ID

3. **Job Processing**
   - Worker picks up jobs
   - Calls print/mail API (stub for now)
   - Updates letter status
   - Handles failures with retry

4. **Status Tracking**
   - Update `letters` and `letter_jobs` tables
   - Return status to user via MCP tool

**Documentation:**
- `docs/job-queue-implementation.md` - To be created

**Estimated Time:** 2-3 days

**Next:** Admin API (Phase 5)

---

## Phase 5: Admin API 📊 PLANNED

### Monitoring and Management

**Status:** 📝 Not started

**Goal:** APIs for monitoring system health and manually managing jobs

### Key Endpoints

- `GET /api/admin/stats` - Overall statistics
- `GET /api/admin/users` - User list with credits
- `GET /api/admin/jobs` - Job queue status
- `POST /api/admin/jobs/:id/retry` - Manually retry failed job
- `GET /api/admin/revenue` - Revenue analytics

**Documentation:**
- `docs/admin-api-implementation.md` - To be created

**Estimated Time:** 2 days

**Next:** ACP Integration (Phase 6)

---

## Phase 6: ACP Integration 🛒 PLANNED

### Full Agentic Commerce Protocol

**Status:** 📝 Documentation complete, implementation pending

**What's Ready:**
- ✅ Complete documentation (5 files)
- ✅ Database schema supports ACP
- ✅ Credit system designed
- 📋 Waiting for ChatGPT Merchants Program approval

### Implementation Steps

1. **Product Feed** (Simple - 30 min)
   - Create `src/acp/productFeed.ts`
   - Serve JSON at `/api/acp/v1/products.json`
   - 3 credit packages (5, 20, 100 credits)

2. **Cart & Checkout API** (Complex - 2-3 days)
   - `POST /api/acp/v1/cart/create`
   - `POST /api/acp/v1/cart/items`
   - `GET /api/acp/v1/cart/:cartId`
   - `POST /api/acp/v1/checkout/quote`
   - `POST /api/acp/v1/checkout/complete`

3. **Stripe Integration** (Medium - 1-2 days)
   - Set up Stripe account
   - Enable Shared Payment Token (SPT)
   - Implement `chargeSharedPaymentToken()`
   - Set up webhooks

4. **Idempotency** (Simple - 1 day)
   - Implement idempotency key storage
   - Prevent duplicate charges

**Documentation:**
- `docs/acp-implementation-guide.md` ✅
- `docs/acp-stripe-integration.md` ✅
- `docs/credit-packages-spec.md` ✅
- `docs/credit-purchase-flow.md` ✅
- `docs/acp-quickstart.md` ✅

**Estimated Time:** 1-2 weeks (after Merchants Program approval)

**Next:** Testing & Launch (Phase 7)

---

## Phase 7: Testing & Launch 🚀 PLANNED

### End-to-End Testing & Production

**Status:** 📝 Not started

**Testing Checklist:**

1. **Unit Tests**
   - Credit operations (add/deduct)
   - Transaction atomicity
   - Balance checks

2. **Integration Tests**
   - Complete purchase flow
   - Letter sending flow
   - Stripe payment processing

3. **End-to-End Tests**
   - ChatGPT → Auth0 → Purchase credits → Send letter
   - All 5 identity providers
   - Error scenarios

4. **Load Testing**
   - Concurrent purchases
   - Database connection pooling
   - Job queue throughput

**Production Deployment:**

1. Switch to production Stripe keys
2. Set up proper logging/monitoring
3. Configure error alerts
4. Set up backup/recovery
5. Submit for OpenAI certification
6. Launch! 🎉

**Estimated Time:** 1 week

---

## Technology Stack

### Current Stack

**Backend:**
- Node.js 20+ with TypeScript
- Express.js (HTTP server)
- @modelcontextprotocol/sdk (MCP implementation)

**Database:**
- PostgreSQL 17.5 (Neon serverless)
- pg (Node.js client)
- File-based migrations

**Authentication:**
- Auth0 (OAuth 2.1 + PKCE)
- jose (JWT validation)
- 5 identity providers (Email, Google, Microsoft, Apple, GitHub)

**Payment:**
- Stripe (Shared Payment Token for ACP)

**Job Queue:**
- pg-boss (PostgreSQL-backed)

**Deployment:**
- WSL (development)
- Ngrok (tunnel for Auth0/ChatGPT)
- Production: TBD (Railway, Render, or VPS)

---

## File Structure

```
/mnt/c/letter-irl/
├── src/
│   ├── mcp/
│   │   ├── httpServer.ts          ✅ MCP HTTP server
│   │   ├── registerTools.ts       ✅ Tool registration
│   │   └── stdioServer.ts         ✅ MCP stdio server
│   ├── services/
│   │   ├── LetterIrlServer.ts     ✅ Core letter logic
│   │   ├── accountService.ts      ✅ File-based accounts (legacy)
│   │   ├── userService.ts         📝 Database user CRUD
│   │   ├── creditService.ts       📝 Credit management
│   │   └── types.ts               📝 Shared TypeScript types
│   ├── api/
│   │   ├── creditRoutes.ts        📝 Credit API routes
│   │   └── middleware/
│   │       └── auth.ts            📝 JWT auth middleware
│   ├── acp/
│   │   ├── productFeed.ts         📋 Product catalog
│   │   ├── cartService.ts         📋 Shopping cart
│   │   ├── checkoutService.ts     📋 Checkout logic
│   │   ├── stripeService.ts       📋 Stripe SPT integration
│   │   └── acpRoutes.ts           📋 ACP API routes
│   └── db/
│       └── index.ts               ✅ Database connection
├── db/
│   ├── migrate.ts                 ✅ Migration runner
│   └── migrations/
│       └── 001_initial_schema.sql ✅ Database schema
├── scripts/
│   ├── test-db.ts                 ✅ Test DB connection
│   └── verify-tables.ts           ✅ Verify tables created
├── docs/
│   ├── IMPLEMENTATION-ROADMAP.md  ✅ This file
│   ├── database-setup.md          ✅ Database guide
│   ├── credit-api-implementation.md ✅ Credit API guide
│   ├── acp-implementation-guide.md  ✅ ACP technical spec
│   ├── acp-stripe-integration.md    ✅ Stripe SPT guide
│   ├── credit-packages-spec.md      ✅ Product specs
│   ├── credit-purchase-flow.md      ✅ Purchase flow
│   └── acp-quickstart.md            ✅ 8-week plan
├── .env                           ✅ Configuration
├── package.json                   ✅ Dependencies
└── manifest.json                  ✅ ChatGPT MCP manifest
```

Legend:
- ✅ Complete
- 📝 In progress / Ready to implement
- 📋 Planned / Not started

---

## Success Metrics

### MVP Launch Criteria

- ✅ Auth0 OAuth working with 5 providers
- ✅ Database connected and migrated
- 📝 Users can purchase credits via ACP
- 📝 Credits persist and sync correctly
- 📝 Letters can be sent using credits
- 📝 Job queue processes letters
- 📝 Admin can monitor system health

### "Hero App" Criteria

- Full ACP implementation (cutting edge)
- Seamless UX (never leave ChatGPT)
- Reliable delivery (job queue with retries)
- Complete observability (admin API)
- Production-ready (proper error handling, logging)
- Well-documented (comprehensive docs)

### Business Metrics (Post-Launch)

- User acquisition rate
- Purchase conversion rate
- Average transaction value
- Repeat purchase rate
- Letter delivery success rate
- Customer support tickets

---

## Current Focus

**Phase 3: Credit API** ← YOU ARE HERE

**Next Task:** Implement User Service (`src/services/userService.ts`)

**See:** `docs/credit-api-implementation.md` for detailed implementation guide

---

## Questions or Blockers?

**Waiting On:**
- ChatGPT Merchants Program approval (applied, pending)
- Stripe SPT feature access (will apply when ready)

**Ready to Build:**
- All documentation complete
- Database schema ready
- Implementation plan clear

**Let's build! 🚀**
