# Manual Test Checklist

## Issue #160 — Auth0 public CIMD DEV acceptance

Execution owner: `LIRL · Test · Browser`, after the implementation is deployed
and the owner completes the DEV Auth0/OpenAI configuration gate.

**Status (reconciled 2026-08-23).** CIMD-01 through CIMD-05 were executed against
DEV in late July / early August and are ticked below, each against the issue
comment carrying its sanitized evidence. CIMD-06, CIMD-07, CIMD-09, and CIMD-10
remain open, and the reason each is blocked is recorded on the case itself.
Ticks here mean an execution happened and was evidenced; they are not a claim
that the case can never regress.

Record the deployment/version, ChatGPT app/version IDs, redacted Auth0 client
count before and after, browser/mobile platform, result, and evidence link for
each case. Never capture tokens, authorization codes, addresses, letter content,
or raw request bodies.

### CIMD-01 — Fresh link

- [x] Unlink the DEV app, revoke its stale Auth0 grant, and use a fresh/clean
      test account.
- [x] Click **Sign in with (DEV) Letter IRL** and confirm Auth0 opens.
- [x] Confirm the OAuth client ID is the current HTTPS CIMD URL, the exact
      `https://chatgpt.com/connector/oauth/{callback_id}` callback is accepted,
      authorization code + PKCE S256 is used, and no client secret is sent.
- [x] Confirm consent identifies Letter IRL and requests only the expected
      identity and `mail:read`, `mail:draft`, `mail:send` scopes.

Evidence: https://github.com/dnobj/mail-letter-irl/issues/160#issuecomment-5146200022 (link established, CIMD client imported) and
https://github.com/dnobj/mail-letter-irl/issues/160#issuecomment-5147799259 (read-only audit: exact CIMD client ID and callback).
**Re-run required** once `offline_access` is advertised - the consent screen will
then also request offline access, so the last checkbox's expectation changes.

### CIMD-02 — Reconnect, revoke, and client-count/DCR

- [x] Record the Auth0 application/client count before testing.
- [x] Disconnect, reconnect, and re-consent twice.
- [x] Revoke the Auth0 grant and verify the next tool call requires linking.
- [x] Confirm the client count did not increase and no DCR registration request
      or new Auth0 application was created.

Evidence: https://github.com/dnobj/mail-letter-irl/issues/160#issuecomment-5146247529 (two reconnects, count stable at 7, same CIMD
client reused) and https://github.com/dnobj/mail-letter-irl/issues/160#issuecomment-5148795945 (post-reconnect invariant: 7 clients,
1 CIMD client, 1 grant, 0 DCR create events).

#### CIMD-02a - Session survives access-token expiry (refresh tokens)

Added 2026-08-23. Before `offline_access` was requested, no refresh token was
issued, so an expired access token could only be recovered by a human clicking
**Reconnect** and re-consenting. This case is the proof that the fix works.

**Passed 2026-08-23 on DEV.** Verified with the API's access-token lifetime
temporarily lowered to 300s (restored afterwards to 86400 / 7200 for web).

- [x] Confirm the consent screen requests offline access, and that Auth0 records
      a refresh token issued on the code exchange.
      Consent screen listed **Allow offline access**; the authorize event
      recorded `scope: "mail:read mail:draft mail:send offline_access"`.
- [x] Leave the connection idle past the access-token lifetime, then invoke any
      read tool (for example `get_account_balance`).
      Token issued 21:53:30Z (300s life, expiring 21:58:30Z); tool invoked
      ~22:18Z - roughly 22 minutes past expiry.
- [x] Confirm the tool call succeeds with **no** "connection has expired" prompt
      and no human re-consent.
      Call returned the balance. Auth0 logged
      `Successful Refresh Token exchange` at 22:18:12Z with
      `policy_used: refresh_token_user_grant` and `tokenCounter: 2`, confirming
      rotation is active. Baseline before the fix was **zero** refresh
      exchanges of any kind, ever.

**Two traps worth knowing before re-running this:**

1. The scope must appear in each tool's `securitySchemes`, not merely in
   `scopes_supported`. ChatGPT builds its authorization request from the union
   of the per-tool lists (issue #160).
2. A deploy alone does not reach ChatGPT - the connector holds a pinned
   app-version snapshot, and only **Refresh** re-ingests tool schemas.
   **Refresh is not rendered while the connector is in the disconnected
   state**, so it must be clicked while connected. Reading the tool's
   `SECURITY SCHEMES` block on the connector page is the way to confirm a
   refresh actually landed; the App Version Id does not change.
- [ ] Confirm rotation: the refresh token used is replaced, and Auth0 shows no
      growth in client or grant count.

#### CIMD-02b - Revocation still forces a re-link

Added 2026-08-23. The counterpart to CIMD-02a: refresh tokens exist to remove
prompts, and the risk they introduce is a grant that outlives the user's intent.
A grant that survives revocation would be the real defect.

**Passed 2026-08-23 on DEV.** Run it with the access token already expired,
otherwise the call succeeds on the still-valid access token and proves nothing
about the refresh token - a revoked grant does not invalidate an access token
that has already been issued.

- [x] Revoke the ChatGPT grant in the Auth0 dashboard.
      Revoked 22:37:27Z (`API Operation - Delete a grant by id`).
- [x] Invoke any Letter IRL tool in ChatGPT.
      `get_account_balance` at ~22:38, with the access token expired since
      22:23:12Z, so the call had to go through the refresh token.
- [x] Confirm the call fails closed and a fresh link/consent is required - the
      stored refresh token must not silently resurrect the session.
      ChatGPT showed the "connection has expired" prompt and returned **no
      account data**.

The positive evidence is on the Auth0 side, and it matters: at 22:38:34Z the log
recorded `Failed Exchange - Token could not be decoded or is missing in DB` for
ChatGPT. So the client did present its refresh token and the authorization
server rejected it, rather than the client merely declining to try. Successful
refresh exchanges stayed at 3 across the test; the failed count went 0 to 1.

Note the connector is left **disconnected** by this test and must be
reconnected before further manual cases.

### CIMD-03 — Tool exposure and `get_started`

- [x] Start a fresh ChatGPT conversation, select **(DEV) Letter IRL**, and run:
      `Use the selected DEV app's get_started tool and show me its onboarding card.`
- [x] Confirm the Letter IRL `get_started` tool is invoked and `GetStartedCard`
      renders; record the tool evidence.

Evidence: https://github.com/dnobj/mail-letter-irl/issues/160#issuecomment-5148795945 (post-reconnect PASS, conversation linked).
Re-confirmed repeatedly since, most recently 2026-08-23 during the widget
redesign and the get_started narration fix.

### CIMD-04 — Image routing and upload widget

- [x] Run a generic `Generate an image of a sunset` with the app attached and
      confirm ChatGPT uses NATIVE image generation and NO Letter IRL tool is
      invoked (Letter IRL's generator was removed Aug 2026; decision record:
      docs/learnings/generate-image-removal-decision.md).
- [x] Run `Open the Letter IRL photo upload widget for a postcard` and confirm
      `upload_image` is invoked and `ImageUploadCard` renders.
- [x] Continue into a postcard preview/edit and confirm `mail:draft` behavior.

Evidence: https://github.com/dnobj/mail-letter-irl/issues/160#issuecomment-5147473811 (generate -> widget -> postcard preview reached
Ready to send; nothing mailed or charged). Note the image-routing expectation was
rewritten afterwards by the #227 arc - current behavior is governed by
`LETTER_IRL_IMAGE_GEN_MODE` and documented in
docs/learnings/generate-image-removal-decision.md.

### CIMD-05 — Scope enforcement

- [x] Use a controlled DEV token/grant missing each product scope in turn.
- [x] Verify read tools require `mail:read`, previews/images/address writes
      require `mail:draft`, and physical sends require `mail:send`.
- [x] Confirm failures return `insufficient_scope` and a consistent
      `WWW-Authenticate` challenge without exposing credentials.

Evidence: https://github.com/dnobj/mail-letter-irl/issues/160#issuecomment-5148966534 (missing `mail:read`) and
https://github.com/dnobj/mail-letter-irl/issues/160#issuecomment-5149023713 (missing `mail:draft`, missing `mail:send`). All three
used temporary loopback PKCE clients that were removed afterwards; each guard
fired before any handler, provider, charge, or mail action.

### CIMD-06 — Account switch and identity integrity

**Blocked:** needs a second approved DEV test identity provisioned through the
secure local test-account process (https://github.com/dnobj/mail-letter-irl/issues/160#issuecomment-5149106768). An arbitrary tenant
user is not an approved test identity.

- [ ] Link account A, inspect its balance/order identity, then disconnect.
- [ ] Use the account-switch flow and link account B.
- [ ] Confirm account A data/email is not shown or overwritten for account B.
- [ ] Repeat after a userinfo failure and confirm a known email is not replaced
      by a placeholder.

### CIMD-07 — Web and mobile

**Partial.** The web half is covered by CIMD-01/03/04 above. Native-app coverage
exists for widgets and image routing (Aug 2026 Android sessions recorded in the
#227 evidence trail), but a mobile *fresh link* has not been executed.

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

**Blocked:** needs an already-approved DEV PAT placed in the documented
gitignored test-credential location, or an existing PAT-compatible client
configured locally (https://github.com/dnobj/mail-letter-irl/issues/160#issuecomment-5149106768). No PAT is to be created for this
purpose, pasted into GitHub, or exposed in chat.

- [ ] Connect the supported Claude/non-ChatGPT MCP path with a PAT.
- [ ] Confirm PAT tool calls work and never call Auth0 userinfo.
- [ ] Confirm the Claude/PAT path does not use or mutate the ChatGPT CIMD app.

### CIMD-10 — DEV rollback

**Open:** preparation recorded in https://github.com/dnobj/mail-letter-irl/issues/160#issuecomment-5149106768; the exercise itself
has not been run. Worth running before the production cutover (#158), since it is
the only rehearsal of the rollback path.

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
| [Image Generation Routing](#image-generation-routing) | After image-routing or upload-widget changes | ~5 min |
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
- [ ] Multi-tenant address with a suite/apartment (e.g. 350 5th Ave, Suite 8701, New York, NY 10118) → draft IS created; response carries a one-sentence note that USPS couldn't confirm the unit and mail goes out as entered (issue #200)
- [ ] Same building with no unit given → draft IS created with an "add the unit if you have it" note
- [ ] Garbage street (123 Fake Street, Nowhere) → still refused, message says what to check

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

## Image Generation Routing

`generate_image_for_mail` is a HYBRID (decision record Addendum 3): with
Letter IRL image credits (pack/JIT grants plus a one-time starter allowance)
it generates in-turn; without credits it returns a redirect card with a
copy-ready prompt for free built-in generation. Unmentioned requests still
route to built-in generation directly.

### Prerequisites
- [ ] (DEV) Letter IRL app activated in ChatGPT chat (type `@` → select "(DEV) Letter IRL")
- [ ] Authenticated / connected to the app

### Hybrid Image Tool (Issue #227, Addendum 3)
1. [ ] With credits available (fresh accounts receive the starter allowance on first use): `@(DEV) Letter IRL generate an image of ...` → confirm the ImageRoutingCard shows the GENERATED image in-turn with the credit line, and the model chains the imageUrl into `quote_and_preview_postcard`
2. [ ] With credits exhausted: repeat → confirm the REDIRECT card shows the explanation plus a copy-ready prompt field with a working Copy button; pasting the prompt WITHOUT the mention generates natively
3. [ ] Unmentioned generic request ("Generate an image of a sunset") → confirm NATIVE generation runs with no Letter IRL tool call
4. [ ] Ask ChatGPT to use a natively generated image in `quote_and_preview_postcard`; confirm the postcard front renders the same image (fileParams handoff, no manual URL copying)
5. [ ] Confirm generations appear in `image_generation_reservations` (feeds the `LETTER_IRL_IMAGE_DAILY_CEILING` count) and no secrets or prompts leak into diagnostics

### Image Recovery Path (upload widget)
1. [ ] Ask to pick a different photo; confirm `upload_image` renders the ImageUploadCard
2. [ ] Desktop/mobile web: confirm "Choose from Library" is present and lists generated images; native app: confirm "Select Photo" (local upload) is present — `selectFiles` does not exist on the native host, which is expected
3. [ ] Refresh the DEV app after widget changes (Refresh re-ingests schemas; Reconnect only re-auths); on the native iOS/Android app force-quit and reopen after the web Refresh (the native apps cache widget templates aggressively - the versioned ui://…@vN URIs exist to bust this, issue #235)
4. [ ] Repeat at a narrow mobile viewport and in dark mode; states must remain readable without overflow
5. [ ] Confirm server and browser logs contain no bearer tokens, complete temporary image URLs, capability tokens, or base64 image bodies

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

## Admin Operator Interface

The legacy public page and API are disabled while the hardened local operator application is delivered in
issue #162 slices. Do not set `ADMIN_ENABLED=true`, open `admin-panel.html` directly, or place an admin
database URL in `.env`.

### ADMIN-FOUNDATION-022 — Slice 1 public denial and regression case

**Status:** Awaiting execution by `LIRL · Test · Browser`; this checklist does not claim a result.

**Preconditions:**

- Use the deployed development public API only; do not connect to production or provision a role.
- Confirm the candidate build contains `022_admin_audit.sql` and that the migration record shows the
  separate `021_jit_commerce_foundation.sql` before `022_admin_audit.sql`.
- Confirm the migration content identities in the
  [migration 021/022/023 integration gate](deployment.md#migration-021022023-integration-gate) still match
  the candidate build. A changed blob ID means the arrival-order proof must be rerun first.
- Record the candidate commit and development public API origin without recording any credential.

**Steps:**

1. [ ] Open `/admin`, `/admin/`, `/admin.html`, `/admin-panel.html`, and `/admin/example`; verify each
   returns `404`, does not render the legacy HTML, and is not cacheable.
2. [ ] Request `/api/admin`, `/api/admin/`, `/api/admin/users`, and an `OPTIONS` request to
   `/api/admin/users`; verify each returns `404`, contains no user/admin data, and sends no CORS allow
   header.
3. [ ] Open `/healthz`; verify `200` and body `ok`.
   Then open `/readyz`; verify `200` with `"ready":true` and `"mode":"development"` (issue #155).
   A `503` names the failing check — config, database, routing, or prices — with detail in the deploy log
   under `readiness.failed`.
4. [ ] Open `/`; verify the existing public service status response remains successful.
5. [ ] Open the manifest and OAuth metadata routes used by the development deployment; verify their
   existing public behavior remains successful and contains no admin route advertisement.
6. [ ] Confirm no new local admin browser server or UI is expected in this slice and no production access,
   provider call, charge, mail order, Railway mutation, or role provisioning was performed.
7. [ ] Confirm `JIT_PURCHASE_ENABLED` and `IMAGE_TRIAL_ENABLED` are still `false`, because issue #69's
   `/api/admin/image-generation/*` operator recovery routes are intentionally among the paths this slice
   404s and no replacement operator control exists yet.
8. [ ] Attach status/header evidence for every route, the migration ordering evidence, browser console
   observations, and the tested commit to the PR. Redact origins only if required; never attach secrets.

**Pass criteria:** Every legacy path is a no-store `404` with no CORS/data leakage, and the public health,
root, manifest, and OAuth metadata regressions remain healthy. Any non-404 legacy response is a release
blocker.

The authenticated session, read models, UI, and command cases will be added by later slices before their
corresponding functionality is enabled.

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
- [ ] Before applying migration 023, rerun both migration orders with the exact issue #162 `022_admin_audit.sql`. Confirm 023 is independently recorded only after both orders converge structurally, including defaults, constraints, triggers/functions, and privileges.
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
- [ ] Force PostGrid 429, 500, 502, 503, and 504 responses and confirm each becomes a held/ambiguous outcome with a `mail_provider_outcome_ambiguous` alert, no refund, and no second submission. Repeat with a timeout/connection loss, a truncated response body, and a 2xx body missing `id`/`status`. Confirm the admin retry endpoint rejects every one of them, and that only a non-ambiguous 4xx (400/401/403/404/422) becomes a definite rejection eligible for refund and audited retry.
- [ ] Confirm an audited retry can restore JIT fulfillment only before refund starts; cross-account/replayed/changed requests fail closed.
- [ ] Point one `STRIPE_PRICE_*` at an archived Price (or a nonexistent id) and restart. In production `/readyz` reports `prices` failing (503); in a development deploy - where this manual test normally runs - it stays 200 with `"prices":"degraded"`, and the detail is in the log under `readiness.prices_unresolved`. Either way, both the current and legacy pack checkout paths must fail closed with a stable configuration error, create no order, and call no Stripe checkout API. (Replaces the pre-#275 case of removing a `STRIPE_*_AMOUNT_CENTS`, which no longer exists.)
- [ ] With that price still unresolvable, complete a paid sandbox checkout that no order can bind. Confirm the webhook event is retained as `unmatched` with an open critical `stripe_money_event_unmatched` alert, no credits are granted, and the customer's payment is visible to an operator. Restore the variable and confirm the alert still requires manual reconciliation — this case does not auto-recover, and redelivering the event from Stripe is deduplicated.
- [ ] After a sandbox provider accepts a submission, fault the database result-persistence step. Confirm the outbox becomes `held`/`ambiguous`, no refund or automatic resend starts, and an authenticated operator must reconcile the single provider outcome.
- [ ] Resolve an ambiguous mail job with conclusive provider acceptance and confirm the existing submission becomes `accepted`/`completed` without another provider call. For a provider-confirmed rejection, test both explicit outcomes: `retry` must atomically restore the held job/letter/JIT order to `pending`/`queued`/`fulfillment_pending` with the same provider idempotency key, while `rejected` must make the job terminal/exhausted and move the JIT order to `refund_pending`. Confirm exact replay is harmless, changed-actor/key reuse conflicts, and accepted/refund-resolved work cannot be re-mailed.
- [ ] Race a full refund and a dispute against the final pre-dispatch lock. Confirm the winner atomically cancels undispatched mail or holds ambiguous dispatched mail; an admin retry must reject refunded, disputed, held, accepted, and exhausted jobs.
- [ ] From the hardened local origin, inspect `commerce_operational_alerts`, acknowledge one, resolve one with a safe resolution code, and replay the same idempotency key. Confirm cross-origin, preflight, missing custom-header, non-JSON mutation, bad-CSRF, proxied, and unauthenticated requests fail closed without CORS readback.
- [ ] Confirm a zero-entitlement account cannot use Letter IRL-funded generation but can upload or reuse an external/conversation-generated image. After provider generation succeeds, simulate temporary-image storage failure and confirm the entitlement is still consumed.
- [ ] Stop the application after reservation commit but before durable dispatch; after the pre-dispatch lease expires, run maintenance and confirm the exact entitlement is released once.
- [ ] Simulate a definite 4xx provider rejection after dispatch and confirm the exact entitlement is released. Separately simulate a transport timeout or 5xx response and confirm the reservation becomes `ambiguous`, quota remains held, and no automatic retry spends a second provider generation.
- [ ] Use the authenticated admin procedure in `docs/deployment.md` to inspect ambiguous reservations. Confirm an unauthenticated request cannot inspect or resolve them and a mismatched account cannot mutate the reservation.
- [ ] Resolve one ambiguous reservation from provider evidence with `consume` / `provider_confirmed_succeeded` and confirm it becomes `consumed` without quota restoration. Resolve another with `release` / `provider_confirmed_failed` (or an explicitly approved `customer_compensation`) and confirm only its exact entitlement is restored once.
- [ ] Replay each resolution with the same idempotency key and exact body. Confirm HTTP 200 with `replayed: true`, one audit row, and no second counter change. Reuse the key with changed evidence and confirm a conflict with no mutation.
- [ ] Confirm operator diagnostics retain the stable decision/result classifications but never include reservation, account, provider request, address, URL, endpoint, tracking, or image identifiers.
- [ ] Replay a Stripe dispute event after forcing the first durable-alert insert to roll back. Confirm retry creates exactly one webhook claim and one sanitized open operational alert with no recipient, letter, order, dispute, charge, payment, or user identifier in alert details or logs.
- [ ] Close that sandbox dispute and confirm the matching open alert becomes `resolved` with a safe `stripe_dispute_*` resolution code while an idempotent close alert is recorded; unrelated dispute alerts must remain open.
- [ ] Cause checkout completion handling to roll back, then issue a dashboard refund before replaying checkout. Confirm the refund creates `stripe_money_event_unmatched`; later checkout/reconciliation resolves it into `refund_pending` without creating a letter or provider submission. Repeat with missing payment/order references and confirm the durable alert remains open.
- [ ] Race provider-acceptance persistence against a full refund in disposable PostgreSQL. Confirm no deadlock, one accepted provider submission, a refunded order, and a critical already-dispatched alert; no retry path may submit the mail again.
- [ ] Run Stripe reconciliation with one fulfilled pack and one funded JIT order. Confirm the pack ledger is joined through `order_id -> stripe_checkout_session_id`, JIT requires no credit row, and both match. Remove a test pack grant and confirm repair locks the exact fulfilled order/session and restores its ledger plus image entitlement once under concurrent attempts. A pending JIT checkout, wrong session, or amount/currency mismatch must require webhook/operator review and must never receive pack credits.

### Teardown

- [ ] Restore `JIT_PURCHASE_ENABLED=false` in Railway development.
- [ ] Confirm production configuration, Stripe live mode, production Neon, and production mail-provider state were never changed.
- [ ] Attach the collected browser, Stripe, provider, and database evidence to the draft PR and record any deviations as linked issues.
