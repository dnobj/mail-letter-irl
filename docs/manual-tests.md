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

Test Stripe checkout and webhook handling. In production, Stripe and PostGrid
are **live**: every completed purchase charges a real card and every send mails
a real letter. Use the smallest pack, refund it afterwards under REFUND-01, and
never type a card number anywhere except Stripe's own checkout page. Card
numbers, checkout URLs, and addresses never go into evidence.

**Precondition for every case below: the Stripe webhook endpoint for the
environment subscribes to every event the handler dispatches on.** Check
Developers → Webhooks → the endpoint. `processStripeWebhookEvent` acts on
exactly:

- `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`
- `refund.created`, `refund.updated`, `refund.failed`, `charge.refunded`
- `charge.dispute.created`, `charge.dispute.closed`

Anything else is recorded and ignored. A refund event that is not subscribed
fails silently: the money goes back and the letters stay, and only the
on-demand admin reconciliation would ever notice.

Evidence for every case comes from three places: the ChatGPT transcript, the
Railway log line `stripe.webhook_received` (its `eventType` field says which
event arrived; `credits.webhook_failed` means the handler threw), and the
account balance as `get_account_balance` reports it.

### PAY-01 — Pack purchase (US-CREDIT-02)
- [ ] In ChatGPT, ask to buy the smallest letter pack (Starter Pack, 2 letters).
- [ ] `list_letter_packs` runs, then `create_pack_checkout`, and ChatGPT
      presents the checkout as a clickable link. Known gap: it may say the
      checkout is "open" without showing a link until asked for one.
- [ ] Open the link. Stripe Checkout shows the pack name, the price, and the
      account email already filled in. The prefilled email proves the `users`
      row exists; a blank email field means it does not (#319).
- [ ] Pay. Production: a real card, refunded under REFUND-01. Development: a
      Stripe test card, typed by the owner.
- [ ] Balance reads 2 letters. Railway shows `stripe.webhook_received` with
      `checkout.session.completed`. If the balance is right but that line is
      absent, the card's Check status polled Stripe directly and the webhook
      endpoint is not delivering: fix the endpoint before REFUND-01, which has
      no such fallback.

### PAY-02 — Webhook idempotency (US-EDGE-04)
- [ ] Stripe Dashboard → Developers → Webhooks → the endpoint → the delivered
      `checkout.session.completed` event → Resend.
- [ ] Response body is `{ "received": true, "duplicate": true }`.
- [ ] Balance unchanged; no second purchase lot in the ledger.

### REFUND-01 — Full refund from the Stripe Dashboard (US-CREDIT-06)
Precondition: PAY-01, then one letter sent from that pack, so the spent and
unspent halves are both present. Letter IRL has no refund button of its own;
the refund is issued in Stripe and reaches the service only as a webhook.
- [ ] Stripe Dashboard → Payments → the pack payment → Refund → full amount.
- [ ] Railway: `stripe.webhook_received` with `charge.refunded` (and
      `refund.created` / `refund.updated` if delivered), no
      `credits.webhook_failed`.
- [ ] Balance drops by the **unspent** letters only: 1 → 0. The sent letter is
      untouched and its status still tracks normally.
- [ ] `get_purchase_status` for the pack order reads `refunded`, message
      "The payment was refunded."
- [ ] Database or admin view: the purchase lot is `revoked` with
      `remaining_amount = 0`; one `refund` ledger row links to it with
      `remaining_at_revocation` equal to what was left; one `credit_transactions`
      row of `-<unspent credits>`; `orders.refunded_at` is set;
      `credits_purchased` dropped by the whole pack.
- [ ] No `stripe_money_event_unmatched` row in `commerce_operational_alerts`.

### REFUND-02 — Partial refund from the Stripe Dashboard raises an alert
The house rule forbids partial pack refunds from the Dashboard; this case proves
the mistake is loud rather than silent. Nothing about the customer's account
changes: the money left, the letters stayed, and a person has to decide.
- [ ] Stripe Dashboard → Payments → a fulfilled pack payment → Refund → an
      amount less than the total.
- [ ] Balance, purchase lot, and order status are all unchanged; nothing is
      revoked and no `refund` ledger row appears.
- [ ] `commerce_operational_alerts` has exactly one open critical
      `stripe_partial_refund_unmatched` row for the order, naming the Stripe
      refund id and the amount, even though Stripe delivered `refund.created`,
      `refund.updated`, and `charge.refunded`; its `details.events` lists all
      three.
- [ ] Railway shows `stripe.partial_refund_unmatched` once per event;
      `commerce_order_events` has a row per event with
      `unmatchedPartialRefund: true`; the reconciliation report lists the refund
      as `unmatched_partial_refund`.
- [ ] Refund the remainder in the Dashboard: REFUND-01's expectations now hold
      for that order, and the alert can be resolved with a
      `dashboard_partial_reviewed` code.
### REFUND-03 — Replay and sibling events
- [ ] Resend the delivered `charge.refunded` event from the Stripe Dashboard.
      Response `duplicate: true`; balance unchanged; still exactly one `refund`
      ledger row.
- [ ] If Stripe also delivered `refund.updated` for the same refund, that event
      is processed (it is a different event id) but records `already_refunded`
      and revokes nothing more.

### REFUND-04 — Refunding a Pay & Send letter
A single-letter order behaves differently from a pack: the money funded one
specific piece of mail, so the handler tries to stop that mail first.
- [ ] Refund a Pay & Send order **before** the printer accepts it: the letter
      job and the letter both read `cancelled`, and nothing mails.
- [ ] Refund one **after** acceptance, only with a letter you meant to send
      anyway, because it is real postage: the refund records, the mail
      continues, and a critical `refunded_mail_already_dispatched` row appears
      in `commerce_operational_alerts`.

### REFUND-05 — Proportional refund of unspent letters (operator command)
Precondition: PAY-01 with the Regular Pack (5 letters), then one letter sent,
so four letters remain. `LETTER_IRL_PACK_REFUND_COMMAND_ENABLED=true` on the
service the command runs in. Development first, with Stripe in test mode. No
customer-facing tool can start this; it runs from the admin panel's order page in
full mode (`ADMIN-STRIPE-02` walks the panel steps).
- [ ] `get_purchase_status` for the pack reads `letters 5, lettersRemaining 4,
      lettersRefunded 0, perLetterCents 200, refundableAmountCents 800`.
- [ ] Preview the command for 3 letters: it shows USD 6.00 and a digest.
      Confirm with that digest, an operator name, a reason code, and a fresh
      idempotency key.
- [ ] Balance drops 4 → 1 letter BEFORE the Stripe refund exists; Stripe then
      shows a partial refund of USD 6.00 on the payment with metadata
      `orderId`, `packRefundId`, `lettersRefunded: 3`.
- [ ] Railway: `stripe.webhook_received` with `refund.created` and
      `charge.refunded`, no `credits.webhook_failed`; no
      `stripe_partial_refund_unmatched` row; `pack_refund.stripe_event` logged.
- [ ] `get_purchase_status` reads `submitted` with `lettersRemaining 1,
      lettersRefunded 3, amountRefundedCents 600`; `commerce_pack_refunds` row
      is `succeeded` with the Stripe refund id.
- [ ] Database: the purchase lot is `active` with `remaining_amount = 2`; one
      `refund` ledger row with `reason: partial_refund`, `letters_refunded: 3`;
      `credit_transactions` `-6`; `orders.credits_refunded = 6`; one
      `commerce_operator_audit_events` row with `operation = pack_refund`.
- [ ] Replay the confirm with the same idempotency key: `replayed: true`, no
      second refund in Stripe. Send a second command for the same order: refused
      as already issued.
- [ ] Send the last letter, then refund the remainder from the Stripe Dashboard
      (REFUND-06 checks the outcome).

### REFUND-06 — Full Dashboard refund after a proportional refund
Precondition: REFUND-05 completed (3 of 5 letters refunded, 2 sent).
- [ ] Stripe Dashboard → the same payment → Refund → full remaining amount
      (USD 4.00).
- [ ] Railway: `refund.created` with amount 400 is processed as a FULL refund
      (not an alert); `charge.refunded` shows `amount_refunded 1000`.
- [ ] Balance unchanged at 0 (nothing was left); the purchase lot is `revoked`;
      `orders.status = refunded`, `amount_refunded_cents = 1000`;
      `credits_purchased` dropped by 4 (10 − 6 already refunded), not by 10.
- [ ] `get_purchase_status` reads `refunded` with `lettersRefunded 3`.

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

The legacy public page and API stay disabled (`ADMIN_ENABLED=true` fails the public server's boot). The
replacement is the tailnet-only admin panel described in [admin-panel-guide.md](admin-panel-guide.md);
its cases follow `ADMIN-FOUNDATION-022`. Never open `admin-panel.html` directly or place an admin
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
7. [ ] Confirm `JIT_PURCHASE_ENABLED` and `IMAGE_TRIAL_ENABLED` match the environment's intent: issue #69's
   operator recovery no longer lives behind the denied `/api/admin/image-generation/*` routes but in the
   tailnet admin panel (`ADMIN-ACCT-04`).
8. [ ] Attach status/header evidence for every route, the migration ordering evidence, browser console
   observations, and the tested commit to the PR. Redact origins only if required; never attach secrets.

**Pass criteria:** Every legacy path is a no-store `404` with no CORS/data leakage, and the public health,
root, manifest, and OAuth metadata regressions remain healthy. Any non-404 legacy response is a release
blocker.

### ADMIN-INFRA-01 — Tailnet ingress spike (development)

**Status:** Executed 2026-09-07 from the owner's laptop (curl over the tailnet plus the owner's Chrome):
steps 1, 2, 5, 6 and 7 passed; step 3 (phone) and step 4 (private network) were not run, because the
phone's client is below the posture minimum and Railway offers no shell into the API service.

**Preconditions:**

- The development `letter-irl-admin` service exists with a `/data` volume, no domain, Serverless off, and
  the variables in [admin-panel-guide.md](admin-panel-guide.md); `TS_AUTHKEY` was consumed and deleted.
- The tailnet policy carries the `tag:dev-admin` grant, posture and tests; HTTPS and MagicDNS are on.
- The laptop and the phone run Tailscale signed in as the allowlisted login.

**Steps:**

1. [x] Read the deploy log; verify `[tailscale] ready name=letter-irl-admin-dev.<tailnet>.ts.net tags=tag:dev-admin`
   and `admin.listening`, and that the Railway healthcheck passed with no domain. (Seen on the first boot
   and again on the redeploy without `TS_AUTHKEY`; the healthcheck answered 503 twice, then 200.)
2. [x] Open `https://letter-irl-admin-dev.<tailnet>.ts.net/` from the laptop; verify a valid certificate
   and the overview page. (curl with certificate verification returned 200; Chrome rendered the overview
   with no warning.)
3. [ ] From the phone on the tailnet, open the same URL; verify it answers. Turn Tailscale off on the phone;
   verify the URL no longer resolves or connects.
4. [ ] **The app port must be refused from the tailnet.** The boot log prints
   `admin.tailnet_addresses`; from a device the policy allows, and for each address it names, verify
   that `curl -sv --max-time 5 http://<address>:8790/` and `https://<address>:8790/` both fail to
   connect, while `https://letter-irl-admin-dev.<tailnet>.ts.net/` answers. This is the step that
   proves the policy carries the weight the trust model gives it: userspace networking forwards an
   inbound tunnel connection to the same port on localhost, so a peer allowed to reach 8790 would
   meet the application listener with headers of its own choosing. Re-run after any policy edit.
   Then, from another service in the development environment (a Railway shell on the API service),
   run `curl -si http://letter-irl-admin.railway.internal:$PORT/healthz`; verify the body is exactly
   `ok` and `curl -si http://letter-irl-admin.railway.internal:8790/` is refused (connection refused,
   not a page).
5. [x] From the internet, verify the service has no `*.up.railway.app` domain and that
   `https://letter-irl-admin-dev.<tailnet>.ts.net/healthz` does not resolve off the tailnet. (Railway lists
   no service or custom domain; public resolvers return no address for the name; `/healthz` through Serve
   answers 404, so even a tailnet peer reaches the health listener only on the private port.)
6. [x] Redeploy the service; verify the machine keeps its name (no `-1` suffix) and the URL still answers.
   (One machine, same address, after the redeploy without `TS_AUTHKEY`.)
7. [x] Attach the log lines, the console screenshot of the machine (tag and no "Locked out" badge), and
   the curl outputs. Never attach a key or a connection string. (Recorded in the setup session and in
   the first-boot section of the guide.)

**Pass criteria:** The `.ts.net` URL answers only from an allowed device; the private network reaches only
`/healthz`; port 8790 is refused; a redeploy is the same node. Any answer from the internet is a release
blocker.

### ADMIN-READ-01 — Banner and identity

**Status:** Passed 2026-09-07 (curl over the tailnet from the laptop; build 5172e00).

**Preconditions:** `ADMIN-INFRA-01` passed; the development panel runs in `read-only` mode.

**Steps:**

1. [x] Open the overview; verify the banner shows `development`, `mode: read-only`, `marker: development`,
   `db role: letter_irl_admin_reader_development`, `stripe: test` (or `absent` while no key is set), the
   mail provider (`unset` until `LETTER_PROVIDER` is given), the node name with `tag:dev-admin`, the build
   commit, and `operator: <your login> from <your device name>`.
2. [x] Reload; verify the session cookie is reused (one `admin.session_start` row per session in
   `/audit`, not one per request). (Three requests on one cookie jar left the row count unchanged.)
3. [x] Verify the response headers carry `Content-Security-Policy` with a nonce, `Cache-Control: no-store`
   and `X-Correlation-Id`. (Also `X-Frame-Options: DENY` and `Referrer-Policy`, which was `no-referrer` when
   this ran and is `same-origin` since 2026-09-08: `no-referrer` made browsers send `Origin: null` on form
   posts, which the boundary check refuses, so no write was possible from a browser.)

**Pass criteria:** The banner states what the machine checked, and one session produces one audit row.

### ADMIN-READ-02 — Account and pack figures

**Status:** Passed 2026-09-07 against the owner's own development account (looked up by exact subject;
the lookup-by-email variant of step 1 is still open).

**Preconditions:** A development account that bought a pack in test mode and mailed one letter (PAY-01).

**Steps:**

1. [x] Look the account up by exact email; verify the email is masked on the account page. (Looked up by
   exact Auth0 subject: one match, plus the recent-accounts table with masked emails. Before the reveal
   the only full email address in the page source was the operator's own in the banner.)
2. [x] Verify the ledger lots show initial and remaining credits, and the letters table shows metadata
   only: no content, no recipient, no address anywhere on the page. (The letters table is captioned
   "metadata only; content and recipients are never shown here".)
3. [x] Open the pack order; verify "unspent letters" and "maximum proportional refund" match
   letters remaining × amount ÷ letters in pack, floored. (50 in pack, 24 unspent, 26 sent, 0 refunded,
   1.80 USD per letter, 43.20 USD maximum: 24 × 90.00 ÷ 50.)
4. [x] Reveal the email with a reason; verify it appears once, and `/audit` shows a `pii.reveal` row with
   that reason. Submit a reason shorter than 8 characters; verify a 400 and a denied `pii.reveal` row.
   (200 with exactly one more email address in the page than before; `short` answered
   `400 ADMIN_INVALID_REQUEST`; `/audit` shows one allowed and one denied `pii.reveal` row.)

**Pass criteria:** Figures agree with the ledger; content and addresses are absent; the reveal is audited.

### ADMIN-READ-03 — A Dashboard refund is visible

**Status:** Not run on 2026-09-07: the development database held no refunded order at the time.

**Preconditions:** REFUND-01 was run in development.

**Steps:**

1. [ ] Open the refunded order; verify the lots show `revoked`, `amount refunded` equals the pack amount,
   the webhook events list the three refund events, and no alert is open for the order.
2. [ ] Run REFUND-02 (a partial Dashboard refund); verify `/alerts` shows the critical
   `stripe_partial_refund_unmatched` alert linked to the order, and the order page lists it.

**Pass criteria:** The panel shows what the webhook did, without a log search.

### ADMIN-READ-04 — Denials

**Status:** Step 4 passed 2026-09-07 (curl); steps 1 to 3 not run.

**Steps:**

1. [ ] Temporarily remove your login from `ADMIN_OPERATOR_LOGINS` and redeploy; verify the URL answers
   `403 forbidden` with a constant body and `/audit` (after restoring the variable) shows the denied row
   with your login. Restore the variable.
2. [ ] From another service on the private network, request `http://letter-irl-admin.railway.internal:8790/`;
   verify connection refused (the app listener is loopback only).
3. [ ] Leave a tab idle for 16 minutes; verify the next request starts a new session (a new
   `admin.session_start` row) rather than failing.
4. [x] Submit the reveal form with the CSRF field removed (browser devtools); verify `403 forbidden` and a
   denied row with `ADMIN_CSRF_REJECTED`. (A POST with same-origin headers but no token, and a POST with
   no `Origin` at all, both answered `403` with the body `forbidden`; `/audit` shows `admin.request_denied`
   for route `account.reveal` with `ADMIN_CSRF_REJECTED`.)

**Pass criteria:** Every denial is a constant body plus an audit row; nothing on the private network
reaches an application route.

### ADMIN-READ-05 — Keyboard-only navigation and 200 % zoom

**Status:** Partly run 2026-09-07 in the owner's Chrome: focus is visible on the navigation links and every
badge carries text; the full keyboard traversal and the 320 px rendering are still open (Chrome refused a
320 px window; every table on the overview, account and jobs pages sits in a `.scroll` container with
`overflow-x: auto`, which is the structural half of step 2).

**Steps:**

1. [ ] Navigate the overview, lookup, account and order pages with Tab, Shift+Tab and Enter only; verify
   every control is reachable, focus is visible, and the reveal form submits from the keyboard.
2. [ ] At 200 % zoom and at a 320 px wide window, verify no horizontal page scroll: wide tables scroll
   inside their own container.
3. [x] Verify status is conveyed by text as well as by colour in every badge. (`failed` and
   `definite_failure` badges on the overview and jobs pages.)

**Pass criteria:** No mouse needed; no page-level horizontal scroll at 320 px.

### ADMIN-READ-06 — The same pages from the phone

**Steps:**

1. [ ] Repeat ADMIN-READ-01 and ADMIN-READ-02 steps 1 to 3 from the phone browser over Tailscale.
2. [ ] Verify the banner shows the phone's device name as the node.

**Pass criteria:** Identical data; the node name identifies the device.

### ADMIN-PROD-RO-01 — Production read-only gate

**Status:** Executed 2026-09-10 on the owner's read-only approval, from the owner's laptop over the
tailnet (curl with certificate verification plus the embedded browser). All three steps passed, with
two readings recorded below. The production service is `letter-irl-admin-prod` (Railway service names are
unique per project and development holds `letter-irl-admin`); the node is `letter-irl-admin-prod`.

**Preconditions:** Production roles created by SQL; grants applied with `--confirm-production-access`;
the production node registered with `tag:prod-admin`; `ADMIN_MODE=read-only`; the restricted Stripe key
absent or live.

**Steps:**

1. [x] Verify the banner shows `production`, `read-only`, `marker: production`,
   `letter_irl_admin_reader_production`, `stripe: live` and `tag:prod-admin`. (Seen, with `stripe: absent`:
   the restricted live key is a full-mode item and was not set at this gate. Build `801b40c`.)
2. [x] Open the refunded Starter Pack order from the launch weekend; verify 2 letters, 0 remaining,
   500 cents refunded, lots revoked. (Status `refunded`, both ledger lots `revoked` with 0 remaining and not
   spendable, 5.00 USD paid. The order's refunded-amount field reads 0.00 USD because that column arrived
   with migration 029 and the refund was issued from the Dashboard before it existed; the status and the
   revoked lots are the record of the refund.)
3. [x] Verify `/audit` shows the boot event and this session, and that no command route exists in full mode
   terms (every POST other than reveal and logout answers 403 `ADMIN_READ_ONLY_MODE`). (`admin.boot` and
   the sessions listed; a POST to `/elevate` carrying the session cookie and its CSRF token answered 403
   with the read-only page and audited `admin.request_denied` with `ADMIN_READ_ONLY_MODE`. A POST without
   a session is refused earlier as `ADMIN_CSRF_REJECTED`, also audited. The app port 8790 is unreachable
   from the tailnet, as in ADMIN-INFRA-01 step 4.)

**Pass criteria:** Production is visible and untouchable.

### ADMIN-PROD-FULL-01 — Production full-mode gate and first command

**Status:** Executed 2026-09-11 on the owner's separate full-mode and first-command approvals, from the
owner's own browser over the tailnet (the writes need the owner's authenticator code and a browser
session; the audit rows were read back with curl). Passed, with one configuration gap found and closed
between the two runs of step 4.

**Preconditions:** `ADMIN-PROD-RO-01` passed; a restricted **live** Stripe key created for this service
(Charges and Refunds write, Payment Intents read, Payment Disputes read, Checkout Sessions read);
`ADMIN_TOTP_SECRET` enrolled with `npx tsx scripts/adminTotpEnrol.ts production`; `DATABASE_URL` switched
to `letter_irl_admin_operator_production` and `ADMIN_MODE=full` in the same variable edit; the provider
variables wired as references to the API service.

**Steps:**

1. [x] Verify the banner shows `production`, `full`, `stripe: live`, `mail: postgrid` and `tag:prod-admin`,
   and that `/audit` carries the boot event. (Seen on build `801b40c`. The banner names the reader role,
   which pages read through; the operator role is what the boot validated.)
2. [x] Run the Stripe reconciliation from `/stripe` (no elevation needed). (Last 30 days: 1 Stripe payment,
   1 grant, matched, no discrepancies; `stripe.reconcile` audited with counts and no Stripe identifiers.)
3. [x] Elevate on `/elevate` with the authenticator; verify the banner shows the elevation and `/audit`
   records `admin.elevate`. (Both seen; the window is 10 minutes in production, and a redeploy drops
   every session.)
4. [x] Execute the provider status sync as a dry run from
   `/commands/mail.status_sync/preview?target=letters&days=30&dryRun=on` with a reason and the phrase
   `PRODUCTION SYNC-DRY-RUN letters`; verify a `succeeded` run row and a `mail.status_sync` audit row.
   (First run: succeeded, `checked: 1, errors: 1`, the error being `Letter not found` for the one live
   letter, because the service had no `LETTER_PROVIDER*` variables and used the dummy provider. After
   wiring the three provider variables as references to the API service and redeploying: succeeded,
   `checked: 1, updated: 0, errors: 0` against PostGrid.)

**Pass criteria:** Every write goes through elevation, preview and typed confirmation, is recorded as a
run and an audit row, and the panel's provider commands talk to the real provider.

### ADMIN-CMD-01 — Acknowledge and resolve an alert with elevation, preview, typed confirmation and replay

**Status:** Executed 2026-09-08 in the owner's Chrome, driven by the browser extension, with the
balance adjustment on the owner's own development account standing in for the alert, because no alert
was open. Step 1 passed (the preview named elevation and Execute was disabled). Step 2 passed (banner
"elevated until", `admin.elevate` audited). Step 3 passed (`CONFIRM <account id>`; the run listed on
`/commands`, `account.adjust_balance` audited with the reason and command id, and the ledger lot reads
`adjustment` with no reason text anywhere on the account page). Step 4 passed (the same confirmation
answered "already processed", no second audit row). Step 5 passed (two previews of the same change;
the second answered `409 ADMIN_STALE_PREVIEW`). Step 6 not run: five wrong codes would lock the owner
out for fifteen minutes. Also seen: a wrong phrase answered `400 ADMIN_INVALID_REQUEST` and was audited
as denied, and a five-character reason was accepted, because the eight-character minimum lived only in
the form until the pull request that carries this record.

**Preconditions:** The development panel runs in full mode (`ADMIN_MODE=full`, `DATABASE_URL` on the
operator role, `ADMIN_TOTP_SECRET` from `npm run admin:totp-enrol -- development`, the authenticator
enrolled on a different device); an open alert exists (REFUND-02 raises one).

**Steps:**

1. [ ] Open the alert and preview "acknowledge" without elevating; verify the page says elevation is
   needed and the execute button is disabled.
2. [ ] Open `/elevate`, enter a code; verify the banner shows "elevated until", a new session cookie was
   issued, and `/audit` shows `admin.elevate`.
3. [ ] Preview "acknowledge" again; type the phrase shown (`CONFIRM <alert id>` in development); execute.
   Verify the outcome page says succeeded, the alert shows `acknowledged`, `/commands` lists the run, and
   `/audit` shows `alert.transition` with your reason and the command id.
4. [ ] Go back and submit the same form again; verify the outcome page says the confirmation was already
   processed and `/audit` gained no second `alert.transition` row.
5. [ ] Open two "resolve" previews for the same alert in two tabs with different resolution codes;
   execute the first; execute the second; verify the second answers `409 ADMIN_STALE_PREVIEW` and the alert
   keeps the first code.
6. [ ] Enter a wrong code on `/elevate` five times; verify elevation locks, the page says so, and `/audit`
   shows five `admin.elevation_denied` rows.

**Pass criteria:** Nothing executes without elevation, a matching phrase and a fresh preview; a replay
returns the first outcome; every step is in the audit log.

### ADMIN-CMD-02 — Resolve an ambiguous job with provider evidence

**Status:** Not run 2026-09-08: no job was held on an ambiguous outcome.

**Preconditions:** Full mode as above; a job held on an ambiguous provider outcome (the stub evidence
flow in [deployment.md](deployment.md#ambiguous-image-reservation-operator-procedure) describes how the
dummy provider produces one).

**Steps:**

1. [ ] Open the job; verify the resolution form appears only while the job is `held / ambiguous`.
2. [ ] Choose `accepted`, the provider consulted and its reference; preview; verify the preview shows the
   letter, account, current state and that the reference is described as hashed.
3. [ ] Execute with the phrase; verify the letter is `accepted`, the job `completed`, the
   `mail_provider_outcome_ambiguous` alert for the job is resolved, and `/audit` shows `job.resolve`.
4. [ ] Repeat with `rejected` on another held job; verify the letter fails and, for a prepaid letter, the
   credits return through the failed-send path (account page shows an adjustment lot).

**Pass criteria:** The job leaves the held state only with evidence, and the outcome matches the decision.

### ADMIN-CMD-03 — Retry a definite failure, and the refusals

**Status:** Step 3 passed 2026-09-08 (elevation dropped on `/elevate`; a prepared preview answered
`403 ADMIN_ELEVATION_REQUIRED`, the balance was unchanged, and both events were audited). Steps 1 and
2 deliberately not run: a retried job is dispatched to whatever provider development routes to, an
outside effect the owner should trigger knowingly. Step 4 not run.

**Preconditions:** Full mode; a job in `failed / definite_failure` with a failed letter.

**Steps:**

1. [ ] Preview the retry; give a reason of at least 8 characters; execute. Verify the job is `pending` and
   the letter `queued`, and that the next maintenance run dispatches it.
2. [ ] Preview a retry of the same job again; verify `409 ADMIN_INVALID_STATE` (it is no longer failed).
3. [ ] Drop the elevation on `/elevate` (or wait for it to expire) and execute a prepared preview; verify
   `403 ADMIN_ELEVATION_REQUIRED` and that nothing changed.
4. [ ] Set `ADMIN_MODE=read-only` and redeploy; verify previews still render but every execute answers
   `403 ADMIN_READ_ONLY_MODE` before the handler runs.

**Pass criteria:** A retry needs the exact state, a live elevation and full mode; each refusal is a stable
code and an audit row.

### ADMIN-STRIPE-01 — Reconciliation in development against test-mode data

**Preconditions:** The development panel has a **restricted** test-mode Stripe key
(`STRIPE_SECRET_KEY`, permissions: Checkout Sessions read, Refunds read/write, Charges read,
PaymentIntents read, Disputes read); at least one PAY-01 purchase in the window.

**Steps:**

1. [ ] Open `/stripe`; verify the banner and the page show the key as `test (restricted)`.
2. [ ] Run reconciliation for 30 days; verify the summary counts match the purchases made, the
   discrepancy table is empty, and `/audit` shows a `stripe.reconcile` row whose summary carries counts
   and order ids but no Stripe identifier.
3. [ ] Inject a discrepancy: in the Neon SQL editor on the development branch, revoke a fulfilled pack's
   purchase lot (`UPDATE credit_ledger SET status = 'revoked', remaining_amount = 0 WHERE source_order_id =
   '<order>'`) or delete it. Run reconciliation again; verify the order appears as `missing_credit` with a
   "Preview repair…" button in full mode (or "full mode only" in read-only).
4. [ ] Full mode: preview the repair; verify the preview shows what the order says against what the
   reconciliation says; execute with the phrase; verify `repaired`, the lot is back, and `/audit` shows
   `order.repair_grant`. Run the preview again and execute; verify `already_granted` and no change.
5. [ ] Remove the key from the service and redeploy; verify the run button is disabled and a POST answers
   `403 ADMIN_COMMAND_DISABLED`. Restore the key.

**Pass criteria:** Reconciliation reads Stripe and writes only an audit row; a repair applies once and
refuses to double-grant.

### ADMIN-STRIPE-02 — Proportional refund of one letter from a two-letter test pack

**Preconditions:** Development, full mode, `LETTER_IRL_PACK_REFUND_COMMAND_ENABLED=true` on the admin
service; a Starter Pack bought in test mode (PAY-01) with no letters sent.

**Steps:**

1. [ ] Open the order; verify the pack figures show 2 letters, 2 unspent, and the maximum proportional
   refund equal to the whole price, and that the refund form is present (with the flag unset it shows the
   disabled note instead).
2. [ ] Preview a refund of 1 letter with reason code `customer_request`; verify the preview shows the
   per-letter price, the refund amount floored on the product, the three warnings, and the phrase.
3. [ ] Execute; verify the outcome shows `succeeded` (or `stripe_pending`), the account balance dropped by
   one letter, the order shows a `commerce_pack_refunds` row linked to the command id, and the Stripe test
   Dashboard shows a partial refund with metadata `orderId`, `packRefundId`, `lettersRefunded: 1`.
4. [ ] Preview a second refund for the same order; verify `409 ADMIN_INVALID_STATE` (one proportional
   refund per pack).
5. [ ] Refund the remainder from the Stripe Dashboard; verify REFUND-06's expectations.

**Pass criteria:** Letters leave first, Stripe follows with the app-computed amount, the run and the
refund row reference each other, and a second command is refused.

### ADMIN-ACCT-01 — Lift a send block

**Preconditions:** Development, full mode; an account blocked by a dispute (the dispute webhook flow in
REFUND-04's dispute variant, or a row inserted on the development branch).

**Steps:**

1. [ ] Open the account; verify the red "sends blocked" banner and the "Preview lifting the send block"
   button. Preview; verify the standing-dispute count and the warning when one stands.
2. [ ] Execute while the dispute is still open; verify `409 ADMIN_INVALID_STATE`, the block remains, and
   `/commands` shows no run for the attempt.
3. [ ] Close the dispute in our favour (test Dashboard, or set its status to `won`), preview again,
   execute with the phrase; verify sends are unblocked and `/audit` shows `account.unblock_sends`.

**Pass criteria:** The block lifts only when no dispute justifies it; a refusal writes nothing.

### ADMIN-ACCT-02 — Adjust a letter balance and grant image generations

**Steps:**

1. [ ] On an account, preview adding 1 letter; verify the preview shows balance before and after in
   letters and credits; execute; verify a never-expiring `adjustment` lot of 2 credits and
   `/audit` shows `account.adjust_balance` with the reason.
2. [ ] Preview removing more letters than the ledger holds; verify `409 ADMIN_INVALID_STATE`.
3. [ ] Preview removing 1 letter; execute; verify the soonest-expiring lot lost 2 credits and the
   transaction row reads `Operator adjustment: <reason>`.
4. [ ] Preview granting 2 image generations; execute; verify the `operator_grant` entitlement referencing
   the command id, and that resubmitting the same confirmation grants nothing more.

**Pass criteria:** Balance changes are letters in the UI, credits in the ledger, and atomic with their
audit.

### ADMIN-ACCT-03 — Release an amount-mismatch quarantine

**Preconditions:** An order in `refund_pending` with `last_error_code = PAYMENT_AMOUNT_MISMATCH`
(adopt a legacy session with a different amount on the development branch, or insert the row).

**Steps:**

1. [ ] Open the order; verify the quarantine panel and the warning in the preview.
2. [ ] Execute; verify the code is cleared, the order event `operator.quarantine_released` carries the
   reason, and the next `npm run maintenance` (or hourly run) refunds the order.

**Pass criteria:** Release is a deliberate operator decision, recorded, and the sweep then acts.

### ADMIN-ACCT-04 — Promo campaigns and ambiguous image reservations

**Steps:**

1. [ ] `/promos/new`: preview and create a draft campaign; verify it appears as `draft`.
2. [ ] Preview `active`; before confirming, change the campaign on another tab (or in SQL); execute;
   verify `409 ADMIN_STALE_PREVIEW`. Preview again and execute; verify `active`.
3. [ ] Redeem the code with a test account (`redeem_promo_code`); verify the campaign page lists the
   redemption with a masked email and that "delete" is no longer offered. End the campaign.
4. [ ] `/images`: with an ambiguous reservation (the stub evidence flow in
   [deployment.md](deployment.md#ambiguous-image-reservation-operator-procedure)), preview "release as
   compensation" and execute; verify the reservation is `released`, the quota is back, and `/audit` shows
   `image.resolve` alongside the domain's `image_reservation_resolve` row.

**Pass criteria:** Promo status follows the documented machine with version checks; image recovery is
reachable and audited.

### ADMIN-OPS-01 — Retention report and quarantine listing

**Steps:**

1. [ ] Open `/retention`; verify the counts (redacted letters and drafts, quarantine rows, purge due) and
   the report of what the next enforcing run would touch, matching `npm run maintenance` in report mode.
2. [ ] Verify the quarantine table shows source table, row id and dates only: no content anywhere on the
   page, and no restore control.

**Pass criteria:** Report mode only, metadata only.

### ADMIN-OPS-02 — Tier override

**Steps:**

1. [ ] On an account, preview setting the override to `trusted`; execute; verify the account shows
   `standard (override: trusted)` and `/audit` shows `account.set_tier`.
2. [ ] Preview the same override again; verify `409 ADMIN_INVALID_STATE`. Clear the override; verify the
   daily tier calculation applies again.

**Pass criteria:** The override is explicit, audited, and idempotent.

### ADMIN-OPS-03 — Provider routing and status sync

**Preconditions:** Development (the dummy provider is refused in production routing).

**Steps:**

1. [ ] Open `/routing`; verify the four mail types, the environment default provider and the registered
   providers. Preview routing `postcard` to `dummy`; execute; verify the row shows `dummy`, your login as
   "by", and `/audit` shows `routing.update`. Route it back to `postgrid`.
2. [ ] Preview a provider that is not registered (edit the query string); verify `400 ADMIN_INVALID_REQUEST`.
3. [ ] Preview a status sync dry run over 7 days; execute; verify the outcome lists checked, updated and
   error counts and the first changes, and that no letter status changed. Repeat in apply mode on a
   development letter with a known provider status; verify the status and history rows update.

**Pass criteria:** Routing changes are validated against the runtime registry and versioned; the sync is
explicit about dry run versus apply.

### ADMIN-LEGACY-01 — Public denial unchanged after the legacy removal

**Steps:**

1. [ ] Repeat `ADMIN-FOUNDATION-022` steps 1 to 5 against the deployed development API; verify every
   legacy `/admin*` and `/api/admin*` path is still a no-store `404` and the public routes are unaffected.
2. [ ] Verify the repository no longer contains `admin-panel.html`, `src/api/adminApiHandler.ts` or
   `scripts/run-reconciliation.ts`, and that `ADMIN_ENABLED=true` still fails the public server's boot.

**Pass criteria:** Nothing public changed; the only operator surface is the tailnet panel.

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
- [ ] Issue a partial sandbox refund and confirm the order and all entitlements are not marked refunded/revoked, and that exactly one critical `stripe_partial_refund_unmatched` alert is opened for the order (#323); then complete the full refund and verify terminal state.
- [ ] Confirm provider acceptance changes the JIT order to `fulfilled`; failures before acceptance use refund handling and never resubmit an already accepted mail item.
- [ ] Force PostGrid 429, 500, 502, 503, and 504 responses and confirm each becomes a held/ambiguous outcome with a `mail_provider_outcome_ambiguous` alert, no refund, and no second submission. Repeat with a timeout/connection loss, a truncated response body, and a 2xx body missing `id`/`status`. Confirm the admin retry endpoint rejects every one of them, and that only a non-ambiguous 4xx (400/401/403/404/422) becomes a definite rejection eligible for refund and audited retry.
- [ ] Confirm an audited retry can restore JIT fulfillment only before refund starts; cross-account/replayed/changed requests fail closed.
- [ ] Point one `STRIPE_PRICE_*` at an archived Price (or a nonexistent id) and restart. In production `/readyz` reports `prices` failing (503); in a development deploy - where this manual test normally runs - it stays 200 with `"prices":"degraded"`, and the detail is in the log under `readiness.prices_unresolved`. Either way, both the current and legacy pack checkout paths must fail closed with a stable configuration error, create no order, and call no Stripe checkout API. (Replaces the pre-#275 case of removing a `STRIPE_*_AMOUNT_CENTS`, which no longer exists.)
- [ ] With that price still unresolvable, complete a paid sandbox checkout for a session carrying legacy pack metadata. Confirm the adoption still succeeds — it prices from the product table's pinned amount, not from Stripe — and the customer's credits are granted. Then complete a paid session whose metadata names NO known product: confirm that one is retained as `unmatched` with an open critical `stripe_money_event_unmatched` alert and no credits, and that redelivering the event from Stripe is deduplicated. Finally, complete a paid legacy session whose paid total DIFFERS from the pin and confirm it is retained as `unmatched` with the critical alert and NO order row - a mismatched historical payment must reach an operator, never the automatic refund sweep.
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
