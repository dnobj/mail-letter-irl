# Manual Test Checklist

**Purpose:** Integration and end-to-end tests that require manual verification
**Last Updated:** July 16, 2026

---

## Quick Reference

| Test Suite | When to Run | Time |
|------------|-------------|------|
| [Smoke Tests](#smoke-tests) | Every deployment | ~5 min |
| [ChatGPT Integration](#chatgpt-integration) | After auth/MCP changes | ~10 min |
| [Payment Flow](#payment-flow) | After Stripe changes | ~10 min |
| [Full User Journey](#full-user-journey) | Before major releases | ~20 min |
| [Image Generation](#image-generation) | After image generation changes | ~5 min |
| [Idle and Recovery](#idle-and-recovery-verification) | After runtime/infrastructure changes | 20+ min idle time |

---

## Smoke Tests

Quick checks after every deployment. All should pass before considering deployment successful.

### API Health
- [ ] `GET https://api.letterirl.com/healthz` returns 200
- [ ] `GET https://api.letterirl.com/.well-known/openid-configuration` returns valid JSON
- [ ] `GET https://api.letterirl.com/oauth/register` (POST) returns 201 with static client_id

### MCP Endpoint
- [ ] ChatGPT developer-mode refresh discovers the current MCP tools
- [ ] MCP manifest accessible at `/manifest.json`

### Website
- [ ] `https://letterirl.com` loads
- [ ] Login button redirects to Auth0
- [ ] Dashboard loads after login

---

## ChatGPT Integration

Test the full ChatGPT connector flow.

### OAuth Flow (US-ACCT-01, US-DCR-01)
- [ ] Open ChatGPT → GPT that uses Letter IRL
- [ ] Click "Sign in" when prompted
- [ ] Auth0 login page appears
- [ ] Can login with Google
- [ ] Can login with Microsoft
- [ ] Can login with GitHub
- [ ] Can login with Email/Password
- [ ] After login, redirected back to ChatGPT
- [ ] ChatGPT shows "Connected" status

### DCR Behavior (US-DCR-02)
- [ ] After connecting, check Auth0 dashboard
- [ ] **No new "ChatGPT" client created** (uses static client)
- [ ] Only "ChatGPT MCP" first-party client exists

### MCP Tools in ChatGPT
- [ ] Ask "What's my credit balance?" → `get_account_balance` works
- [ ] Ask "Show my letters" → `list_orders` works
- [ ] Ask to preview a letter → `quote_and_preview_letter` works
- [ ] Letter preview renders in chat (widget or text)

### Widget Rendering (if enabled)
- [ ] Balance widget shows correct credits
- [ ] Letter preview widget shows formatted letter
- [ ] Widgets respect dark/light mode

---

## Claude Desktop Integration

Test Claude Desktop via mcp-remote.

### OAuth Flow (US-MCP-04)
- [ ] Configure Claude Desktop with mcp-remote config
- [ ] Start Claude Desktop
- [ ] Browser opens for Auth0 login
- [ ] Login completes successfully
- [ ] Claude Desktop shows Letter IRL tools available

### DCR Behavior
- [ ] After connecting, check Auth0 dashboard
- [ ] **No new "MCP CLI Proxy" client created**
- [ ] Uses same static "ChatGPT MCP" client

### MCP Tools in Claude Desktop
- [ ] Tools list shows Letter IRL tools
- [ ] `get_account_balance` returns balance
- [ ] `quote_and_preview_letter` works

### PAT Authentication (US-MCP-03)
- [ ] Generate PAT from website dashboard
- [ ] Configure Claude Desktop with PAT header
- [ ] Tools work without OAuth flow
- [ ] `last_used_at` updates in database

---

## Payment Flow

Test Stripe checkout and webhook handling.

### Credit Purchase (US-CREDIT-02)
- [ ] In ChatGPT, ask to buy credits
- [ ] Stripe Checkout URL returned
- [ ] Open URL → Stripe Checkout page loads
- [ ] Use test card: `4242 4242 4242 4242`
- [ ] Payment succeeds
- [ ] Redirected to success page

### Webhook Processing (US-EDGE-04)
- [ ] After payment, check credit balance
- [ ] Credits added correctly (4, 10, or 100)
- [ ] Transaction appears in history
- [ ] Ledger entry has 2-year expiration

### Webhook Idempotency
- [ ] Manually replay webhook (Stripe dashboard)
- [ ] Credits NOT duplicated
- [ ] Logs show "duplicate detected"

### Refund Handling (US-CREDIT-06)
- [ ] Issue refund in Stripe dashboard
- [ ] Credits deducted from balance
- [ ] Ledger entry marked revoked
- [ ] Transaction recorded

---

## Letter Sending Flow

Test the complete letter journey.

### Preview (US-LETTER-01)
- [ ] Provide valid US addresses (sender + recipient)
- [ ] Provide text-only letter body (at most 1,600 characters and 24 lines)
- [ ] Preview returns HTML
- [ ] Draft ID returned
- [ ] `canSendNow` reflects actual balance

### Validation Errors
- [ ] Missing address fields → clear error
- [ ] Non-US address → "Only supports US" error
- [ ] Text-only body over 1,600 characters or 24 lines returns a clear limit error
- [ ] Invalid address → suggestions returned

### Send (US-LETTER-02)
- [ ] Use draft ID from preview
- [ ] Set `confirm: true`
- [ ] Credits deducted
- [ ] Order ID returned
- [ ] Status is `accepted`, or `pending` with recovery explicitly scheduled

### Idempotency (US-LETTER-03)
- [ ] Call send again with same draft ID
- [ ] Same order returned
- [ ] `isRetry: true` in response
- [ ] Credits NOT deducted again

### Status Check (US-LETTER-04)
- [ ] Query status with order ID
- [ ] Status timeline shows history
- [ ] Recipient info shown (redacted appropriately)

### Outbox and Recovery (US-LETTER-06)
- [ ] A normal confirmed send is submitted immediately
- [ ] Exactly one `letter_jobs` row exists for the letter
- [ ] PostGrid/test-provider order ID is recorded once
- [ ] Repeating the same send returns the original order and does not deduct credits again
- [ ] A simulated transient provider failure leaves a due/pending outbox row
- [ ] `npm run maintenance` processes the due row and exits cleanly
- [ ] A stale processing lock is recovered after the configured lock timeout

---

## Image Generation

Test server-side image generation via the `generate_image` tool.

### Prerequisites
- [ ] (DEV) Mail IRL app activated in ChatGPT chat (type `@` → select "(DEV) Mail IRL")
- [ ] Authenticated / connected to the app

### Basic Generation (US-IMG-01)
1. [ ] Ask ChatGPT to generate an image (e.g. "Generate an image of a sunset over mountains for a postcard")
2. [ ] `generate_image` tool is invoked
3. [ ] GenerateImageCard widget appears in chat
4. [ ] Widget shows a loading/spinner state initially
5. [ ] Preview image renders in the widget
6. [ ] Image matches the prompt description

### Widget Interaction (US-IMG-02)
- [ ] "Use This Image" button is visible on the widget
- [ ] "Generate Another" button is visible on the widget
- [ ] Clicking "Use This Image" triggers upload to OpenAI file storage
- [ ] Widget transitions to success state after upload
- [ ] ChatGPT receives the image URL for use in subsequent tools

### Context-Specific Dimensions (US-IMG-03)
- [ ] Postcard context → landscape image (1536×1024)
- [ ] Header image context → landscape image (1536×1024)
- [ ] Inline image context → square image (1024×1024)

### Error Handling (US-IMG-04)
- [ ] Empty prompt → clear error message
- [ ] Content policy violation prompt → appropriate error

---

## Promo Code Flow

Test promotional code redemption.

### Validation (US-PROMO-01)
- [ ] Valid code returns credits amount
- [ ] Invalid code returns reason
- [ ] Expired code shows "expired"
- [ ] Case insensitive (PROMO = promo)

### Redemption (US-PROMO-02)
- [ ] Redeem valid code
- [ ] Credits added with correct expiration
- [ ] Redemption recorded
- [ ] Second redemption blocked ("already used")

### Rate Limiting (US-SEC-05)
- [ ] Public `/api/promo/validate` rate limited
- [ ] 10+ requests/min from same IP → 429
- [ ] Rate limit headers present

### New User Only (US-SEC-06)
- [ ] Create "new users only" campaign
- [ ] New user can redeem
- [ ] Existing user (with purchases) blocked

---

## Admin Panel

Test admin functionality (local only).

### Access Control (US-SEC-03)
- [ ] Admin panel only accessible on localhost
- [ ] `ADMIN_ENABLED=true` required
- [ ] Non-admin user rejected

### Dashboard (US-ADMIN-01)
- [ ] Metrics load correctly
- [ ] User counts accurate
- [ ] Credit totals match database

### User Investigation (US-ADMIN-04)
- [ ] Search user by email
- [ ] View user's credit ledger
- [ ] View user's letters
- [ ] View user's transactions

### Credit Adjustment (US-ADMIN-05)
- [ ] Add credits to user
- [ ] Reason/description required
- [ ] Ledger entry created
- [ ] Balance updated

### Promo Management (US-ADMIN-07)
- [ ] Create new campaign
- [ ] Set limits (per user, total)
- [ ] Activate/pause campaign
- [ ] View redemption count

---

## Full User Journey

End-to-end test of complete user experience.

### New User Journey (US-ACCT-00)
1. [ ] Connect via ChatGPT (first time)
2. [ ] Account auto-created
3. [ ] Balance shows 0 credits
4. [ ] Preview letter → `canSendNow: false`
5. [ ] Redeem promo code OR purchase credits
6. [ ] Balance updated
7. [ ] Send letter with same draft
8. [ ] Letter queued successfully
9. [ ] Check status shows progress

### Returning User Journey
1. [ ] Connect via ChatGPT
2. [ ] Recognized (existing account)
3. [ ] Balance shows previous credits
4. [ ] Can see previous letters
5. [ ] Send new letter
6. [ ] Credits deducted correctly

### Multi-Provider Journey (US-ACCT-02)
1. [ ] Login with Google
2. [ ] Note user ID
3. [ ] Switch account
4. [ ] Login with GitHub
5. [ ] Different user ID (separate account)
6. [ ] Each account has own credits/letters

---

## Idle and Recovery Verification

Rollout note (July 16, 2026): the outbox migration, pooled development database connection, hourly maintenance, public endpoint checks, cost limits, and development Serverless settings are deployed. The unchecked items below remain the acceptance record; do not promote to production until they pass.

### Zero Balance and Simulated Purchase
- [ ] Confirm the dedicated test account has zero available sends
- [ ] Preview a letter or postcard and verify the UI clearly says it cannot be sent yet
- [ ] Attempt a confirmed send and verify no order or credit deduction is created
- [ ] Open the development website letter-pack checkout
- [ ] Complete a simulated Stripe purchase with `4242 4242 4242 4242`
- [ ] Return to ChatGPT and verify the updated balance
- [ ] Confirm the original or a fresh draft can now be sent exactly once

### Image Restart Persistence
- [ ] Generate an image through the development app
- [ ] Verify the temporary image URL works
- [ ] Restart the development API service
- [ ] Verify the same image URL still works before 15 minutes expires
- [ ] Verify expired images are removed by hourly maintenance

### Development Sleep and Wake
- [x] Leave development API and website idle for more than ten minutes
- [x] Confirm both Railway services report sleeping
- [x] Measure first API and website response after sleep (`1.34s` API, `1.38s` website on July 16, 2026)
- [x] Confirm first-use recovery is at most three seconds
- [ ] Connect the ChatGPT app and render a widget after wake-up
- [ ] Generate or reuse an image after wake-up
- [ ] Disable Serverless if latency exceeds three seconds or any flow fails

### Neon Scale to Zero
- [ ] Close manual Neon SQL/editor sessions
- [ ] Wait more than five minutes after the final application query
- [ ] Confirm both Neon computes suspend when their environments are idle
- [ ] Confirm no two-second polling queries or pg-boss connections appear
- [ ] Track combined usage for seven idle days; target less than `1 CU-hour/day`

---

## Environment-Specific Tests

### Development Environment
- [ ] Dev API responds (Railway dev URL)
- [ ] Uses Neon dev branch
- [ ] Uses Stripe test mode
- [ ] Uses dummy letter provider
- [ ] No real mail sent
- [ ] No real charges

### Production Environment
- [ ] api.letterirl.com responds
- [ ] Uses Neon main branch
- [ ] Uses Stripe live mode
- [ ] Uses PostGrid live mode
- [ ] Real mail capability confirmed

---

## Post-Incident Tests

Run after fixing issues.

### After Auth Changes
- [ ] All OAuth providers work
- [ ] Token validation works
- [ ] PAT authentication works
- [ ] No duplicate Auth0 clients created

### After Payment Changes
- [ ] Checkout creates correct session
- [ ] Webhook processes payment
- [ ] Credits added correctly
- [ ] Refunds processed correctly

### After Database Changes
- [ ] Migrations applied successfully
- [ ] No data loss
- [ ] Queries perform acceptably
- [ ] Indexes working

---

## Test Data

### Stripe Test Cards
| Card | Behavior |
|------|----------|
| `4242 4242 4242 4242` | Success |
| `4000 0000 0000 0002` | Decline |
| `4000 0000 0000 9995` | Insufficient funds |

### Test Addresses (US)
```
Sender:
123 Test Street
San Francisco, CA 94102

Recipient:
456 Sample Ave
New York, NY 10001
```

### Test Promo Codes
Check admin panel or database for active test campaigns.

---

## Notes

- Always test in **development environment first**
- Use Stripe test mode for payment tests
- PostGrid test mode or dummy provider for letter tests
- Document any issues found in GitHub Issues
- Update this checklist as features change
