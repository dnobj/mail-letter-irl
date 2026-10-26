# Launch Promotion Plan

**Last Updated:** October 23, 2026

The plan for promoting the launch version to production (#702, part of #680; tracker #158). It says
what is pending, in what order it goes, what each system needs and when, how to check each stage,
and how far back each stage can be rolled. Steps that need credentials or a dashboard are the
owner's; everything else can be driven by an agent with the owner's approval at each change.

Revalidate before acting: numbers below are as of `dev` at `789a0f5` (2026-10-20).

## What is pending

| Repository | Production | Development | Pending |
| --- | --- | --- | --- |
| API (`mail-letter-irl`) | `master` at `27e160a` (#416, 2026-09-16) | `dev` | 285 pull requests (#336, #415 to #827), migrations `033` to `065` |
| Website (`mail-letter-irl-website`) | `main` at `bc81767` (2026-09-16) | `dev` | 42 commits (#31 to #83) |

[status.md](status.md) summarises what the launch version adds.

## The order, and why

1. **Stage 0, preparation** (days before): decisions, DEV tests, the production Auth0 tenant,
   production variables set ahead, read-only checks.
2. **Stage A, the website** (`dev` to `main`).
3. **Stage B, the API** (`dev` to `master`), in the merge window, the same day as stage A.
4. **Stage C, the decided switches,** one change at a time.
5. **Stage D, the renderer.**
6. **Stage E, the studio features without a price,** one per deploy.
7. **Stage F, arrive-by.**
8. **Stage G, the paid options,** one per deploy.
9. **The live checks,** one real piece of each kind, then the submission.

**The website goes first.** The API no longer boots in production without the send rule
(`LETTER_IRL_SEND_CONFIRMATION_ENABLED=true`, #731), and the send rule sends people to the
website's confirmation page (`/confirm/<draft>`), which exists only on the website's `dev`. The older
order, "API dark, then the website", is obsolete for that reason. The website's new pages answer
nothing useful until the API is promoted (the gift, address and confirmation pages call new API
routes), so keep the gap between stages A and B short. Nothing links to those pages before stage B.

**Merge between :10 and :40 past the hour.** The API's pre-deploy runs every pending migration in
one transaction once the image is built, a few minutes after the merge, and the hourly maintenance
run at :00 must not overlap it (see "Migrations").

## Stage 0: preparation

### Decisions (owner)

**The launch cut, approved 2026-10-20** (#816; it replaces 2026-10-16's "the launch set is
everything"). Feature freeze since 2026-10-19: only launch-blocking fixes until launch.

- **Group 1, on at launch:** the print renderer (`pdf`), the studio card, stationery, room to
  write, postcard sizes and layouts, collages, arrive-by, the envelope reveal, gift letters, and the
  send confirmation.
- **Group 2, on once its step is done** (otherwise off at submission):
  - certified mail: one live certified letter after stage B, checking the markings and where the
    return receipt goes; off before the submission if they fail;
  - signatures: SIGNATURE-01's remaining steps on DEV; its privacy rows are published with the
    promotion (#825, website #83);
  - card upload (Claude): the owner's photo pick in Claude Desktop and on Android.
- **Group 3, off at launch, for after it:** the home (#651, #665, #644), address requests, saved
  designs, the separate words-editor flag (room to write turns the editor on), and image
  generation (`off`).
- **The submission's tool set is the cut:** 34 tools in ChatGPT, pinned by
  `tests/unit/mcp/__snapshots__/tools-list.chatgpt-launch.json`. Certified mail or signatures
  switched off shrinks it (card upload's tool is never served to ChatGPT), so the submission waits
  until every group 2 step has its answer. Turning a flag on
  after approval changes the tools, which goes back to review.
- **Prices**, approved 2026-10-20: 2-page letter $5.99, 3-page $6.99, 4x6 postcard $3.99, 11x6
  $5.99, certified $11.99, certified with return receipt $14.99. The live Stripe prices exist and
  their ids are set on the production API and maintenance services (2026-10-20).
- **The promotion date:** as soon as stage 0 is done.

Taken on 2026-10-16 (recorded on #680), and still standing:

- D2 to D8 as written on #680. The scheduled-mail privacy row (D6, #701) is approved; it is
  published with arrive-by.
- `CONTENT_RETENTION_MODE`: `report` through the promotion, `enforce` in stage C (see "Rollback").
- The non-root image (`Dockerfile.api`, #772) in stage C, as its own change.
- Sign-in methods: what has passed on DEV (Google, GitHub, email and password; Microsoft only after
  LINK-02 with it), with our own OAuth applications.

Still the owner's, before the stage that needs it (stage G): the terms for the paid options (#579;
drafted for the owner on 2026-10-20, never published by an agent). PostGrid's written confirmation
of certified mail was **waived by the owner on 2026-10-20**: the live certified letter above answers
the same questions (the markings clear of the address window, where the return receipt goes, the
production time), and certified mail goes off before the submission if it fails. The privacy rows for saved designs and address requests, and the home's sharing (#651), wait
with those features until after the launch.

### Manual tests on DEV (owner, with an agent driving)

Owed before stage A, on DEV at the head being promoted:

- **SEND-01:** a send from the card and from the confirmation page. It last passed 2026-09-26,
  before the content-version changes (#695).
- **The words changed after the card was shown (#723):** change the letter in the chat, then press
  Send on the old card; it must refuse.
- **PRINT-02's sends** (its previews passed): before stage D, not before stage A.
- **REFUND-01.**
- **A card smoke test:** ChatGPT web, desktop, Android and iOS; Claude web, desktop and Android;
  VS Code.
- **GIFT-01** steps 4 and 8: a paper reprint and an iPhone scan, once with the renderer and once
  with `LETTER_IRL_PRINT_RENDERER` unset, since production prints gift cards from the old layout
  between stage C and stage D.
- **LINK-02** with each sign-in method chosen for production.
- **ERASE-01**'s alert steps, and the admin order page's held-refund note (needs elevation).
- **The other app gates:** CLIENT-02, CLIENT-04 (Codex), CLIENT-06, and the Hermes and VS Code gates.
- **Group 2's DEV steps:** SIGNATURE-01's remaining steps (the card in ChatGPT, a test-mode send,
  the website's signature page), and the photo pick in Claude Desktop and on Android (card upload).
  A step not done before the submission leaves its feature off: set it off in the launch golden,
  re-record, and take it out of the reviewer materials (below).
- **The custom domain's open checks on DEV** (the tenant doc's state table): a new ChatGPT
  connector, signing out of a session from before the switch, and a connection made before it,
  used again after its access token has expired.

[manual-tests.md](manual-tests.md) has each test.

**Done on DEV, 2026-10-21 to 10-23:**
- SEND-01 and #723;
- REFUND-01;
- the card smoke test, in every client listed;
- SIGNATURE-01 apart from step 11's touch checks;
- the photo pick in Claude web;
- of the custom domain's checks, the new ChatGPT connector and the connection made before the switch.

**Done on DEV, 2026-10-24 to 26:**
- PRINT-02's seven sends, read in PostGrid's proofs;
- GIFT-01's paper scans on Android, for both card layouts;
- every app gate: CLIENT-02 (Claude Code) with its refusals, CLIENT-03 (VS Code), CLIENT-04 (Codex),
  CLIENT-05 (Hermes), and CLIENT-06 (OpenClaw) as far as sign-in, probe and disconnect (its agent steps
  need a model provider and were left by the owner's choice);
- ERASE-01 with its alert steps;
- the photo pick on Claude Android and in Claude Desktop.

**Still open:** GIFT-01's iPhone scan, and what a person with an unconfirmed email sees when an app
signs them in (Auth0's generic error page, #837). LINK-02 passed on DEV for Google, GitHub and email,
and signing out of a session from before the switch can no longer be tried there (the rotation of
`AUTH0_SECRET` signed everyone out): both are production checks at stage B.

### The production Auth0 tenant (owner), before stage B

The API refuses to open an account for a token without the verified-email claims, so the tenant
must be ready before the API deploys against it
([auth0-tenant-configuration.md](auth0-tenant-configuration.md)):

1. A custom email provider (Resend) and the verification email template enabled, **before** the
   linking Action goes into the flow, or new password sign-ups cannot confirm.
2. Count production's applications first: at the free plan's limit of 10, "Create application" is
   off, and this step and step 3 need two slots at once, so free two legacy entries now (step 8
   removes the rest). Then the `Account Linking
   (production)` machine-to-machine application, with exactly `read:users` and `update:users` on
   the Management API.
3. Create the temporary application `Tenant check (temporary)` (the tenant doc's "Checking a
   tenant"), with `read:users` added for the row-holder check the tenant doc describes; run that
   check, and from the same pass count the users of each connection (`identities[].connection`),
   for step 6. Then delete the application, so it does not hold a slot during step 8. Then add the two
   Post Login Actions from [`docs/auth0/actions/`](auth0/actions/), the linking Action above the
   email-claim Action. Production already has an email-claim Action (deployed 2026-09-05): replace
   its code with the file's rather than adding a second, so the flow binds one of each.
4. The consent setting (`use_scope_descriptions_for_consent`, #267).
5. The ChatGPT client's refresh-token settings (they are not inherited from development).
6. The sign-in methods decided: Google, GitHub, and email and password (Microsoft only after
   LINK-02 with it). The outcome, which stage B checks on the website and on a connected app, is
   that exactly these are offered and each works:
   - each social connection uses our own OAuth application's credentials, not Auth0's developer
     keys, and asks for the email address (the linking Action needs it);
   - each chosen connection is ticked on the website's application and promoted to the domain
     level, since the connected apps are third-party clients that use domain-level connections
     only (production's record has only Google and the password connection promoted);
   - each connection left out (Apple, Microsoft until then) has that promotion off and is unticked
     on the website's application. **Never delete a connection**: Auth0 deletes its users with it,
     past undoing. If step 3 counted users on one left out, decide first what becomes of them.
7. Run `scripts/check-auth0-tenant.ts` and record the result in the tenant doc. On production, run it
   here, before the imports of step 8 take the free application slots (none of them holds a
   Management API grant, so the check loses nothing). On development, which is at the free plan's
   10-application limit, free a slot first: remove an app you can import again from its client
   document afterwards, never `Account Linking` or the website's.
   Its token comes from a new temporary application holding only the five read scopes (step 3's
   was deleted, with its `read:users`), deleted again after the run. **Not** from the Management API's API Explorer tab: on a tenant
   without the API Explorer Application, that tab creates it, with every Management API scope (the
   development tenant's was deleted on 2026-09-26; if production still has one, the check reports
   its grant).
8. The applications: remove legacy entries within the tenant's application limit, then import the
   apps chosen for launch, keeping one slot for OpenClaw: its client document is served by the
   production website, so it is imported after stage A.
9. The custom domain `auth.letterirl.com`, steps 1 and 2 of the tenant doc's "Moving a tenant to a custom
   domain": verified, emails switched, Google and GitHub callbacks in place. Done 2026-10-20; steps 3 and 4
   wait for stage B.

### Production variables set ahead (owner, or an agent with approval)

The current production code ignores every variable below except `CONTENT_RETENTION_MODE` (it acts
only on `enforce`), so they can be set before the merge; a variable change redeploys the current
build, which is harmless. Names only; values come from the owner's records.

| Service | Variable | Value | Why before |
| --- | --- | --- | --- |
| API | `LETTER_IRL_SEND_CONFIRMATION_ENABLED` | `true` | The new API refuses to boot without it (#731) |
| API | `LETTER_IRL_WEBSITE_CLIENT_ID` | the production website application's client id | Required with the send rule |
| API, maintenance | `LETTER_IRL_OPERATOR_ALERT_URL` | an https ntfy topic | Required in production (#727) |
| maintenance | `MAINTENANCE_HEARTBEAT_URL` | an https healthchecks.io check | Required in production (#727) |
| maintenance | `CONTENT_RETENTION_MODE` | `report` | Required in production; **never `enforce` yet** |
| admin | `ADMIN_TOTP_SECRETS` | `<login>=<secret>` per operator | The new panel never uses the shared secret in production (#773) |

Also before stage B:

- **Image generation.** `LETTER_IRL_IMAGE_GEN_MODE` changes meaning: on the current code `off`
  shows a redirect card; on the new code `off` removes the tool and `redirect` is the old behaviour.
  Check the production value, and set the one the launch wants (`off`).
- **Option flags stay unset, never `false`.** The preflight reads names, so a flag present as
  `false` still demands its prices.
- **Values the preflight cannot see.** It reads names only, so check these values by hand:
  - `LETTER_IRL_OAUTH_SCOPES`, if set, must include `mail:read`, `mail:draft`, `mail:send`,
    `offline_access`, `openid` and `email` (#425), or the new API refuses to boot after the
    migrations have committed. Unset, the default carries all six.
  - `UV_THREADPOOL_SIZE=16` on the API ([railway-setup.md](railway-setup.md)); stage B checks it.
  - `LETTER_IRL_ALLOWED_ORIGINS` includes the website's origin: the gift page (stage C) and later
    the address form call the API from the browser.
  - On the website, `LETTER_IRL_PUBLIC_API_URL` names the public API when `LETTER_IRL_API_URL` is a
    private address: the browser calls of the gift and address pages use it. Stage C checks it.
- **The Stripe webhook.** The production endpoint must subscribe to every event in
  [railway-setup.md](railway-setup.md), including `charge.dispute.updated` and
  `charge.dispute.funds_withdrawn`, which only the new build handles. Without them, an inquiry that
  becomes a chargeback leaves its letters spendable until the dispute closes. Adding them ahead is
  harmless: the current build records events it does not handle and does nothing with them.
- **The admin reader role.** The new panel refuses to start (`ADMIN_READER_ROLE_TOO_WIDE`, 503)
  if the production reader can read past its column grants. As the owner, run the query in
  `readReaderSeparation` (`src/admin/db.ts`) with the production reader's name: every column must
  be false (`address_requests` reads false before stage B). It covers table-wide grants, which the
  shorter query in [admin-panel-guide.md](admin-panel-guide.md) does not. Revoke what it finds
  before stage B.
- **Which services run a pre-deploy.** `railway.toml` gives the API and the maintenance service the
  same migrating pre-deploy (safe: the second waits on the advisory lock and finds nothing to
  apply). Note what each production service actually has, and whether the admin service has none,
  for stage B step 2.
- Run the preflight **from a checkout at the `dev` head being promoted**, with
  `$env:RAILWAY_API_TOKEN` set in PowerShell the way the tenant check sets its token (a hidden
  prompt, removed afterwards), then `npx tsx scripts/preflight-cutover.ts --env production`
  (PowerShell's npm shim drops the `--` of `npm run preflight:cutover -- --env production`; run from
  `master`, it checks the old variable list) and close its gaps ([deployment.md](deployment.md)). It reads the API and maintenance services only, so check
  `ADMIN_TOTP_SECRETS` on the admin service by hand.
- Make `ADMIN_TOTP_SECRETS` with `npm run admin:totp-enrol -- production <tailnet login>`, run from the
  same `dev` checkout. `master`'s copy of the script takes no login, prints a bare secret for the old
  `ADMIN_TOTP_SECRET`, and labels the authenticator entry with the environment alone, the same label
  as any earlier entry. On development that left two `letter-irl-admin-dev` entries after the
  2026-10-21 rotation, and the codes came from the wrong one. The current script's entry names the
  login. Elevate once on production after stage B deploys, to prove the entry.
- Keep `ADMIN_TOTP_SECRET` on the admin service: the current release needs it, and so does a
  rollback.

### Read-only database checks (owner)

The owner role can write, so its connection string is never handed to an agent; an agent may only
read the output the owner pastes.

Run on the production branch, with the role the API's `DATABASE_URL` uses, the day of the
promotion. Each query only reads.

```sql
-- The ledger: expect 032_error_text_minimisation.sql as the newest, and no row after it.
SELECT count(*) AS applied, max(name) AS newest FROM migrations;
SELECT name FROM migrations WHERE name > '032_error_text_minimisation.sql' ORDER BY name;

-- The server: 054 needs PostgreSQL 15 or later; 058 folds case by the database's locale.
-- datlocale exists from PostgreSQL 17 (Neon's version here); on an older server, drop it.
SELECT current_setting('server_version_num')::int AS server_version_num, current_user;
-- Expect the same answer as on the development branch, where 058 has run.
SELECT datname, datlocprovider, datcollate, datctype, datlocale FROM pg_database WHERE datname = current_database();

-- Constraints 033 and 058 drop without IF EXISTS: expect three rows.
SELECT conrelid::regclass AS tbl, conname FROM pg_constraint
 WHERE conname IN ('valid_letter_funding', 'valid_letter_funding_order', 'users_email_key') ORDER BY 1, 2;

-- 058: addresses that differ only in case stop the whole run. Expect 0 groups.
SELECT count(*) AS collision_groups FROM (
  SELECT 1 FROM users GROUP BY lower(email) HAVING count(*) > 1) g;

-- Ownership: every table must belong to the DATABASE_URL role (062 and 064 need it for the purges).
-- Expect 12 rows: a missing table is a finding too.
SELECT c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
 WHERE c.relkind = 'r' AND c.relname IN ('users', 'letters', 'letter_drafts', 'letter_jobs',
   'personal_access_tokens', 'promo_campaigns', 'promo_redemptions', 'commerce_operational_alerts',
   'commerce_operator_audit_events', 'admin_audit_events', 'admin_command_runs', 'admin_operations')
 ORDER BY 1;

-- Snapshots of the two data changes (keep the output): 034 ends these campaigns (a superset:
-- 034 also requires a column 033 adds), 057 gives these tokens an expiry.
SELECT campaign_id, code, status, credits_amount FROM promo_campaigns
 WHERE credits_amount = 0 AND status <> 'ended';
SELECT token_id, status, created_at FROM personal_access_tokens WHERE expires_at IS NULL ORDER BY token_id;

-- 055's input: expect 0.
SELECT count(*) AS jobs_with_held_until FROM letter_jobs WHERE metadata ? 'heldUntil';

-- Right before merging, as the owner role (another role sees no start time for other roles'
-- transactions): transactions open longer than five seconds would hold up the run. Look again
-- when the build finishes, just before the pre-deploy starts.
SELECT pid, state, now() - xact_start AS age, left(query, 60) AS query FROM pg_stat_activity
 WHERE datname = current_database() AND xact_start IS NOT NULL AND now() - xact_start > INTERVAL '5 seconds';
```

## Stage A: the website

1. Set **Last Updated** to the promotion date (owner's choice, 2026-10-19) in both copies of the privacy
   policy: `docs/privacy-policy.md` here and the website's `app/(marketing)/privacy/page.tsx`. The
   Scheduled Mail and Saved Signature rows (#825, website #83) go live with this promotion.
2. Merge the website's `dev` into `main` (a pull request, the owner's merge).
3. Check: the home and dashboard pages load signed in and signed out, the session cookie carries
   `Secure`, and the Connect page lists only ChatGPT (`LETTER_IRL_CONNECT_APPS` unset) until each
   other app passes its production gate.

## Stage B: the API

1. Between :10 and :40, merge `dev` into `master` (a pull request, the owner's merge).
2. Watch the API's and the maintenance service's deploy logs (either may run the migrations first;
   the other then finds nothing to apply): the pre-deploy applies `033` to `065` in one transaction, then the
   new build starts. If the API's pre-deploy fails, read the migration ledger first: the
   maintenance service's run may have applied them while the API's waited on the lock. If the
   ledger's newest row is `065`, they did: redeploy the API, and leave the maintenance service on
   the new build. Otherwise the old API build keeps serving and nothing was applied; fix the cause
   and redeploy, the maintenance service too. A service with its own migrating pre-deploy (the
   maintenance service, by `railway.toml`) stays on its old deployment when that run fails; one
   without (the admin service, or a maintenance service whose pre-deploy is not set) starts the new
   build against the old schema, so roll it back to its previous deployment until the run succeeds.
   If the run succeeds but the new build fails its health check (a variable the preflight cannot
   see, such as the OAuth scopes), the old build keeps serving on the new schema, which it
   tolerates. Fix the variable and redeploy; do not roll back the migrations. If the API's run
   succeeds and the maintenance service's fails, redeploy the maintenance service: the ledger is
   already at `065`.
3. Check:
   - `/readyz` answers 200 with the new `X-Build-Commit`;
   - the boot log shows `boot.thread_pool` with size 16;
   - the ledger's newest row is `065_letters_print_pdf.sql`;
   - one production sign-in with each method chosen in stage 0, through the website and through a
     connected app (the ChatGPT connector, with "Connect another account"), each sign-in page
     offering exactly the chosen methods; sign out on the website between methods, so a remembered
     session does not skip the sign-in page;
   - the maintenance and admin services are on the new build.
   Then move sign-in to the custom domain (owner; the tenant doc's "Moving a tenant to a custom domain", steps 3
   and 4): the production script's `--only api`; wait until the API's protected-resource metadata names
   `https://auth.letterirl.com/` and `/readyz` answers 200; then `--only website`. Repeat the sign-ins above,
   each sign-in page now on `auth.letterirl.com`, with that doc's checks: sign out of a session from before the
   switch, a new connector, and a connection made before it. `--rollback` undoes either step. Step 5, the
   manifest snapshot, is a PR to `dev` afterwards.
4. Re-run the admin provisioning for production **from a checkout at the promoted commit**, never
   from an older one: it applies the grants of the code it runs (`038`, `053` and `063` need it).
   The command is `npx tsx scripts/provisionAdminDatabaseAccess.ts --environment production
   --confirm-production-access --config <the production profile> --apply`
   ([admin-panel-guide.md](admin-panel-guide.md)).
   Then elevate on the production panel with an operator's own secret.
5. The first maintenance run on the new build: every task completes, and the refund sweep holds
   any `refund_pending` order whose refund already ended, with one alert each (#759).
6. Refresh the production connectors (ChatGPT, then each other app), and re-paste the app
   instructions in the OpenAI portal.
7. A canary: buy a Starter pack, send one real letter from the card and one from the confirmation
   page, and refund the pack only once both letters show as accepted by PostGrid (a full refund holds
   any letter still queued). Claiming a gift code waits for stage C: gift letters are still off.
8. Once it has settled (a day without a rollback), delete `ADMIN_TOTP_SECRET` from the admin
   service.

## Stage C: the decided switches

Stage C starts once stage B has settled (a day without a rollback). From its first switch, the old
build is no longer a rollback target (see "Rollback"). One change at a time, each with its check, in
this order:

- `LETTER_IRL_GIFT_LETTERS_ENABLED=true` (on at launch, after GIFT-01). Once the flag's redeploy is
  live (before it, every code answers that gifts are not available), load the website's `/g/` page
  with a made-up code: the not-found sentence must appear. If nothing appears, the
  browser cannot reach the API: check `LETTER_IRL_ALLOWED_ORIGINS` and the website's public API URL.
  Then buy a pack (packs
  grant gift letters only while the flag is on), send a gift letter, and claim its code when the
  printed card arrives, as GIFT-01 does.
- `STRIPE_CHECKOUT_DOMAIN`, then refresh the connector, then switch the domain on in Stripe
  ([stripe-custom-domain.md](stripe-custom-domain.md)).
- `CONTENT_RETENTION_MODE=enforce` (the old build is no longer a rollback target), then watch
  the first enforced run and check the quarantine the same day.
- The non-root image (`RAILWAY_DOCKERFILE_PATH=Dockerfile.api` on the API and maintenance, the API's
  start command cleared); the steps are in [deployment.md](deployment.md).
- `LETTER_IRL_CONNECT_APPS` on the website, one app at a time as each passes its production gate.

## Stage D: the renderer

`LETTER_IRL_PRINT_RENDERER=pdf`, after PRINT-02's sends pass. The old build cannot print this mail
(its floor is migration `039`, [deployment.md](deployment.md)); by this stage it is no longer a
rollback target.

## Code owed before stages E to G

**None for the launch cut.** What was owed on 2026-10-16 merged to `dev` before the freeze, so it is
in the head promoted at stage B: approved-PDF storage for held mail (#697: #789, #790), the
address-request retention cap and delete (#701 part 2: #788), the collage decode budget (#622:
#786), the arrive-by checkout fixes (#726: #787) and the certified mail follow-ups (#625: #803).
Their issues close when stage B lands. The home's fixes (#651, #665) are not all in, and the home is
off at launch.

A feature whose code is only on `dev` goes on after a later promotion of `dev` to `master`, run like
stage B (the merge window, the preflight from the promoted commit, provisioning when a change
grants, a connector refresh) without the stage B rollback, which no longer applies.

## Stage E: the studio features without a price

One per deploy, each after its test on DEV, then a connector refresh:

1. The card features, with no floor: the studio card, the envelope reveal (on the confirmation
   page too: website #77 is promoted in stage A), card upload once its group 2 step is done.
2. Postcard layouts and stationery (each prints a newer renderer version), then collages.
3. Signatures, once SIGNATURE-01's remaining steps pass (their privacy rows are published in
   stage A).

Not at launch (group 3): saved designs, the home, address requests and the separate words-editor
flag. Each comes back after the launch, with its privacy row where it needs one; the home with
#644 and #645.

## Stage F: arrive-by

`LETTER_IRL_ARRIVE_BY_ENABLED=true`, after #697 and #726 are in production, with the object
storage #697 needs configured on each service its docs name (the owner's step), after SCHEDULE-01 and ADMIN-CMD-04, once the operator alert and
heartbeat URLs are proven, and with its privacy row published. Then refresh the connectors: it adds
tools and an input.

## Stage G: the paid options

One per deploy, each after its live prices exist, its terms are published and its test has passed
on DEV: room to write (two and three pages), postcard sizes, certified mail (also its follow-ups from #625 in production, the website's part and a
provisioning re-run; its live letter follows, in the live checks below). All three are sold by Pay & Send, so
they need `JIT_PURCHASE_ENABLED=true`; room to write and the postcard sizes also need the renderer
(stage D). For each option, in this order:

1. Set its price ids on the API **and the maintenance service**: both validate them at start (each
   while it has `JIT_PURCHASE_ENABLED=true`), and a maintenance service with the flag but not the
   prices fails every hourly run. Done ahead for all six live prices on 2026-10-20; check they
   are still present.
2. Turn its flag on, on both services.
3. Re-run the preflight from the promoted commit: it asks for an option's prices only once that flag
   is set.
4. Confirm the next maintenance run completes, and refresh the connectors (the option adds an input
   or a tool).

## The flags

The last column is what each flag's mail needs of a rollback below the promoted commit, which only
stage B allows (see "Rollback").

| Flag | Service | Launch | Before turning on | Rollback |
| --- | --- | --- | --- | --- |
| `LETTER_IRL_SEND_CONFIRMATION_ENABLED` | API | `true` (required) | website stage A | cannot be off in production |
| `LETTER_IRL_GIFT_LETTERS_ENABLED` | API | on, stage C | GIFT-01; the website's `/g` page | queued gift letters still print their card |
| `LETTER_IRL_PRINT_RENDERER` | API | `pdf`, stage D | PRINT-02 sends | floor: migration `039` while rendered mail is live |
| `LETTER_IRL_ARRIVE_BY_ENABLED` | API | stage F | #697 and #726 in production, #697's object storage, SCHEDULE-01, ADMIN-CMD-04, its privacy row | held mail still goes out with it off |
| `LETTER_IRL_ROOM_TO_WRITE_ENABLED` | API, maintenance | stage G | its two prices, terms, PAGES-01 | under the renderer floor |
| `LETTER_IRL_POSTCARD_SIZES_ENABLED` | API, maintenance | stage G | its two prices, terms, POSTCARD-01 | not below #596's build while such postcards are live |
| `LETTER_IRL_CERTIFIED_MAIL_ENABLED` | API, maintenance | stage G (group 2; off before the submission if its live letter fails) | its prices, terms, CERTIFIED-01, provisioning; its live letter before the submission (PostGrid's written confirmation waived 2026-10-20) | certified letters must be sent before rolling back |
| `LETTER_IRL_STATIONERY_ENABLED`, `..._CUSTOM_STATIONERY_ENABLED` | API | stationery stage E; saved designs off at launch | STATIONERY-01; saved designs STATIONERY-02, with stationery on and their privacy row | `pdf-2` mail must be gone before rolling back |
| `LETTER_IRL_SIGNATURES_ENABLED` | API | stage E (group 2) | SIGNATURE-01, its privacy row | `pdf-4` mail |
| `LETTER_IRL_POSTCARD_LAYOUTS_ENABLED` | API | stage E | POSTCARD-01 | `pdf-3` postcards |
| `LETTER_IRL_ADDRESS_REQUESTS_ENABLED` | API | off at launch | ADDRESS-01, its privacy row; the website's `/address` page; `LETTER_IRL_ADDRESS_REQUEST_RETENTION_DAYS` on the maintenance service matching the row | the old build does not sweep requests |
| `LETTER_IRL_HOME_ENABLED`, `..._WORDS_EDITOR_ENABLED`, `..._POSTCARD_COLLAGES_ENABLED`, `..._CARD_UPLOAD_ENABLED`, `..._ENVELOPE_REVEAL_ENABLED`, `..._STUDIO_CARD_ENABLED` | API | stage E; the home and the words-editor flag off at launch, card upload group 2 | each one's DEV test: HOME-01 to HOME-04, the words editor alone in STUDIO-01 step 3 and with room to write in PAGES-01, COLLAGE-01, CLIENT-01's upload steps, ENVELOPE-01, STUDIO-01; the home after #651 (`LETTER_IRL_CHATGPT_PLUGIN_ID` only once the production plugin exists and HOME-03 passes) | none |
| `LETTER_IRL_IMAGE_GEN_MODE` | API | `off` | check the current value first | meaning differs between builds |
| `CONTENT_RETENTION_MODE` | maintenance | `report`, then `enforce` in stage C | the rule below | never `enforce` while the old build is a rollback target |
| `LETTER_IRL_OUTBOX_DISPATCH_ENABLED` | API, maintenance | `true` | | `false` pauses the printer queue (new build only) |

## Migrations

All of `033` to `065` apply in one transaction, with a 60-second lock timeout. None breaks the old
build while it serves during the deploy; the columns, tables and check lists only widen. What to
know:

- **All or nothing.** A failure rolls every one back, and the old build keeps serving. A redeploy
  retries.
- **`058` can fail on data:** two addresses differing only in case stop it. The read-only check
  above finds them; join or correct those accounts first.
- **Locks.** The run takes exclusive locks on the main tables until it commits, a few seconds on
  today's sizes. That is why it goes in the merge window, after checking for long transactions.
- **Two data changes are not undone by a rollback:** `034` ends the zero-letter promo campaigns, and
  `057` gives every personal access token without an expiry one (at least 30 days ahead). Keep the
  snapshots.
- **Provisioning** is re-run once after the run (stage B, step 4).
- **A rollback never removes a migration:** the old build's migrator ignores the newer ledger rows.

## Rollback

**The old build is a rollback target only during stage B.** `master`'s previous build (September,
migration `032`) knows nothing the launch version makes: gift cards, mail held for its funding or
for a blocked account, refunds held for a person, renderer versions, certified mail. It also ignores
`LETTER_IRL_OUTBOX_DISPATCH_ENABLED` and has no send rule. Every switch from stage C on makes more
mail it would mishandle, so:

- **During stage B, until stage C's first switch,** a broken new build may be rolled back to the old
  one:
  1. Roll back the API **and the maintenance service together**, with Railway's Rollback (it restores
     the previous image and its variables, rather than building the old commit again). The
     maintenance run is what dispatches the queue. The admin service stays on the new build: it reads
     the `065` schema and holds the commands below.
  2. Do it between maintenance runs, and only when this read-only count, run as the owner role
     (the admin roles cannot read `letters.content`), is 0 in every column; run it again right
     before:

     ```sql
     SELECT count(*) FILTER (WHERE j.hold_reason IN ('funding_reversed', 'funding_disputed')) AS funding_held,
            count(*) FILTER (WHERE u.sends_blocked_reason IS NOT NULL) AS blocked_account,
            count(*) FILTER (WHERE l.content ? 'giftCard') AS gift_card
       FROM letter_jobs j JOIN letters l ON l.letter_id = j.letter_id JOIN users u ON u.user_id = l.user_id
      WHERE j.status IN ('pending', 'processing') AND j.provider_outcome = 'not_dispatched';
     SELECT count(*) AS refunds_held FROM orders WHERE last_error_code = 'REFUND_NOT_COMPLETED';
     SELECT count(*) AS pack_refunds_open FROM commerce_pack_refunds WHERE status = 'letters_revoked';
     ```

     Decide each on its own merits, never to make a rollback possible: a held letter is released
     (`job.dispatch_now`) or cancelled (`job.cancel_held`; a Pay & Send letter of a blocked account
     by refunding its order), a block lifted (`account.unblock_sends`, refused while a dispute
     stands), a held refund settled as [deployment.md](deployment.md) says (a new Stripe refund, no
     panel command), and an open pack refund left to the new maintenance run to finish. **If a
     column cannot honestly reach 0, do not roll back:** fix forward.
  3. After it: the website stays on its new version, and its confirmation, gift and address pages
     fail until the API is promoted again; refresh the connectors, which still list the new tools.
     The old build has no send rule, so the model can call the send tools itself and every
     personal access token can send; set `LETTER_IRL_MAIL_SENDING_ENABLED=false` on the old API if
     sending must stop meanwhile, and check `/readyz`'s `X-Build-Commit` afterwards, since a
     variable change redeploys.
- **From stage C on, never roll back to the old build.** To undo a switch, change that one
  variable back, with these exceptions. `STRIPE_CHECKOUT_DOMAIN`: once Stripe serves the domain, undo
  it in Stripe first ([stripe-custom-domain.md](stripe-custom-domain.md), "Removing it"), and the
  variable stays. And two switches with side effects: turning gift letters off means printed gift
  codes answer that gifts are not available until it is back on; turning the renderer off stops
  every feature that needs it, so turn off the feature at fault instead. A code regression is fixed forward, or rolled back to an earlier launch-version
  deployment with Railway's Rollback, which also restores **that deployment's variables**: compare
  them with the current ones first, and never roll the API back across `STRIPE_CHECKOUT_DOMAIN` once
  Stripe serves the domain (every new checkout would be refused), nor across a feature switch whose
  mail or links are live. The floors in [deployment.md](deployment.md) and the flag table are met by
  any deployment at or after the promoted commit; a later commit that adds a migration or a
  renderer version brings its own.
- **The website:** before stage B, roll it back with Railway's Rollback if it breaks. From stage B on
  it stays on the new version (the API's send rule needs its confirmation page): fix forward.
- **To stop something, switch it off.** `LETTER_IRL_OUTBOX_DISPATCH_ENABLED=false` on the API and the
  maintenance service pauses all mail on any launch-version build; each feature's flag stops new mail
  of its kind.
- **`CONTENT_RETENTION_MODE=enforce` only from stage C,** once the old build is no longer a target:
  its enforce path has known defects.
- **The admin panel:** `ADMIN_TOTP_SECRET` stays until stage B has settled, because the old panel
  needs it.

## Before the submission: the live checks

After stage G and before the ChatGPT submission, with every group 1 flag on in production, and
each group 2 flag whose step passed: mail one real piece of each kind and check it on arrival. That means a 2-page and a
3-page letter (double-sided show-through), a 4x6 and an 11x6 postcard (postage), a letter with
stationery and a signature (the signature only if signatures are on), a collage, and a certified letter with a return receipt (the markings,
where the receipt goes). Certified mail whose live letter fails is switched off before the submission;
for any other feature whose piece fails, switching it off is the owner's call. Whatever is off at
the submission is off in the launch golden too (re-record it), and out of
[openai-test-cases.md](app-submission/openai-test-cases.md): its line in the app description, its
launch feature case, and the count and list under Tool Annotations Verification. So the tool set
and the materials OpenAI reviews are the ones that work.

## After the promotion

- Close the issues that waited for production.
- Move the pre-deploy command off `railway.toml` before 2026-12-01 (#703).
- Record the Auth0 check results, and the date, in [auth0-tenant-configuration.md](auth0-tenant-configuration.md).
- Update [status.md](status.md).
