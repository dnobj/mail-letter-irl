# Launch Promotion Plan

**Last Updated:** October 16, 2026

The plan for promoting the launch version to production (#702, part of #680; tracker #158). It says
what is pending, in what order it goes, what each system needs and when, how to check each stage,
and how far back each stage can be rolled. Steps that need credentials or a dashboard are the
owner's; everything else can be driven by an agent with the owner's approval at each change.

Revalidate before acting: numbers below are as of `dev` at `3db2f57` (2026-10-16).

## What is pending

| Repository | Production | Development | Pending |
| --- | --- | --- | --- |
| API (`mail-letter-irl`) | `master` at `27e160a` (#416, 2026-09-16) | `dev` | 248 pull requests (#336, #415 to #782), migrations `033` to `065` |
| Website (`mail-letter-irl-website`) | `main` at `bc81767` (2026-09-16) | `dev` | 31 commits (#31 to #72) |

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

Taken on 2026-10-16 (recorded on #680):

- **The launch set is everything** (D1 widened): every studio feature goes on at launch, each after
  its test passes on DEV and its prerequisites below, in stages C to G. Any can be switched off
  afterwards. The ChatGPT submission describes the whole set (41 tools), so it is submitted after
  the set is fixed.
- D2 to D8 as written on #680. The scheduled-mail privacy row (D6, #701) is approved; it is
  published with arrive-by.
- `CONTENT_RETENTION_MODE`: `report` through the promotion, `enforce` in stage C (see "Rollback").
- The non-root image (`Dockerfile.api`, #772) in stage C, as its own change.
- Sign-in methods: what has passed on DEV (Google, GitHub, email and password; Microsoft only after
  LINK-02 with it), with our own OAuth applications.

Still the owner's, before the stage that needs it: the option prices (#578) and their terms (#579),
PostGrid's confirmation of certified mail, the privacy rows for signatures, saved designs and
address requests, and the home's sharing (#651).

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

[manual-tests.md](manual-tests.md) has each test.

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
  Check the production value, and set the one the launch wants (`off`, 24 tools).
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

1. Merge the website's `dev` into `main` (a pull request, the owner's merge).
2. Check: the home and dashboard pages load signed in and signed out, the session cookie carries
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

Several features still need code that is not in the head promoted at stage B (#680, 2026-10-16):
approved-PDF storage for held mail (#697), the address-request retention cap and delete (#701 part
2), the collage decode budget (#622), the arrive-by checkout fixes (#726), the certified mail
follow-ups (#625), and the home's fixes (#651, #665). A feature goes on only once its code is **in
production**, not only on `dev`: each needs a later promotion of `dev` to `master`, run like stage
B (the merge window, the preflight from the promoted commit, provisioning when a change grants, a
connector refresh) without the stage B rollback, which no longer applies.

## Stage E: the studio features without a price

One per deploy, each after its test on DEV and once its owed code is in production, then a
connector refresh:

1. The card features, with no floor: the studio card, the envelope reveal, the
   words editor, card upload.
2. Postcard layouts and stationery (each prints a newer renderer version), then collages.
3. Saved designs and signatures, once their privacy rows are published on both privacy pages.
4. The home, after the owner's call on what it shares (#651).
5. Address requests, once their privacy row is published.

## Stage F: arrive-by

`LETTER_IRL_ARRIVE_BY_ENABLED=true`, after #697 and #726 are in production, with the object
storage #697 needs configured on each service its docs name (the owner's step), after SCHEDULE-01 and ADMIN-CMD-04, once the operator alert and
heartbeat URLs are proven, and with its privacy row published. Then refresh the connectors: it adds
tools and an input.

## Stage G: the paid options

One per deploy, each after its live prices exist, its terms are published and its test has passed
on DEV: room to write (two and three pages), postcard sizes, certified mail (also PostGrid's
confirmation, its follow-ups from #625 in production, the website's part and a provisioning
re-run). All three are sold by Pay & Send, so
they need `JIT_PURCHASE_ENABLED=true`; room to write and the postcard sizes also need the renderer
(stage D). For each option, in this order:

1. Set its price ids on the API **and the maintenance service**: both validate them at start (each
   while it has `JIT_PURCHASE_ENABLED=true`), and a maintenance service with the flag but not the
   prices fails every hourly run.
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
| `LETTER_IRL_CERTIFIED_MAIL_ENABLED` | API, maintenance | stage G | its prices, terms, PostGrid's confirmation, CERTIFIED-01, provisioning | certified letters must be sent before rolling back |
| `LETTER_IRL_STATIONERY_ENABLED`, `..._CUSTOM_STATIONERY_ENABLED` | API | stage E | STATIONERY-01; saved designs STATIONERY-02, with stationery on and their privacy row | `pdf-2` mail must be gone before rolling back |
| `LETTER_IRL_SIGNATURES_ENABLED` | API | stage E | SIGNATURE-01, its privacy row | `pdf-4` mail |
| `LETTER_IRL_POSTCARD_LAYOUTS_ENABLED` | API | stage E | POSTCARD-01 | `pdf-3` postcards |
| `LETTER_IRL_ADDRESS_REQUESTS_ENABLED` | API | stage E | ADDRESS-01, its privacy row; the website's `/address` page; `LETTER_IRL_ADDRESS_REQUEST_RETENTION_DAYS` on the maintenance service matching the row | the old build does not sweep requests |
| `LETTER_IRL_HOME_ENABLED`, `..._WORDS_EDITOR_ENABLED`, `..._POSTCARD_COLLAGES_ENABLED`, `..._CARD_UPLOAD_ENABLED`, `..._ENVELOPE_REVEAL_ENABLED`, `..._STUDIO_CARD_ENABLED` | API | stage E | each one's DEV test: HOME-01 to HOME-04, the words editor alone in STUDIO-01 step 3 and with room to write in PAGES-01, COLLAGE-01, CLIENT-01's upload steps, ENVELOPE-01, STUDIO-01; the home after #651 (`LETTER_IRL_CHATGPT_PLUGIN_ID` only once the production plugin exists and HOME-03 passes) | none |
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

## After the promotion

- Close the issues that waited for production.
- Move the pre-deploy command off `railway.toml` before 2026-12-01 (#703).
- Record the Auth0 check results, and the date, in [auth0-tenant-configuration.md](auth0-tenant-configuration.md).
- Update [status.md](status.md).
