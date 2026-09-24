# Core User Flows

**Last Updated:** September 16, 2026

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

13. Server **inserts one outbox row** in `letter_jobs`. Steps 9-13 commit in one transaction; an
    insufficient balance rolls all of them back.

### Step 3: Immediate Submission
14. In the same request, the server claims the outbox row and submits the letter to PostGrid, using
    the `letter_id` as the `Idempotency-Key`
15. On success the letter becomes `accepted`, with `tracking_id`, `cost_cents` and
    `expected_delivery`, and the job `completed`
16. Server returns confirmation:
    - `orderId` (letter ID)
    - `currentStatus`: `accepted`, `pending` (retry scheduled, or queued because the outbox is paused:
      "Queued for the print provider", #444) or `failed`
    - `lettersRemaining`
    - `isRetry: true` when the draft had already been consumed
17. ChatGPT confirms the order in chat and may continue with status follow-up

A timeout or `5xx` after dispatch holds the job for an operator rather than resubmitting it. The hourly
maintenance run retries anything left due. See [letter-send-flow.md](letter-send-flow.md).

### Paying for one letter instead (Pay & Send)
When the balance is too low, the preview card offers **Pay & Send**. It calls `create_mail_checkout`
and opens Stripe-hosted Checkout. A verified payment webhook consumes the same draft and creates the
letter and its outbox row in one transaction; the next hourly maintenance run submits it to PostGrid.
The user does not call `send_letter` afterwards.

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
   - Tracking support level
4. ChatGPT summarizes the current order status
5. Optional: User can request follow-up letter (loops to Flow A)

---

## Flow C - Check Credit Balance

1. User asks about remaining credits
2. ChatGPT calls `get_account_balance`
3. Server returns:
   - `lettersRemaining`
   - Letters expiring soon, with dates
   - `imageGenerationsRemaining` and `imageGenerationsAllowance`
   - `canSendStandardLetter` flag
4. ChatGPT summarizes the balance and can offer a letter pack (Flow D)

---

## Flow D - Buy a Letter Pack

1. User wants more letters, or a preview says the balance is too low
2. ChatGPT calls `list_letter_packs` (or the preview card's **Buy a Letter Pack** button does):
   - Starter - 2 letters - $5.00
   - Regular - 5 letters - $10.00
   - Power - 50 letters - $90.00
3. User picks a pack; `create_pack_checkout` creates an `orders` record and a Stripe-hosted Checkout
   Session, and `PackCheckoutCard` shows the order and the link
4. User completes Stripe Checkout outside ChatGPT and returns to the conversation (the return page
   offers a way back when ChatGPT supplied one)
5. The verified `checkout.session.completed` webhook:
   - Creates the `credit_ledger` lot (valid 24 months), attributed to the order
   - Grants the pack's image generations
   - Completes the order
6. The card polls `get_purchase_status` and shows the letters added; the user can send

The same packs can be bought on the letterirl.com dashboard. Prices are pinned in
`src/config/products.ts`.

---

## Flow E - Redeem Promo Code

Promo codes can be redeemed in two ways:

### Option 1: Public Landing / Pre-Auth Promo Entry
Used for public promo codes entered before login.

1. User visits website
2. User enters promo code
3. Server validates (public endpoint - no auth required):
   - Code exists and is active
   - Campaign within validity window
   - Total redemption limit not reached
4. User signs up/logs in
5. Credits (if any) added to account on first authenticated action

### Option 2: In ChatGPT

1. User gives ChatGPT a code
2. ChatGPT calls `redeem_promo_code`
3. The server applies the same validation and ledger steps as Option 3; an invalid, expired or spent
   code returns `redeemed: false` with the reason rather than an error

### Option 3: Settings Page (Authenticated)
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
7. User sees a success message with the letters added

### Promo Code Types
- **Landing-page codes** (0 credits): Reserved for future marketing or access experiments
- **Credit codes** (X credits): Grant bonus credits with optional expiration
- **Welcome codes**: May be restricted to new users only

---

## Flow F - Switch Account

There is no tool for this; `switch_account` was removed.

1. User disconnects Letter IRL in ChatGPT's app settings
2. User ends the Auth0 session (the tenant's `/v2/logout` URL), so the next login is not silently reused
3. User connects Letter IRL again; ChatGPT starts the OAuth flow
4. User signs in with the other account
5. Tool calls now run as that account's `user_id`

Login methods sharing one confirmed email address are one account, joined at
sign-in by an Auth0 post-login Action, so step 4 lands back on the same account
unless the other method carries a different address
([account-switching-guide.md](account-switching-guide.md)).

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
