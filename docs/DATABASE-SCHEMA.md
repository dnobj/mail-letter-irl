# Database Schema

This document describes the Letter IRL database schema as it exists in production.

## Tables

### users
User accounts with credit balances.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| user_id | VARCHAR(255) | NO | Primary key. Auth0 user ID (e.g., "auth0\|123456") |
| email | VARCHAR(255) | NO | Unique email address |
| credits | INTEGER | NO | Current credit balance (default: 0, must be >= 0) |
| credits_purchased | INTEGER | NO | Total credits ever purchased |
| credits_used | INTEGER | NO | Total credits ever used |
| created_at | TIMESTAMP | NO | Account creation timestamp |
| updated_at | TIMESTAMP | NO | Last update timestamp (auto-updated via trigger) |

### credit_transactions
Complete audit trail of all credit changes.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| transaction_id | SERIAL | NO | Primary key |
| user_id | VARCHAR(255) | NO | Foreign key to users |
| amount | INTEGER | NO | Credit change (positive for purchase/refund, negative for use) |
| balance_after | INTEGER | NO | Snapshot of balance after this transaction |
| type | VARCHAR(50) | NO | One of: 'purchase', 'deduction', 'refund', 'adjustment' |
| reference_type | VARCHAR(50) | YES | Context: 'order', 'letter', 'manual' |
| reference_id | VARCHAR(255) | YES | Related order_id, letter_id, or admin note |
| description | TEXT | YES | Human-readable description |
| created_at | TIMESTAMP | NO | Transaction timestamp |

### orders
Purchase orders from Stripe or other payment methods.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| order_id | VARCHAR(255) | NO | Primary key |
| user_id | VARCHAR(255) | NO | Foreign key to users |
| credits | INTEGER | NO | Number of credits purchased (must be > 0) |
| amount_cents | INTEGER | NO | Payment amount in cents (must be > 0) |
| currency | VARCHAR(3) | NO | Currency code (default: 'USD') |
| stripe_payment_intent_id | VARCHAR(255) | YES | Unique Stripe payment intent ID |
| status | VARCHAR(50) | NO | One of: 'pending', 'completed', 'failed', 'refunded' |
| created_at | TIMESTAMP | NO | Order creation timestamp |
| completed_at | TIMESTAMP | YES | Order completion timestamp |

### letters
Letter content and delivery information.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| letter_id | VARCHAR(255) | NO | Primary key |
| user_id | VARCHAR(255) | NO | Foreign key to users |
| content | JSONB | NO | Letter content as JSON (body, formatting, etc.) |
| recipient | JSONB | NO | Recipient address as JSON (name, address1, city, state, zip, country) |
| credits_cost | INTEGER | NO | Credits charged for this letter (must be > 0) |
| status | VARCHAR(50) | NO | One of: 'draft', 'queued', 'processing', 'sent', 'failed', 'cancelled' |
| preview_html | TEXT | YES | HTML preview of the letter |
| tracking_id | VARCHAR(255) | YES | Provider tracking ID (e.g., PostGrid letter ID) |
| created_at | TIMESTAMP | NO | Letter creation timestamp |
| sent_at | TIMESTAMP | YES | When letter was sent to provider |
| provider | VARCHAR(50) | YES | Letter fulfillment provider (dummy, postgrid, lob, etc.) |
| cost_cents | INTEGER | YES | Actual cost charged by provider in cents |
| expected_delivery | TIMESTAMP | YES | Provider estimated delivery date |
| updated_at | TIMESTAMP | YES | Last update timestamp |

### letter_jobs
Background jobs for processing and sending letters.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| job_id | VARCHAR(255) | NO | Primary key |
| letter_id | VARCHAR(255) | NO | Foreign key to letters |
| status | VARCHAR(50) | NO | One of: 'pending', 'processing', 'completed', 'failed', 'cancelled' |
| attempts | INTEGER | NO | Number of attempts made (default: 0) |
| max_attempts | INTEGER | NO | Maximum retry attempts (default: 3) |
| scheduled_at | TIMESTAMP | NO | When job should run |
| started_at | TIMESTAMP | YES | When job started processing |
| completed_at | TIMESTAMP | YES | When job finished |
| error_message | TEXT | YES | Error message if job failed |
| metadata | JSONB | YES | Job-specific data |
| created_at | TIMESTAMP | NO | Job creation timestamp |

## Indexes

### users
- `idx_users_email` on email
- `idx_users_created_at` on created_at

### credit_transactions
- `idx_credit_transactions_user_id` on user_id
- `idx_credit_transactions_created_at` on created_at DESC
- `idx_credit_transactions_type` on type

### orders
- `idx_orders_user_id` on user_id
- `idx_orders_status` on status
- `idx_orders_created_at` on created_at DESC
- `idx_orders_stripe_payment_intent_id` on stripe_payment_intent_id

### letters
- `idx_letters_user_id` on user_id
- `idx_letters_status` on status
- `idx_letters_created_at` on created_at DESC
- `idx_letters_tracking_id` on tracking_id
- `idx_letters_provider` on provider

### letter_jobs
- `idx_letter_jobs_status` on status
- `idx_letter_jobs_scheduled_at` on scheduled_at
- `idx_letter_jobs_letter_id` on letter_id

## Migrations

| Migration | Description |
|-----------|-------------|
| 001_initial_schema.sql | Creates all tables, indexes, and triggers |
| 002_add_provider_fields.sql | Renames tracking_number to tracking_id, adds provider, cost_cents, expected_delivery, updated_at |

## Notes

### Column Name Changes (Migration 002)
- `tracking_number` was renamed to `tracking_id` for consistency with provider terminology
- Code must use `tracking_id`, not `tracking_number`

### JSON Column Formats

**letters.content**:
```json
{
  "bodyText": "Letter body content...",
  "signOff": "Sincerely,",
  "sender": {
    "name": "Sender Name",
    "addressLine1": "123 Main St",
    "city": "City",
    "state": "ST"
  }
}
```

**letters.recipient**:
```json
{
  "name": "Recipient Name",
  "addressLine1": "456 Other St",
  "addressLine2": "Apt 2",
  "city": "City",
  "state": "ST",
  "postalCode": "12345",
  "country": "US"
}
```
