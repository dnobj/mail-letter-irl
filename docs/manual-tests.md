# Manual Test Checklist

## Issue #160 — Auth0 public CIMD DEV acceptance

Execution owner: `LIRL · Test · Browser`, after the implementation is deployed
and the owner completes the DEV Auth0/OpenAI configuration gate. These are
durable test definitions, not evidence that browser execution occurred.

Record the deployment/version, ChatGPT app/version IDs, redacted Auth0 client
count before and after, browser/mobile platform, result, and evidence link for
each case. Never capture tokens, authorization codes, addresses, letter content,
or raw request bodies.

### CIMD-01 — Fresh link

- [ ] Unlink the DEV app, revoke its stale Auth0 grant, and use a fresh/clean
      test account.
- [ ] Click **Sign in with (DEV) Letter IRL** and confirm Auth0 opens.
- [ ] Confirm the OAuth client ID is the current HTTPS CIMD URL, the exact
      `https://chatgpt.com/connector/oauth/{callback_id}` callback is accepted,
      authorization code + PKCE S256 is used, and no client secret is sent.
- [ ] Confirm consent identifies Letter IRL and requests only the expected
      identity and `mail:read`, `mail:draft`, `mail:send` scopes.

### CIMD-02 — Reconnect, revoke, and client-count/DCR

- [ ] Record the Auth0 application/client count before testing.
- [ ] Disconnect, reconnect, and re-consent twice.
- [ ] Revoke the Auth0 grant and verify the next tool call requires linking.
- [ ] Confirm the client count did not increase and no DCR registration request
      or new Auth0 application was created.

### CIMD-03 — Tool exposure and `get_started`

- [ ] Start a fresh ChatGPT conversation, select **(DEV) Letter IRL**, and run:
      `Use the selected DEV app's get_started tool and show me its onboarding card.`
- [ ] Confirm the Letter IRL `get_started` tool is invoked and `GetStartedCard`
      renders; record the tool evidence.

### CIMD-04 — Letter IRL image generation and widget

- [ ] Run: `Use Letter IRL to generate an image of a vivid sunset over mountain peaks for a postcard.`
- [ ] Confirm Letter IRL's `generate_image` tool is invoked and
      `GenerateImageCard` renders.
- [ ] Confirm ChatGPT does not fall back to native image generation.
- [ ] Continue into a postcard preview/edit and confirm `mail:draft` behavior.

### CIMD-05 — Scope enforcement

- [ ] Use a controlled DEV token/grant missing each product scope in turn.
- [ ] Verify read tools require `mail:read`, previews/images/address writes
      require `mail:draft`, and physical sends require `mail:send`.
- [ ] Confirm failures return `insufficient_scope` and a consistent
      `WWW-Authenticate` challenge without exposing credentials.

### CIMD-06 — Account switch and identity integrity

- [ ] Link account A, inspect its balance/order identity, then disconnect.
- [ ] Use the account-switch flow and link account B.
- [ ] Confirm account A data/email is not shown or overwritten for account B.
- [ ] Repeat after a userinfo failure and confirm a known email is not replaced
      by a placeholder.

### CIMD-07 — Web and mobile

- [ ] Repeat fresh link, `get_started`, and image/widget flow on ChatGPT web.
- [ ] Repeat the same core flow on each supported ChatGPT mobile client.
- [ ] Record platform/version and any mobile widget degradation separately.

### CIMD-08 — Sensitive logging

- [ ] Review Railway/Auth0 DEV logs for the test interval.
- [ ] Confirm logs contain no bearer tokens, authorization codes, CIMD document
      bodies, raw OAuth subject/user IDs, email addresses, MCP session IDs,
      addresses, letter/postcard content, generated image payloads or URLs,
      widget diagnostic payloads, or raw request bodies.
- [ ] Confirm validation diagnostics use only stable event names and non-sensitive
      error classes, with no arbitrary exception messages or stack traces.

Diagnostic `errorClass` values use a fixed privacy-safe taxonomy: `authorization_error`,
`configuration_error`, `database_error`, `provider_error`, `transport_error`,
`validation_error`, `rate_limit_error`, and `unknown_error`. A small allowlist of trusted JOSE,
network, and PostgreSQL codes may be emitted instead. Exception messages, stacks, identifiers, addresses,
tokens, and request content must never be used as an error class.

### CIMD-09 — Claude/PAT regression

- [ ] Connect the supported Claude/non-ChatGPT MCP path with a PAT.
- [ ] Confirm PAT tool calls work and never call Auth0 userinfo.
- [ ] Confirm the Claude/PAT path does not use or mutate the ChatGPT CIMD app.

### CIMD-10 — DEV rollback

- [ ] Save the accepted CIMD configuration and deployment identifiers.
- [ ] Enable `LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY=true` in DEV only with
      the recorded legacy client/audience and deploy the rollback configuration.
- [ ] Run a fresh-link smoke test and record behavior/client count.
- [ ] Restore CIMD mode (`false`), restore the dedicated exact `/mcp` audience,
      redeploy DEV, and rerun CIMD-01, CIMD-03, and CIMD-04.
- [ ] Confirm production was unchanged throughout.

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
- [ ] `GET https://api.letterirl.com/.well-known/oauth-protected-resource` returns
      the exact resource, Auth0 issuer, and product scopes
- [ ] Auth0's own discovery returns valid JSON; Letter IRL's authorization-server
      proxy and `POST /oauth/register` return 404 in normal CIMD mode

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

### CIMD client-count behavior
- [ ] After connecting, check Auth0 dashboard
- [ ] No new client or DCR call is created during connect/reconnect
- [ ] ChatGPT uses the manually imported public CIMD application

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

### Client separation
- [ ] After connecting, check Auth0 dashboard
- [ ] **No new "MCP CLI Proxy" client created**
- [ ] Does not use the ChatGPT CIMD application; use the supported separate
      OAuth adapter or PAT path

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
- [ ] (DEV) Letter IRL app activated in ChatGPT chat (type `@` → select "(DEV) Letter IRL")
- [ ] Authenticated / connected to the app

### Basic Generation (US-IMG-01)
1. [ ] Ask ChatGPT to generate an image (e.g. "Generate an image of a sunset over mountains for a postcard")
2. [ ] `generate_image` tool is invoked
3. [ ] GenerateImageCard widget appears in chat
4. [ ] Widget shows a loading/spinner state initially
5. [ ] Preview image renders in the widget
6. [ ] Image matches the prompt description

### Result Bridge and Chaining (Issue #169)
1. [ ] Confirm Letter IRL's `generate_image` tool is used, not native ChatGPT image generation
2. [ ] Confirm the widget displays the generated preview without exposing base64 data in the conversation
3. [ ] Ask ChatGPT to use the image in `quote_and_preview_postcard` without copying or re-entering its URL
4. [ ] Confirm the postcard front renders the same generated image
5. [ ] Reconnect or refresh the DEV app and repeat the generate-to-postcard flow to guard against cached widget resources
6. [ ] Repeat at a narrow mobile viewport and in dark mode; loading, preview, URL, and error states must remain readable without overflow
7. [ ] Confirm server and browser logs contain no bearer tokens, complete temporary image URLs, capability tokens, or base64 image bodies

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

## LIRL · Test · Browser — Issue #69 Pay & Send

**Execution status:** Not executed as part of the implementation PR. The test
coordinator must record the date, tester, client versions, order IDs, Stripe
session/payment/refund IDs, screenshots, and pass/fail results here or in the
linked PR before enabling Pay & Send.

### Preconditions

- [ ] Use only the Railway **development** services and isolated Neon development database.
- [ ] Confirm migration `021_jit_commerce_foundation.sql` is recorded in development.
- [ ] Confirm migration `023_jit_recovery_state_machines.sql` is recorded in development; migration 022 may arrive before or after it but must remain independently recorded.
- [ ] Confirm Stripe is in sandbox/test mode and both JIT prices are active at USD 4.99.
- [ ] Confirm the non-production mail provider is selected; no real mail may be submitted.
- [ ] Start with `JIT_PURCHASE_ENABLED=false`; the test coordinator may enable it in development only for this test and must restore it afterward.
- [ ] Prepare separate owner and non-owner test users, one zero-balance account, and one account with sufficient prepaid balance.

### Browser acceptance

1. [ ] In the desktop ChatGPT client, create and preview a letter with the zero-balance user. Choose **Pay & Send**, verify the checkout describes that exact letter and charges USD 4.99, complete sandbox payment, return to the conversation, observe **Paid - preparing mail**, and then observe **Sent**.
2. [ ] Repeat the complete path for a 6x9 postcard and verify the checkout describes that exact postcard at USD 4.99.
3. [ ] Repeat the letter or postcard happy path on Android, including return from Stripe to ChatGPT and the processing-to-sent status transition.
4. [ ] When `JIT_ALLOW_WITH_PREPAID_BALANCE=true`, confirm a funded user can see both the normal prepaid send action and Pay & Send; confirm the pack purchase action is not redundantly shown beside an already-available prepaid send.
5. [ ] Open Pay & Send and abandon the checkout. After Stripe reports the session expired, confirm the draft remains unsent and a new checkout or prepaid send can be started.
6. [ ] While a JIT checkout is active, attempt prepaid send for the same draft and confirm it is rejected. After a prepaid send wins, attempt to fulfill a late paid JIT session for that draft and confirm no second mail item is created and the paid order enters refund handling.
7. [ ] As the non-owner, attempt checkout and purchase-status access for the owner's draft/order. Confirm both are rejected without revealing whether the target exists.
8. [ ] Buy a sandbox letter pack and send from its balance to regression-test the existing prepaid path.

### Stripe, database, and recovery evidence

- [ ] For each successful JIT purchase, verify one authoritative `orders` row, one consumed draft, one funded `letters` row, one outbox job, one provider submission, and the configured image entitlement grant.
- [ ] Replay both completed-payment and asynchronous-payment-success events. Verify webhook-event deduplication and no duplicate fulfillment, provider submission, credit, or entitlement.
- [ ] Leave an asynchronous Checkout session in `complete`/`unpaid`; run maintenance and confirm it remains `checkout_pending` until Stripe reports success, failure, or expiry.
- [ ] Simulate a terminal failure before provider acceptance. Confirm `refund_pending`, at most one active Stripe refund for the order, retry recovery after a failed refund, and eventual `refunded` status.
- [ ] Start two refund-maintenance attempts concurrently and confirm only one acquires the lease and contacts Stripe. Then interrupt persistence after Stripe creates the refund; on replay, confirm the existing refund is discovered and finalized without creating another.
- [ ] Issue a partial sandbox refund and confirm the whole order and all entitlements are not marked refunded/revoked; then complete the full refund and verify terminal state.
- [ ] Confirm provider acceptance changes the JIT order to `fulfilled`; failures before acceptance use refund handling and never resubmit an already accepted mail item.
- [ ] After a sandbox provider accepts a submission, fault the database result-persistence step. Confirm the outbox remains recoverable, no refund is started, replay uses the same letter idempotency key, and the order eventually reaches `fulfilled` with one provider order.
- [ ] Confirm a zero-entitlement account cannot use Letter IRL-funded generation but can upload or reuse an external/conversation-generated image. After provider generation succeeds, simulate temporary-image storage failure and confirm the entitlement is still consumed.
- [ ] Stop the application after reservation commit but before durable dispatch; after the pre-dispatch lease expires, run maintenance and confirm the exact entitlement is released once.
- [ ] Simulate a definite 4xx provider rejection after dispatch and confirm the exact entitlement is released. Separately simulate a transport timeout or 5xx response and confirm the reservation becomes `ambiguous`, quota remains held, and no automatic retry spends a second provider generation.
- [ ] Resolve one ambiguous reservation from provider evidence as succeeded and confirm it becomes `consumed` without quota restoration. Resolve another as provider-confirmed failed (or record an explicit customer-compensation decision) and confirm only its exact entitlement is restored once.
- [ ] Replay a Stripe dispute event after forcing the first durable-alert insert to roll back. Confirm retry creates exactly one webhook claim and one sanitized open operational alert with no recipient, letter, order, dispute, charge, payment, or user identifier in alert details or logs.

### Teardown

- [ ] Restore `JIT_PURCHASE_ENABLED=false` in Railway development.
- [ ] Confirm production configuration, Stripe live mode, production Neon, and production mail-provider state were never changed.
- [ ] Attach the collected browser, Stripe, provider, and database evidence to the draft PR and record any deviations as linked issues.
