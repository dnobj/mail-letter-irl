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
- [ ] Confirm a known email is never replaced: an account that exists keeps its
      stored address whatever a later token says, and no placeholder address
      exists to replace it with.

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
- [ ] Confirm PAT tool calls work on an account that already exists (a PAT
      carries no address, and no account is opened from one).
- [ ] Confirm the Claude/PAT path does not use or mutate the ChatGPT CIMD app.

### CIMD-10 — DEV rollback

**Open:** preparation recorded in https://github.com/dnobj/mail-letter-irl/issues/160#issuecomment-5149106768; the exercise itself
has not been run. Worth running before the production cutover (#158), since it is
the only rehearsal of the rollback path.

- [ ] Save the accepted CIMD configuration and deployment identifiers.
- [ ] Grant the rollback static client user-delegated `mail:read`, `mail:draft`
      and `mail:send` on the DEV MCP API. The API uses per-app authorization, so
      without a grant Auth0 refuses the client for the `/mcp` resource.
- [ ] Enable `LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY=true` in DEV only with
      the recorded static client (`CHATGPT_STATIC_CLIENT_ID`,
      `CHATGPT_STATIC_REDIRECT_URIS`) and deploy. Keep `LETTER_IRL_OAUTH_AUDIENCE`
      the single `/mcp` resource: there is no legacy audience any more, and the
      retired `https://letter-irl/api` API was deleted from both tenants on
      2026-09-14.
- [ ] Run a fresh-link smoke test and record behavior/client count.
- [ ] Restore CIMD mode (`false`), remove the static client's MCP API grant,
      redeploy DEV, and rerun CIMD-01, CIMD-03, and CIMD-04.
- [ ] Confirm production was unchanged throughout.

**Purpose:** Integration and end-to-end tests that require manual verification
**Last Updated:** September 25, 2026

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

**Status:** Executed 2026-09-15 (UTC) against production (build 56f297d) and development
(build 61a140b), after the Auth0 Default Audience repoint and the retired API's deletion (#391):
- `/healthz` and `/readyz` return 200 on both.
- Both protected-resource documents are exact on both: resource `/mcp`, the environment's Auth0
  issuer, and the seven scopes.
- Auth0's discovery document names the same issuer.
- The authorization-server proxy and `POST /oauth/register` return 404 on both.
- `/manifest.json` and the website return 200 on both.
- On both websites, `/auth/login` redirects to the environment's `/authorize` with the MCP
  audience and full scope. Auth0 answers with its login page, and also does so with the audience
  removed (the Default Audience fallback).
- Both dashboards load for a signed-in session, with `credits/balance`, `letters` and
  `promo/redeem-pending` at 200.

The previous run, 2026-09-13 (production 2a0144d, development 7d3cdc5), did not exercise login
or the dashboard. The DEV connector refresh after #376 listed every widget at v29.

### API Health
- [x] `GET https://api.letterirl.com/healthz` returns 200
- [x] `GET https://api.letterirl.com/.well-known/oauth-protected-resource` returns
      the exact resource, Auth0 issuer, and product scopes
- [x] Auth0's own discovery returns valid JSON; Letter IRL's authorization-server
      proxy and `POST /oauth/register` return 404 in normal CIMD mode

### MCP Endpoint
- [x] ChatGPT developer-mode refresh discovers the current MCP tools
- [x] MCP manifest accessible at `/manifest.json`

### Website
- [x] `https://letterirl.com` loads
- [x] Login button redirects to Auth0
- [x] Dashboard loads after login

---

## ChatGPT Integration

Test the full ChatGPT connector flow.

### OAuth Flow (US-ACCT-01, US-DCR-01)

**Create the connector with OIDC off.** In ChatGPT's New Plugin form, open **Advanced OAuth
settings** and untick **OIDC enabled** before **Create**; leave everything else at its default.
With it on, the first link fails with "We couldn't connect this account"
(`OAUTH_OWNER_PROFILE_ID_MISSING`), because Auth0 issues no ID token to the strict CIMD client
([chatgpt-connector-oidc-setting.md](learnings/chatgpt-connector-oidc-setting.md), #424).

**Status:** Reconnect executed 2026-09-15 in development, after the Auth0 cleanup (#391):
- In the current ChatGPT UI, **Disconnect** (Settings → Plugins → the app → **…**) also removes
  the app from the installed plugins. The app's own page under Plugins then offers **Install
  plugin**, which runs the Auth0 sign-in.
- After signing in, the first `get_account_balance` call in a fresh chat succeeded with no
  prompt, and the development API log shows it JWT-authenticated.
- The login provider was not recorded, so the per-provider lines stay open.

- [x] Open ChatGPT → the Letter IRL app
- [x] Click "Sign in" when prompted (here: **Install plugin** on the app's page)
- [x] Auth0 login page appears
- [ ] Can login with Google
- [ ] Can login with Microsoft
- [ ] Can login with GitHub
- [ ] Can login with Email/Password
- [x] After login, redirected back to ChatGPT
- [x] ChatGPT shows "Connected" status (the app is installed again and its tools run)

### CIMD client-count behavior

**Status:** Executed 2026-09-15 in development, with the reconnect above:
- The tenant held the same 7 applications before and after.
- Its log since the test began holds only a **Success Login** and a **Success Exchange** for the
  `ChatGPT` CIMD application, with audience
  `https://letter-irl-api-development.up.railway.app/mcp`, and no client creation.
- The exchange event records no scope list (`"scope": null`), so the granted scopes were not read
  from the log.

- [x] After connecting, check Auth0 dashboard
- [x] No new client or DCR call is created during connect/reconnect
- [x] ChatGPT uses the manually imported CIMD application

### MCP Tools in ChatGPT

**Status:** Executed 2026-09-13 in development through the embedded browser, in one fresh chat
with the (DEV) app: the balance (12 prepaid letters, no permission prompt for a read-only tool),
the order history (13 mailed-letter orders and 19 letter-pack purchase records with their
statuses, #365), a preview that rendered the letter card with the draft id, the cost and a
**Send Letter** button, and the send itself (the Letter Sending Flow below carries the readings).

Re-run 2026-09-15 after the Auth0 cleanup, in a fresh chat with each app through Claude in
Chrome. The production **Letter IRL** app and the **Letter IRL (DEV)** app each answered the
balance question through `get_account_balance`, with no permission prompt. Each API's log shows
the call JWT-authenticated and successful.

- [x] Ask "What's my credit balance?" → `get_account_balance` works
- [x] Ask "Show my letters" → `list_orders` works
- [x] Ask to preview a letter → `quote_and_preview_letter` works
- [x] Letter preview renders in chat (widget or text)

### Widget Rendering (if enabled)
- [ ] Balance widget shows correct credits
- [ ] Letter preview widget shows formatted letter
- [ ] Widgets respect dark/light mode

---

## Claude Desktop Integration

### CLIENT-01 — Claude through a custom connector (launch gate, #471)

**Status:** Partly run in development on 2026-09-26, with the send rule on. It used Claude on the web
(claude.ai, in the Claude app's built-in browser) and Letter IRL test account testlirl02. Steps 1 to
3 passed; step 4 ran as far as the link; steps 5 and 6 were not run.

Background: Claude connects with its published identity, the document at
`https://claude.ai/oauth/mcp-oauth-client-metadata`. That document must be imported into each tenant
([auth0-tenant-configuration.md](auth0-tenant-configuration.md), Applications, section 6). One
connector on a Claude account covers Claude on the web, Desktop, mobile and Cowork.

1. Install
- [x] Customize, then Connectors, then **Add custom connector**: name "Letter IRL (DEV)", URL the
      development `/mcp`. Claude should detect **Sign in now** and **Use Claude's published
      identity** by itself; keep both. (It did. A link can fill the form in:
      `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=…&connectorUrl=…`,
      and Claude then warns that the connector came from an external link.)
2. Sign in
- [x] Press **Connect**, sign in, and accept the consent screen. (The first press did nothing: no
      request reached Auth0 or the API. The second opened the sign-in, which reused an existing
      session, then the consent screen: Read, Draft, Send and offline access.)
- [x] The development log should show `client=claude` on `mcp.request_received`. (It did, for
      `initialize`, `tools/list` and `resources/list`.)
- [x] The connector's page should list `send_letter` and `send_postcard` under **App-only tools**,
      and `request_send` among the read-only tools. (Both as expected.)
3. Preview
- [x] Ask for the balance, then a text-only letter preview, approving each call with **Allow
      once**. (Both ran. Claude could not display the preview card ("There was a problem displaying
      content"), which is expected until the cards work outside ChatGPT, #474.)
4. The person sends it
- [x] Say "Send it." Claude should call `request_send`, give the link and send nothing. (It said
      it can't send from there and gave the link. The log shows no send tool call.)
- [ ] Open the link on the development website, signed in as the same account, and press **Send
      this letter**. (Not run. SEND-01 covers the page, and this account's only letter was a gift
      letter.)
5. Refusals
- [ ] No letters, an unconfirmed address, an erased account. (Not run.)
6. Disconnect
- [ ] Disconnect on Claude's connector page, then check that the Auth0 user no longer lists Claude
      among authorized applications. (Not run.)

Findings to fix before listing:
- Several tool descriptions still say "so ChatGPT can reuse that existing image".
- Claude uses a tool's description as its name in approval prompts ("Claude wants to use Check how
  many prepaid letters remain…"), so the tools need a `title`.
- `get_started` promises buying "without leaving the conversation", and Claude offered to set up a
  pack purchase, which Claude doesn't allow (#475).

The sections below describe the older path, before Claude could connect with its published
identity.

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
- [ ] The read and preview tools work without an OAuth flow
- [ ] `create_pack_checkout` and `redeem_promo_code` are refused with "A personal access token can
      read your Letter IRL account and make previews, but it can't send, pay or buy.", and no
      sign-in is offered (migration 037, #470)
- [ ] `send_letter` sends nothing. With the send rule on, it answers with the confirmation link
      ([SEND-01](#send-01--only-the-person-sends-issue-470)); with the rule off, it is refused like
      a purchase
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

**Status:** Executed in production on 2026-09-11 with the owner's own card, refunded under REFUND-01
the same night. Passed on the payment path; the link step failed twice before it passed, and that
failure is recorded on #322.

- [x] In ChatGPT, ask to buy the smallest letter pack (Starter Pack, 2 letters).
- [x] `list_letter_packs` runs, then `create_pack_checkout`, and ChatGPT
      presents the checkout as a clickable link. Known gap: it may say the
      checkout is "open" without showing a link until asked for one. (Worse
      than the gap says: on the first two attempts the model claimed success
      after the permission prompt without calling the tool at all, once with a
      fabricated 26,000-character URL, and the production log shows no
      request. After "you did not call the tool, call it now" the call ran, but
      the reply claimed a card that this tool does not render. The genuine URL
      was reachable only in the developer-mode "Called tool" response panel.
      Live Stripe Checkout URLs now use the `/g/pay/` path.)
- [x] Open the link. Stripe Checkout shows the pack name, the price, and the
      account email already filled in. The prefilled email proves the `users`
      row exists; a blank email field means it does not (#319).
- [x] Pay. Production: a real card, refunded under REFUND-01. Development: a
      Stripe test card, typed by the owner.
- [x] Balance reads 2 letters. Railway shows `stripe.webhook_received` with
      `checkout.session.completed`. If the balance is right but that line is
      absent, the card's Check status polled Stripe directly and the webhook
      endpoint is not delivering: fix the endpoint before REFUND-01, which has
      no such fallback. (Webhook received 23:19Z; order `checkout_pending` →
      `paid` → `fulfilled`; purchase lot 4 credits active; balance 2 letters.)

### PAY-03 — Checkout card recovery after a dropped call (issue #322)

**Status:** Executed 2026-09-12 in development through the embedded browser; the owner paid with a
Stripe test card. Passed: the dropped call reproduced on the first attempt and the card recovered
without a second permission prompt. **Repeated in production on 2026-09-13 (UTC) after the
promotion in #364, with the owner's own card, refunded under REFUND-01's steps the same night:**
the dropped call reproduced again (one template read at 00:17:01Z, no tool call, the model saying
"I'm ready to start the checkout"), **Create my checkout** created order b99046a9 at 00:17:31Z with
no prompt, and the card showed the live link and the order id. Six first attempts, six drops, across
both environments. **Android, native ChatGPT app, 2026-09-13 13:09Z (development, owner's S25 Ultra
over adb, app force-stopped first):** the first "Allow once" was NOT dropped. `tools/call
create_pack_checkout` ran at 13:09:33Z, the card rendered at widget v28 in dark theme with the
link, Check status and the order id, and the model's own text carried the link and the order id too,
because on native the host made the call. One of one; the dropped call is a web-client behaviour so
far.

Background: on 2026-09-11 (production) and 2026-09-12 (development) ChatGPT dropped the first
`create_pack_checkout` after "Allow once": no request reached the API, the model said to use "the
checkout shown above", and the card template rendered as grey placeholder bars. The card now waits
five seconds for a result and then offers to create the checkout itself through the bridge, the way
the preview cards already buy packs.

- [x] With the (DEV) connector refreshed to a widget version of 26 or later, start a fresh chat and
      ask to buy the Starter Pack. Click **Allow once**. (Connector refreshed after PR #360 deployed:
      22 tools, every widget at v26. Allow once clicked at 16:43Z.)
- [x] If the card fills in with the price and the link within a moment, the call went through and
      the retry never appears. Record that and stop; the dropped call did not reproduce. (Did not
      apply: the call was dropped again. The dev log shows exactly one request at 16:42:55Z, a
      `resources/read` of `PackCheckoutCard.html@v26`, and no `tools/call`. The model still wrote
      that the checkout "has been created".)
- [x] If the card shows grey bars, wait five seconds. It should read "No checkout is showing on this
      card. If you have already paid for a pack, ask for your purchase status before buying
      another." with **Create my checkout** (or **Choose a pack** when the host passed no pack in
      `toolInput`). This wording applies from widget v31. Up to v30 the card read "No checkout was
      created yet. Nothing has been charged.", which PAY-05 found untrue on a reopened conversation.
      (Seen after five seconds, with **Create my checkout**, so the host had passed the pack.)
- [x] Click it. Record whether ChatGPT shows another permission prompt for the widget-initiated
      call, and whether the card then fills in with the link. The Railway dev log shows the
      `create_pack_checkout` request only for this second attempt. (No prompt at all.
      `tools/call create_pack_checkout` logged at 16:44:06Z, invocation succeeded, and the card
      filled in with the pack, the price and the link. The card's one convenience `openExternal` was
      blocked by the embedded browser because the click was automated; the anchor remained.)
- [x] Open the link and pay with a Stripe test card, typed by the owner. Balance reads 2 letters;
      `stripe.webhook_received` with `checkout.session.completed` appears in the dev log. (Webhook
      at 16:47:47Z. Order a5984b30: `letter_pack / credit-pack-4`, `fulfilled`, 5.00 USD, events
      `checkout.session.created` → `checkout.session.completed` → `fulfilled`; purchase lot of 4
      credits active for 730 days. Balance via ChatGPT: 6 letters, three active lots, so +2.)
- [x] Record on #322 whether the bridge was live inside a card the host drew without a result. If
      the button did nothing, the card's text-only fallback ("Ask for the checkout again") is the
      expected state and the issue stays open. (Recorded: the bridge is live, and a call started
      from the card shows no permission prompt. Two gaps found on the way: the model never sees a
      widget-initiated result, so afterwards it could not name the order id without a new checkout;
      and `list_orders` covers mail orders only, so a pack order id cannot be recovered in the chat.)

### PAY-04 — Checkout card shows the purchase outcome (issue #322)

**Status:** Executed 2026-09-12 in development through the embedded browser; the owner paid with a
Stripe test card. Passed: the card switched to the paid state two seconds after the webhook, with no
click and before the owner had returned to the tab. **Repeated in production on 2026-09-13 (UTC):**
polls every 3-4 s for the first minute, then every 20 s, the last automatic poll at 00:27:46Z just
past the ten-minute budget, then nothing for seventeen minutes while the owner was away; the webhook
arrived at 00:44:50Z and the owner's return to the tab fired the visibility refresh in the same
second, which returned `submitted` and switched the card to "Paid. 2 letters added to your account.
2 of 2 from this pack are still unused." with the order id and no link. Order `fulfilled`, lot active,
ChatGPT balance 2. The Dashboard refund (owner's click) delivered `refund.created` and
`charge.refunded` at 00:50:14Z; order `refunded`, lot revoked, balance 0. The card itself still
reads "Paid" afterwards: polling stops at the paid state and does not follow a later refund.
**Android, native app, 2026-09-13 (development):** polls every 4-5 s from 13:09:37Z, paused at
13:10:05Z the moment the Stripe Custom Tab came in front (the WebView went hidden), the owner paid
with a test card, the webhook arrived at 13:12:06Z, and the single poll at 13:12:26Z on the owner's
return to the app returned `submitted`: the card read "Paid. 2 letters added to your account. 2 of 2
from this pack are still unused." with Check status still offered (#368) and the order id. Order
5511c462 `fulfilled`, lot active. Visibility gating and the return refresh both work natively.

Background: PAY-03 left the card showing "Open secure checkout" after the payment, for a session
Stripe would refuse, and the model could not name the order afterwards because it never sees a
widget-initiated result. The card now polls `get_purchase_status` while a checkout is open and
replaces the link with the outcome.

- [x] With the (DEV) connector refreshed to a widget version of 27 or later, buy the Starter Pack in a
      fresh chat (the PAY-03 path, dropped first call and all). Confirm the populated card shows the
      order id under the link and a **Check status** button. (Connector refreshed after PR #362
      deployed; the panel only shows the new version after it is reopened. The first Allow once was
      dropped for the fourth time in four attempts: one template read at 17:26:52Z, no tool call.
      **Create my checkout** produced `tools/call create_pack_checkout` at 17:27:12Z with no prompt,
      and the card showed the link, **Check status** and the order line for b87d767f.)
- [x] Pay with a Stripe test card, typed by the owner, in the tab the link opened. Return to the
      ChatGPT tab. Within a few seconds the card should read "Paid. 2 letters added to your account."
      with the link and the note gone, the unused count from this pack, and no Check status button.
      Record whether the switch happened on return without a click (the visibility refresh) or needed
      **Check status** (timers throttled in the hidden iframe). (Polls reached the dev API at 17:27:15,
      :19, :24, :28, :33 and :39Z; the webhook `checkout.session.completed` arrived at 17:27:41Z; the
      poll at 17:27:43Z returned `submitted` and polling stopped. So the timers kept running while the
      Stripe tab was open in the embedded browser, and the card read "Paid. 2 letters added to your
      account. 2 of 2 from this pack are still unused." with the order line and no link or button when
      the owner returned. Order b87d767f: `letter_pack / credit-pack-4`, `fulfilled`, 5.00 USD;
      purchase lot of 4 credits active for 730 days.)
- [x] Ask ChatGPT for the balance; it should agree with the card. (8 prepaid letters, up from 6.)
- [x] Optional expiry path: create a checkout and, from the Stripe test dashboard, expire the session.
      The card should read "This checkout expired before it was paid. Nothing was charged." with
      **Create a new checkout**; clicking it creates a replacement without a permission prompt and the
      card polls the new order. (Executed 2026-09-13 00:15Z in development. First finding: the dev
      Stripe destination subscribed to seven events and not `checkout.session.expired`, so Stripe
      refused a manual delivery with "Endpoint not configured for event type"; it was set to the ten
      events docs/railway-setup.md lists, through the Workbench Shell
      (`stripe webhook_endpoints update … -d "enabled_events[]=…"`). Then
      `stripe checkout sessions expire <id>` in the Shell: the webhook arrived seven seconds later,
      the order was cancelled, the card's next poll showed the expired state, and **Create a new
      checkout** produced a replacement with no prompt, polling under its own order id.)
- [x] Record the readings on #322.
- [x] Return page (change of 2026-09-13): the Stripe success and cancel pages land on
      `/purchase/return`. On Android and desktop it shows a **Back to ChatGPT** button to chatgpt.com;
      on iPhone and iPad it shows text only ("close this page and return to the ChatGPT app"), because
      the iOS universal link has not been verified on a device and Apple devices get a proven link or
      none. (Android, 2026-09-13, owner's phone, via Stripe's cancel arrow: the button opened chatgpt.com
      in full Chrome, logged out, not the app. The phone has the app's handling of chatgpt.com links
      switched off at user level, and an explicit intent to the app with the site root was handed back
      to the browser; an explicit intent with a conversation link, `/c/<id>`, opened the app on that
      conversation. So the Android button is a web-app fallback on such phones until #372 supplies a
      conversation link.)

### PAY-05 — Back to the conversation after checkout (issue #372)

**Status:** Passed on the web in development on 2026-09-14, with widget v31. Android not run.

- **2026-09-13: the return link did not arrive.**
  - The owner clicked the card's link from the embedded browser; no safe-link modal was reported.
  - The owner paid with a test card, and the return page offered **Back to ChatGPT**, the fallback
    for a request with no return cookie.
  - Order 0b7dc374 went `paid` → `fulfilled` on the webhook at 18:35:26Z with its lot active, so the
    purchase itself was sound.
  - The API logged nothing for the two page requests. #378 then added a presence-and-host log line to
    both.
- **2026-09-14: the return link works.** The run used widget v30, the DEV app on ChatGPT web in the
  owner's Chrome, and a test card.
  - At 19:38:06Z `purchase.start` logged `hasRedirectUrl=true redirectHost=chatgpt.com targetOk=true
    returnKept=true`.
  - `checkout.session.completed` arrived at 19:38:26Z.
  - `purchase.return` logged `outcome=success cookiePresent=true conversationKept=true
    linkOffered=conversation`.
  - **Back to your conversation** opened the same conversation, in the checkout tab.
- **2026-09-14: it exposed a defect.**
  - The reopened conversation gave the card no tool result. After five seconds the card read "No
    checkout was created yet. Nothing has been charged." beside **Create my checkout**, over a paid
    order.
  - A reload reproduced it at 19:44Z with no API call.
  - `create_pack_checkout` never reuses a pack order, so that button starts a second purchase.
  - The original tab was unaffected and showed the purchase paid after its visibility refresh.
  - Widget v31 fixes it: the card keeps its order in `widgetState` and resumes from it.
- **2026-09-14: passed with widget v31.** The run used the DEV app on ChatGPT web, the connector
  refreshed to v31, and a test card.
  - At 21:21Z the first `create_pack_checkout` after "Allow once" was dropped, and only the template
    read reached the API. The card showed "No checkout is showing on this card…" with **Create my
    checkout**, while ChatGPT's reply claimed the checkout had started.
  - **Create my checkout** created the order at 21:27:11Z, and `purchase.start` kept the return link.
  - `checkout.session.completed` arrived at 21:27:16Z, and `purchase.return` offered the conversation
    link at 21:27:19Z.
  - **Back to your conversation** opened the same conversation in a new tab. At 21:27:27Z that tab's
    card read `get_purchase_status` once and showed "Paid. 2 letters added to your account." with
    "pack t7". It opened no checkout and offered no second one.
  - The card had created this order itself, so no host tool result could carry it. ChatGPT web
    therefore restores `widgetState` on reopen.

Background: the checkout card now opens a start page on the API host through `window.openai.openExternal`
instead of the Stripe URL directly. For an allowlisted redirect origin (the API origin is in
`redirect_domains`), ChatGPT is documented to skip the safe-link modal and append a `redirectUrl`
query parameter. The start page keeps it in a same-site cookie and forwards to Stripe; the return page
then offers **Back to your conversation**: on Android as an intent link that opens the app by package,
on desktop as a plain link, on iPhone and iPad text only until a device has proven the universal link.

- [ ] Web (owner's click; the embedded browser blocks host-opened tabs from automated clicks): in a
      fresh chat with the DEV app, buy the Starter Pack, and when the card shows the link, click it.
      Record whether a safe-link modal appeared, and whether the tab that opened is the Stripe page
      (the start page forwards in one hop). Cancel with Stripe's back arrow.
- [x] On the return page: is the button **Back to your conversation**? If so ChatGPT appended a
      return link. Record the shape of the link's target (conversation URL or something else) from the
      dev log or the page source, without pasting it into a shared place. Click it and record where
      it lands. (Yes, on both 2026-09-14 runs: `linkOffered=conversation`, and the button lands on
      the same conversation.)
- [ ] Android (owner's phone over adb): same purchase, tap the card's link, cancel with Stripe's back
      arrow, tap **Back to your conversation**. Expected: the ChatGPT app comes to the front on the
      conversation, even with the app's link handling switched off.
- [ ] If the button says **Back to ChatGPT** instead, no return link was appended: record the
      client, and check the dev log for the start-page request's query (the API logs no values).
- [ ] If the card's tap opened nothing, record that the fallback link appeared after a moment and
      that it opens the checkout.
- [x] Reopened conversation (widget v31 or later, with the DEV connector refreshed): after paying,
      click **Back to your conversation**, or reload the conversation. Within a moment the card must
      show the order and **Paid**. It must never show "No checkout" with **Create my checkout**, and
      it must not open a checkout tab by itself. The dev log shows one `get_purchase_status` for the
      order straight after the reload, and no `create_pack_checkout`. (Passed on 2026-09-14 at
      21:27Z. See the Status list above.)

### PAY-02 — Webhook idempotency (US-EDGE-04)

**Status:** Executed 2026-09-12 in development against the PAY-04 order. Passed.

- [x] Stripe Dashboard → Developers → Webhooks → the endpoint → the delivered
      `checkout.session.completed` event → Resend. (In Workbench: the sandbox named `sandbox`
      holds the dev endpoint; the `Letterirl` environment that `/test/` URLs open has no events.
      Webhooks → the destination → Event deliveries → the 12:27 PM CDT row → Resend.)
- [x] Response body is `{ "received": true, "duplicate": true }`. (The resent attempt at 23:09:10Z:
      HTTP 200, `"received": true, "duplicate": true`; the original showed `duplicate: false`.)
- [x] Balance unchanged; no second purchase lot in the ledger. (16 credits and nine purchase lots
      before and after; the order's lot appears once.)

### REFUND-01 — Full refund from the Stripe Dashboard (US-CREDIT-06)

**Status:** Executed in production on 2026-09-12 after PAY-01. Passed. The precondition letter went
to the owner's own return address as recipient: preview validated both addresses live at PostGrid,
`send_letter` deducted the ledger, routed to PostGrid, the provider accepted, the transaction
committed; lot 4 initial / 2 remaining, balance 1 letter, letter accepted, job completed.

Precondition: PAY-01, then one letter sent from that pack, so the spent and
unspent halves are both present. Letter IRL has no refund button of its own;
the refund is issued in Stripe and reaches the service only as a webhook.
- [x] Stripe Dashboard → Payments → the pack payment → Refund → full amount.
- [x] Railway: `stripe.webhook_received` with `charge.refunded` (and
      `refund.created` / `refund.updated` if delivered), no
      `credits.webhook_failed`. (`refund.created` and `charge.refunded` at
      02:31Z, no failure line.)
- [x] Balance drops by the **unspent** letters only: 1 → 0. The sent letter is
      untouched and its status still tracks normally. (Balance 0 through
      ChatGPT; the letter still `accepted`.)
- [x] `get_purchase_status` for the pack order reads `refunded`, message
      "The payment was refunded." (Also 0 remaining, 500 cents refunded. The
      model's prose stopped mid-sentence on that turn while the tool panel
      held the complete result; an earlier turn answered "connector lookup is
      timing out" with no request reaching the API, and a retry worked.)
- [x] Database or admin view: the purchase lot is `revoked` with
      `remaining_amount = 0`; one `refund` ledger row links to it with
      `remaining_at_revocation` equal to what was left; one `credit_transactions`
      row of `-<unspent credits>`; `orders.refunded_at` is set;
      `credits_purchased` dropped by the whole pack. (Admin panel: order
      `refunded`, refunded amount 5.00 USD, purchase lot revoked 4/0, refund lot
      recorded with reason `payment_refunded`; the panel's "letters already
      refunded" line shows the pro-rata 2.50 USD for the one unspent letter.)
- [x] No `stripe_money_event_unmatched` row in `commerce_operational_alerts`.
      (Alerts: nothing to show; unmatched events: none.)

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

**Status:** Executed 2026-09-13 in development through the embedded browser (dummy letter
provider, so nothing was mailed), in the same chat as the MCP tool checks above. Preview at
19:05:01Z from the saved DEV return address to a named recipient at 350 5th Ave, New York, NY
10118 with no unit: the draft was created, the card read Text Only, 1 letter, USPS First-Class,
**Ready to send**, and the model relayed the "add the unit if you have it" note. The card's
**Send Letter** button sent it at 19:05:42Z with no permission prompt (the widget made the call):
the card switched to **With the printer** with the order id, the balance read 11 (from 12), and
`get_order_status` read accepted. Asking the model to send the same draft again with the same
draft id produced a permission prompt, **Allow once**, and a `send_letter` call at 19:06:53Z that
returned the same order id with `isRetry: true` and "Existing order returned (duplicate
request)"; the balance stayed at 11. That consequential call after **Allow once** was NOT dropped
(one of one on web), so the dropped first call in PAY-03 is not a property of every consequential
tool. Validation: 123 Fake Street, Nowhere, CA 90000 was refused with "Recipient address could
not be delivered to: Unable to find a match for this address" and no draft; a London address was
refused before any provider call with "Missing required address fields: recipient.state", which
is a clear error but not the "Only supports US" wording this list expects (the model had passed
no country). The over-limit body, the suite variant and the outbox cases were not exercised.

### Preview (US-LETTER-01)
- [x] Provide valid US addresses (sender + recipient)
- [x] Provide text-only letter body (at most 1,600 characters and 24 lines)
- [x] Preview returns HTML
- [x] Draft ID returned
- [x] `canSendNow` reflects actual balance

### PREVIEW-01 — Preview card recovery after a lost "Allow once" (issue #411)

**Status:** Executed 2026-09-17 in development through Claude in Chrome, between 00:18 and 00:30
UTC, after #413 deployed. The connector refresh logged `tools/list` at steering revision 8 and
widget v32, then eight template reads at v32. Passed for text-only letters, image letters given
as a URL, and postcards. An image attached or generated in the chat cannot be recovered (#414).
The send step was not run.

Background: on 2026-09-16 ChatGPT web lost six of six preview calls approved with **Allow once**,
including one clicked by the owner. After each approval no `tools/call` reached the development
API, the card stayed on its loading state, and the model usually said the preview had been
created. The preview cards now wait and then offer **Create my preview**, which repeats the call
from the card.

- [x] With the (DEV) connector refreshed to widget v32 or later, start a fresh chat and ask for a
      text-only letter preview. If ChatGPT asks for permission, click **Allow once**. If it does
      not ask, the call goes through unprompted; record that and try again in a new chat. (Asked
      every time. All four approved calls in this run were lost again: the dev log showed the
      template read and no `tools/call`.)
- [x] If the card fills in with the draft within a few seconds, the approved call went through.
      Record that; the lost call did not reproduce. (Did not apply.)
- [x] If the card stays on "Loading letter preview…", wait 25 seconds. It should read "No
      preview is showing on this card. If this letter was already sent, there is nothing more to
      do here. Otherwise, create the preview again." with **Create my preview**. The dev log
      should show the template read and no `tools/call` for the approved call. (As described.)
- [x] Click **Create my preview**. The dev log shows `tools/call quote_and_preview_letter`, and the
      card fills in with the letter, the cost, the delivery line and the draft id, with **Send
      Letter** when the balance covers it. Record whether ChatGPT asked for permission for the
      card's call. (The call arrived and succeeded, and the card showed Text Only, 1 Letter,
      **Ready to send** and **Send Letter**. No permission prompt for the card's call.)
- [x] Reload the page. The reopened card should offer **Create my preview** straight away, without
      the wait. (Offered within seven seconds of the reload.)
- [ ] Create the preview again and send it from the card (the dummy provider mails nothing), then
      reload. The card should read "This letter was sent to the printer from this card. Ask for its
      status in the chat." with **With the printer** and no buttons. (Not run: clicking Send needs
      the owner's go.)
- [x] After a lost call, ask the model whether the preview exists. With instructions r8 it should
      say the call did not complete, or point at **Create my preview**, rather than describe a
      draft it never received. (Observed without asking: three of the four replies still claimed
      success, and one said the call did not complete. The card is what recovers.)
- [x] Repeat the lost-call steps for an enclosed-image letter
      (`quote_and_preview_letter_with_image`) with an attached image. The card waits 45 seconds
      and must repeat that tool. In the dev log, the repeated call should log
      `quote.letter.image.from_fileParams`, not `from_recent_upload`. Record whether the card
      shows the image, or "Image not shown on this card", or advice to ask in the chat, which
      means the host passed the image in a form the card will not repeat. (Run twice. With the
      image given as a URL, the card repeated that tool, the log showed
      `quote.letter.image.from_url`, and the card drew the draft with the image, so ChatGPT
      returns `_meta` to a card's own call. With an image generated in the chat, the approval
      panel showed the image argument as a sandbox file path. The card offered only the advice
      to ask in the chat, as designed; #414 tracks recovering that case.)
- [x] If time allows, repeat the lost-call steps for a postcard. It also waits 45 seconds. (With
      the front image given as a URL: `tools/call quote_and_preview_postcard` from the card, and
      the card drew the front image with **Send Postcard**.)

### DUPLICATE-01 — The same letter twice (issue #412)

**Status:** Executed 2026-09-17 in development through Claude in Chrome, after #419 deployed and
with the (DEV) connector refreshed to widget v35. Thinking effort was Medium, and every call
approved with **Allow once** ran. Passed, except the Pay & Send step, which was not run.

Background: each draft is sent at most once, but two drafts can hold the same letter, and the #411
recovery makes that likely. A send from the balance, or a new Pay & Send checkout, is now refused
when the account has the same mail from the last 24 hours. It goes through only when the person
asks for another copy ([letter-send-flow.md](letter-send-flow.md)).

- [x] Refresh the (DEV) connector. Its settings page should list `sendAnotherCopy` in the input
      schemas of `send_letter`, `send_postcard` and `create_mail_checkout`. (Before the refresh it
      still listed the old schema.)
- [x] Ask for a text-only letter preview and send it from the card. (Sent: **Letter Sent!** and
      **With the printer**.)
- [x] Ask for a second preview of exactly the same letter, then ask ChatGPT to send it. The
      refusal should reach the model, which should say what went out and ask before trying again.
      (It said an identical letter to the same recipient had been sent from this account about 22
      minutes earlier, that nothing was sent or charged, and that it would send another copy if
      asked.)
- [x] Say yes. The approval panel should describe an explicit request for another copy, and the
      send should succeed. (It did: "Sent successfully as an intentional additional copy.")
- [x] Ask for a third preview of the same letter and click **Send Letter** on its card. The card
      should say the same letter went out recently and turn its button into **Send another copy**.
      (It did, with the shorter notice "This same letter was sent or paid for recently. Send another
      copy only if you want two." **Send another copy** was not clicked.)
- [ ] With a balance too small to send, open a Pay & Send checkout for a letter, then a checkout
      for the same letter from another draft. The card should say a checkout for this same letter
      is still open and offer **Pay for another copy**. (Not run.)

The card showed the shorter notice because the details in `_meta` never reached it. The server
does send them on the error result (`tests/unit/mcp/duplicateMailRefusal.test.ts` checks this over a real
MCP transport), and a successful call does return `_meta` to a card (PREVIEW-01). So ChatGPT
gives a card no `_meta` for a refused call; see
[openai-app-sdk-notes.md](learnings/openai-app-sdk-notes.md).

### SEND-01 — Only the person sends (issue #470)

**Status:** Executed in development between 2026-09-25 22:30 and 2026-09-26 00:50 UTC, through the
Claude app's built-in browser, on #479 (c19b131), #480 (e002a68) with the rule on, then #481
(ea3fd96), and website #41 (52b8f7c). The (DEV) connector, "Letter IRL (DEV) v8 no-OIDC", was used
as testlirl02; mail went to PostGrid's test mode, so nothing was printed. **Passed.** The model never
reached `send_letter`: asked to send, it gave the link each time. The optional token check was not
run.

Observations:
- With the card showing, "Send it." got the link rather than a pointer to the card's Send button.
  ChatGPT offered two candidate replies and both called `request_send`. The rule allows either way.
- The preview replies said nothing had been sent but did not mention the card's Send button. The
  narration asks the model to point there when the person asks to send.
- A send refused as a duplicate logs `credits.ledger_deducted` from inside the transaction it then
  rolls back. The balance was unchanged, but the log line reads as a charge.

Background: with `LETTER_IRL_SEND_CONFIRMATION_ENABLED` on, the model can't send mail in any app.
The person sends it with the preview card's Send button, or on a confirmation page on the website
that `request_send` links to. ChatGPT keeps its card and its Pay & Send checkout
([letter-send-flow.md](letter-send-flow.md)).

Before the rule is on:
- [x] Set `LETTER_IRL_WEBSITE_CLIENT_ID` on the development API to the development website's Auth0
      client id ([auth0-tenant-configuration.md](auth0-tenant-configuration.md)). (Set without a
      redeploy; #480's deployment picked it up.)
- [x] Make one Letter IRL (DEV) call in ChatGPT, such as the balance. Its `mcp.request_received`
      log line should read `client: chatgpt`. If it reads anything else, stop: with the rule on,
      the card's Send button would get the link instead of sending. (A balance call at 22:31:34
      logged `client=chatgpt` on both `mcp.request_received` and `mcp.client_request`.)

With the rule on:
- [x] Set `LETTER_IRL_SEND_CONFIRMATION_ENABLED=true` on the development API and redeploy it. (The
      variable change redeployed it by itself. `GET /api/sends/<uuid>` without a token went from
      404 to 401, and the boot log had no `send_confirmation.website_client_missing`.)
- [x] Refresh the (DEV) connector. Its settings page should list `request_send`. Note whether it
      still lists `send_letter` and `send_postcard`: they stay in `tools/list`, marked private, so
      the card can call them. (Refresh tools is under Plugins, the plugin's … menu, Manage. It
      logged `tools/list` at steering revision 9 and widget v37. The app's tool list, opened from
      the plugin page, shows 24 tools: `request_send` among 9 read tools, and `send_letter` and
      `send_postcard` still among 15 write tools.)
- [x] Ask for a text-only letter preview. The card should read **Ready to send**, and the reply
      should point to the card's Send button. (Ready to send once the account had a letter. The
      reply said it had not been sent, without mentioning the Send button; see Observations.)
- [x] Ask ChatGPT to send it. It should point to the card's Send button, or call `request_send` and
      give the link. It must not call `send_letter`: no approval panel for a send, and no
      `send_letter` call in the development log. If it does call it, the letter is sent and the rule
      has failed in ChatGPT. ("Send it." at 00:48: no approval panel, two `request_send` calls, one
      per candidate reply, and no `send_letter`.)
- [x] Press **Send Letter** on the card. It should send as before: **With the printer**, and the
      balance one lower. (The card's `send_letter` call ran at 00:49:33 as `client=chatgpt`; the card
      read **With the printer** and **Letter Sent!**, and the balance went from 1 to 0.)
- [x] Ask for a different letter, then ask for a link to send it from the website. `request_send`
      is read-only, so it should run without an approval panel, and return a link to
      `/confirm/<draftId>` on the development website. (Run first, at 22:40, on a preview made with
      no letters in the account.)

On the confirmation page, signed in to the development website with the same account:
- [x] Open the link. The page should read "Check your letter, then send it" and "Nothing is sent
      until you press Send.", and show the preview, where it goes, and how many letters it takes.
- [x] Press **Send this letter**. The page should read "Sent. We'll print your letter and mail it."
      with the letters left, and the letter should appear on the dashboard's letters page. ("You have
      1 letter left."; `send.confirmed_on_website outcome=sent` at 00:44:18; listed as Accepted.)
- [x] Reload the page. It should read "This letter has already been sent."
- [x] Ask ChatGPT for the same letter again and for its link, then press **Send this letter**. The
      page should say this letter went to the recipient a few minutes ago and ask "Send another
      copy?". Press **Don't send**. Nothing is sent. ("You sent this letter to Sam Rivera 2 minutes
      ago." A fresh load still showed 1 letter.)
- [x] Sign out, open a link and sign in. You should land back on the same page.
- [x] Signed in with another development account, open the first link. The page should read "We
      couldn't find this preview." (testlirl01+428, with a testlirl02 link; the API answered 404
      and logged no client refusal.)
- [x] Optional: on an account with no letters, open a link. The page should say there aren't
      enough letters and offer **Buy letters**, which opens Letter Packs. A test purchase (the
      owner enters the test card) should lead back to the page, where **Check again** shows the new
      balance. (The page came back already showing 2 letters, so **Check again** was not needed.)

Other callers:
- [ ] Optional: from an MCP client that uses a development personal access token (see
      [PAT Authentication](#pat-authentication-us-mcp-03)), call `send_letter` for a preview. It
      should send nothing and answer "Not sent: Letter IRL sends mail only when the person sends
      it.", followed by the link. (Not run.)

Leave the rule on in development afterwards. (It is on.)

### Validation Errors
- [x] Missing address fields → clear error
- [x] Non-US address → "Only supports US" error (2026-09-13: refused as a missing `state`
      instead; clear, but not that wording)
- [ ] Text-only body over 1,600 characters or 24 lines returns a clear limit error
- [ ] Invalid address → suggestions returned
- [ ] Multi-tenant address with a suite/apartment (e.g. 350 5th Ave, Suite 8701, New York, NY 10118) → draft IS created; response carries a one-sentence note that USPS couldn't confirm the unit and mail goes out as entered (issue #200)
- [x] Same building with no unit given → draft IS created with an "add the unit if you have it" note
- [x] Garbage street (123 Fake Street, Nowhere) → still refused, message says what to check
- Expected refusals like these, and an over-long gift postcard, log `tool.invocation.failure`
  with `errorClass=unknown_error` (seen 2026-09-22 and 23): the class is a mislabel, so read the
  stage line logged just before it.

### Send (US-LETTER-02)
- [x] Use draft ID from preview
- [x] Set `confirm: true`
- [x] Credits deducted
- [x] Order ID returned
- [x] Status is `accepted`, or `pending` with recovery explicitly scheduled

### Idempotency (US-LETTER-03)
- [x] Call send again with same draft ID
- [x] Same order returned
- [x] `isRetry: true` in response
- [x] Credits NOT deducted again

### Status Check (US-LETTER-04)
- [x] Query status with order ID
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

**Status:** Executed 2026-09-13 against development over plain HTTPS: twelve
`GET /api/public/promo/validate/<code>` calls from one address in a few seconds returned 200 with
`X-RateLimit-Remaining` counting 9 down to 0, then 429 with `Retry-After: 53`.

- [x] Public `/api/promo/validate` rate limited
- [x] 10+ requests/min from same IP → 429
- [x] Rate limit headers present

### New User Only (US-SEC-06)
- [ ] Create "new users only" campaign
- [ ] New user can redeem
- [ ] Existing user (with purchases) blocked

---

## Gift Letters

### GIFT-01 — Gift letter end to end, and the test print

**Status:** Run on development on 2026-09-22 and 23. Steps 1 to 9 passed, step 9 with two workarounds
that #431 fixes. Step 4 was checked on screen rather than on paper, and its iPhone scan is still open.
Gates switching `LETTER_IRL_GIFT_LETTERS_ENABLED` on in production ([gift-letters.md](gift-letters.md)).

Development, with `LETTER_IRL_GIFT_LETTERS_ENABLED=true`,
`LETTER_IRL_GIFT_LANDING_BASE_URL` set to the development website, and the DEV connector refreshed
after deploy (widget v36).

1. [x] Buy a Starter pack in test mode. `get_account_balance` reports `giftLettersRemaining: 1`.
2. [x] Preview a letter with `sendAsGift: true`. The card shows "Free (gift letter)", a second
       page, "Send Gift Letter", and no Pay & Send.
3. [x] Send it. The admin **Gifts** page lists a new chain code issued to the account.
4. [ ] **The test print.** Open the letter in the PostGrid test dashboard and download its PDF.
       Print it at 100% on plain paper and check:
       - [x] page 2 holds the card in its upper half, clear of PostGrid's integrity QR and
             sequence ids at the bottom left;
       - [ ] the QR scans on an iPhone and on the S25 Ultra, in ordinary indoor light, and opens
             `<website>/g/<code>`;
       - [x] the printed code, typed at `<website>/g`, is accepted;
       - [x] the QR rendered at all. If it is missing or blurred, set
             `LETTER_IRL_GIFT_QR_FORMAT=png` and repeat from step 2;
       - [x] PostGrid's cost for the letter shows the extra B&W page and no colour.

       **2026-09-23:** checked on the PDF on screen, not printed. The S25 Ultra scanned the QR
       from the screen and opened the development claim page; the iPhone scan is still to do. The
       inline SVG rendered, so the PNG fallback is not needed. PostGrid's order records two pages,
       `color: false` and single-sided; test mode shows no price. The QR carries the code
       without its hyphen, which the claim page accepts. On the S25 the claim page showed **Claim
       my letter** for a code already used and refused it only after sign-in. On the desktop the
       check before sign-in shows its notice (checked on a used-up seed code). Not investigated.
5. [x] On a second Auth0 account, redeem the code (`redeem_promo_code`, or the website). It
       reports one gift letter; the admin page shows the code redeemed.

       **2026-09-23:** claimed on the website at `/g/<code>`. The dashboard showed the gift
       letter only after a reload (Findings, below).
6. [x] Redeem it again from a third account: refused as already used. Redeem it from the sender's
       account: refused as their own code.

       **2026-09-23:** both in ChatGPT: the third account was told the code had already been used,
       and the sender that it was printed on a letter they sent.
7. [x] From the second account, preview and send. Its budget is 0, so the preview and the print
       show the plain "Sent with Letter IRL" card and no new code is issued.

       **2026-09-23:** the rule was checked on the sender's own budget-0 gift letter, from an
       earlier claim: the plain card printed and no code was minted. The second account's send
       itself was not run.
8. [x] Repeat 2 to 4 with a postcard: the strip sits at the foot of the message half and a message
       over 350 characters is refused.

       **2026-09-23:** a 398-character message was refused ("398/350 ... leaves room for the gift
       card"). The strip sits at the foot of the message half, under a rule, with the code, the
       claim address and the redeem-by date, and its QR matched the encoder's output for
       `<website>/g/<code>` byte for byte. PostGrid prints the back in one sans-serif face,
       though the card preview shows a serif.
9. [x] Create a seed campaign (credits 0, budget 1, cap 2, new accounts only), activate it, grant
       an account one gift letter bound to it, send, and confirm the card prints the campaign
       code. Claim it from two accounts; the third claim is refused at the cap.

       **2026-09-23, with two workarounds that #431 fixes.** The create form sends no `target`,
       so the campaign was created by adding `target=<code>` to the preview address. After a
       claim, the claiming account's admin page answered 500, so its gift letter was granted through
       the grant preview's address. Two new accounts claimed on the website; the third claim, from
       ChatGPT, was refused with "Promo code redemption limit reached" (#432), and the public
       lookup then answered `limit_reached`.

       The first sender had already sent three pieces that UTC day, so the per-account cap refused
       its seeded send (gift sends count; the gift letter was rolled back). A claiming account sent
       instead. The gift letter from its claim expired sooner, so its first send used that one and
       minted a chain code with budget 0: a seed claim carries the campaign's budget one hop down.
       Its second send used the bound gift letter and printed the campaign's code, and that QR
       matched the encoder's output too. The card said "The code works once." (#431 changes that
       for seed codes) and the preview showed a placeholder code (#433). A bound gift letter sent
       after the cap would still print the used-up code (#435); ending the campaign avoids that.

**Findings, 2026-09-23 (development):**

- Fixed by #431: the create-campaign form, the account page after a gift-only seed claim, and
  the seed card's "works once" wording.
- Filed: #432 (seed refusals use promo-code wording), #433 (a seed-bound preview shows a
  placeholder), #434 (a refused send shows the host's raw exception on the card), #435 (a bound
  gift letter sent after the cap prints the used-up code).
- Website: right after a claim the dashboard shows the gift-letter count from before it, until a
  reload. Its gift copy promises "a card for your recipient" even for a budget-0 gift letter,
  which prints the plain card.
- The per-account daily mail cap (3) counts gift sends, so seeding a batch of letters on one
  account takes days.
- An admin elevation lasts 60 minutes only while its session is in use: the session's
  15-minute idle timeout ends both, and the banner's "elevated until" does not say so.
- Auth0's sign-in page expires when left open: after about two hours it answered "Oops!,
  something went wrong" (`invalid_request`, "we couldn't find your session"). Start the
  claim again from `/g/<code>`.
- After the Starter pack bought from the checkout card (step 1), the return page logged
  `cookiePresent=false` and offered a plain ChatGPT link, not the way back to the conversation
  (PAY-05).

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

**Preconditions:** Full mode as above; a job held on an ambiguous provider outcome. The decision rules are in
[deployment.md](deployment.md#operator-recovery-through-the-admin-panel). The dummy provider cannot
produce an ambiguous outcome (its failures are definite rejections), so this case needs a real one.

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
   cleared code (the reason is on the audit row alone, #394), and the next `npm run maintenance` (or hourly run) refunds the order.

**Pass criteria:** Release is a deliberate operator decision, recorded, and the sweep then acts.

### ADMIN-ACCT-04 — Promo campaigns and ambiguous image reservations

**Status:** Not run. Step 1 fails on development until #431: the create form sends no `target`
and the preview refuses it (found by GIFT-01 step 9, 2026-09-23). Running this step would have
caught it when the panel shipped.

**Steps:**

1. [ ] `/promos/new`: preview and create a draft campaign; verify it appears as `draft`.
2. [ ] Preview `active`; before confirming, change the campaign on another tab (or in SQL); execute;
   verify `409 ADMIN_STALE_PREVIEW`. Preview again and execute; verify `active`.
3. [ ] Redeem the code with a test account (`redeem_promo_code`); verify the campaign page lists the
   redemption with a masked email and that "delete" is no longer offered. End the campaign.
4. [ ] `/images`: with an ambiguous reservation (decision rules in
   [deployment.md](deployment.md#operator-recovery-through-the-admin-panel)), preview "release as
   compensation" and execute; verify the reservation is `released`, the quota is back, and `/audit` shows
   `image.resolve` alongside the domain's `image_reservation_resolve` row.

**Pass criteria:** Promo status follows the documented machine with version checks; image recovery is
reachable and audited.

### ERASE-01 — Account erasure (development)

**Status:** Passed on development, 2026-09-24. Build 7e92ba0 for steps 1 to 5 and 7; the step 6 sign-ins ran on c25f86d. The account was a throwaway password account, `testlirl_erase01`.

- **Not yet run:** the follow-up alert checks in steps 4 and 6 (#453). They came after this run, and the account was erased before migration 036.
- **Reworded after the run**, to match the code:
  - the precondition: the letter was `accepted`, that is with the printer, and the erasure counts that as finished;
  - step 2: the account still had a letter, so Pay & Send was not offered and a pack checkout stood in;
  - step 6: it now covers a password account.

What each step showed:
1. The preview named nothing in flight: one letter, two drafts and the upload link to erase; one order kept; two credits and one gift letter forfeited. No email appeared.
2. With a pack checkout open, the preview named "1 orders not settled", and Execute was refused with `ADMIN_INVALID_STATE`. A pack checkout stays open for 24 hours and Back does not settle it (#461), so it was settled by paying. The preview then showed nothing in flight.
3. The erasure was queued, and `/audit` showed `account.erase` with the reason and no email. A form left open past the 15-minute idle answered a bare `forbidden` and needed a fresh elevation (#462).
4. The 18:00 UTC run erased the account: one letter scrubbed, two drafts deleted, five descriptions cleared. The page showed `e***@erased.invalid` and the send block `account_erased`, and the letter stayed `accepted`.
5. In ChatGPT, the balance call answered "Account closed" with the sentence, and `get_account_balance` never started (`identity.account_erased_refused`). The dashboard showed the sentence, and its calls answered 403.
6. A fresh password sign-in (`prompt=login`) got the sentence. After the Auth0 user was deleted, signing up again with the same address opened a new, empty account (`auth0|6ab589d1…`). The stub stayed erased.
7. A new preview was refused (`ADMIN_INVALID_STATE`).

**Preconditions:** A disposable development test account that has signed in on the website and in the
(DEV) ChatGPT connector, has sent a letter that is now with the printer or finished (`sent`, `accepted`,
`delivered` or `failed`), and holds a draft and a saved return address. Nothing on it is in flight.

**Steps:**

1. [x] Open the account in the panel. Under **Erase account**, preview. Verify that "Still in flight" says
   nothing, that the counts match the account, and that no email appears anywhere in the preview.
2. [x] Start a checkout on the account and leave it open: Pay & Send if the account has no letters,
   otherwise a letter pack. Preview again: verify it names one order not settled and that confirming is
   refused. Settle it, then preview again. A Pay & Send checkout expires after about 40 minutes. A pack
   checkout stays open for 24 hours and Back does not settle it (#461), so pay it.
3. [x] Confirm with the development phrase and a reason with no personal details. Verify the account page
   says the erasure is queued, and that `/audit` shows `account.erase` with counts only.
4. [x] After the next hourly maintenance run (the `account-erasures` task on `/maintenance`), verify on
   the account page:
   - erased, with counts;
   - the email shows as `e***@erased.invalid`;
   - the letters keep their statuses;
   - "Still to do by hand", linking an open `account_erasure_followup` alert. The alert is also listed
     on `/alerts`, with the account in its "Order or account" column. Its page lists the steps, and its
     details hold the account id and nothing else (#453).
5. [x] Call any tool from the (DEV) connector: verify the erased-account sentence, and that nothing ran.
   Reload the website dashboard: verify the same sentence (needs website #36 on development).
6. [x] Sign in again with the same method, forcing a fresh sign-in (`/auth/login?prompt=login`): verify
   the same sentence. Delete the Auth0 user in the development tenant. Resolve the follow-up alert with
   the code its form fills in, `auth0_user_deleted`: verify the account page then says the follow-up is
   done. Then sign in once more:
   - a Google or Apple sign-in brings back the same subject: verify the same sentence;
   - a password account cannot sign in once its Auth0 user is gone. Sign up again with the same address:
     verify a new, empty account, because the erasure released the address.
7. [x] Preview an erasure of the account again: verify it is refused.

**Pass criteria:**
- Nothing is queued while money or mail is moving.
- The erased account keeps its money records and loses its content and identity.
- Every sign-in path refuses it with one sentence.
- The steps done by hand stay on an open alert until an operator resolves it.

### ADMIN-OPS-01 — Retention report and quarantine listing

**Steps:**

1. [ ] Open `/retention`; verify the counts (redacted letters and drafts, quarantine rows, purge due) and
   the report of what the next enforcing run would touch, matching `npm run maintenance` in report mode.
2. [ ] Verify the quarantine table shows source table, row id, account and dates only, with a restore
   control per row and no content anywhere on the page.
3. [ ] Search the quarantine by a letter id, then by the account it belongs to: verify each finds that
   letter's copy, and a search for an unknown id finds none. On the account page, verify the link to its
   quarantined copies opens the same search.

**Pass criteria:** Metadata only; any copy can be found, however old; a restore is a queued command
(`RETENTION-01`).

### RETENTION-01 — The first enforcing sweep (development)

**Status:** Run on development on 2026-09-24 at build 7e92ba0. Results by step:
- Steps 1, 2 and 5 passed.
- Step 3 passed for the backlog rows. No row was swept on time, so the on-time purge could not be observed.
- Step 4 was not verified, because nothing past the window was in flight.

The run's figures:
- **Before switching:** 3 letters due (93 past the window, 90 held back). No paid or abandoned drafts were due (17 abandoned drafts held back).
- **The 13:00 UTC sweep:** `lettersRedacted: 3`, no drafts, nothing purged, `moreWaiting: false`, no errors. The log carried counts only. The batch was not full, so there was no `retention.backlog_remaining`.
- **Quarantine:** the three rows showed "purge after 24h" from the moment they were quarantined.
- **Restore:** letter `d3cb6e47` showed its saved copy and "purged 23h from now". The owner confirmed the restore, and the 15:00 run logged `retention_restore.completed`. **Recent restores** then read `restored`, the letter's page no longer showed it redacted, and `/retention` counted it as due again.

Run on development before `CONTENT_RETENTION_MODE=enforce` is set anywhere else (#153).

**Steps:**

1. [x] Before switching: note the counts on `/retention` (letters, paid drafts and abandoned drafts due,
   and held back).
2. [x] Set `CONTENT_RETENTION_MODE=enforce` on `letter-irl-maintenance-dev`. After the next daily
   `content-retention-sweep` (`/maintenance`), verify each redacted count rose by its due count from
   step 1 or by the batch size (`CONTENT_RETENTION_BATCH_SIZE`, 500 by default), whichever is smaller,
   give or take rows that came due in between. Verify the maintenance log carries counts only, and
   `retention.backlog_remaining` when a batch was full.
3. [x] The same day, verify on the quarantine table:
   - a row swept on time purges when its published period ends;
   - a row swept after its period (the backlog) purges about a day after it was quarantined. That day is
     all the time there is to restore a backlog row the sweep should not have taken, so check the swept
     rows now, not after the next run.
4. [ ] Verify letters that were still in flight (queued, held, or with an unsettled order) were not
   touched.
5. [x] On a quarantined letter's own page (`/letters/<id>`), verify the saved copy shows with its purge
   time, preview its restore and confirm it. After the next hourly run, verify under **Recent restores**
   on `/retention` that it says `restored`, and that the letter page no longer shows the content as
   redacted. The next daily sweep quarantines it again, because nothing about it changed.

**Pass criteria:** The sweep cleared what the report said it would and nothing in flight, and a restore
put a copy back.

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
2. [ ] Note the email on the balance
3. [ ] End the Auth0 session
4. [ ] Login with GitHub **on the same confirmed address**
5. [ ] Same account: one balance, the same letters
6. [ ] An address the two methods do NOT share is a different account

### LINK-01 — One account per confirmed address

Run on development first, after the two Post Login Actions and the
`Account Linking` machine-to-machine application are in place
([auth0-tenant-configuration.md](auth0-tenant-configuration.md)), and again on
production before anyone but the owner signs in there.

**Preconditions:** both Actions are in the Post Login trigger flow, with
`link-verified-email` **above** the email-claim Action, **before** the API is
deployed against the tenant. The order is not a formality and there is no
fallback: a new customer arriving between the deploy and the Action update is
refused until their token is re-minted or expires, 24 hours. Then: the API is
deployed, `/readyz` is green, and the connector has been refreshed.

**Tenant state recorded when this was first set up (development, 2026-09-19):**
all 8 Auth0 users held distinct addresses, so linking had nothing to join and
could not strand a row holder; exactly one user (`testuser321@…`, one login,
nine months old) had `email_verified: false` and is denied by the gate, which
is the intended behaviour. Both facts were read from the Users list with
**Search by: Lucene Syntax (Advanced)** and `email_verified:true` /
`email_verified:false` - the plain "User" search silently matches the query as
literal text and answers "No users found" for both, which reads exactly like a
clean tenant.

**Do the row-holder check first, and immediately before enabling the Action.**
For every confirmed address held by more than one Auth0 user, the oldest must
be the subject holding the `users` row, or the address must have no row.
Otherwise linking hands the surviving subject an account it cannot reach, with
no way back. The procedure, and the hand-written SQL that is today's only
remedy when a pair does not match, are in
[auth0-tenant-configuration.md](auth0-tenant-configuration.md).

1. [ ] Sign in to the website with Google. Note the balance and the letter
       count.
2. [ ] Sign out, then sign in with a password on the same confirmed address.
3. [ ] The dashboard shows **one** account: the same balance, the same letters.
4. [ ] Auth0 -> User Management shows one user with two identities, and the
       Action logs show the link.
5. [x] A brand-new password sign-up gets one confirmation email and is refused
       until its address is confirmed, with "We've sent a confirmation link to
       your email address - check your spam folder if it's not in your inbox.
       Open the link, then sign in again. If nothing arrives within 10 minutes,
       sign in again for a new link." Signing in again sends nothing within ten
       minutes of the sign-up; after that, one sign-in sends one fresh link, and
       the ten minutes start again. Once a link is opened, the next sign-in
       opens a new, empty account.

       **Passed 2026-09-25 on development** (#428), as `testlirl01+428@…`, a
       plus-address that Auth0 treats as a new user. Times are UTC, from the
       Auth0 log:
       - 04:38 sign-up, with Auth0's own email. The automatic sign-in a second
         later was refused with nothing re-sent.
       - 04:49, eleven minutes on: a sign-in was refused and sent one fresh
         link, and Auth0 recorded the time on the user.
       - 04:49 to 04:50: six more refused sign-ins sent nothing, so the
         recorded time survives a refused login.
       - Two emails arrived in all, at 04:38 and 04:49.
       - 13:44: after a link was opened, the sign-in reached an empty
         dashboard. The API logged `identity.user_created` with no identity
         warning, and the admin lookup shows the new account with 0 letters.

       The 2026-09-23 run passed on the refusal alone: that version of the
       Action worded it differently and sent another email on every refused
       attempt.
6. [ ] An Apple sign-in with **Hide My Email** on is a separate account, as
       documented.
7. [x] In ChatGPT, connect Letter IRL on an address that already has an account
       through another method. It connects rather than answering "We couldn't
       connect this account".

       **Passed 2026-09-22 on development**, with the connector created with
       **OIDC enabled** unticked, as the OAuth Flow section now requires. The
       link listed all 23 tools, and ChatGPT called `get_profile` during the
       link and stored its answer - the account id and the confirmed address -
       as the link's owner profile. `get_account_balance` then ran in a fresh
       chat with the connector attached.

       **The failure was mis-attributed twice before that.** It started this
       work on 2026-09-18 and was first put down to the duplicate-address
       collision, then on 2026-09-21 to ChatGPT not requesting `openid` (#424,
       #425). Both were wrong. ChatGPT does request `openid profile email`, but
       Auth0 grants no OIDC scope to its strict CIMD client - so the grant that
       was read as evidence can never show one - and with **OIDC enabled**
       ticked ChatGPT refuses a link that brings no ID token
       ([chatgpt-connector-oidc-setting.md](learnings/chatgpt-connector-oidc-setting.md)).
       When a connect fails, read ChatGPT's own callback response
       (`/backend-api/aip/connectors/links/oauth/callback`) in the browser tab
       first: nothing server-side logs a link that fails before this server is
       called.

       If the link fails after ChatGPT reaches this server, the API log shows a
       `mcp.client_request` for `tools/call get_profile`. With no
       `tool.invocation.start` after it, the signature is shared: with an
       `auth.account_missing_no_verified_email` or
       `identity.email_already_linked` line beside it, the wrapper refused the
       account (the row-holder hazard above produces exactly this); with
       nothing beside it, it is either the SDK rejecting a call made without
       an `arguments` object before our code runs, or a token lacking
       `mail:read`, which the scope refusal does not log.
8. [x] `get_account_balance` names the address and no longer names a sign-in
       provider.

       **Passed 2026-09-22 on development:** "Account: <address>", and no provider.
9. [ ] Gift rules still hold across the linked methods: a code printed on your
       own letter is refused whichever method you sign in with.

       **2026-09-23, development:** passed for the Google sign-in. Not yet run for the password
       sign-in, and it needs a fresh, unused code: a used code is refused to everyone before the
       own-code rule runs. The own-code rule also matches the issuer's normalised address, so any
       sign-in on the same address is refused, linked or not.
10. [ ] A token with no confirmed address gets the sentence, not a broken
       account. Simulate on development by taking the claim Action out of the
       trigger flow and signing in with a fresh subject: both surfaces then
       refuse. Every tool answers "Letter IRL needs a confirmed email
       address...", and the dashboard answers 403 with the same text. Put the
       Action back afterwards. Use a fresh subject on a **confirmed** address
       that no other Auth0 user holds - an unconfirmed one is denied by the
       linking Action with its own message and never reaches the server, and a
       shared address is linked into the older account instead.

       **2026-09-23, development: the server passed, the surfaces did not.** With
       the claim Action out of the flow, a fresh subject's REST calls answered 403
       with the sentence (`auth.account_missing_no_verified_email`), but the
       dashboard drew an empty account (dnobj/mail-letter-irl-website#34), and in
       ChatGPT the refused `get_profile` failed the link as
       `OAUTH_OWNER_PROFILE_ID_MISSING`, so the sentence never reached the
       person (#429). The Action was put back and checked live.

### LINK-02 — Every launch sign-in method yields a confirmed address

**Status:** Not run.

The owner kept the refusal of a sign-in that carries no confirmed address (#429, 2026-09-23). In
ChatGPT that refusal surfaces only as "We couldn't connect this account", so a launch sign-in method
must always vouch for the address. A method that fails here comes off the launch list: disable its
connection for the Letter IRL applications before launch. The rule does not change.

**Launch methods:** Google, GitHub, Microsoft (personal accounts only, per
[auth0-tenant-configuration.md](auth0-tenant-configuration.md)), and email with a password. Apple is
not in the launch (#437).

**Preconditions:**
- A test identity for each method that has never signed in to the tenant, so each run is a first
  sign-in.
- The GitHub connection requests the account's email address.

Run on development, then on production before launch. The sign-ins are the owner's.

**Steps, for each method:**

1. [ ] Sign in to the website with the method. For email with a password, sign up and confirm the
   address from the email first; LINK-01 step 5 covers the refusal before confirming.
2. [ ] The dashboard shows a new account. The API log shows `identity.user_created`, and no
   `auth.account_missing_no_verified_email`.
3. [ ] In Auth0 → User Management → Users, the user's email shows as verified (Raw JSON:
   `"email_verified": true`).
4. [ ] In ChatGPT, connect the environment's Letter IRL connector with the same method: the link
   succeeds and `get_account_balance` answers.

| Method | Development | Production |
|--------|-------------|------------|
| Google | | |
| GitHub | | |
| Microsoft | | |
| Email and password | | |

**Pass criteria:** every launch method gives `email_verified: true` on a first sign-in and opens an
account in both environments. Any method that does not is disabled before launch and recorded on #158.

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

**Status:** Run 2026-09-15, after the Auth0 Default Audience repoint and the retired API's
deletion (#391):
- Token validation: the ChatGPT balance calls above succeeded against both APIs, and both
  dashboards' REST calls returned 200.
- Duplicate clients: none after the development reconnect.
- Login providers and personal access tokens were not exercised.

- [ ] All OAuth providers work
- [x] Token validation works
- [ ] PAT authentication works
- [x] No duplicate Auth0 clients created

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

PostGrid's address verification rejects made-up addresses, even in test mode: the pair this
section used to list failed on 2026-09-22. These two pass, in **test mode only**; in live mode they
would really be mailed.

```
Sender (verified, after PostGrid's correction):
1600 Pennsylvania Avenue NW
Washington, DC 20500

Recipient (accepted with the missing-unit note, issue #200):
350 Fifth Avenue
New York, NY 10118
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
