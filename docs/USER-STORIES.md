# User Stories

**Last Updated:** December 15, 2025
**Purpose:** Test coverage and acceptance criteria for Letter IRL

---

## Overview

User stories are organized into categories:
- **Core Flow** - Primary letter sending journey
- **Credits** - Balance, purchases, expiration
- **Promo Codes** - Campaign redemption
- **Account** - Authentication, profile
- **Admin** - Dashboard, investigation, management
- **Edge Cases** - Error handling, idempotency
- **Security** - Authorization, data protection
- **Data Integrity** - Consistency and audit
- **MCP Access** - Token-based auth for non-ChatGPT clients

Each story includes acceptance criteria that can be converted to test cases.

---

## 1. Core Flow - Letter Sending

### US-1.1: Preview a Letter
**As a** user
**I want to** preview my letter before sending
**So that** I can verify the content and cost before committing

**Acceptance Criteria:**
- [ ] Can provide sender and recipient addresses (US only)
- [ ] Can provide letter body text and sign-off
- [ ] System validates addresses via PostGrid
- [ ] System calculates required credits (2 per standard letter)
- [ ] Returns HTML preview of formatted letter
- [ ] Returns `canSendNow` based on credit balance
- [ ] Creates draft with 24-hour expiration
- [ ] Returns `draftId` for use in send operation

**Error Cases:**
- [ ] Missing required address fields → Clear error listing missing fields
- [ ] Non-US address → "Only supports mailing within United States"
- [ ] Body exceeds 1,800 characters → "Letter exceeds one-page limit"
- [ ] Invalid address format → Returns corrections/suggestions

---

### US-1.2: Send a Letter
**As a** user
**I want to** send my previewed letter
**So that** it gets printed and mailed to the recipient

**Acceptance Criteria:**
- [ ] Must provide valid `draftId` from preview
- [ ] Must set `confirm: true` to proceed
- [ ] Credits deducted atomically (FIFO: expiring-soonest first)
- [ ] Letter record created with status `queued`
- [ ] Background job queued for processing
- [ ] Returns `orderId`, `creditsRemaining`, `statusTimeline`
- [ ] Transaction recorded in audit trail

**Error Cases:**
- [ ] Missing `draftId` → "Draft ID required"
- [ ] `confirm` not true → "Must confirm to send"
- [ ] Draft expired (>24h) → "DRAFT_EXPIRED" error
- [ ] Draft already used → Returns existing order (idempotent)
- [ ] Draft belongs to other user → "DRAFT_NOT_OWNED"
- [ ] Insufficient credits → "INSUFFICIENT_CREDITS"

---

### US-1.3: Idempotent Send (Retry Safety)
**As a** user
**I want** duplicate send requests to be safe
**So that** network issues don't cause double charges

**Acceptance Criteria:**
- [ ] Calling `send_letter` twice with same `draftId` returns same order
- [ ] Credits only deducted once
- [ ] Second call returns `isRetry: true`
- [ ] Letter only created once
- [ ] Works even with concurrent requests (row locking)

---

### US-1.4: Check Letter Status
**As a** user
**I want to** check the status of my letter
**So that** I know if it was sent successfully

**Acceptance Criteria:**
- [ ] Can query by specific `orderId`
- [ ] If no `orderId` provided, returns most recent letter
- [ ] Returns current status from fulfillment lifecycle (see below)
- [ ] Returns status timeline with timestamps
- [ ] Returns recipient summary (name, city, state)
- [ ] Returns preview thumbnail
- [ ] If sent, includes tracking ID and expected delivery

**Status Lifecycle (Database):**
- `queued` - Letter is waiting to be processed
- `processing` - Letter is being rendered/printed by provider
- `in_transit` - Letter has been mailed and is in postal system
- `delivered` - Letter has been delivered
- `returned` - Letter was returned to sender (bad address, etc.)
- `failed` - Processing failed after max retries
- `cancelled` - Letter was cancelled before sending

**MCP Status Mapping (Simplified for Users):**
| Database Status | MCP Status | User-Friendly Meaning |
|-----------------|------------|----------------------|
| queued | queued_for_print | Waiting to print |
| processing | printing | Being printed |
| in_transit | mailed | In the mail |
| delivered | mailed | Delivered |
| returned | mailed | Returned (see details) |
| failed | queued_for_print | Failed (see error) |
| cancelled | queued_for_print | Cancelled |

---

### US-1.5: List My Letters
**As a** user
**I want to** see all my sent letters
**So that** I can review my mailing history

**Acceptance Criteria:**
- [ ] Returns paginated list (default limit: 20)
- [ ] Sorted by most recent first
- [ ] Each entry shows: orderId, recipient, status, date
- [ ] Can filter by status
- [ ] Returns total count for pagination

---

### US-1.6: Letter Background Processing
**As the** system
**I want to** process queued letters via background jobs
**So that** letters are sent to PostGrid reliably

**Acceptance Criteria:**
- [ ] Worker picks up pending jobs from queue
- [ ] Updates letter status: queued → processing → sent
- [ ] Records tracking ID from PostGrid
- [ ] Records expected delivery date
- [ ] On success: job marked completed
- [ ] On failure: retries up to 3 times with exponential backoff
- [ ] After max retries: job marked failed, letter marked failed

---

### US-1.7: Letter Status Sync from Providers
**As the** system
**I want to** periodically sync letter statuses from fulfillment providers
**So that** users see accurate, up-to-date delivery information

**Acceptance Criteria:**
- [ ] Scheduled job runs every 6 hours
- [ ] Queries all non-terminal letters (not delivered, returned, failed, cancelled)
- [ ] Only checks letters from last 30 days (avoid stale queries)
- [ ] Calls provider API to get current status (e.g., PostGrid)
- [ ] Updates database status if changed
- [ ] Records `status_updated_at` timestamp
- [ ] Stores `provider_raw_status` for debugging
- [ ] Handles API rate limits gracefully

**Provider Interface:**
```typescript
interface LetterProvider {
  getStatus(providerLetterId: string): Promise<ProviderStatus>;
}

interface ProviderStatus {
  normalized: string;  // Our internal status
  raw: string;         // Provider's raw status
  timestamp?: Date;    // Provider's status timestamp
}
```

**PostGrid Status Mapping:**
| PostGrid Status | Database Status |
|-----------------|-----------------|
| ready | queued |
| rendered | processing |
| processed | processing |
| printed | processing |
| mailed | in_transit |
| in_transit | in_transit |
| delivered | delivered |
| returned | returned |
| canceled | failed |

**Admin Trigger:**
- [ ] Manual sync available via `/api/admin/sync-statuses`
- [ ] Returns count of letters checked and updated

---

## 2. Credits

### US-2.1: Check Credit Balance
**As a** user
**I want to** see my credit balance
**So that** I know if I can send letters

**Acceptance Criteria:**
- [ ] Shows total available credits
- [ ] Shows `canSendStandardLetter` (credits >= 2)
- [ ] Shows credits expiring soon (within 7 days)
- [ ] Shows breakdown by expiration date
- [ ] Shows auth provider (Google, Microsoft, etc.)
- [ ] Returns user-friendly message with warnings

---

### US-2.2: Purchase Credits
**As a** user
**I want to** buy more credits
**So that** I can send letters

**Acceptance Criteria:**
- [ ] Can select package: 4, 10, or 100 credits
- [ ] Creates Stripe Checkout session
- [ ] Returns checkout URL for payment
- [ ] After payment, webhook adds credits to account
- [ ] Credits have 2-year expiration (730 days)
- [ ] Transaction recorded in ledger
- [ ] User tier recalculated

**Packages:**
- [ ] credit-pack-4: 4 credits (Starter)
- [ ] credit-pack-10: 10 credits (Regular)
- [ ] credit-pack-100: 100 credits (Power - 10% savings)

---

### US-2.3: Credit Expiration
**As a** user
**I want** my credits to be used before they expire
**So that** I don't lose purchased value

**Acceptance Criteria:**
- [ ] Expiring-soonest credits consumed first (FIFO)
- [ ] Then oldest credits
- [ ] Never-expiring credits used last
- [ ] Daily job marks expired entries
- [ ] Balance cache synchronized with ledger
- [ ] Expired credits no longer available

**Expiration Policies:**
- [ ] Purchase: 2 years (730 days)
- [ ] Promo: 90 days (campaign-configurable)
- [ ] Signup bonus: 30 days
- [ ] Adjustment/Refund: Never expires

---

### US-2.4: View Transaction History
**As a** user
**I want to** see my credit transaction history
**So that** I can understand my usage

**Acceptance Criteria:**
- [ ] Shows all transactions: purchases, deductions, refunds, adjustments
- [ ] Paginated (default: 50, max: 100)
- [ ] Can filter by type
- [ ] Each shows: amount, balance_after, type, timestamp, description
- [ ] Most recent first

---

### US-2.5: View Detailed Ledger
**As a** user
**I want to** see my credit ledger entries
**So that** I understand expiration dates

**Acceptance Criteria:**
- [ ] Shows all ledger entries with expiration info
- [ ] Each shows: initial, remaining, source, expires_at, status
- [ ] Can include/exclude expired entries
- [ ] Breakdown by source type (purchase, promo, etc.)

---

### US-2.6: Refund Handling
**As the** system
**I want to** handle Stripe refunds correctly
**So that** credit balances reflect actual payments

**Acceptance Criteria:**
- [ ] Webhook receives `charge.refunded` event
- [ ] Original ledger entry marked as revoked
- [ ] User balance reduced
- [ ] If user has used more credits than remain, balance can go negative
- [ ] User tier recalculated
- [ ] Transaction recorded with refund reference

---

### US-2.7: Insufficient Credits Flow
**As a** user (Sarah, Eleanor)
**I want** clear guidance when I don't have enough credits
**So that** I know how to proceed with sending my letter

**Acceptance Criteria:**
- [ ] Preview returns `canSendNow: false` when balance < required
- [ ] Message clearly states: credits needed vs credits available
- [ ] Provides purchase link or promo code option
- [ ] Draft still created (user can purchase and send within 24h)
- [ ] After purchasing, same `draftId` can be used

**User Flow:**
1. User previews letter → sees `canSendNow: false`
2. User purchases credits (or redeems promo)
3. User calls `send_letter` with same `draftId`
4. Letter sent successfully

---

### US-2.8: Low Balance Warning
**As a** user (Eleanor, Sarah)
**I want** to be warned when my balance is getting low
**So that** I can purchase more credits before running out

**Acceptance Criteria:**
- [ ] Balance check shows warning when credits < 4 (2 letters)
- [ ] Warning message suggests purchasing more
- [ ] After sending, response includes remaining balance
- [ ] If remaining < 2, includes "not enough for another letter" note

---

### US-2.9: Chargeback Handling
**As the** system
**I want to** handle Stripe chargebacks appropriately
**So that** fraud is tracked and accounts are flagged

**Acceptance Criteria:**
- [ ] Webhook receives `charge.dispute.created` event
- [ ] Dispute recorded in `stripe_disputes` table
- [ ] Alert created for admin dashboard
- [ ] User's credits revoked (same as refund)
- [ ] User tier recalculated
- [ ] Dispute resolution tracked (`charge.dispute.closed`)

**Admin Visibility:**
- [ ] Open disputes shown in alerts (critical severity)
- [ ] Can view dispute history per user
- [ ] Dispute reason and amount visible

---

## 3. Promo Codes

### US-3.1: Validate Promo Code
**As a** user
**I want to** check if a promo code is valid
**So that** I know what I'll receive before redeeming

**Acceptance Criteria:**
- [ ] Returns validity status
- [ ] If valid: shows credits amount, expiration policy
- [ ] If invalid: shows reason (expired, already used, etc.)
- [ ] Case-insensitive code matching

---

### US-3.2: Redeem Promo Code
**As a** user
**I want to** redeem a promo code
**So that** I receive free credits

**Acceptance Criteria:**
- [ ] Credits added to ledger with campaign expiration policy
- [ ] Redemption recorded (prevents re-use)
- [ ] Returns credits granted and expiration date
- [ ] Transaction recorded

**Validation Checks:**
- [ ] Code exists and campaign is active
- [ ] Campaign within validity window (starts_at ≤ now ≤ ends_at)
- [ ] User hasn't exceeded max_per_user (typically 1)
- [ ] Campaign hasn't exceeded max_total_redemptions
- [ ] If requires_new_user: user has no prior purchases

---

### US-3.3: View My Redemptions
**As a** user
**I want to** see which promo codes I've redeemed
**So that** I have a record of bonuses received

**Acceptance Criteria:**
- [ ] Lists all user's redemptions
- [ ] Shows: campaign code, name, credits, redeemed_at

---

## 4. Account

### US-4.0: First-Time User Onboarding
**As a** new user (Sarah, Eleanor)
**I want** my account created automatically when I first use the service
**So that** I can start sending letters without a separate signup process

**Acceptance Criteria:**
- [ ] User record created on first MCP tool call
- [ ] Email extracted from OAuth token
- [ ] No signup credits by default (must purchase or use promo)
- [ ] Clear messaging about credit balance (0 credits)
- [ ] Guidance on how to get credits (purchase or promo code)

**First Letter Flow:**
- [ ] User calls `quote_and_preview_letter`
- [ ] Account auto-created if not exists
- [ ] Preview shows cost and `canSendNow: false` (0 credits)
- [ ] User understands they need credits before sending

---

### US-4.1: Authentication
**As a** user
**I want to** authenticate via OAuth
**So that** I can access my account securely

**Acceptance Criteria:**
- [ ] Supports 5 providers: Google, Microsoft, Apple, GitHub, Email/Password
- [ ] Uses Auth0 for dynamic client registration
- [ ] JWT tokens validated via JWKS
- [ ] User created/retrieved on first MCP tool call

---

### US-4.2: Switch Account
**As a** user
**I want to** switch to a different account
**So that** I can use a different authentication method

**Acceptance Criteria:**
- [ ] Returns Auth0 logout URL
- [ ] Lists available auth methods
- [ ] After logout, can re-authenticate with different provider

---

### US-4.3: View Profile
**As a** user
**I want to** see my account information
**So that** I know my account status

**Acceptance Criteria:**
- [ ] Shows user ID (Auth0 format)
- [ ] Shows email address
- [ ] Shows credits, credits_purchased, credits_used
- [ ] Shows account creation date
- [ ] Shows current tier

---

## 5. Admin

### US-5.1: View Dashboard
**As an** admin
**I want to** see system-wide metrics
**So that** I can monitor platform health

**Acceptance Criteria:**
- [ ] Users: total, new (today, 7d, 30d)
- [ ] Credits: total in system, purchased, used
- [ ] Letters: total, sent (today, 7d, 30d)
- [ ] Revenue: total, by period
- [ ] Jobs: pending, processing, completed, failed

---

### US-5.2: View Alerts
**As an** admin
**I want to** see active alerts
**So that** I can address issues promptly

**Alert Types:**
- [ ] Failed jobs (critical): Jobs that failed after max retries
- [ ] Expiring credits (warning): Users with credits expiring in 7 days
- [ ] Chargebacks/disputes (critical): Open Stripe disputes
- [ ] Reconciliation mismatches (warning): Stripe vs database discrepancies

---

### US-5.3: Search Users
**As an** admin
**I want to** search for users
**So that** I can investigate issues

**Acceptance Criteria:**
- [ ] Search by email (partial match)
- [ ] Search by user ID (partial match)
- [ ] Case-insensitive
- [ ] Returns: user details, credits, tier, created date

---

### US-5.4: Investigate User
**As an** admin
**I want to** view a user's full history
**So that** I can understand their account

**Acceptance Criteria:**
- [ ] View user profile and tier
- [ ] View credit ledger entries
- [ ] View transaction history
- [ ] View sent letters
- [ ] View promo redemptions

---

### US-5.5: Adjust Credits
**As an** admin
**I want to** manually adjust a user's credits
**So that** I can handle customer service issues

**Acceptance Criteria:**
- [ ] Can add or remove credits
- [ ] Requires reason/description
- [ ] Creates ledger entry (never expires)
- [ ] Creates transaction record
- [ ] Records admin who made adjustment
- [ ] Recalculates user tier

---

### US-5.6: Retry Failed Job
**As an** admin
**I want to** retry a failed letter job
**So that** customers receive their letters

**Acceptance Criteria:**
- [ ] Can reset job status to pending
- [ ] Resets attempt counter
- [ ] Worker picks up job again
- [ ] Letter status updated accordingly

---

### US-5.7: Manage Promo Campaigns
**As an** admin
**I want to** create and manage promo campaigns
**So that** I can run marketing promotions

**Acceptance Criteria:**
- [ ] Create campaign: code, credits, expiration, limits
- [ ] List all campaigns with status
- [ ] Update status: draft → active → paused → ended
- [ ] View redemption list for campaign
- [ ] See current vs max redemptions

---

### US-5.8: Stripe Reconciliation
**As an** admin
**I want to** reconcile Stripe payments
**So that** all payments result in credits

**Acceptance Criteria:**
- [ ] Compare Stripe completed sessions vs credit_ledger
- [ ] Identify missing credit entries
- [ ] Can run auto-fix (dry-run supported)
- [ ] Creates missing credits with correct expiration

---

## 6. Edge Cases

### US-6.1: Draft Expiration
**As the** system
**I want to** expire unused drafts
**So that** stale quotes don't cause issues

**Acceptance Criteria:**
- [ ] Drafts expire after 24 hours
- [ ] Expired drafts cannot be sent
- [ ] User gets clear error with instructions to re-preview
- [ ] Daily job marks pending drafts as expired
- [ ] Old drafts cleaned up after 7 days

---

### US-6.2: Address Correction Workflow
**As a** user
**I want to** correct invalid addresses
**So that** my letters arrive successfully

**Acceptance Criteria:**
- [ ] Invalid address returns suggestions
- [ ] Status indicates: verified, corrected, or failed
- [ ] User can accept correction or provide new address
- [ ] Corrected address used in letter

---

### US-6.3: Concurrent Request Handling
**As the** system
**I want to** handle concurrent operations safely
**So that** data remains consistent

**Acceptance Criteria:**
- [ ] Two send requests with same draftId → one succeeds, other gets idempotent result
- [ ] Two credit deductions → both succeed with correct balance
- [ ] Database transactions prevent race conditions
- [ ] Row-level locking on draft consumption

---

### US-6.4: Webhook Idempotency
**As the** system
**I want to** handle webhook retries safely
**So that** credits aren't duplicated

**Acceptance Criteria:**
- [ ] Duplicate checkout.session.completed → credits added once
- [ ] Uses source_reference_id to detect duplicates
- [ ] Logs duplicate attempts

---

### US-6.5: Character Limit Enforcement
**As the** system
**I want to** enforce single-page letters
**So that** pricing is predictable

**Acceptance Criteria:**
- [ ] Maximum 1,800 characters (body + sign-off)
- [ ] Clear error with current count vs limit
- [ ] Validation happens at preview time

---

### US-6.6: Failed Letter User Notification
**As a** user (Eleanor, Marcus)
**I want to** know if my letter failed to send
**So that** I can take action (retry or get refund)

**Acceptance Criteria:**
- [ ] Failed status visible in `get_order_status` response
- [ ] Error reason included (if available)
- [ ] Guidance on next steps (contact support, retry)
- [ ] Admin can retry job on user's behalf

**Current Behavior:**
- [ ] User must check status to discover failure
- [ ] No proactive notification (email, etc.)

**Future Enhancement (out of scope):**
- [ ] Email notification when letter fails
- [ ] Automatic refund for failed letters

---

### US-6.7: Expired Draft Recovery
**As a** user (Eleanor)
**I want** clear guidance when my draft has expired
**So that** I can re-create and send my letter

**Acceptance Criteria:**
- [ ] Error message clearly explains draft expired
- [ ] Suggests calling `quote_and_preview_letter` again
- [ ] Original content NOT recoverable (user must re-enter)
- [ ] No credits were charged (draft never sent)

---

## 7. Security

### US-7.1: Authentication Required
**As the** system
**I want to** require authentication for all operations
**So that** user data is protected

**Acceptance Criteria:**
- [ ] All MCP tools require valid JWT
- [ ] All API endpoints require valid JWT
- [ ] Invalid/missing token → 401 Unauthorized
- [ ] Token validated against Auth0 JWKS

---

### US-7.2: User Data Isolation
**As a** user
**I want** my data to be private
**So that** other users can't access it

**Acceptance Criteria:**
- [ ] Can only see own letters
- [ ] Can only see own transactions
- [ ] Can only see own ledger
- [ ] Can only use own drafts
- [ ] Cross-user access returns 404 (not 403, to prevent enumeration)

---

### US-7.3: Admin Access Control
**As the** system
**I want** admin functions to be restricted
**So that** only authorized users can perform them

**Acceptance Criteria:**
- [ ] Admin routes disabled on production (ADMIN_ENABLED=false)
- [ ] Local admin restricted to localhost (ADMIN_LOCAL_ONLY=true)
- [ ] Admin role verified from JWT
- [ ] Non-admin user → 403 Forbidden

---

### US-7.4: Stripe Webhook Security
**As the** system
**I want to** verify webhook authenticity
**So that** attackers can't fake payments

**Acceptance Criteria:**
- [ ] Validates Stripe-Signature header
- [ ] Rejects invalid signatures
- [ ] Validates timestamp (prevents replay attacks)
- [ ] Uses webhook secret for verification

---

### US-7.5: Rate Limiting
**As the** system
**I want to** limit request rates
**So that** abuse is prevented

**Acceptance Criteria:**
- [ ] Per-user rate limits enforced
- [ ] Tier-based limits (trusted users get higher limits)
- [ ] 429 Too Many Requests when exceeded
- [ ] Limits apply to MCP tools and API endpoints

---

### US-7.6: Promo Code Abuse Prevention
**As the** system
**I want to** prevent promo code abuse
**So that** promotional budgets are protected

**Acceptance Criteria:**
- [ ] One redemption per user per campaign enforced
- [ ] `requires_new_user` flag prevents existing customers from using new-user promos
- [ ] `max_total_redemptions` cap enforced globally
- [ ] Case-insensitive code matching (PROMO123 = promo123)
- [ ] Expired campaigns cannot be redeemed

**Multi-Account Detection (Future):**
- [ ] Same email across providers detected (google vs github)
- [ ] Suspicious patterns flagged for admin review
- [ ] Currently: Auth0 handles identity linking

---

## 8. Data Integrity

### US-8.1: Balance-Ledger Consistency
**As the** system
**I want** user balances to match ledger sums
**So that** credits are accurate

**Acceptance Criteria:**
- [ ] users.credits cache equals sum of active ledger entries
- [ ] Daily reconciliation job detects mismatches
- [ ] Mismatches auto-corrected
- [ ] Corrections logged

---

### US-8.2: Audit Trail
**As the** system
**I want** complete transaction history
**So that** all changes are traceable

**Acceptance Criteria:**
- [ ] Every credit change recorded in credit_transactions
- [ ] Every ledger entry traceable to source (order, promo, admin)
- [ ] Admin adjustments include admin email and reason
- [ ] Timestamps on all records

---

### US-8.3: Draft-Letter Linkage
**As the** system
**I want** consumed drafts linked to letters
**So that** idempotency works correctly

**Acceptance Criteria:**
- [ ] Consumed draft has consumed_letter_id set
- [ ] Can trace letter back to original draft
- [ ] Prevents orphaned drafts/letters

---

## 9. MCP Access - Token Authentication

### US-9.1: Generate Personal Access Token
**As a** user (Morgan, Jordan)
**I want to** generate a Personal Access Token from the dashboard
**So that** I can authenticate my MCP client without OAuth flows

**Acceptance Criteria:**
- [ ] Accessible from dashboard after OAuth login
- [ ] Generates cryptographically secure token
- [ ] Token shown once at creation (not retrievable later)
- [ ] User can name/label the token for identification
- [ ] Token stored as bcrypt hash in database
- [ ] Token associated with user account
- [ ] Token has optional expiration (default: no expiration)
- [ ] Returns token in format: `lirl_pat_xxxxxxxxxxxx`

**Token Format:**
- Prefix: `lirl_pat_` (identifies as Letter IRL PAT)
- Body: 32 random alphanumeric characters
- Total: ~40 characters

---

### US-9.2: Revoke Personal Access Token
**As a** user (Morgan, Jordan)
**I want to** revoke a token I've created
**So that** I can remove access if compromised or no longer needed

**Acceptance Criteria:**
- [ ] Can view list of active tokens (name, created date, last used)
- [ ] Can revoke individual tokens
- [ ] Revocation is immediate
- [ ] Revoked tokens return 401 on next use
- [ ] Revocation logged for audit

---

### US-9.3: Authenticate via Personal Access Token
**As a** system
**I want to** accept PAT authentication for MCP requests
**So that** non-ChatGPT clients can use Letter IRL

**Acceptance Criteria:**
- [ ] Accepts `Authorization: Bearer lirl_pat_xxx` header
- [ ] Validates token against stored hashes
- [ ] Looks up user from token
- [ ] All MCP tools work with PAT auth
- [ ] Updates `last_used_at` on token record
- [ ] Invalid/revoked token returns 401
- [ ] PAT auth logged separately from OAuth (for analytics)

**Auth Flow:**
1. MCP client sends request with `Authorization: Bearer lirl_pat_xxx`
2. Server extracts token, looks up hash match
3. If valid, request proceeds as that user
4. If invalid, returns 401 Unauthorized

---

### US-9.4: MCP Client Setup Information
**As a** user (Morgan)
**I want to** see clear setup instructions for my MCP client
**So that** I can configure Letter IRL quickly

**Acceptance Criteria:**
- [ ] Website page at `/mcp-setup` with instructions
- [ ] Shows server URL: `https://api.letterirl.com`
- [ ] Shows example config for common clients (Claude Desktop, etc.)
- [ ] Explains PAT generation process
- [ ] Links to dashboard for token generation
- [ ] Troubleshooting section for common issues

**Example Config (Claude Desktop):**
```json
{
  "mcpServers": {
    "letter-irl": {
      "url": "https://api.letterirl.com/sse",
      "headers": {
        "Authorization": "Bearer lirl_pat_your_token_here"
      }
    }
  }
}
```

---

### US-9.5: Token Usage Analytics
**As an** admin
**I want to** see PAT usage statistics
**So that** I can understand non-ChatGPT adoption

**Acceptance Criteria:**
- [ ] Dashboard shows: total PATs created, active PATs, PAT vs OAuth requests
- [ ] Can see per-user token count
- [ ] Can see last-used dates for tokens
- [ ] Alerts for suspicious patterns (many tokens, rapid creation)

---

## Priority Matrix

| Priority | Category | Stories | Key Personas |
|----------|----------|---------|--------------|
| P0 - Critical | Core Flow | US-1.1, US-1.2, US-1.3 | Sarah, Marcus, Eleanor |
| P0 - Critical | Credits | US-2.1, US-2.2, US-2.7 | All users |
| P0 - Critical | Security | US-7.1, US-7.2 | System |
| P1 - High | Core Flow | US-1.4, US-1.5, US-1.6, US-1.7 | Marcus, David, System |
| P1 - High | Credits | US-2.3, US-2.6, US-2.9 | System |
| P1 - High | Edge Cases | US-6.1, US-6.3, US-6.4 | Eleanor, System |
| P1 - High | Account | US-4.0 | Sarah, Eleanor (new users) |
| P1 - High | MCP Access | US-9.1, US-9.3 | Morgan, Jordan |
| P2 - Medium | Promo | US-3.1, US-3.2, US-3.3 | Alex |
| P2 - Medium | Account | US-4.1, US-4.2, US-4.3 | All users |
| P2 - Medium | Admin | US-5.1, US-5.2, US-5.5 | Admin Amy |
| P2 - Medium | Credits | US-2.8 | Eleanor, Sarah |
| P2 - Medium | Security | US-7.6 | Alex, Frank |
| P2 - Medium | MCP Access | US-9.2, US-9.4 | Morgan, Jordan |
| P3 - Low | Admin | US-5.3 - US-5.8 | Admin Amy |
| P3 - Low | Edge Cases | US-6.2, US-6.5, US-6.6, US-6.7 | Eleanor |
| P3 - Low | MCP Access | US-9.5 | Admin Amy |

---

## Story Count Summary

| Category | Count |
|----------|-------|
| Core Flow (US-1.x) | 7 |
| Credits (US-2.x) | 9 |
| Promo Codes (US-3.x) | 3 |
| Account (US-4.x) | 4 |
| Admin (US-5.x) | 8 |
| Edge Cases (US-6.x) | 7 |
| Security (US-7.x) | 6 |
| Data Integrity (US-8.x) | 3 |
| MCP Access (US-9.x) | 5 |
| **Total** | **52** |

---

## See Also

- [PERSONAS.md](PERSONAS.md) - User personas and archetypes
- [LETTER-SEND-FLOW.md](LETTER-SEND-FLOW.md) - Technical implementation details
- [DATABASE-SCHEMA.md](DATABASE-SCHEMA.md) - Database structure
- [STATUS.md](STATUS.md) - Project overview
