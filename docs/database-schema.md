# Database Schema

**Last Updated:** September 24, 2026
**Purpose:** Complete database schema reference for all tables, indexes, constraints, and migrations

This document describes the Letter IRL database schema as defined by `db/migrations` at the head of `dev` (Neon
PostgreSQL). Production is promoted separately and can lag `dev` by several migrations.

---

## Overview

The schema is forward-migrated. Admin foundation migration 022 requires #69's distinct JIT commerce
migration 021 as its immediate predecessor.

| Category | Tables |
|----------|--------|
| Users | `users` |
| Credits | `credit_ledger`, `credit_transactions`, `credit_consumption` |
| Letters | `letters`, `letter_drafts`, `letter_jobs`, `letter_status_history` |
| Payments | `orders`, `stripe_disputes`, `stripe_webhook_events`, `commerce_order_events`, `commerce_pack_refunds` |
| Promos | `promo_campaigns`, `promo_redemptions` |
| Feedback | `feature_requests` |
| System | `migrations`, `personal_access_tokens` |
| Operations | `commerce_operational_alerts`, `commerce_operator_audit_events`, `maintenance_tasks`, `provider_routing` |
| Images | `image_entitlements`, `image_generation_reservations`, `recent_uploads` |
| Gift letters | `gift_letters`, `gift_codes` |
| Retention | `redacted_content_quarantine` |
| Admin foundation | `admin_environment_marker`, `admin_audit_events`, `admin_command_runs`, `admin_operations` |

---

## Tables

### users

User accounts with credit balances and tier information.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| user_id | VARCHAR(255) | NO | - | Primary key. Auth0 user ID (the linked identity's primary subject) |
| email | VARCHAR(255) | NO | - | Unique confirmed email address. **This is the account's identity** |
| credits | INTEGER | NO | 0 | Current credit balance (computed from ledger) |
| credits_purchased | INTEGER | NO | 0 | Total credits ever purchased |
| credits_used | INTEGER | NO | 0 | Total credits ever used |
| tier | user_tier | NO | 'standard' | Current tier (standard, trusted) |
| tier_override | user_tier | YES | NULL | Admin manual override |
| tier_calculated_at | TIMESTAMPTZ | YES | NOW() | Last tier calculation |
| created_at | TIMESTAMPTZ | NO | NOW() | Account creation |
| updated_at | TIMESTAMPTZ | NO | NOW() | Last update (auto-trigger) |
| erased_at | TIMESTAMPTZ | YES | NULL | Set by the account erasure (#289); sign-in refuses an erased account |

**Erased accounts (migration 035).** An erasure keeps the row as a tombstone, because orders, ledger
lots, disputes and refunds keep foreign keys to it ([account-erasure.md](account-erasure.md)). The
`users_erased_tombstone` check requires an erased row to have no return address and an
`erased-<uuid>@erased.invalid` email, so no later write can put a real address back unless the same
statement clears `erased_at`. The admin panel reads an account as erased from that placeholder, since
neither admin role is granted `erased_at`.

**Indexes:**
- `idx_users_email` on email
- `idx_users_created_at` on created_at
- `idx_users_tier` on tier

**The UNIQUE on `email` is load-bearing, and PostgreSQL calls it
`users_email_key`.** Auth0 mints a subject per sign-in method, so one person
arriving by a second method presents an address the first already holds. The
constraint is what stops that becoming two accounts.
- **Moving an address, or opening an account inside a grant:** `EmailAlreadyLinkedError` matches the constraint's name on a 23505, in `updateUserEmail` and in `ensureAccountRowWithClient`. A migration that renames or replaces the constraint has to update `EMAIL_UNIQUE_CONSTRAINT` in `src/services/userService.ts` to match.
- **Opening an account on a first request:** `createUser` skips a conflict on any unique index, then reads what the conflict was (#457). The subject's own row means a request made at the same moment opened it. Otherwise, another subject holding the address is the collision.

Both are proven against a real database in `tests/integration/accountIdentity.postgres.test.ts` (`src/services/userService.ts`).

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
| description | TEXT | YES | - | Derived, data-free label (`Sent letter (2 credits)`, `Operator adjustment`); never a recipient name or an operator's reason since migration 030; not selectable by the admin reader role |
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
| description | TEXT | YES | - | Derived, data-free label (`Sent letter (2 credits)`, `Operator adjustment`); never a recipient name or an operator's reason since migration 030; not selectable by the admin reader role |
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
| is_gift_send | BOOLEAN | NO | false | Previewed as a gift send: funded by a gift letter and printed with its card (033) |
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
| error_message | TEXT | YES | - | Legacy twin of `last_error`; an error class and provider status only, never provider or driver message text (migrations 031, 032) |
| metadata | JSONB | YES | - | Job-specific data |
| created_at | TIMESTAMPTZ | NO | NOW() | Job creation |

**Indexes:**
- `idx_letter_jobs_status` on status
- `idx_letter_jobs_scheduled_at` on scheduled_at
- `idx_letter_jobs_letter_id` on letter_id

---

Migrations 020 and 023 turned this table into the transactional outbox. Added since the columns above:
`idempotency_key` and `next_attempt_at` (both required), `locked_at`, `provider_order_id`,
`provider_outcome` (`not_dispatched`, `dispatching`, `accepted`, `definite_failure`, `ambiguous`),
`provider_dispatch_started_at`, `held_at`, `hold_reason`, `operator_resolution`, `resolved_at`,
`completed_at`, `last_error` and `updated_at`. `status` gained `held`, and a constraint ties each status
to the provider outcomes it may carry. `last_error` and `error_message` hold an error class and provider
status only, `provider_rejected http_400`, never provider message text (migration 031); the unclassified
text of failures from before 023 was rewritten to `error_text_removed` by migration 032.

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

Migration 021 made this the commerce order table. Added since the columns above: `order_type`
(`letter_pack` or `jit_mail`), `draft_id` (required for `jit_mail`), `product_code`, `product_snapshot`,
`letter_id`, `stripe_checkout_session_id`, `idempotency_key`, `paid_at`, `fulfilled_at`,
`refund_pending_at`, `refund_attempts`, `last_error_code` and `last_error`, and later `amount_known`,
`hold_previous_status`, `held_at`, `credits_refunded` and `amount_refunded_cents`. `status` follows the
commerce lifecycle (`checkout_pending`, `paid`, `fulfillment_pending`, `fulfilled`, `payment_failed`,
`refund_pending`, `refunded`, `disputed`, `held`, `cancelled`); `credits` is required for a pack and must
be `NULL` for `jit_mail`. Under the provider, fulfilment, recovery and refund codes `last_error` holds
an error class only: `provider_rejected http_<status>` (migration 031), the draft or outbox check code
(`DRAFT_EXPIRED`, `LETTER_NOT_FOUND`), a diagnostic class, or `error_text_removed` where migration 032
rewrote earlier text (#394). The checkout and amount-mismatch codes store fixed server-authored
sentences (amounts and product codes, never message text). The refund claim no longer writes it.

For `jit_mail`, `product_snapshot.stripeRequest` records the Stripe Price and the return URLs the
order's checkout sends (#279). A retry of an order whose session creation failed reuses the order,
and its idempotency key, only when it would send the same request; otherwise it cancels the order
(`PRICE_CHANGED_BEFORE_SESSION` or `CHECKOUT_REQUEST_CHANGED_BEFORE_SESSION`) and opens a fresh one
with a fresh key, because Stripe refuses a key it has seen with different parameters. Orders from
before the field are compared on amount and currency alone.

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
| credits_amount | INTEGER | NO | - | Credits per redemption (>= 0 since 007). Only a seed campaign may carry 0; 034 ended the ordinary ones that did |
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
| gift_generations_remaining | INTEGER | YES | - | Set on a seed campaign: redeeming grants a gift letter with this budget (033) |
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
| ledger_id | UUID | YES | - | FK to credit_ledger; NULL when a seed campaign granted only a gift letter (033) |
| gift_id | UUID | YES | - | FK to gift_letters, for a seed campaign (033) |
| email_normalized | TEXT | YES | - | The redeemer's normalised email, written for seed campaigns only (033) |
| redeemed_at | TIMESTAMPTZ | NO | NOW() | Redemption timestamp |

**Constraints:**
- UNIQUE(campaign_id, user_id) - One redemption per user per campaign
- `promo_redemption_grants_something`: ledger_id or gift_id is set
- `idx_promo_redemptions_campaign_email` (unique, partial): one claim of a seed campaign per normalised email

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

Personal access tokens (`lirl_pat_…`). People make them on the website, under Dashboard, then Tokens, for MCP clients that take a bearer header (migrations 011 and 037).

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| token_id | SERIAL | NO | - | Primary key |
| user_id | VARCHAR(255) | NO | - | FK to users |
| name | VARCHAR(100) | NO | - | User-friendly name |
| token_hash | VARCHAR(255) | NO | - | Bcrypt hash of token |
| token_prefix | CHAR(4) | NO | - | Last 4 characters, for display |
| status | pat_status | NO | 'active' | `active` or `revoked` |
| expires_at | TIMESTAMPTZ | YES | - | Expiration (NULL = never) |
| last_used_at | TIMESTAMPTZ | YES | - | Last usage timestamp |
| created_at | TIMESTAMPTZ | NO | NOW() | Token creation |
| revoked_at | TIMESTAMPTZ | YES | - | When it was revoked |
| scopes | TEXT[] | NO | `{mail:read,mail:draft}` | What the token may do (037, #470). The allowed values are `mail:read`, `mail:draft` and `mail:send`, and nothing grants `mail:send` today, so no token sends. A send from a token becomes the confirmation link (docs/letter-send-flow.md) |

**Indexes:**
- `idx_personal_access_tokens_user_id` on user_id
- `idx_personal_access_tokens_token_hash` on token_hash

---

### feature_requests

User-submitted feature requests for product feedback.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| request_id | UUID | NO | gen_random_uuid() | Primary key |
| user_id | VARCHAR(255) | NO | - | FK to users |
| title | VARCHAR(200) | NO | - | Brief title for the request |
| description | TEXT | NO | - | Detailed description (max 2000 chars) |
| category | feature_request_category | NO | 'other' | Category enum |
| attempted_action | VARCHAR(255) | YES | - | What user was trying to do |
| contact_email | VARCHAR(255) | YES | - | Email to contact about request |
| contact_consent | BOOLEAN | NO | false | User consents to being contacted |
| status | feature_request_status | NO | 'new' | Status workflow enum |
| admin_notes | TEXT | YES | - | Internal notes |
| created_at | TIMESTAMPTZ | NO | NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NO | NOW() | Last update (auto-trigger) |
| reviewed_at | TIMESTAMPTZ | YES | - | When reviewed by admin |
| resolved_at | TIMESTAMPTZ | YES | - | When resolved |

**Enums:**
- `feature_request_status`: new, reviewed, planned, in_progress, completed, declined, duplicate
- `feature_request_category`: new_feature, improvement, integration, mail_type, international, other

**Indexes:**
- `idx_feature_requests_user_id` on user_id
- `idx_feature_requests_status` on status
- `idx_feature_requests_category` on category
- `idx_feature_requests_created_at` on created_at DESC
- `idx_feature_requests_user_recent` on (user_id, created_at DESC) for rate limiting

**Retention (#393):** the maintenance task `feature-requests-sweep` deletes a row 12 months after
`created_at` (`purgeExpiredFeatureRequests` in `src/services/featureRequestService.ts`), the optional
`contact_email` with it. Nothing updates a row after submission (neither admin role holds `UPDATE`
here, so `status`, `admin_notes`, `reviewed_at` and `resolved_at` are never set), so submission time is
the only clock. The period is published in `docs/privacy-policy.md`.

---

### stripe_webhook_events

One row per Stripe event the API has seen (`event_id` is Stripe's id, so a redelivered event is a
no-op), with the event type, the Stripe object it concerned and the order it was matched to, if any.
The commerce webhook handler claims the row inside the same transaction as the order change it makes,
which is what makes duplicate deliveries harmless. An event that matches no order is operator work
and surfaces on the panel's alert page as an unmatched money event.

### commerce_order_events

Append-only history of an order's status transitions: the event type, the status it left and entered,
and a bounded JSONB `metadata`. A `provider.terminal_failure` event's metadata carries `errorClass`
(`provider_rejected http_400`), never the provider's message text (migration 031). Since migration 032
`jit.fulfillment_rejected` carries `errorClass` too, `refund.requested` carries the refund id and the
order's `last_error_code`, and `operator.quarantine_released` carries only the cleared code: the
operator's typed reason lives in `admin_audit_events` alone (#394).

### commerce_operational_alerts

The operator alert queue: dispute created or closed, ambiguous mail-provider outcome, refunded mail
already dispatched, unmatched money event, and the steps an account erasure leaves an operator to do by
hand (`account_erasure_followup`, migration 036, #453). That last one has no order or source event; its
`details` hold the account id and nothing else. Each alert has a severity and a three-state lifecycle
(`open`, `acknowledged`, `resolved`) whose timestamps and resolution code the constraints keep
consistent, and the acknowledging or resolving actor is stored as a hash. One alert per source event
and type. The panel's acknowledge and resolve commands are the only writers besides the sweeps and the
account erasure that raise them.

### commerce_operator_audit_events

The older operator audit table from the commerce recovery work: hashed idempotency key, actor and
target, a reason code, before and after state, provider evidence and an outcome. `retention_expires_at`
marks two years from the row (#395); nothing enforces it yet, and the purge is designed under #398.
The admin panel writes `admin_audit_events` instead; this table is kept for the four operations it
recorded.

### commerce_pack_refunds

One row per proportional refund of a letter pack (#323): the letters, credits and amount being
returned, the Stripe payment intent and the idempotency key the refund is submitted under, attempts,
and a status machine (`letters_revoked`, `stripe_pending`, `succeeded`, `failed`, `compensated`) whose
constraints tie each state to the timestamps and references it requires. Letters leave the ledger first
and the Stripe call follows, so a Stripe failure leaves a `failed` row an operator can compensate. The
actor and the idempotency key are stored as hashes; `admin_command_id` links the run that caused it.

### image_entitlements

Grants of image generations to an account: the source that granted them (a purchase, a promo, or an
operator command, with its reference and order), the quantity, how many are consumed, a status
(`active`, `depleted`, `expired`, `revoked`) and an optional expiry. One entitlement per source
reference, so a replayed grant is a no-op.

### gift_letters

The gift letter entitlement ([gift-letters.md](gift-letters.md)): one row per gift letter, with its
budget (`generations_remaining`), its source (`pack_purchase`, `seed_redemption`,
`chain_redemption`, `operator`, `send_failed`) and reference, the order or campaign that granted it,
the chain code that granted it (`parent_code`), an optional seed campaign whose code it prints
(`card_campaign_id`), a status (`available`, `consumed`, `expired`, `revoked`), an expiry, the letter
that used it, and `source_reversed_at` when the purchase behind a used gift is refunded or disputed.
Unique per `(source, source_reference_id, grant_index)`, so a replayed grant is a no-op.

### gift_codes

Single-use chain codes, one per gift letter sent with budget left: the canonical 8-character
Crockford code (primary key, format CHECK), the gift letter and the letter it was printed on (each
UNIQUE: the branching factor of 1 that bounds the cost), the sender, the budget it grants, a status
(`issued`, `redeemed`, `void`), an expiry, the redeemer, and a void class (`send_failed`,
`purchase_reversed`, `operator`).

### image_generation_reservations

One row per generation attempt against an entitlement, `reserved` while the provider call is in
flight and then `consumed` or `released`. A reservation whose outcome is unknown stays `reserved`; the
panel's image recovery page lists those and the resolve command settles them with evidence.

### recent_uploads

The most recent uploaded image per user (one row per `user_id`), kept so a widget that lost its
in-memory state can recover the image it was about to send. The URL is a capability URL and is
treated as one (#282):

- A read returns the row for at most `LETTER_IRL_RECENT_UPLOAD_TTL_MS`. The default is one hour,
  the cap in code is six hours, and an unreadable value falls back to one hour.
- The maintenance task `recent-uploads-sweep` deletes a row 24 hours after its last update
  (`purgeExpiredRecentUploads`). The six-hour cap keeps every readable row younger than that.
- The API process also holds a copy in memory, and drops it once it is older than the TTL. That is
  checked on every call and every five minutes.

### maintenance_tasks

One row per scheduled maintenance task (`task_name` is the key) with its last start, completion,
lock, status and error class (a class since migration 032, never the driver's message). The panel's
maintenance page shows whether a task has an error, never the
text. The maintenance runner claims a task by its `locked_at` so two instances cannot run it at once.

### provider_routing

Which mail provider serves each mail type (`text_only_letter`, `header_image_letter`,
`inline_image_letter`, `postcard`) and whether it is enabled, versioned by `updated_at`. The panel's
routing command validates a change against the runtime provider registry; production never accepts
`dummy`.

### redacted_content_quarantine

Where the content-retention sweep (migration 026) puts what it clears from `letters` and
`letter_drafts`: every cleared column keyed by name in `content`, so a restore is a mechanical
write-back, with a `purge_after` deadline. One live row per source row. The admin reader role has
column-level `SELECT` on this table that omits `content`.

The first copy wins. A sweep saves a row's content only when no copy of it exists
(`ON CONFLICT DO NOTHING`), and a copy is never updated, so a sweep re-run over a row whose `redacted_at`
was cleared by hand keeps the copy that holds the content. Migration 026's comment on
`uniq_quarantine_source` says a re-redaction replaces the copy; that stopped being true with #153's
enforce-path fixes, and applied migrations are not edited. Do not edit a redacted row's content by hand
while its copy exists: the next sweep empties it without saving it. Restore it instead.

`purge_after` is the row's own clock plus its published period, or one day after the sweep when that is
later: a row swept after its period (the backlog an enforcing run starts with) keeps its copy for a day.

### admin_environment_marker

Singleton database identity used to fail closed when a development/production selection does not match
the connected branch. Provisioning inserts either `development` or `production`; migration 022 does not
guess or seed it. A constant unique index enforces at most one row.

### admin_audit_events

Append-only actor/action/target/outcome history. UUIDs, stable error codes, session hashes, reasons, and
three bounded JSONB summaries support later authenticated reads, reveals, and commands. A trigger rejects
every `UPDATE` and `DELETE`; public privileges are revoked and provisioned application roles receive no
mutation privilege beyond `INSERT`.

Indexes cover environment plus actor/time, environment plus target/time, and correlation ID. Rows are
kept for 2 years after the action they record and are exempt from account erasure for that period
(#395); nothing enforces the period yet, and the purge is designed under #398. Application rollback
retains all rows.

### admin_command_runs

Durable command state keyed uniquely by `(environment, idempotency_key)`. The table stores the actor
(the `actor_sid` column now holds the operator's tailnet login; the column name is historical), preview
digest, expected version, timestamps, correlation ID, bounded sanitized result, and stable error code.
Status and timing constraints reject inconsistent outcomes.

### admin_operations

Environment-scoped queue of work a command asks for and a deployed worker performs. Each command can
enqueue one operation. Payload/result size, status, attempts, lock, and completion constraints support
deterministic claim/retry behavior; a partial index covers claimable pending rows.

Its one consumer today is the account erasure (#289): `account.erase` queues an `account.erase`
operation with `{ userId }`. The hourly maintenance run claims operations for its own database's
environment (the admin marker) with `SKIP LOCKED` and erases each account in one transaction as the owner
role. It records `succeeded` with counts, or `failed` with `ACCOUNT_ERASURE_BLOCKED`,
`ACCOUNT_ERASURE_NOT_FOUND` or, after three attempts an hour apart, `ACCOUNT_ERASURE_ERROR`
(`src/services/accountErasureService.ts`).

### Admin grants and provisioning

Migration 022 revokes `PUBLIC` privileges but creates no role or credential. The explicit provisioning
script (`npm run admin:provision-access`) requires pre-existing, environment-specific reader/operator
login roles, verifies migrations 021, 022 and the latest migration the grants depend on
(`ADMIN_LATEST_REQUIRED_MIGRATION` in `src/admin/provisioning.ts`) plus the
database marker, rejects privileged roles, and reapplies the grant set in `src/admin/provisioning.ts`:

- **Reader** (`letter_irl_admin_reader_<env>`): `SELECT` on the commerce, ledger, outbox, alert, audit
  and admin tables, and **column-level** `SELECT` on `users` (no `return_address`), `letters` (no
  `content`, `recipient`, `preview_html`), `letter_drafts` (no bodies, addresses, validations or
  images), `personal_access_tokens` (no `token_hash`), `feature_requests` (no `contact_email`),
  `redacted_content_quarantine` (no `content`), and `credit_transactions` and `credit_ledger` (no
  `description`); `INSERT` on `admin_audit_events` only; no `EXECUTE` on functions, including the
  `PUBLIC` default.
- **Operator** (`letter_irl_admin_operator_<env>`): the reader's reads plus whole-row `SELECT` on
  `users`, `letters` and `letter_drafts` (the domain services select whole rows), **column-scoped**
  `INSERT`/`UPDATE` on exactly the columns the enabled commands write (so an operator can adjust
  `users.credits` but not `users.email` or `letters.content`), `INSERT` and a column-limited `UPDATE`
  on the command and operation tables, and sequence usage. `DELETE` exists only on `promo_campaigns`.
- Both: `UPDATE`, `DELETE` and `TRUNCATE` on `admin_audit_events` are revoked; the trigger refuses
  them regardless.

Production provisioning and the first production connection remain separate owner-approved operations
([admin-panel-guide.md](admin-panel-guide.md)).

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
| 14 | 014_update_letter_status_constraint.sql | Update letter status constraint |
| 15 | 015_provider_routing.sql | Provider routing system |
| 16 | 016_feature_requests.sql | Feature request submission (US-FEEDBACK-01) |
| 17 | 017_feature_request_contact.sql | Add contact email and consent fields |
| 18 | 018_image_generation_tracking.sql | Track image generations used |
| 19 | 019_recent_uploads.sql | Durable recent-upload fallback |
| 20 | 020_transactional_outbox.sql | Durable mail outbox and maintenance state |
| 21 | 021_jit_commerce_foundation.sql | JIT commerce foundation owned by issue #69 |
| 22 | 022_admin_audit.sql | Environment marker, append-only audit, command runs, operations, and grants foundation |
| 23 | 023_jit_recovery_state_machines.sql | Held and ambiguous states for jobs, letters and orders; operational alerts; operator audit events |
| 24 | 024_dispute_send_block.sql | Account send-block for disputed payments (#150) |
| 25 | 025_image_generation_ceiling_index.sql | Index for the global daily image-generation ceiling |
| 26 | 026_content_retention.sql | Content retention: redaction sweep and the quarantine table (#153) |
| 27 | 027_purchase_grant_attribution.sql | Every purchase credit grant names the order that funded it |
| 28 | 028_partial_refund_alerts.sql | An unmatched partial refund raises an operator alert |
| 29 | 029_proportional_pack_refunds.sql | Proportional refunds of letter packs (#323) |
| 30 | 030_ledger_description_minimisation.sql | Recipient names and operator reasons rewritten out of the two ledger description columns (#162) |
| 31 | 031_provider_error_minimisation.sql | Provider message text rewritten out of the job, order and order-event error columns (#162) |
| 32 | 032_error_text_minimisation.sql | Raw error text and operator reasons rewritten out of the order, event, outbox, pack-refund and maintenance columns (#394) |
| 33 | 033_gift_letters.sql | Gift letters: gift_letters, gift_codes, the gift_letter funding type, gift drafts, seed campaigns and gift-only redemptions |
| 34 | 034_end_zero_letter_promos.sql | Ends the ordinary promo campaigns that grant no letters (the preview-gate codes 007 seeded), which could never be redeemed (#420) |
| 35 | 035_account_erasure.sql | Account erasure: `users.erased_at`, and the `users_erased_tombstone` CHECK that holds an erased row to its placeholder email and no return address (#289) |
| 36 | 036_account_erasure_followup_alert.sql | The `account_erasure_followup` alert type, which an erasure opens for the steps done by hand (#453) |

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

A gift letter also carries the card the send decided, so every process that prints it prints the
same code and link:

```json
{
  "giftCard": {
    "state": "funded",
    "code": "K7M2QX9A",
    "url": "https://letterirl.com/g/K7M2QX9A",
    "displayUrl": "letterirl.com/g",
    "redeemBy": "2026-12-16"
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

### commerce_order_events.metadata

Bounded JSONB. For `provider.terminal_failure` and, since migration 032, `jit.fulfillment_rejected`:

```json
{ "errorClass": "provider_rejected http_400" }
```

Since migration 031 the provider's message text is not stored; the class and HTTP status are the
operational signal. `refund.requested` carries `{ "refundId": "…", "lastErrorCode": "…" }` and
`operator.quarantine_released` carries `{ "clearedCode": "PAYMENT_AMOUNT_MISMATCH" }` (032); the
operator's reason is on the audit row.

## Triggers

All tables with `updated_at` columns have triggers calling `update_updated_at_column()`:
- users
- credit_ledger
- promo_campaigns
- letter_drafts
- stripe_disputes

# Commerce and image entitlements (migration 021)

`orders` is authoritative for both `letter_pack` and `jit_mail` purchases. It
stores the server-selected product snapshot, exact amount/currency, unique
Stripe Checkout Session and PaymentIntent IDs, an application idempotency key,
the bound draft/letter for JIT mail, and payment/fulfillment/refund timestamps.
A partial unique index permits only one active JIT order per draft.

`stripe_webhook_events` claims each verified Stripe event ID in the same
transaction as its order transition. `commerce_order_events` provides a
sanitized transition audit trail. `letters.funding_type` records either
`prepaid_balance` or `jit_order`, and JIT-funded letters reference exactly one
commerce order.

`image_entitlements` replaces the lifetime `credits_purchased` formula with
explicit replay-safe grants. `image_generation_reservations` binds each atomic
generation reservation to its exact grant so failed provider calls can release
the correct unit. Migration 021 preserves previously earned allowances as a
`legacy_migration` grant.

Migration 023 extends each reservation with a durable dispatch lease and
provider outcome state. `reserved` means no provider dispatch has been durably
authorized, `dispatched` is the pre-network boundary, `consumed` and `released`
are definite outcomes, and `ambiguous` quarantines an outcome that cannot be
proved after dispatch. Ambiguous rows retain quota until provider evidence or
an explicit customer-compensation decision resolves them. A unique non-null
provider request ID supports reconciliation without exposing it in logs.
`commerce_operator_audit_events` records privacy-minimized hashes for the
authenticated actor, target, and idempotency key plus constrained before/after
state and provider-evidence classifications. It is append-only, has no user or
domain foreign keys that could block account deletion, and expires into an
owner-controlled retention workflow. The durable audit insert and exact
reservation/entitlement mutation share one transaction.

`commerce_operational_alerts` stores sanitized Stripe dispute work in the same
transaction as `stripe_webhook_events`. Its unique source-event/type key makes
replay safe, while open/acknowledged/resolved states survive process restarts.
The same table surfaces ambiguous mail dispatch and refund-after-dispatch work,
and the manual follow-up of an account erasure;
operator transitions are idempotent and append an audit event atomically.
