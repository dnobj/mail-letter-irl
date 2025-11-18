# Database Setup Guide - Neon PostgreSQL

## Step 1: Create Neon Account

1. Go to https://neon.tech
2. Click "Sign Up"
3. Sign in with GitHub (recommended) or email
4. No credit card required

## Step 2: Create Project

Once logged in:

1. Click "New Project" button
2. Project settings:
   - **Name**: `letter-irl` (or whatever you prefer)
   - **Region**: Choose closest to you (e.g., `US East (Ohio)` for USA)
   - **Postgres Version**: 16 (latest, default)
   - **Compute Size**: 0.25 CU (free tier, default)

3. Click "Create Project"

## Step 3: Get Connection String

After project is created:

1. You'll see **Connection Details** section
2. Copy the connection string - it looks like:
   ```
   postgresql://username:password@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

3. **IMPORTANT**: This contains your password. Keep it secret!

## Step 4: Add to .env File

In `/mnt/c/letter-irl/.env`, add:

```bash
# Neon PostgreSQL Database
DATABASE_URL=postgresql://username:password@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
```

Replace with your actual connection string from Step 3.

## Step 5: Install Dependencies

```bash
cd /mnt/c/letter-irl
npm install
```

This will install:
- `pg` - PostgreSQL client for Node.js
- `@types/pg` - TypeScript types

## Step 6: Test Connection

```bash
npm run db:test
```

Expected output:
```
🧪 Testing database connection...

📍 Database URL: postgresql://username:****@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb

📊 Database connected successfully
   Time: 2025-01-14 12:00:00.123456+00
   Version: PostgreSQL 16.1

✅ Database connection successful!

Next steps:
  1. Run migrations: npm run db:migrate
  2. Start building APIs!
```

If you see errors, check:
- DATABASE_URL is correctly copied from Neon
- No typos in `.env` file
- Neon project is active (check dashboard)

## Step 7: Run Migrations

Create all database tables:

```bash
npm run db:migrate
```

Expected output:
```
🔄 Running database migrations...

Found 1 pending migration(s):

  - 001_initial_schema.sql

✅ Executed migration: 001_initial_schema.sql

✨ All migrations completed successfully!
```

## Step 8: Verify Tables Created

Back in Neon Dashboard:

1. Go to your project
2. Click "SQL Editor" in left sidebar
3. Run this query:
   ```sql
   SELECT table_name
   FROM information_schema.tables
   WHERE table_schema = 'public';
   ```

4. You should see:
   - `users`
   - `credit_transactions`
   - `orders`
   - `letters`
   - `letter_jobs`
   - `migrations`

## Database Schema Overview

### Tables Created

**users** - User accounts and credit balances
```sql
user_id (PK)        -- Auth0 user ID like "auth0|123456"
email               -- User email (unique)
credits             -- Current credit balance
credits_purchased   -- Lifetime credits purchased
credits_used        -- Lifetime credits used
created_at          -- Account creation timestamp
updated_at          -- Last update timestamp
```

**credit_transactions** - Complete audit trail of all credit changes
```sql
transaction_id (PK) -- Auto-incrementing ID
user_id (FK)        -- References users.user_id
amount              -- Credits added (+) or removed (-)
balance_after       -- Balance snapshot after transaction
type                -- 'purchase', 'deduction', 'refund', 'adjustment'
reference_type      -- 'order', 'letter', 'manual'
reference_id        -- ID of related order/letter
description         -- Human-readable description
created_at          -- Transaction timestamp
```

**orders** - Purchase orders from ACP
```sql
order_id (PK)               -- Unique order identifier
user_id (FK)                -- References users.user_id
credits                     -- Credits purchased
amount_cents                -- Price in cents (e.g., 999 = $9.99)
currency                    -- 'USD'
stripe_payment_intent_id    -- Stripe PaymentIntent ID
status                      -- 'pending', 'completed', 'failed', 'refunded'
created_at                  -- Order creation time
completed_at                -- When order completed
```

**letters** - Letter content and metadata
```sql
letter_id (PK)      -- Unique letter identifier
user_id (FK)        -- References users.user_id
content (JSONB)     -- Full letter content as JSON
recipient (JSONB)   -- Address and recipient info
credits_cost        -- Credits charged for this letter
status              -- 'draft', 'queued', 'processing', 'sent', 'failed'
preview_html        -- HTML preview of letter
tracking_number     -- USPS tracking number (when available)
created_at          -- Letter creation time
sent_at             -- When letter was sent
```

**letter_jobs** - Background jobs for processing letters
```sql
job_id (PK)         -- Unique job identifier
letter_id (FK)      -- References letters.letter_id
status              -- 'pending', 'processing', 'completed', 'failed'
attempts            -- Number of processing attempts
max_attempts        -- Maximum retry attempts (default: 3)
scheduled_at        -- When job should run
started_at          -- When processing started
completed_at        -- When job completed
error_message       -- Error details if failed
metadata (JSONB)    -- Job-specific data
created_at          -- Job creation time
```

## Useful Neon Features

### Database Branching

Create a copy of your database for testing:

1. In Neon Dashboard → "Branches" tab
2. Click "New Branch"
3. Use for testing migrations or new features
4. Delete when done

### Connection Pooling

Neon includes built-in connection pooling. Use the **pooled connection string** for production:

```
DATABASE_URL=postgresql://username:password@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
```

Notice `-pooler` in the hostname.

### Monitoring

In Neon Dashboard:
- **Metrics** tab - See query performance, storage usage
- **Operations** tab - View active queries
- **Settings** tab - Configure auto-suspend, compute size

## NPM Scripts Reference

```bash
# Test database connection
npm run db:test

# Run all pending migrations
npm run db:migrate

# View rollback info (manual process)
npm run db:migrate:rollback

# Start MCP server (uses database)
npm run mcp:http
```

## Troubleshooting

### "relation does not exist"

Migrations haven't been run yet:
```bash
npm run db:migrate
```

### "permission denied for schema public"

Check Neon project is active and database isn't read-only.

### "too many clients"

Connection pool full. This shouldn't happen with Neon's pooling, but if it does:
1. Use pooled connection string (with `-pooler` in hostname)
2. Check for connection leaks in code

### "connection timeout"

Neon auto-suspends after 5 min inactivity on free tier. First query after suspension takes 2-3 seconds to wake up. This is normal.

## ✅ Setup Complete!

All database tables created successfully:

| Table | Status | Columns | Purpose |
|-------|--------|---------|---------|
| users | ✅ | 7 | User accounts & credit balances |
| credit_transactions | ✅ | 9 | Complete audit trail |
| orders | ✅ | 9 | Purchase history |
| letters | ✅ | 10 | Letter content & status |
| letter_jobs | ✅ | 11 | Background job queue |
| migrations | ✅ | 3 | Migration tracking |

**Database Info:**
- Provider: Neon (Serverless PostgreSQL)
- Version: PostgreSQL 17.5
- Connection: Pooled (production-ready)
- Region: US East
- Free tier: 0.5 GB storage

## Next Steps

Now that database is set up:

1. ✅ Database connected and migrated
2. 📝 **Build Credit API** - See `docs/credit-api-implementation.md`
3. 📝 **Build Letter Job Queue** - See `docs/job-queue-implementation.md`
4. 📝 **Build Admin API** - See `docs/admin-api-implementation.md`
5. 🔌 **Integrate with ACP** - See `docs/acp-quickstart.md`

## Implementation Timeline

**Week 1: Database Setup** ✅ COMPLETE
- Neon PostgreSQL project created
- Schema designed and migrated
- Connection tested and verified

**Week 2-3: Credit API** ← YOU ARE HERE
- User service (CRUD operations)
- Credit service (add/deduct/balance/history)
- Express routes and middleware
- Integration with ACP checkout

**Week 3-4: Job Queue**
- pg-boss setup
- Letter job creation and processing
- Retry logic and error handling
- Status tracking

**Week 4-5: Admin API**
- Stats and analytics
- Job monitoring
- Manual operations
- Dashboard endpoints

See individual documentation files for detailed implementation guides.
