# Letter Send Flow - Technical Reference

**Last Updated:** December 29, 2025
**Purpose:** Technical reference for letter and postcard send flows, including draft-based idempotency

This document describes the complete flow for sending letters and postcards, including the draft-based idempotency system, credit deduction, job queuing, and delivery.

---

## Overview

The letter and postcard sending process uses a **two-phase commit** pattern with drafts:

1. **Quote Phase** (quote tools) - Creates a draft, locks in pricing
   - `quote_and_preview_letter_text_only`
   - `quote_and_preview_letter_with_header_image`
   - `quote_and_preview_letter_with_image`
   - `quote_and_preview_postcard`

2. **Send Phase** (send tools) - Consumes draft, deducts credits, queues job
   - `send_letter` (for all letter drafts)
   - `send_postcard` (for postcard drafts)

This prevents duplicate sends and ensures credits are deducted exactly once.

---

## Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           QUOTE PHASE                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  User Request                                                                │
│       │                                                                      │
│       ▼                                                                      │
│  quote_and_preview_[tool_variant](recipient, body, sender, signOff, image?)  │
│       │                                                                      │
│       ├──► Calculate required credits (based on page count)                  │
│       │                                                                      │
│       ├──► Generate preview HTML                                             │
│       │                                                                      │
│       ├──► CREATE DRAFT in letter_drafts table                               │
│       │    - status: 'pending'                                               │
│       │    - expires_at: NOW() + 24 hours                                    │
│       │    - Stores: sender, recipient, body, signOff, required_credits      │
│       │                                                                      │
│       ▼                                                                      │
│  Return: { draftId, previewHtml, requiredCredits, canSendNow }              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ User confirms
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            SEND PHASE                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  send_letter/send_postcard(draftId, confirm: true)                           │
│       │                                                                      │
│       ├──► CONSUME DRAFT (atomic operation)                                  │
│       │    - Validates: draft exists, owned by user, not expired             │
│       │    - Updates status: 'pending' → 'consumed'                          │
│       │    - Sets consumed_at timestamp                                      │
│       │                                                                      │
│       │    IF draft already consumed:                                        │
│       │       └──► Return existing letter (idempotent retry)                 │
│       │                                                                      │
│       ├──► DEDUCT CREDITS                                                    │
│       │    - Uses credit_ledger (FIFO by expiration)                         │
│       │    - Records in credit_consumption table                             │
│       │    - Atomic transaction with SELECT FOR UPDATE                       │
│       │                                                                      │
│       ├──► CREATE LETTER in letters table                                    │
│       │    - status: 'queued'                                                │
│       │    - Links to draft via letter_drafts.letter_id                      │
│       │                                                                      │
│       ├──► QUEUE JOB via pg-boss                                             │
│       │    - Creates entry in letter_jobs table                              │
│       │    - Adds job to pgboss.job queue                                    │
│       │                                                                      │
│       ▼                                                                      │
│  Return: { orderId, status: 'queued_for_print', creditsRemaining }          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Background worker picks up job
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PROCESSING PHASE                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  letterWorker.ts (pg-boss worker)                                            │
│       │                                                                      │
│       ├──► Update letter status: 'queued' → 'processing'                     │
│       │                                                                      │
│       ├──► Get active provider (PostGrid in production)                      │
│       │                                                                      │
│       ├──► SEND TO PROVIDER                                                  │
│       │    - PostGrid: Create letter via API                                 │
│       │    - Returns: tracking_id, cost_cents, expected_delivery             │
│       │                                                                      │
│       ├──► Update letter with provider response                              │
│       │    - status: 'processing' → 'sent'                                   │
│       │    - tracking_id, provider, cost_cents, expected_delivery            │
│       │                                                                      │
│       ├──► Update job status: 'completed'                                    │
│       │                                                                      │
│       │    ON FAILURE:                                                       │
│       │       ├──► Increment attempts                                        │
│       │       ├──► If attempts < max_attempts: retry with backoff            │
│       │       └──► If attempts >= max_attempts: mark as 'failed'             │
│       │                                                                      │
│       ▼                                                                      │
│  Letter delivered to PostGrid for printing and mailing                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Database Tables Involved

### letter_drafts
Stores draft letters before confirmation.

| Column | Description |
|--------|-------------|
| draft_id | UUID primary key |
| user_id | Owner of the draft |
| status | 'pending', 'consumed', 'expired', 'cancelled' |
| sender | JSONB - sender address |
| recipient | JSONB - recipient address |
| body_text | Letter content |
| sign_off | Closing (e.g., "Sincerely,") |
| required_credits | Credits needed to send |
| preview_html | Generated preview |
| expires_at | Draft expiration (24 hours from creation) |
| consumed_at | When draft was used to send |
| letter_id | Links to letters table after send |

### letters
Stores sent letters.

| Column | Description |
|--------|-------------|
| letter_id | UUID primary key |
| user_id | Sender |
| content | JSONB - full letter content |
| recipient | JSONB - recipient address |
| credits_cost | Credits charged |
| status | 'queued', 'processing', 'sent', 'failed', 'cancelled' |
| tracking_id | Provider tracking ID (PostGrid) |
| provider | 'postgrid', 'dummy' |
| cost_cents | Actual provider cost |
| expected_delivery | Provider ETA |

### letter_jobs
Tracks background job processing.

| Column | Description |
|--------|-------------|
| job_id | UUID primary key |
| letter_id | Foreign key to letters |
| status | 'pending', 'processing', 'completed', 'failed' |
| attempts | Number of tries |
| max_attempts | Retry limit (default: 3) |
| error_message | Last error if failed |

### credit_ledger
Stores credit balances with expiration.

| Column | Description |
|--------|-------------|
| entry_id | Serial primary key |
| user_id | Credit owner |
| source_type | 'purchase', 'promo', 'adjustment' |
| original_amount | Credits added |
| remaining_amount | Credits available |
| expires_at | Expiration date (null = never) |
| status | 'active', 'consumed', 'expired' |

### credit_consumption
Links credit usage to letters.

| Column | Description |
|--------|-------------|
| consumption_id | Serial primary key |
| ledger_entry_id | Source credit entry |
| letter_id | Letter that used credits |
| amount_consumed | Credits used |

---

## Key Code Files

| File | Purpose |
|------|---------|
| `src/tools/quoteAndPreview.ts` | Creates drafts, generates previews |
| `src/tools/sendLetter.ts` | Consumes drafts, deducts credits, queues jobs |
| `src/services/draftService.ts` | Draft CRUD operations |
| `src/services/creditLedgerService.ts` | Credit deduction with FIFO |
| `src/services/letterJobService.ts` | Job queue integration |
| `src/workers/letterWorker.ts` | Background job processor |
| `src/services/providers/PostGridProvider.ts` | PostGrid API integration |

---

## Idempotency Guarantees

### Draft Consumption
- Draft status is updated atomically: `pending` → `consumed`
- If `send_letter` is called twice with same `draftId`:
  - First call: Draft consumed, letter created, credits deducted
  - Second call: Returns existing letter with `isRetry: true`

### Credit Deduction
- Uses `SELECT FOR UPDATE` to lock user row during transaction
- Credits deducted from `credit_ledger` using FIFO (oldest first)
- Consumption recorded in `credit_consumption` for audit

### Job Processing
- pg-boss handles job deduplication
- Jobs have unique `letter_id` as natural key
- Retry logic with exponential backoff (max 3 attempts)

---

## Error Handling

### Draft Errors
| Error Code | Meaning |
|------------|---------|
| DRAFT_NOT_FOUND | Invalid draftId |
| DRAFT_NOT_OWNED | Draft belongs to different user |
| DRAFT_EXPIRED | Draft older than 24 hours |
| DRAFT_CANCELLED | Draft was explicitly cancelled |

### Credit Errors
| Error | Meaning |
|-------|---------|
| INSUFFICIENT_CREDITS | User balance < required credits |

### Job Errors
- Transient failures: Retried automatically
- Permanent failures: Marked as 'failed', letter status updated
- Failed letters can be retried via admin panel

---

## Configuration

### Environment Variables
| Variable | Purpose |
|----------|---------|
| LETTER_PROVIDER | 'postgrid' or 'dummy' |
| POSTGRID_API_KEY | PostGrid API credentials |
| DUMMY_PROVIDER_DELAY_MS | Simulated delay for testing |
| DUMMY_PROVIDER_FAIL_RATE | Failure rate for testing |

### Job Queue Settings
- Queue name: `send-letter`
- Retry limit: 3 attempts
- Retry delay: 60 seconds (exponential backoff)
- Job expiration: 7 days

---

## Monitoring

### Admin Dashboard
Access at `http://localhost:8788/admin` (local only)

- **Dashboard**: Letter counts, job status, failed jobs
- **Letters**: Search and view letter details
- **Jobs**: View job history, retry failed jobs

### Key Metrics
- Letters by status (queued, processing, sent, failed)
- Failed jobs needing attention
- Credit consumption trends
