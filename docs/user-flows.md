# Core User Flows

**Last Updated:** December 4, 2025

This document describes the primary user interaction flows for Letter IRL.

---

## Flow A - Send a New Letter

This is the main flow for composing and sending a letter.

### Step 1: Quote & Preview
1. User instructs ChatGPT to draft and mail a letter
2. ChatGPT composes the letter content
3. ChatGPT calls `quote_and_preview_letter` with:
   - Sender address
   - Recipient address
   - Body text
   - Sign-off

4. Server creates a **draft** in `letter_drafts` table:
   - Status: `pending`
   - Expires in 24 hours
   - Stores all letter content
   - Calculates required credits (based on page count)
   - Generates HTML preview

5. Server returns:
   - `draftId` (UUID) - the idempotency key
   - Preview HTML
   - Required credits
   - `canSendNow` flag (has sufficient credits?)

6. ChatGPT displays `LetterPreviewCard` with preview and cost

### Step 2: Confirm & Send
7. User approves the letter
8. ChatGPT calls `send_letter` with:
   - `draftId` from step 5
   - `confirm: true`

9. Server **atomically consumes** the draft:
   - Validates draft exists and is owned by user
   - Checks draft not expired
   - Updates status: `pending` → `consumed`
   - Records `consumed_at` timestamp

10. **Idempotency check**: If draft already consumed:
    - Returns existing letter (no duplicate charge)
    - Sets `isRetry: true` in response

11. Server **deducts credits**:
    - Uses FIFO from `credit_ledger` (soonest-expiring first)
    - Records consumption in `credit_consumption`
    - Creates transaction in `credit_transactions`

12. Server **creates letter** in `letters` table:
    - Status: `queued`
    - Links to draft via `letter_drafts.consumed_letter_id`

13. Server **queues job** via pg-boss:
    - Creates entry in `letter_jobs`
    - Adds job to background queue

14. Server returns confirmation:
    - `orderId` (letter ID)
    - `currentStatus: "queued_for_print"`
    - `creditsRemaining`

15. ChatGPT displays `LetterConfirmationCard`

### Step 3: Background Processing
16. pg-boss worker picks up job
17. Worker sends letter to PostGrid API
18. Worker updates letter:
    - Status: `sent`
    - `tracking_id` from PostGrid
    - `expected_delivery` date
19. Worker marks job as completed

---

## Flow B - Check Letter Status

1. User asks about a recent letter
2. ChatGPT calls `get_order_status`:
   - With `orderId` for specific letter
   - Without `orderId` for most recent
3. Server returns:
   - Status timeline
   - Recipient summary
   - Tracking info (if available)
   - Preview thumbnail
4. ChatGPT displays `LetterStatusCard`
5. Optional: User can request follow-up letter (loops to Flow A)

---

## Flow C - Check Credit Balance

1. User asks about remaining credits
2. ChatGPT calls `get_account_balance`
3. Server returns:
   - Total available credits
   - Credits expiring soon
   - Recent transactions
   - `canSendStandardLetter` flag
4. ChatGPT displays `BalanceCard`

---

## Flow D - Purchase Credits

1. User indicates need for more credits
2. ChatGPT provides purchase link:
   - `https://letterirl.com/buy` (or similar)
3. User clicks link and chooses package:
   - 4 credits - $7.99
   - 10 credits - $17.99
   - 100 credits - $149.99
4. User completes Stripe checkout
5. Stripe webhook triggers:
   - Creates `credit_ledger` entry
   - Creates `orders` record
   - Credits immediately available
6. User returns to ChatGPT and can send letters

---

## Flow E - Redeem Promo Code

Promo codes can be redeemed in two ways:

### Option 1: Preview Gate (Pre-Auth)
Used for beta access codes that unlock the website.

1. User visits website and sees preview gate
2. User enters promo code
3. Server validates (public endpoint - no auth required):
   - Code exists and is active
   - Campaign within validity window
   - Total redemption limit not reached
4. If valid: Cookie set, user gains preview access
5. User signs up/logs in
6. Credits (if any) added to account on first authenticated action

### Option 2: Settings Page (Authenticated)
Used for credit-granting promo codes by existing users.

1. User goes to Dashboard → Settings → Promo Code
2. User clicks "Enter a code →" to expand the form
3. User enters promo code
4. Server validates:
   - Code exists and is active
   - User hasn't exceeded per-user limit
   - Campaign within validity window
   - Total redemption limit not reached
5. Server creates `credit_ledger` entry:
   - Source: `promo`
   - Linked to campaign
   - Expiration per campaign policy (default: 90 days, or "never")
6. Server records in `promo_redemptions`
7. User sees success message with credits added

### Promo Code Types
- **Preview-only codes** (0 credits): Unlock website access during beta
- **Credit codes** (X credits): Grant bonus credits with optional expiration
- **Welcome codes**: May be restricted to new users only

---

## Flow F - Switch Account

1. User wants to use different account
2. ChatGPT calls `switch_account`
3. Server invalidates current session
4. ChatGPT initiates OAuth flow
5. User authenticates with new account
6. New session established with new user context

---

## Safety & Idempotency

### Only `send_letter` Has Real-World Effects
- All other tools are read-only
- `quote_and_preview_letter` creates drafts but doesn't charge
- Explicit `confirm: true` required to send

### Draft-Based Idempotency
- Each preview creates a unique `draftId`
- Calling `send_letter` twice with same `draftId`:
  - First call: Full processing, credits deducted
  - Second call: Returns existing letter, no duplicate charge
- Drafts expire after 24 hours if not used

### Credit Safety
- Credits deducted in same transaction as letter creation
- If job processing fails, credits stay deducted (letter still created)
- Refunds available for failed/cancelled letters via admin

---

## Error Handling

### Insufficient Credits
- `send_letter` fails with clear error
- User directed to purchase more credits

### Expired Draft
- `send_letter` fails if draft > 24 hours old
- User asked to call `quote_and_preview_letter` again

### Invalid Address
- Validation happens during quote phase
- Warnings shown in preview
- User can correct before sending

### Job Processing Failure
- Automatic retry (up to 3 attempts)
- Letter marked as `failed` after max retries
- Admin can manually retry via dashboard

---

## See Also

- [letter-send-flow.md](letter-send-flow.md) - Technical implementation details
- [database-schema.md](database-schema.md) - Database structure
- [status.md](status.md) - Project overview
