# Test: Purchase Letter Pack

**Purpose:** Verify that a user can purchase a Letter Pack through the Letter IRL development website using Stripe test checkout, and that the new balance is visible to the ChatGPT app.

**Test ID:** TEST-008

**Category:** Credits - Purchase Flow

## Background

Letter Packs are purchased on the Letter IRL website and then used by the ChatGPT app. This test validates the browser purchase flow, Stripe test checkout, webhook/credit update, and ChatGPT-side balance refresh.

## Start State

- Browser open to the Letter IRL development website
- User logged in to the Letter IRL dashboard
- Development website URL: `https://mail-letter-irl-website-development.up.railway.app`
- Stripe checkout is configured in test mode
- The target account has a known starting balance

## End State

- Letter Pack purchase is completed with Stripe test payment
- Dashboard shows increased letter balance
- ChatGPT app balance check shows the same Letter IRL/Auth0 account and updated balance

## Prerequisites

- Development Letter IRL website is available
- Test account credentials are available in `browser-test-procedures/config/.env.development`
- Stripe is in test mode for the development website
- Do not run this against production unless explicitly testing live billing with separate approval

## Safety Gate

- **Real mail risk:** None
- **Credit risk:** Adds simulated/dev letter balance
- **Approval required before irreversible action:** Yes for production only. Development Stripe test checkout can proceed when the user requests this test.

## Test Steps

### 1. Open Dev Website
- Navigate to:
  ```text
  https://mail-letter-irl-website-development.up.railway.app/dashboard/letter-packs
  ```
- If prompted, log in with the development test account.
- Verify the account email and starting balance.

### 2. Select a Pack
- Choose the smallest Letter Pack unless the test requires a larger balance.
- Current dev pack options observed on May 31, 2026:
  - `2 Letters` for `$5`
  - `5 Letters` for `$10`
  - `50 Letters` for `$90`

### 3. Complete Stripe Test Checkout
- Confirm the checkout URL starts with `https://checkout.stripe.com/` and the session ID begins with `cs_test_`.
- Use Stripe's success test card:
  ```text
  Card: 4242 4242 4242 4242
  Expiration: any future date, for example 12/34
  CVC: any three digits, for example 123
  ZIP: any valid ZIP, for example 64111
  ```
- Disable saved payment/Link options when possible.
- Submit the payment.

### 4. Verify Website Balance
- Wait for Stripe to redirect back to Letter IRL.
- Verify the Letter Packs page shows the new balance.
- Verify transaction history shows the purchase and number of letters added.

### 5. Verify ChatGPT App Balance
- Open ChatGPT.
- Activate `${APP_NAME}`.
- Ask: `Check my Letter IRL account balance.`
- Verify the app reports the updated balance for the same OAuth account.

## Expected Results

| Check | Expected |
|-------|----------|
| Dev dashboard loads | YES |
| Stripe checkout is `cs_test_` | YES |
| Test card succeeds | YES |
| Website balance increases | YES |
| Transaction history records purchase | YES |
| ChatGPT app sees updated balance | YES |

## Pass Criteria

- Stripe test checkout completes successfully.
- The Letter IRL dashboard shows the purchased letters.
- ChatGPT app balance reflects the purchase without needing code changes.

## Fail Criteria

- Checkout uses live Stripe mode unexpectedly.
- Payment succeeds but the website balance does not update.
- Website balance updates but ChatGPT app still reports the old balance for the same OAuth account.
- The tester cannot determine which Auth0/OAuth account received the purchased letters.

## Tool Notes

### Playwright MCP
- After clicking `Buy Now`, watch for a new Stripe tab or same-tab navigation.
- Use selectors for Stripe fields where available: `#cardNumber`, `#cardExpiry`, `#cardCvc`, `#billingName`, `#billingPostalCode`.

### Codex Chrome Control
- Claim the existing dev website tab if the user already has it open.
- Confirm the URL is the development Railway website before clicking `Buy Now`.
- Report only generic Stripe test card details; never print real payment data or stored credentials.
- After purchase, run a ChatGPT app balance check to verify propagation.

### Claude Chrome Extension
- Ask Claude to verify `cs_test_` before entering payment details.
- If Stripe prompts for real payment details or live mode, stop immediately.

### Manual Execution
- Use only Stripe's published test card values in development.
- If the Stripe page appears stuck on `Processing`, check whether the Letter IRL dashboard tab already updated or redirected back.

## Notes

- In the May 31, 2026 dev run, the 2-letter pack successfully added 2 letters to `testlirl@davidnicholl.com`.
- The transaction history label displayed `Purchased credit-pack-4 via Stripe Checkout` while the user-facing balance correctly increased by 2 letters. This is acceptable for the run but worth watching for copy clarity.
- A successful purchase may also refresh image-generation entitlement metadata returned by `get_account_balance`.

## Related Procedures

- [TEST-007-zero-credit-send-gating.md](./TEST-007-zero-credit-send-gating.md) - Verify zero-credit behavior before purchase
- [TEST-003-send-text-letter.md](./TEST-003-send-text-letter.md) - Verify sending after purchase
- [TEST-006-send-postcard.md](./TEST-006-send-postcard.md) - Verify postcard sending after purchase
