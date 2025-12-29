# Database Schema

**Last Updated:** December 29, 2025
**Purpose:** Complete database schema reference for all tables, indexes, constraints, and migrations

This document describes the Letter IRL database schema as deployed in production (Neon PostgreSQL).

---

## Overview

**13 Tables** across 13 migrations:

| Category | Tables |
|----------|--------|
| Users | `users` |
| Credits | `credit_ledger`, `credit_transactions`, `credit_consumption` |
| Letters | `letters`, `letter_drafts`, `letter_jobs`, `letter_status_history` |
| Payments | `orders`, `stripe_disputes` |
| Promos | `promo_campaigns`, `promo_redemptions` |
| System | `migrations`, `personal_access_tokens` |

---

## Tables

### users

User accounts with credit balances and tier information.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| user_id | VARCHAR(255) | NO | - | Primary key. Auth0 user ID |
| email | VARCHAR(255) | NO | - | Unique email address |
| credits | INTEGER | NO | 0 | Current credit balance (computed from ledger) |
| credits_purchased | INTEGER | NO | 0 | Total credits ever purchased |
| credits_used | INTEGER | NO | 0 | Total credits ever used |
| tier | user_tier | NO | 'standard' | Current tier (standard, trusted) |
| tier_override | user_tier | YES | NULL | Admin manual override |
| tier_calculated_at | TIMESTAMPTZ | YES | NOW() | Last tier calculation |
| created_at | TIMESTAMPTZ | NO | NOW() | Account creation |
| updated_at | TIMESTAMPTZ | NO | NOW() | Last update (auto-trigger) |

**Indexes:**
- `idx_users_email` on email
- `idx_users_created_at` on created_at
- `idx_users_tier` on tier

---

### credit_ledger

Serialized credit entries with expiration tracking. Source of truth for balances.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| ledger_id | UUID | NO | gen_random_uuid() | Primary key |
| user_id | VARCHAR(255) | NO | - | FK to users |
| initial_amount | INTEGER | NO | - | Credits added (must be > 0) |
| remaining_amount | INTEGER | NO | - | Credits available (>= 0) |
| source_type | credit_source_type | NO | - | purchase, promo, adjustment, etc. |
| source_reference_id | VARCHAR(255) | YES | - | order_id, promo_code, etc. |
| source_metadata | JSONB | YES | - | Additional context |
| activated_at | TIMESTAMPTZ | NO | NOW() | When credits became available |
| expires_at | TIMESTAMPTZ | YES | - | Expiration (NULL = never) |
| expiration_policy | VARCHAR(50) | YES | - | fixed_date, days_from_activation, never |
| expiration_days | INTEGER | YES | - | Days until expiration |
| status | credit_ledger_status | NO | 'active' | active, depleted, expired, revoked |
| description | TEXT | YES | - | Human-readable description |
| related_ledger_id | UUID | YES | - | Links refunds to original |
| created_at | TIMESTAMPTZ | NO | NOW() | Entry creation |
| updated_at | TIMESTAMPTZ | NO | NOW() | Last update |

**Enums:**
- `credit_source_type`: purchase, signup_bonus, promo, adjustment, refund, legacy
- `credit_ledger_status`: active, depleted, expired, revoked

**Indexes:**
- `idx_credit_ledger_user_id` on user_id
- `idx_credit_ledger_user_active` on user_id WHERE status='active' AND remaining_amount > 0
- `idx_credit_ledger_consumption_order` on (user_id, expires_at NULLS LAST, created_at) for FIFO
- `idx_credit_ledger_expires_at` on expires_at WHERE NOT NULL AND status='active'
- `idx_credit_ledger_source_ref` on source_reference_id

---

### credit_transactions

Complete audit trail of all credit changes.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| transaction_id | SERIAL | NO | - | Primary key |
| user_id | VARCHAR(255) | NO | - | FK to users |
| amount | INTEGER | NO | - | Change (+purchase, -deduction) |
| balance_after | INTEGER | NO | - | Balance snapshot after change |
| type | VARCHAR(50) | NO | - | purchase, deduction, refund, adjustment |
| reference_type | VARCHAR(50) | YES | - | order, letter, manual |
| reference_id | VARCHAR(255) | YES | - | Related order_id, letter_id |
| description | TEXT | YES | - | Human-readable description |
| created_at | TIMESTAMPTZ | NO | NOW() | Transaction timestamp |

**Indexes:**
- `idx_credit_transactions_user_id` on user_id
- `idx_credit_transactions_created_at` on created_at DESC
- `idx_credit_transactions_type` on type

---

### credit_consumption

Links credit usage to specific ledger entries (audit trail for FIFO consumption).

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| consumption_id | UUID | NO | gen_random_uuid() | Primary key |
| transaction_id | INTEGER | NO | - | FK to credit_transactions |
| ledger_id | UUID | NO | - | FK to credit_ledger (source) |
| amount | INTEGER | NO | - | Credits consumed (> 0) |
| ledger_remaining_after | INTEGER | NO | - | Ledger remaining after consumption |
| created_at | TIMESTAMPTZ | NO | NOW() | Consumption timestamp |

**Constraints:**
- UNIQUE(transaction_id, ledger_id) - Each ledger entry consumed once per transaction

---

### letter_drafts

Temporary drafts for idempotent send operations. Prevents duplicate sends.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| draft_id | UUID | NO | gen_random_uuid() | Primary key (idempotency key) |
| user_id | VARCHAR(255) | NO | - | FK to users |
| mail_type | mail_type | NO | 'letter' | letter or postcard (enum) |
| sender | JSONB | NO | - | Sender address |
| recipient | JSONB | NO | - | Recipient address |
| body_text | TEXT | NO | - | Letter content (message for postcards) |
| sign_off | TEXT | YES | - | Closing text (NULL for postcards) |
| required_credits | INTEGER | NO | - | Credits needed (> 0) |
| preview_html | TEXT | YES | - | Generated preview |
| sender_validation | JSONB | YES | - | Cached address validation |
| recipient_validation | JSONB | YES | - | Cached address validation |
| status | draft_status | NO | 'pending' | pending, consumed, expired, cancelled |
| expires_at | TIMESTAMPTZ | NO | - | Expiration (24h from creation) |
| consumed_at | TIMESTAMPTZ | YES | - | When draft was sent |
| consumed_letter_id | VARCHAR(255) | YES | - | FK to letters (after send) |
| front_image_data | TEXT | YES | - | Base64 JPEG for postcard front (NULL for letters) |
| front_image_url | TEXT | YES | - | Original image URL for debugging |
| postcard_size | VARCHAR(10) | YES | - | Postcard size: '6x9' (NULL for letters) |
| created_at | TIMESTAMPTZ | NO | NOW() | Draft creation |
| updated_at | TIMESTAMPTZ | NO | NOW() | Last update |

**Enum:**
- `draft_status`: pending, consumed, expired, cancelled

**Constraints:**
- `postcard_requires_image`: Postcards must have front_image_data
- `postcard_requires_size`: Postcards must have postcard_size
- `valid_postcard_size`: postcard_size must be '6x4', '6x9', or '6x11'

**Indexes:**
- `idx_letter_drafts_user_pending` on (user_id, status) WHERE status='pending'
- `idx_letter_drafts_expires_at` on expires_at WHERE status='pending'
- `idx_letter_drafts_consumed_letter` on consumed_letter_id WHERE NOT NULL
- `idx_letter_drafts_id_user` on (draft_id, user_id)
- `idx_letter_drafts_mail_type` on mail_type

---

### letters

Sent letters with content and tracking.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| letter_id | VARCHAR(255) | NO | - | Primary key |
| user_id | VARCHAR(255) | NO | - | FK to users |
| mail_type | mail_type | NO | 'letter' | letter or postcard (enum) |
| content | JSONB | NO | - | Letter content (body, sender, etc.) |
| recipient | JSONB | NO | - | Recipient address |
| credits_cost | INTEGER | NO | - | Credits charged (> 0) |
| status | VARCHAR(50) | NO | - | queued, processing, sent, failed, cancelled |
| preview_html | TEXT | YES | - | HTML preview |
| tracking_id | VARCHAR(255) | YES | - | Provider tracking ID (PostGrid) |
| provider | VARCHAR(50) | YES | - | postgrid, dummy |
| cost_cents | INTEGER | YES | - | Actual provider cost |
| expected_delivery | TIMESTAMPTZ | YES | - | Provider ETA |
| created_at | TIMESTAMPTZ | NO | NOW() | Letter creation |
| sent_at | TIMESTAMPTZ | YES | - | When sent to provider |
| updated_at | TIMESTAMPTZ | YES | - | Last update |

**Enums:**
- `mail_type`: letter, postcard

**Indexes:**
- `idx_letters_user_id` on user_id
- `idx_letters_status` on status
- `idx_letters_created_at` on created_at DESC
- `idx_letters_tracking_id` on tracking_id
- `idx_letters_provider` on provider
- `idx_letters_mail_type` on mail_type

---

### letter_jobs

Background job tracking for letter processing.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| job_id | VARCHAR(255) | NO | - | Primary key |
| letter_id | VARCHAR(255) | NO | - | FK to letters |
| status | VARCHAR(50) | NO | - | pending, processing, completed, failed, cancelled |
| attempts | INTEGER | NO | 0 | Number of attempts |
| max_attempts | INTEGER | NO | 3 | Retry limit |
| scheduled_at | TIMESTAMPTZ | NO | - | When job should run |
| started_at | TIMESTAMPTZ | YES | - | When processing started |
| completed_at | TIMESTAMPTZ | YES | - | When finished |
| error_message | TEXT | YES | - | Last error |
| metadata | JSONB | YES | - | Job-specific data |
| created_at | TIMESTAMPTZ | NO | NOW() | Job creation |

**Indexes:**
- `idx_letter_jobs_status` on status
- `idx_letter_jobs_scheduled_at` on scheduled_at
- `idx_letter_jobs_letter_id` on letter_id

---

### orders

Purchase orders from Stripe.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| order_id | VARCHAR(255) | NO | - | Primary key |
| user_id | VARCHAR(255) | NO | - | FK to users |
| credits | INTEGER | NO | - | Credits purchased (> 0) |
| amount_cents | INTEGER | NO | - | Payment amount in cents (> 0) |
| currency | VARCHAR(3) | NO | 'USD' | Currency code |
| stripe_payment_intent_id | VARCHAR(255) | YES | - | Unique Stripe payment intent |
| status | VARCHAR(50) | NO | - | pending, completed, failed, refunded |
| created_at | TIMESTAMPTZ | NO | NOW() | Order creation |
| completed_at | TIMESTAMPTZ | YES | - | Order completion |

**Indexes:**
- `idx_orders_user_id` on user_id
- `idx_orders_status` on status
- `idx_orders_created_at` on created_at DESC
- `idx_orders_stripe_payment_intent_id` on stripe_payment_intent_id

---

### stripe_disputes

Chargeback tracking for admin monitoring.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| dispute_id | TEXT | NO | - | Primary key (Stripe dispute ID) |
| charge_id | TEXT | NO | - | Stripe charge ID |
| payment_intent_id | TEXT | YES | - | Stripe payment intent |
| user_id | TEXT | YES | - | FK to users (ON DELETE SET NULL) |
| amount_cents | INTEGER | NO | - | Dispute amount |
| currency | TEXT | NO | 'usd' | Currency |
| reason | TEXT | YES | - | Dispute reason |
| status | TEXT | NO | 'open' | open, won, lost, under_review |
| evidence_due_by | TIMESTAMPTZ | YES | - | Evidence deadline |
| stripe_created_at | TIMESTAMPTZ | YES | - | When Stripe created dispute |
| created_at | TIMESTAMPTZ | NO | NOW() | Record creation |
| resolved_at | TIMESTAMPTZ | YES | - | Resolution timestamp |
| metadata | JSONB | YES | '{}' | Additional data |
| updated_at | TIMESTAMPTZ | NO | NOW() | Last update |

**Indexes:**
- `idx_stripe_disputes_user_id` on user_id
- `idx_stripe_disputes_status` on status
- `idx_stripe_disputes_charge_id` on charge_id

---

### promo_campaigns

Promotional credit campaigns with redeemable codes.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| campaign_id | UUID | NO | gen_random_uuid() | Primary key |
| code | VARCHAR(50) | NO | - | Unique promo code (case-insensitive) |
| name | VARCHAR(255) | NO | - | Campaign name |
| description | TEXT | YES | - | Description |
| credits_amount | INTEGER | NO | - | Credits per redemption (> 0) |
| expiration_policy | VARCHAR(50) | NO | 'days_from_activation' | Expiration policy |
| expiration_days | INTEGER | YES | 90 | Days until credits expire |
| fixed_expiration_date | TIMESTAMPTZ | YES | - | For fixed_date policy |
| max_total_redemptions | INTEGER | YES | - | Total limit (NULL = unlimited) |
| max_per_user | INTEGER | NO | 1 | Per-user limit |
| current_redemptions | INTEGER | NO | 0 | Current redemption count |
| starts_at | TIMESTAMPTZ | NO | NOW() | Campaign start |
| ends_at | TIMESTAMPTZ | YES | - | Campaign end (NULL = no end) |
| requires_new_user | BOOLEAN | NO | false | New users only |
| status | VARCHAR(50) | NO | 'draft' | draft, active, paused, ended, expired |
| created_by | VARCHAR(255) | YES | - | Admin who created |
| created_at | TIMESTAMPTZ | NO | NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NO | NOW() | Last update |

**Indexes:**
- `idx_promo_campaigns_code` on LOWER(code)
- `idx_promo_campaigns_status` on status
- `idx_promo_campaigns_active` on (status, starts_at, ends_at) WHERE status='active'

---

### promo_redemptions

User promo code redemption tracking.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| redemption_id | UUID | NO | gen_random_uuid() | Primary key |
| campaign_id | UUID | NO | - | FK to promo_campaigns |
| user_id | VARCHAR(255) | NO | - | FK to users |
| ledger_id | UUID | NO | - | FK to credit_ledger |
| redeemed_at | TIMESTAMPTZ | NO | NOW() | Redemption timestamp |

**Constraints:**
- UNIQUE(campaign_id, user_id) - One redemption per user per campaign

---

### migrations

Migration tracking table.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | SERIAL | NO | - | Primary key |
| name | VARCHAR(255) | NO | - | Migration filename (unique) |
| executed_at | TIMESTAMPTZ | NO | NOW() | Execution timestamp |

---

### letter_status_history

Historical record of all status changes for letters and postcards.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | SERIAL | NO | - | Primary key |
| letter_id | VARCHAR(255) | NO | - | FK to letters |
| old_status | VARCHAR(50) | YES | - | Previous status (NULL for first entry) |
| new_status | VARCHAR(50) | NO | - | New status |
| changed_at | TIMESTAMPTZ | NO | NOW() | When status changed |
| changed_by | VARCHAR(50) | YES | - | Source of change (system, worker, admin) |
| metadata | JSONB | YES | - | Additional context |

**Indexes:**
- `idx_letter_status_history_letter_id` on letter_id
- `idx_letter_status_history_changed_at` on changed_at DESC

---

### personal_access_tokens

API tokens for programmatic access (future use).

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| token_id | UUID | NO | gen_random_uuid() | Primary key |
| user_id | VARCHAR(255) | NO | - | FK to users |
| token_hash | VARCHAR(255) | NO | - | Bcrypt hash of token |
| name | VARCHAR(255) | NO | - | User-friendly name |
| last_used_at | TIMESTAMPTZ | YES | - | Last usage timestamp |
| expires_at | TIMESTAMPTZ | YES | - | Expiration (NULL = never) |
| created_at | TIMESTAMPTZ | NO | NOW() | Token creation |

**Indexes:**
- `idx_personal_access_tokens_user_id` on user_id
- `idx_personal_access_tokens_token_hash` on token_hash

---

## Migrations History

| # | File | Description |
|---|------|-------------|
| 1 | 001_initial_schema.sql | Core tables: users, credit_transactions, orders, letters, letter_jobs |
| 2 | 002_add_provider_fields.sql | Add provider, tracking_id, cost_cents, expected_delivery to letters |
| 3 | 003_credit_ledger.sql | Credit ledger with expiration, promo campaigns, consumption tracking |
| 4 | 004_letter_drafts.sql | Draft-based idempotency system |
| 5 | 005_user_tiers.sql | User tier system for rate limiting |
| 6 | 006_stripe_disputes.sql | Chargeback/dispute tracking |
| 7 | 007_seed_preview_promos.sql | Preview access promo codes |
| 8 | 008_status_sync.sql | Status sync tracking columns |
| 9 | 009_letter_status_history.sql | Historical status change tracking |
| 10 | 010_user_return_address.sql | Saved return addresses per user |
| 11 | 011_personal_access_tokens.sql | API token authentication |
| 12 | 012_mail_types.sql | Postcard support (mail_type enum, postcard fields) |
| 13 | 013_letter_layouts.sql | Layout support for letters (text-only, header, inline images) |

---

## JSONB Column Formats

### letters.content
```json
{
  "bodyText": "Letter body content...",
  "signOff": "Sincerely,",
  "sender": {
    "name": "Sender Name",
    "addressLine1": "123 Main St",
    "addressLine2": "Apt 1",
    "city": "City",
    "state": "ST",
    "postalCode": "12345",
    "country": "US"
  }
}
```

### letters.recipient / letter_drafts.recipient
```json
{
  "name": "Recipient Name",
  "addressLine1": "456 Other St",
  "addressLine2": "Suite 200",
  "city": "City",
  "state": "ST",
  "postalCode": "12345",
  "country": "US"
}
```

### credit_ledger.source_metadata
```json
{
  "stripe_session_id": "cs_xxx",
  "stripe_payment_intent": "pi_xxx",
  "package_type": "credit-pack-10"
}
```

---

## Triggers

All tables with `updated_at` columns have triggers calling `update_updated_at_column()`:
- users
- credit_ledger
- promo_campaigns
- letter_drafts
- stripe_disputes
