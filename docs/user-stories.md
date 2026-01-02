# User Stories

**Last Updated:** December 24, 2025
**Purpose:** Test coverage and acceptance criteria for Letter IRL

---

## Overview

User stories are organized by feature area using semantic prefixes:

| Prefix | Area | Description |
|--------|------|-------------|
| `US-LETTER` | Letter Sending | Core letter flow (preview, send, status) |
| `US-POSTCARD` | Postcards | Postcard preview, send, image handling |
| `US-CREDIT` | Credits | Balance, purchases, expiration |
| `US-PROMO` | Promo Codes | Campaign redemption |
| `US-ACCT` | Account | Authentication, profile |
| `US-ADMIN` | Admin | Dashboard, investigation, management |
| `US-EDGE` | Edge Cases | Error handling, idempotency |
| `US-SEC` | Security | Authorization, data protection |
| `US-DATA` | Data Integrity | Consistency and audit |
| `US-MCP` | MCP Access | Token-based auth for non-ChatGPT clients |
| `US-DEV` | Development | Development environment and workflows |
| `US-DCR` | OAuth Registration | Dynamic Client Registration handling |
| `US-LAYOUT` | Letter Layouts | Letter layout options (text-only, header image, inline image) |

Each story includes acceptance criteria that can be converted to test cases.

---

## Letter Sending (LETTER)

### US-LETTER-01: Preview a Letter
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

### US-LETTER-02: Send a Letter
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

### US-LETTER-03: Idempotent Send (Retry Safety)
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

### US-LETTER-04: Check Letter Status
**As a** user
**I want to** check the status of my letter
**So that** I know if it was sent successfully

**Acceptance Criteria:**
- [ ] Can query by specific `orderId`
- [ ] If no `orderId` provided, returns most recent letter
- [ ] Returns current status from fulfillment lifecycle (see below)
- [ ] Returns status timeline with timestamps
- [ ] Returns recipient summary (name, city, state)
- [ ] If sent, includes tracking ID and expected delivery

**Response Optimization (Performance):**
- [ ] Does NOT return preview thumbnail HTML in tool response (reduces payload size)
- [ ] Preview was already shown at send time; status is for tracking delivery
- [ ] Avoids large base64 image data in model context

**Status Lifecycle (Database):**
- `draft` - Order created, not yet queued
- `queued` - Letter is waiting to be processed
- `processing` - Letter is being rendered
- `accepted` - PostGrid accepted order (awaiting print)
- `printing` - Letter is being printed (PostGrid: printing)
- `in_transit` - Letter handed to USPS (PostGrid: processed_for_delivery)
- `delivered` - Letter delivered (PostGrid: completed, estimated)
- `returned` - Letter returned to sender (bad address, etc.)
- `failed` - Processing failed after max retries
- `cancelled` - Letter was cancelled

**MCP Status Mapping (User-Facing):**
| Database Status | MCP Status | User-Friendly Meaning |
|-----------------|------------|----------------------|
| draft, queued | pending | Processing your order |
| accepted | accepted | Accepted by print facility |
| processing, printing | printing | Being printed |
| in_transit | in_transit | In the mail |
| delivered | delivered | Delivered |
| returned | returned | Returned to sender |
| failed | failed | Failed |
| cancelled | cancelled | Cancelled |

**PostGrid to Database Status Mapping (Future Webhook/Sync):**
| PostGrid Status | Database Status |
|-----------------|-----------------|
| ready | accepted |
| printing | printing |
| processed_for_delivery | in_transit |
| completed | delivered |
| cancelled | cancelled |

---

### US-LETTER-05: List My Letters
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

### US-LETTER-06: Letter Background Processing
**As the** system
**I want to** process queued letters via background jobs
**So that** letters are sent to PostGrid reliably

**Acceptance Criteria:**
- [ ] Worker picks up pending jobs from queue
- [ ] Updates letter status: queued → processing → accepted
- [ ] Records tracking ID from PostGrid
- [ ] Records expected delivery date
- [ ] On success: job marked completed
- [ ] On failure: retries up to 3 times with exponential backoff
- [ ] After max retries: job marked failed, letter marked failed

---

### US-LETTER-07: Letter Status Sync from Providers
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

## Postcards (POSTCARD)

### US-POSTCARD-01: Preview a Postcard
**As a** user
**I want to** preview my postcard with an image before sending
**So that** I can verify the design and cost before committing

**Acceptance Criteria:**
- [ ] Can provide sender and recipient addresses (US only)
- [ ] Can upload/provide an image for the postcard front
- [ ] Image accepted via OpenAI `_meta["openai/fileParams"]` with `download_url`
- [ ] System validates addresses via PostGrid
- [ ] System processes image (resize to 1800x2700px for 6x9 at 300 DPI)
- [ ] System calculates required credits (2 per postcard, same as letter)
- [ ] Returns preview of front (image) and back (message)
- [ ] Returns `canSendNow` based on credit balance
- [ ] Creates draft with `mail_type='postcard'` and 24-hour expiration
- [ ] Returns `draftId` for use in send operation

**Image Requirements:**
- [ ] Maximum file size: 10 MB
- [ ] Allowed formats: PNG, JPEG, WebP
- [ ] Minimum dimensions: 600x900 pixels (for print quality)
- [ ] Images are resized to fit 6x9 postcard (cover/center crop)

**Error Cases:**
- [ ] Missing image → "Postcard requires an image for the front"
- [ ] Image too large (>10MB) → "Image is too large. Please use an image under 10MB."
- [ ] Wrong format → "Unsupported image format. Please use PNG, JPEG, or WebP."
- [ ] Image too small → "Image is too small for print quality. Please use at least 600x900 pixels."
- [ ] Image download failed → "Couldn't download the image. Please try again."
- [ ] Message too long → "Message exceeds postcard limit (~400 characters)"
- [ ] Non-US address → "Only supports mailing within United States"

---

### US-POSTCARD-02: Send a Postcard
**As a** user
**I want to** send my previewed postcard
**So that** it gets printed and mailed to the recipient

**Acceptance Criteria:**
- [ ] Must provide valid `draftId` from postcard preview
- [ ] Must set `confirm: true` to proceed
- [ ] Credits deducted atomically (FIFO: expiring-soonest first)
- [ ] Letter record created with `mail_type='postcard'` and status `queued`
- [ ] Background job queued for processing
- [ ] Returns `orderId`, `creditsRemaining`, `statusTimeline`
- [ ] Transaction recorded in audit trail
- [ ] Worker routes to `provider.sendPostcard()` based on mail_type

**Error Cases:**
- [ ] Missing `draftId` → "Draft ID required"
- [ ] `confirm` not true → "Must confirm to send"
- [ ] Draft expired (>24h) → "DRAFT_EXPIRED" error
- [ ] Draft already used → Returns existing order (idempotent)
- [ ] Draft belongs to other user → "DRAFT_NOT_OWNED"
- [ ] Insufficient credits → "INSUFFICIENT_CREDITS"

---

### US-POSTCARD-03: Postcard Image Processing
**As the** system
**I want to** process user images for postcard printing
**So that** postcards have high-quality, properly-sized images

**Acceptance Criteria:**
- [ ] Download image from OpenAI `download_url` during preview
- [ ] Validate file size (max 10MB) before full download
- [ ] Validate content type (PNG, JPEG, WebP only)
- [ ] Validate dimensions (min 600x900 pixels)
- [ ] Resize to print dimensions: 1800x2700px (6x9 at 300 DPI)
- [ ] Use `cover` fit with `center` position for cropping
- [ ] Convert to JPEG at 85% quality
- [ ] Store as base64 data URI in draft
- [ ] Processing completes inline (not background job)
- [ ] Memory usage ~50-150MB per image, 2-5 second duration

**Technical Details:**
- Uses Sharp library for image processing
- Image stored in `front_image_data` column (base64)
- Original URL stored in `front_image_url` for debugging
- PostGrid receives image via `frontHTML` containing base64 img tag

**Error Handling:**
- [ ] Network timeout → Retry once, then fail with clear error
- [ ] Corrupted image → "Image could not be processed. Please try a different image."
- [ ] Processing failure → Log error, return user-friendly message

---

### US-POSTCARD-04: Mobile Image Compatibility
**As a** mobile ChatGPT user
**I want** clear guidance when image attachments don't transfer
**So that** I can still create postcards using the optimization workaround

**Background:**
On mobile ChatGPT, the `fileParams` mechanism (image attachments to MCP tools) doesn't work reliably.
However, if ChatGPT preprocesses the image via Code Interpreter first, the resulting file CAN be used.
We frame this as "print quality optimization" rather than a workaround.

**Acceptance Criteria:**
- [ ] Tool description includes image optimization guidance for best print quality
- [ ] Error message when no image received suggests the optimization workaround
- [ ] Optimization framing: resize to 1872×1248 pixels (6x9 @ 300dpi)
- [ ] Direct image URL (imageUrl parameter) works as fallback on all platforms
- [ ] Works transparently on both mobile and desktop

**Error Scenarios:**
| Scenario | Expected Behavior |
|----------|-------------------|
| No image received | Suggest optimization workaround + direct URL option |
| Mobile user with attached image | ChatGPT guided to preprocess via Code Interpreter |

**Reference:** https://community.openai.com/t/apps-sdk-on-mobile-devices/1366422

---

## Credits (CREDIT)

### US-CREDIT-01: Check Credit Balance
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

### US-CREDIT-02: Purchase Credits
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

### US-CREDIT-03: Credit Expiration
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

### US-CREDIT-04: View Transaction History
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

### US-CREDIT-05: View Detailed Ledger
**As a** user
**I want to** see my credit ledger entries
**So that** I understand expiration dates

**Acceptance Criteria:**
- [ ] Shows all ledger entries with expiration info
- [ ] Each shows: initial, remaining, source, expires_at, status
- [ ] Can include/exclude expired entries
- [ ] Breakdown by source type (purchase, promo, etc.)

---

### US-CREDIT-06: Refund Handling
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

### US-CREDIT-07: Insufficient Credits Flow
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

### US-CREDIT-08: Low Balance Warning
**As a** user (Eleanor, Sarah)
**I want** to be warned when my balance is getting low
**So that** I can purchase more credits before running out

**Acceptance Criteria:**
- [ ] Balance check shows warning when credits < 4 (2 letters)
- [ ] Warning message suggests purchasing more
- [ ] After sending, response includes remaining balance
- [ ] If remaining < 2, includes "not enough for another letter" note

---

### US-CREDIT-09: Chargeback Handling
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

## Promo Codes (PROMO)

### US-PROMO-01: Validate Promo Code
**As a** user
**I want to** check if a promo code is valid
**So that** I know what I'll receive before redeeming

**Acceptance Criteria:**
- [ ] Returns validity status
- [ ] If valid: shows credits amount, expiration policy
- [ ] If invalid: shows reason (expired, already used, etc.)
- [ ] Case-insensitive code matching

---

### US-PROMO-02: Redeem Promo Code
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

### US-PROMO-03: View My Redemptions
**As a** user
**I want to** see which promo codes I've redeemed
**So that** I have a record of bonuses received

**Acceptance Criteria:**
- [ ] Lists all user's redemptions
- [ ] Shows: campaign code, name, credits, redeemed_at

---

## Account (ACCT)

### US-ACCT-00: First-Time User Onboarding
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

### US-ACCT-01: Authentication
**As a** user
**I want to** authenticate via OAuth
**So that** I can access my account securely

**Acceptance Criteria:**
- [ ] Supports 5 providers: Google, Microsoft, Apple, GitHub, Email/Password
- [ ] Uses Auth0 for dynamic client registration
- [ ] JWT tokens validated via JWKS
- [ ] User created/retrieved on first MCP tool call

---

### US-ACCT-02: Switch Account
**As a** user
**I want to** switch to a different account
**So that** I can use a different authentication method

**Acceptance Criteria:**
- [ ] Returns Auth0 logout URL
- [ ] Lists available auth methods
- [ ] After logout, can re-authenticate with different provider

---

### US-ACCT-03: View Profile
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

## Admin (ADMIN)

### US-ADMIN-01: View Dashboard
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

### US-ADMIN-02: View Alerts
**As an** admin
**I want to** see active alerts
**So that** I can address issues promptly

**Alert Types:**
- [ ] Failed jobs (critical): Jobs that failed after max retries
- [ ] Expiring credits (warning): Users with credits expiring in 7 days
- [ ] Chargebacks/disputes (critical): Open Stripe disputes
- [ ] Reconciliation mismatches (warning): Stripe vs database discrepancies

---

### US-ADMIN-03: Search Users
**As an** admin
**I want to** search for users
**So that** I can investigate issues

**Acceptance Criteria:**
- [ ] Search by email (partial match)
- [ ] Search by user ID (partial match)
- [ ] Case-insensitive
- [ ] Returns: user details, credits, tier, created date

---

### US-ADMIN-04: Investigate User
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

### US-ADMIN-05: Adjust Credits
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

### US-ADMIN-06: Retry Failed Job
**As an** admin
**I want to** retry a failed letter job
**So that** customers receive their letters

**Acceptance Criteria:**
- [ ] Can reset job status to pending
- [ ] Resets attempt counter
- [ ] Worker picks up job again
- [ ] Letter status updated accordingly

---

### US-ADMIN-07: Manage Promo Campaigns
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

### US-ADMIN-08: Stripe Reconciliation
**As an** admin
**I want to** reconcile Stripe payments
**So that** all payments result in credits

**Acceptance Criteria:**
- [ ] Compare Stripe completed sessions vs credit_ledger
- [ ] Identify missing credit entries
- [ ] Can run auto-fix (dry-run supported)
- [ ] Creates missing credits with correct expiration

---

## Edge Cases (EDGE)

### US-EDGE-01: Draft Expiration
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

### US-EDGE-02: Address Correction Workflow
**As a** user
**I want** minor address corrections to be applied automatically
**So that** I don't have to re-submit for common formatting fixes (ZIP+4, standardization)

**Acceptance Criteria:**
- [ ] Address validation returns status: `verified`, `corrected`, or `failed`
- [ ] **Verified addresses**: Used as-is in preview
- [ ] **Corrected addresses**: Auto-applied to preview (no re-submission required)
- [ ] **Failed addresses**: Error thrown with suggestions (user must correct)
- [ ] Preview shows both original and corrected addresses when corrections applied
- [ ] Draft stores the corrected address (what will actually be mailed)
- [ ] Response includes `senderAddressValidation` and `recipientAddressValidation` objects
- [ ] Each validation object includes: status, originalAddress, verifiedAddress (if corrected)

**Error Cases:**
- [ ] Failed sender address → Error with suggestions, must correct
- [ ] Failed recipient address → Error with suggestions, must correct
- [ ] Both addresses failed → Error listing both with suggestions

**User Experience:**
- [ ] User sees preview immediately for verified/corrected addresses
- [ ] User informed of any corrections made (can see original vs corrected)
- [ ] Only truly invalid addresses require user action

**GitHub Issue:** #40

---

### US-EDGE-03: Concurrent Request Handling
**As the** system
**I want to** handle concurrent operations safely
**So that** data remains consistent

**Acceptance Criteria:**
- [ ] Two send requests with same draftId → one succeeds, other gets idempotent result
- [ ] Two credit deductions → both succeed with correct balance
- [ ] Database transactions prevent race conditions
- [ ] Row-level locking on draft consumption

---

### US-EDGE-04: Webhook Idempotency
**As the** system
**I want to** handle webhook retries safely
**So that** credits aren't duplicated

**Acceptance Criteria:**
- [ ] Duplicate checkout.session.completed → credits added once
- [ ] Uses source_reference_id to detect duplicates
- [ ] Logs duplicate attempts

---

### US-EDGE-05: Character Limit Enforcement
**As the** system
**I want to** enforce single-page letters
**So that** pricing is predictable

**Acceptance Criteria:**
- [ ] Maximum 1,800 characters (body + sign-off)
- [ ] Clear error with current count vs limit
- [ ] Validation happens at preview time

---

### US-EDGE-06: Failed Letter User Notification
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

### US-EDGE-07: Expired Draft Recovery
**As a** user (Eleanor)
**I want** clear guidance when my draft has expired
**So that** I can re-create and send my letter

**Acceptance Criteria:**
- [ ] Error message clearly explains draft expired
- [ ] Suggests calling `quote_and_preview_letter` again
- [ ] Original content NOT recoverable (user must re-enter)
- [ ] No credits were charged (draft never sent)

---

### US-EDGE-08: Promo Redemption Race Condition Prevention
**As the** system
**I want to** prevent race conditions during promo code redemption
**So that** campaign limits cannot be exceeded by concurrent requests

**Acceptance Criteria:**
- [ ] `max_total_redemptions` enforced atomically
- [ ] Concurrent redemptions cannot exceed campaign limit
- [ ] Atomic conditional increment: only succeeds if limit not reached
- [ ] If increment fails, return "Promo code redemption limit reached"
- [ ] Fast pre-validation for user feedback (outside transaction)
- [ ] Safe atomic check inside transaction

**Race Conditions Prevented:**
1. **Global limit exceeded**: Two users redeeming simultaneously when only 1 redemption remains
2. **New user check bypass**: Same user redeeming two "new user only" promos concurrently

**Implementation Strategy (Hybrid):**
1. Keep `validatePromoCode()` for fast user feedback (optimistic)
2. Inside `redeemPromoCode()` transaction:
   - Atomic increment with condition: `UPDATE ... SET current_redemptions = current_redemptions + 1 WHERE current_redemptions < max_total_redemptions`
   - If no rows affected, limit was reached between validation and redemption
   - Roll back transaction on failure

**Test Scenarios:**
- [ ] Campaign with max_total_redemptions=1, two concurrent redemptions → only one succeeds
- [ ] Campaign with max_total_redemptions=100, redemption 100 and 101 concurrent → 100 succeeds, 101 fails
- [ ] Validation passes but redemption fails due to limit → clear error message
- [ ] Normal single-user redemption still works correctly

**Related Stories:**
- US-SEC-06 (Promo Code Abuse Prevention)
- US-EDGE-03 (Concurrent Request Handling)
- US-PROMO-02 (Redeem Promo Code)

---

## Security (SEC)

### US-SEC-01: Authentication Required
**As the** system
**I want to** require authentication for all operations
**So that** user data is protected

**Acceptance Criteria:**
- [ ] All MCP tools require valid JWT or PAT
- [ ] All API endpoints require valid JWT or PAT
- [ ] Invalid/missing token → 401 Unauthorized
- [ ] Token validated against Auth0 JWKS (JWT) or database (PAT)

---

### US-SEC-02: User Data Isolation
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

### US-SEC-03: Admin Access Control
**As the** system
**I want** admin functions to be restricted
**So that** only authorized users can perform them

**Acceptance Criteria:**
- [ ] Admin routes disabled on production (ADMIN_ENABLED=false)
- [ ] Local admin restricted to localhost (ADMIN_LOCAL_ONLY=true)
- [ ] Admin role verified from JWT
- [ ] Non-admin user → 403 Forbidden

---

### US-SEC-04: Stripe Webhook Security
**As the** system
**I want to** verify webhook authenticity
**So that** attackers can't fake payments

**Acceptance Criteria:**
- [ ] Validates Stripe-Signature header
- [ ] Rejects invalid signatures
- [ ] Validates timestamp (prevents replay attacks)
- [ ] Uses webhook secret for verification

---

### US-SEC-05: Rate Limiting
**As the** system
**I want to** limit request rates
**So that** abuse is prevented

**Acceptance Criteria:**
- [x] Per-user rate limits enforced
- [x] Tier-based limits (trusted users get higher limits)
- [x] 429 Too Many Requests when exceeded
- [x] Limits apply to MCP tools and API endpoints
- [x] Public promo validation endpoint rate limited (10/min per IP + 100/min global)
- [x] Rate limit headers included (X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset)
- [x] Admin endpoint for rate limit stats (`GET /api/admin/ratelimit/stats`)

---

### US-SEC-06: Promo Code Abuse Prevention
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

## Data Integrity (DATA)

### US-DATA-01: Balance-Ledger Consistency
**As the** system
**I want** user balances to match ledger sums
**So that** credits are accurate

**Acceptance Criteria:**
- [ ] users.credits cache equals sum of active ledger entries
- [ ] Daily reconciliation job detects mismatches
- [ ] Mismatches auto-corrected
- [ ] Corrections logged

---

### US-DATA-02: Audit Trail
**As the** system
**I want** complete transaction history
**So that** all changes are traceable

**Acceptance Criteria:**
- [ ] Every credit change recorded in credit_transactions
- [ ] Every ledger entry traceable to source (order, promo, admin)
- [ ] Admin adjustments include admin email and reason
- [ ] Timestamps on all records

---

### US-DATA-03: Draft-Letter Linkage
**As the** system
**I want** consumed drafts linked to letters
**So that** idempotency works correctly

**Acceptance Criteria:**
- [ ] Consumed draft has consumed_letter_id set
- [ ] Can trace letter back to original draft
- [ ] Prevents orphaned drafts/letters

---

## MCP Access (MCP)

### US-MCP-01: Generate Personal Access Token
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

### US-MCP-02: Revoke Personal Access Token
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

### US-MCP-03: Authenticate via Personal Access Token
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

### US-MCP-04: MCP Client Setup Information
**As a** user (Morgan)
**I want to** see clear setup instructions for my MCP client
**So that** I can configure Letter IRL quickly

**Acceptance Criteria:**
- [ ] Website page at `/mcp` with instructions
- [ ] Shows server URL: `https://api.letterirl.com/mcp`
- [ ] Shows platform-specific configs (Windows vs macOS/Linux)
- [ ] Explains OAuth flow for Claude Desktop (preferred)
- [ ] Explains PAT generation for clients without OAuth support
- [ ] Links to dashboard for token generation (if needed)
- [ ] Troubleshooting section for common issues

**Example Config (Claude Desktop - OAuth, Recommended):**

Windows:
```json
{
  "mcpServers": {
    "letter-irl": {
      "command": "npx.cmd",
      "args": ["-y", "mcp-remote", "https://api.letterirl.com/mcp"]
    }
  }
}
```

macOS/Linux:
```json
{
  "mcpServers": {
    "letter-irl": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://api.letterirl.com/mcp"]
    }
  }
}
```

**Example Config (PAT - for clients without OAuth):**
```json
{
  "mcpServers": {
    "letter-irl": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "https://api.letterirl.com/mcp",
        "--header", "Authorization:${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer lirl_pat_your_token_here"
      }
    }
  }
}
```

**Note:** Claude Desktop supports OAuth natively via `mcp-remote`. Users authenticate via browser on first connection. PAT is only needed for MCP clients that don't support OAuth.

---

### US-MCP-05: Token Usage Analytics
**As an** admin
**I want to** see PAT usage statistics
**So that** I can understand non-ChatGPT adoption

**Acceptance Criteria:**
- [ ] Dashboard shows: total PATs created, active PATs, PAT vs OAuth requests
- [ ] Can see per-user token count
- [ ] Can see last-used dates for tokens
- [ ] Alerts for suspicious patterns (many tokens, rapid creation)

---

### US-MCP-06: Tool Read/Write Annotations
**As a** ChatGPT user
**I want** read-only tools to be marked as "READ"
**So that** I don't have to confirm every tool call

**Acceptance Criteria:**
- [ ] Read-only tools show as "READ" in ChatGPT connector settings
- [ ] Write tools show as "WRITE" in ChatGPT connector settings
- [ ] Read-only tools don't require user confirmation
- [ ] Write tools require user confirmation before execution
- [ ] Destructive tools (clear_return_address) show additional warning
- [ ] Open-world tools (send_letter) marked with `openWorldHint: true` for real-world effects

**Tool Classification:**
| Tool | Type | Annotation |
|------|------|------------|
| `get_account_balance` | READ | `readOnlyHint: true` |
| `get_order_status` | READ | `readOnlyHint: true` |
| `get_return_address` | READ | `readOnlyHint: true` |
| `list_orders` | READ | `readOnlyHint: true` |
| `quote_and_preview_letter` | READ | `readOnlyHint: true` |
| `switch_account` | READ | `readOnlyHint: true` |
| `send_letter` | WRITE | `readOnlyHint: false`, `openWorldHint: true` |
| `set_return_address` | WRITE | `readOnlyHint: false` |
| `clear_return_address` | WRITE | `readOnlyHint: false`, `destructiveHint: true` |

**Technical Details:**
- MCP SDK expects annotations in separate `annotations` parameter
- Not in `_meta` object (current incorrect implementation)
- Annotations: `readOnlyHint`, `destructiveHint`, `openWorldHint`, `idempotentHint`

**Related:**
- GitHub Issue: #17
- [OpenAI: Define Tools](https://developers.openai.com/apps-sdk/plan/tools/)

---

### US-MCP-07: Widget Resources
**As a** ChatGPT user
**I want** rich visual previews of my letters
**So that** I can see exactly what will be mailed before confirming

**Acceptance Criteria:**
- [ ] `quote_and_preview_letter` renders in LetterPreviewCard widget
- [ ] Widget shows letter preview HTML
- [ ] Widget shows cost (required credits)
- [ ] Widget shows delivery class and estimated delivery days
- [ ] Widget shows status pill (Ready to send / Cannot send)
- [ ] Widget uses correct theme (light/dark)
- [ ] Heavy data (previewHtml) in `_meta` to reduce model context bloat
- [ ] Widget can access API via CSP `connect_domains`

**Technical Details:**
- Widget resource URI: `ui://widgets/LetterPreviewCard.html`
- MIME type: `text/html+skybridge`
- Data sources:
  - `window.openai.toolOutput` → Model-facing data (cost, status, draftId)
  - `window.openai.toolResponseMetadata` → Widget-only data (previewHtml)
- CSP includes both ChatGPT domain and backend API URL

**Related:**
- GitHub Issue: #42
- [OpenAI: ChatGPT UI](https://developers.openai.com/apps-sdk/build/chatgpt-ui/)

---

### US-MCP-08: Widget Tool Accessibility
**As a** ChatGPT user
**I want** to send a letter directly from the preview widget
**So that** I can complete the send without typing another message

**Acceptance Criteria:**
- [ ] LetterPreviewCard widget has "Send Now" button
- [ ] Button is disabled when `canSendNow` is false
- [ ] Button calls `send_letter` tool via `window.openai.callTool()`
- [ ] Button shows loading state during send
- [ ] Button shows success/error feedback after send
- [ ] `send_letter` tool has `widgetAccessible: true` meta

**User Experience:**
1. User requests letter preview via ChatGPT
2. LetterPreviewCard renders with preview and "Send Now" button
3. User clicks "Send Now" button
4. Widget calls `send_letter` with `draftId` and `confirm: true`
5. Widget shows success message and order ID

**Security Considerations:**
- Idempotency via `draftId` prevents double-send
- User must explicitly click button (no auto-send)
- `confirm: true` requirement maintained

**Related:**
- GitHub Issue: #42
- [OpenAI: Calling Tools](https://developers.openai.com/apps-sdk/build/chatgpt-ui/#calling-tools)

---

### US-MCP-09: Tool Idempotency Annotations

**As a** ChatGPT user
**I want** tools to be correctly annotated for idempotency
**So that** ChatGPT doesn't unnecessarily call tools multiple times

**Acceptance Criteria:**
- [ ] Quote/preview tools have `idempotentHint: false` (each call creates new draft)
- [ ] Send tools have `idempotentHint: true` (draft consumption makes retries safe)
- [ ] set_return_address has `idempotentHint: true` (same address = no change)
- [ ] clear_return_address has `idempotentHint: true` (clearing twice = no effect)
- [ ] Tests verify correct idempotency annotations for all 12 tools

**Idempotency Classification:**
| Tool | idempotentHint | Reason |
|------|----------------|--------|
| quote_and_preview_letter | false | Creates new draft each call |
| quote_and_preview_letter_with_header_image | false | Creates new draft each call |
| quote_and_preview_letter_with_image | false | Creates new draft each call |
| quote_and_preview_postcard | false | Creates new draft each call |
| send_letter | true | Draft consumption makes retries safe |
| send_postcard | true | Draft consumption makes retries safe |
| set_return_address | true | Setting same address = no change |
| clear_return_address | true | Clearing twice = no additional effect |
| get_account_balance | true | Read-only, always same result |
| list_orders | true | Read-only, always same result |
| get_order_status | true | Read-only, always same result |
| get_return_address | true | Read-only, always same result |

**Related:**
- GitHub Issue: #94
- docs/learnings/tool-annotation-decision.md

---

### US-MCP-10: Tracking Support Transparency

**As a** ChatGPT user (David, Marcus, Eleanor)
**I want** the send response to indicate tracking capabilities
**So that** the AI doesn't over-promise delivery tracking features

**Background:**
ChatGPT offered "Track it until delivery" to a user after sending a postcard, but Letter IRL only has estimated delivery status from PostGrid. This field lets AI models accurately communicate tracking limitations without hardcoding negative text responses.

**Acceptance Criteria:**
- [ ] `send_letter` response includes `trackingSupport` field
- [ ] `send_postcard` response includes `trackingSupport` field
- [ ] Field value is `"estimated_only"` (current capability)
- [ ] Schema description explains enum values
- [ ] Field present in both normal sends and idempotent retries
- [ ] Tests verify trackingSupport field is returned

**Field Definition:**
| Value | Meaning |
|-------|---------|
| `none` | No tracking available |
| `estimated_only` | Status updates via periodic PostGrid sync, delivery is ESTIMATED |
| `carrier_tracking` | Real-time carrier tracking with confirmed delivery (future) |

**Current Value:** `"estimated_only"`
- PostGrid syncs status every 6 hours via `statusSyncService.ts`
- "Delivered" status is ESTIMATED based on USPS mail timing
- No USPS tracking numbers or confirmed delivery scans

**Related:**
- GitHub Issue: #98
- US-LETTER-04: Check Letter Status
- US-LETTER-07: Letter Status Sync from Providers

---

## Development (DEV)

### US-DEV-01: Isolated Development Environment
**As a** developer
**I want** a fully isolated development environment
**So that** I can test changes without affecting production users or data

**Acceptance Criteria:**
- [ ] Separate Auth0 tenant (letter-irl-dev.us.auth0.com) for complete isolation
- [ ] Separate Neon database branch (dev) with production data copy
- [ ] Separate Railway deployment with obscure URL
- [ ] Stripe test mode (no real charges)
- [ ] Dummy PostGrid provider (no real letters mailed)
- [ ] Git branch `dev` auto-deploys to development environment
- [ ] Git branch `master` auto-deploys to production environment

**Environment Components:**
| Component | Production | Development |
|-----------|------------|-------------|
| Git Branch | `master` | `dev` |
| Railway | api.letterirl.com | Obscure URL |
| Neon | main branch | dev branch |
| Auth0 | dev-ky21dxn3qmi71hjl.us.auth0.com | letter-irl-dev.us.auth0.com |
| Stripe | Live mode | Test mode |
| PostGrid | Live mode | Dummy provider |

---

### US-DEV-02: Database Synchronization
**As a** developer
**I want** to sync production data to development
**So that** I can test with realistic data

**Acceptance Criteria:**
- [ ] Command `npm run dev:sync` triggers sync process
- [ ] Deletes existing Neon dev branch
- [ ] Creates new Neon dev branch from production (main)
- [ ] Exports Username-Password users from production Auth0
- [ ] Imports Username-Password users to development Auth0
- [ ] Preserves user IDs to maintain data consistency
- [ ] One-way sync only (production → development)
- [ ] Social login user IDs automatically match (no import needed)

**User ID Matching:**
| Login Type | Same Across Tenants? | Import Needed? |
|------------|---------------------|----------------|
| Google (`google-oauth2\|xxx`) | Yes | No |
| GitHub (`github\|xxx`) | Yes | No |
| Microsoft (`windowslive\|xxx`) | Yes | No |
| Apple (`apple\|xxx`) | Yes | No |
| Username-Password (`auth0\|xxx`) | No | Yes |

**Safety Checks:**
- [ ] Requires confirmation before deleting dev branch
- [ ] Validates environment variables before starting
- [ ] Reports sync progress and results
- [ ] Handles errors gracefully with clear messages

---

### US-DEV-03: Feature Branch Workflow
**As a** developer
**I want** a clear branching strategy
**So that** feature development is organized

**Acceptance Criteria:**
- [ ] Features branch from `dev` branch
- [ ] Feature branch naming: `feature/description`
- [ ] Features merge to `dev` via pull request
- [ ] `dev` merges to `master` for production releases
- [ ] Railway auto-deploys on push to `dev` or `master`
- [ ] Each environment has isolated credentials

**Git Flow:**
```
master (production)
  ↑
  └── dev (development)
        ↑
        ├── feature/add-email-notifications
        ├── feature/improve-address-validation
        └── feature/user-dashboard-redesign
```

---

## OAuth Registration (DCR)

### US-DCR-01: MCP Client OAuth Registration
**As an** MCP client (ChatGPT, Claude Desktop)
**I want to** register for OAuth access
**So that** I can authenticate users to the Letter IRL service

**Acceptance Criteria:**
- [ ] `/oauth/register` endpoint accepts POST requests
- [ ] Returns RFC 7591 compliant response with `client_id`
- [ ] Returns `token_endpoint_auth_method: none` (public client)
- [ ] Includes all required redirect URIs (ChatGPT, Claude Desktop)
- [ ] Returns 201 Created status code
- [ ] Response includes `client_id_issued_at` timestamp

**Required Redirect URIs:**
- `https://chat.openai.com/aip/auth/callback` (ChatGPT)
- `https://chatgpt.com/connector_platform_oauth_redirect` (ChatGPT)
- `http://localhost:18883/oauth/callback` (Claude Desktop via mcp-remote)

**Personas:**
- ChatGPT (OpenAI Apps SDK connector)
- Claude Desktop (Anthropic via mcp-remote)

---

### US-DCR-02: Prevent Duplicate OAuth Client Creation
**As an** admin
**I want** the system to prevent duplicate Auth0 client creation
**So that** we don't hit Auth0 entity limits or clutter the tenant

**Acceptance Criteria:**
- [ ] Multiple DCR requests return the same static `client_id`
- [ ] No new clients created in Auth0 on registration requests
- [ ] Auth0 tenant stays within application entity limits
- [ ] Pre-provisioned first-party client used for all MCP connections
- [ ] Environment variable `CHATGPT_STATIC_CLIENT_ID` configures the client

**Background:**
The MCP spec (Nov 2025) has transitioned from DCR to CIMD (Client ID Metadata Documents).
This implementation uses a static client approach aligned with the spec direction.

**References:**
- [MCP Auth Spec Update Nov 2025](https://aaronparecki.com/2025/11/25/1/mcp-authorization-spec-update)
- GitHub Issue: #20

---

## Letter Layouts (LAYOUT)

### US-LAYOUT-01: Preview Letter with Header Image
**As a** user (Sarah, David)
**I want to** add a header image to my letter
**So that** I can include personal branding or decorative graphics at the top

**Acceptance Criteria:**
- [ ] Can provide header image via URL or file upload
- [ ] Image appears at top of letter (below address window area)
- [ ] Image resized to fit: max 6.5" wide, max 2" tall (300 DPI)
- [ ] Accepted formats: PNG, JPEG, WebP
- [ ] Maximum file size: 5 MB
- [ ] Character limit reduced to ~1500 (accounting for image space)
- [ ] Preview shows letter mockup with header image
- [ ] Layout auto-detected when header image provided
- [ ] Can explicitly set `layoutType: 'header_image'`

**Use Cases:**
- Personal letterhead (name/logo at top)
- Decorative headers (holiday themes, seasonal graphics)
- Business branding

**Error Cases:**
- [ ] Image too large (>5MB) → "Header image is too large. Please use an image under 5MB."
- [ ] Wrong format → "Unsupported image format. Please use PNG, JPEG, or WebP."
- [ ] Image processing fails → "Could not process header image. Please try a different image."
- [ ] Body exceeds reduced limit → "Letter exceeds one-page limit with header image (~1500 characters)"

---

### US-LAYOUT-02: Preview Letter with Inline Image
**As a** user (Sarah)
**I want to** add an image after my signature/closing
**So that** I can include a personal photo or illustration with my letter

**Acceptance Criteria:**
- [ ] Can provide inline image via URL or file upload
- [ ] Image appears after signature/closing text
- [ ] Image resized to fit: max 6.5" wide, max 3" tall (300 DPI)
- [ ] Accepted formats: PNG, JPEG, WebP
- [ ] Maximum file size: 5 MB
- [ ] Character limit reduced to ~1200 (accounting for image space)
- [ ] Preview shows letter mockup with inline image
- [ ] Layout auto-detected when inline image provided
- [ ] Can explicitly set `layoutType: 'inline_image'`

**Use Cases:**
- Personal photos with letters
- Hand-drawn illustrations
- QR codes or visual content

**Error Cases:**
- [ ] Image too large (>5MB) → "Inline image is too large. Please use an image under 5MB."
- [ ] Wrong format → "Unsupported image format. Please use PNG, JPEG, or WebP."
- [ ] Image processing fails → "Could not process inline image. Please try a different image."
- [ ] Body exceeds reduced limit → "Letter exceeds one-page limit with inline image (~1200 characters)"

---

### US-LAYOUT-03: Layout Type Detection and Override
**As a** user
**I want** the system to automatically detect my layout type
**So that** I don't have to specify it manually

**Acceptance Criteria:**
- [ ] Layout auto-detected from provided content:
  - Header image provided → `header_image` layout
  - Inline image provided → `inline_image` layout
  - No images provided → `text_only` layout
- [ ] Explicit `layoutType` parameter overrides auto-detection
- [ ] Layouts are mutually exclusive (cannot have both header AND inline image)
- [ ] If both images provided, error thrown with guidance
- [ ] Response includes `layoutType` field for confirmation

**Error Cases:**
- [ ] Both header and inline images provided → "Cannot use both header and inline images. Please choose one layout type."

---

### US-LAYOUT-04: Letter Layout Image Processing
**As the** system
**I want to** process images for letter layouts
**So that** letters print with high-quality images

**Acceptance Criteria:**
- [ ] Download image from URL during preview (same as postcard flow)
- [ ] Validate file size (max 5MB) before full download
- [ ] Validate content type (PNG, JPEG, WebP only)
- [ ] Resize to print dimensions at 300 DPI:
  - Header: max 1950x600px (6.5" x 2")
  - Inline: max 1950x900px (6.5" x 3")
- [ ] Use `contain` fit to preserve aspect ratio
- [ ] Convert to JPEG at 85% quality
- [ ] Store as base64 data URI in draft
- [ ] Processing completes inline (not background job)

**Technical Details:**
- Uses existing imageService.ts patterns from postcard
- Header stored in `header_image_data` column
- Inline stored in `inline_image_data` column
- Original URLs stored for debugging

---

### US-LAYOUT-05: Letter Layout Widget Preview
**As a** ChatGPT user
**I want** to see a visual mockup of my letter layout
**So that** I can verify how my letter will look when printed

**Acceptance Criteria:**
- [ ] Widget shows letter paper mockup (8.5x11 aspect ratio)
- [ ] Address window area visible at top (grayed/labeled)
- [ ] Text-only layout: Shows sender address, body text, signature
- [ ] Header layout: Shows header image, then content below
- [ ] Inline layout: Shows content, then image below signature
- [ ] Layout type indicated in widget meta section
- [ ] Scrollable content area for long letters
- [ ] Theme-aware (light/dark mode)
- [ ] Send button still functional for all layouts

**Visual Elements:**
- [ ] Simulated paper texture/shadow
- [ ] Proper typography (serif font for letter body)
- [ ] Clear visual separation of sections
- [ ] Image preview at appropriate scale

---

### US-LAYOUT-06: Letter Layout PostGrid Printing
**As the** system
**I want to** generate correct HTML for each letter layout
**So that** PostGrid prints letters with images correctly

**Acceptance Criteria:**
- [ ] Text-only layout: Current behavior (plain text in styled HTML)
- [ ] Header layout: Image embedded at top, content below
- [ ] Inline layout: Content at top, image at bottom
- [ ] Images embedded as base64 data URIs
- [ ] Proper margins maintained:
  - Top: 3.5" for address window
  - Sides/bottom: 1"
- [ ] Content fits on single page (validation at preview time)
- [ ] Worker passes layout data to provider

**PostGrid HTML Structure:**
- Header image positioned below 3.5" address margin
- Inline image positioned after message content
- CSS ensures proper sizing and positioning

---

## Priority Matrix

| Priority | Category | Stories | Key Personas |
|----------|----------|---------|--------------|
| P0 - Critical | Letter Sending | US-LETTER-01, US-LETTER-02, US-LETTER-03 | Sarah, Marcus, Eleanor |
| P0 - Critical | Credits | US-CREDIT-01, US-CREDIT-02, US-CREDIT-07 | All users |
| P0 - Critical | Security | US-SEC-01, US-SEC-02 | System |
| P1 - High | Letter Sending | US-LETTER-04, US-LETTER-05, US-LETTER-06, US-LETTER-07 | Marcus, David, System |
| P1 - High | Postcards | US-POSTCARD-01, US-POSTCARD-02, US-POSTCARD-03 | Sarah, David, Creative users |
| P1 - High | Credits | US-CREDIT-03, US-CREDIT-06, US-CREDIT-09 | System |
| P1 - High | Edge Cases | US-EDGE-01, US-EDGE-03, US-EDGE-04, US-EDGE-08 | Eleanor, System |
| P1 - High | Account | US-ACCT-00 | Sarah, Eleanor (new users) |
| P1 - High | MCP Access | US-MCP-01, US-MCP-03, US-MCP-07, US-MCP-08 | Morgan, Jordan |
| P2 - Medium | Promo | US-PROMO-01, US-PROMO-02, US-PROMO-03 | Alex |
| P2 - Medium | Account | US-ACCT-01, US-ACCT-02, US-ACCT-03 | All users |
| P2 - Medium | Admin | US-ADMIN-01, US-ADMIN-02, US-ADMIN-05 | Amy |
| P2 - Medium | Credits | US-CREDIT-08 | Eleanor, Sarah |
| P2 - Medium | Security | US-SEC-06 | Alex, Frank |
| P2 - Medium | MCP Access | US-MCP-02, US-MCP-04 | Morgan, Jordan |
| P3 - Low | Admin | US-ADMIN-03 - US-ADMIN-08 | Amy |
| P3 - Low | Edge Cases | US-EDGE-02, US-EDGE-05, US-EDGE-06, US-EDGE-07 | Eleanor |
| P3 - Low | MCP Access | US-MCP-05 | Amy |
| P3 - Low | Development | US-DEV-01, US-DEV-02, US-DEV-03 | Developers |
| P1 - High | OAuth Registration | US-DCR-01, US-DCR-02 | MCP Clients, Admin |
| P1 - High | Letter Layouts | US-LAYOUT-01 - US-LAYOUT-06 | Sarah, David |

---

## Story Count Summary

| Category | Prefix | Count |
|----------|--------|-------|
| Letter Sending | US-LETTER | 7 |
| Postcards | US-POSTCARD | 3 |
| Credits | US-CREDIT | 9 |
| Promo Codes | US-PROMO | 3 |
| Account | US-ACCT | 4 |
| Admin | US-ADMIN | 8 |
| Edge Cases | US-EDGE | 8 |
| Security | US-SEC | 6 |
| Data Integrity | US-DATA | 3 |
| MCP Access | US-MCP | 8 |
| Development | US-DEV | 3 |
| OAuth Registration | US-DCR | 2 |
| Letter Layouts | US-LAYOUT | 6 |
| **Total** | | **70** |

---

## See Also

- [personas.md](personas.md) - User personas and archetypes
- [letter-send-flow.md](letter-send-flow.md) - Technical implementation details
- [database-schema.md](database-schema.md) - Database structure
- [status.md](status.md) - Project overview
