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
| API (`mail-letter-irl`) | `master` at `27e160a` (#416, 2026-09-16) | `dev` | 248 pull requests (#336, #415 to #782), migrations `033` to `064` |
| Website (`mail-letter-irl-website`) | `main` at `bc81767` (2026-09-16) | `dev` | 31 commits (#31 to #72) |

[status.md](status.md) summarises what the launch version adds.

## The order, and why

1. **Stage 0, preparation** (days before): decisions, DEV tests, the production Auth0 tenant,
   production variables set ahead, read-only checks.
2. **Stage A, the website** (`dev` to `main`).
3. **Stage B, the API** (`dev` to `master`), in the merge window, the same day as stage A.
4. **Stage C, the decided switches,** one change at a time.
5. **Stage D, the renderer:** the first switch with a rollback floor.
6. **Stage E, arrive-by.**
7. **Stage F, the paid options,** one per deploy.

**The website goes first.** The API no longer boots in production without the send rule
(`LETTER_IRL_SEND_CONFIRMATION_ENABLED=true`, #731), and the send rule sends people to the
website's confirmation page (`/confirm/<draft>`), which exists only on the website's `dev`. The older
order, "API dark, then the website", is obsolete for that reason. The website's new pages answer
nothing useful until the API is promoted (the gift, address and confirmation pages call new API
routes), so keep the gap between stages A and B short. Nothing links to those pages before stage B.

**The merge window is :10 to :50 past the hour.** The API's pre-deploy runs every pending migration
in one transaction, and the hourly maintenance run must not overlap it (see "Migrations").

## Stage 0: preparation

### Decisions (owner)

- Confirm or override D1 to D8 on #680.
- The scheduled-mail privacy row (D6, #701).
- Arrive-by at launch: D1 says on, but approved-PDF storage (#697) is open and SCHEDULE-01 has not
  run, so it launches dark unless both close first (stage E).
- `CONTENT_RETENTION_MODE`: `report` through the promotion, `enforce` in stage C (see the rule under
  "Rollback").
- Whether production moves to the non-root image (`Dockerfile.api`, #772) in stage C or later.
- Sign-in methods for production (Microsoft, the social OAuth apps) and the app list within Auth0's
  application limit.

### Manual tests on DEV (owner, with an agent driving)

Owed before stage A, on DEV at the head being promoted:

- **SEND-01:** a send from the card and from the confirmation page. It last passed 2026-09-26,
  before the content-version changes (#695).
- **The words changed after the card was shown (#723):** change the letter in the chat, then press
  Send on the old card; it must refuse.
- **PRINT-02's sends** (its previews passed), before stage D.
- **REFUND-01.**
- **A card smoke test:** ChatGPT web, desktop, Android and iOS; Claude web, desktop and Android;
  VS Code.
- **GIFT-01** steps 4 and 8: a paper reprint and an iPhone scan.
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
2. The `Account Linking (production)` machine-to-machine application, with exactly `read:users` and
   `update:users` on the Management API.
3. The row-holder check the tenant doc describes, then the two Post Login Actions from
   [`docs/auth0/actions/`](auth0/actions/): the linking Action above the email-claim Action.
4. The consent setting (`use_scope_descriptions_for_consent`, #267).
5. The ChatGPT client's refresh-token settings (they are not inherited from development).
6. The applications: remove legacy entries within the tenant's application limit, then import the
   apps chosen for launch. OpenClaw's client document is served by the production website, so it is
   imported after stage A.
7. Run `scripts/check-auth0-tenant.ts` on both tenants and record the result in the tenant doc.

### Production variables set ahead (owner, or an agent with approval)

The current production code ignores every variable below except `CONTENT_RETENTION_MODE`, so they
can be set before the merge; a variable change redeploys the current build, which is harmless.
Names only; values come from the owner's records.

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
- Run `npm run preflight:cutover -- --env production` and close its gaps
  ([deployment.md](deployment.md)).
- Keep `ADMIN_TOTP_SECRET` on the admin service: the current release needs it, and so does a
  rollback.

### Read-only database checks (owner, or an agent with read access)

Run on the production branch, with the role the API's `DATABASE_URL` uses, the day of the
promotion. Each query only reads.

```sql
-- The ledger: expect 032_error_text_minimisation.sql as the newest, and no row after it.
SELECT count(*) AS applied, max(name) AS newest FROM migrations;
SELECT name FROM migrations WHERE name > '032_error_text_minimisation.sql' ORDER BY name;

-- The server: 054 needs PostgreSQL 15 or later; 058 folds case by the database's locale.
SELECT current_setting('server_version_num')::int AS server_version_num, current_user;
SELECT datname, datlocprovider, datcollate, datctype FROM pg_database WHERE datname = current_database();

-- Constraints 033 and 058 drop without IF EXISTS: expect three rows.
SELECT conrelid::regclass AS tbl, conname FROM pg_constraint
 WHERE conname IN ('valid_letter_funding', 'valid_letter_funding_order', 'users_email_key') ORDER BY 1, 2;

-- 058: addresses that differ only in case stop the whole run. Expect 0 groups.
SELECT count(*) AS collision_groups FROM (
  SELECT 1 FROM users GROUP BY lower(email) HAVING count(*) > 1) g;

-- Ownership: every table must belong to the DATABASE_URL role (062 and 064 need it for the purges).
SELECT c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
 WHERE c.relkind = 'r' AND c.relname IN ('users', 'letters', 'letter_drafts', 'letter_jobs',
   'personal_access_tokens', 'promo_campaigns', 'promo_redemptions', 'commerce_operational_alerts',
   'commerce_operator_audit_events', 'admin_audit_events', 'admin_command_runs', 'admin_operations')
 ORDER BY 1;

-- Snapshots of the two data changes (keep the output): 034 ends these campaigns,
-- 057 gives these tokens an expiry.
SELECT campaign_id, code, status, credits_amount FROM promo_campaigns
 WHERE credits_amount = 0 AND status <> 'ended';
SELECT token_id, status, created_at FROM personal_access_tokens WHERE expires_at IS NULL ORDER BY token_id;

-- 055's input: expect 0.
SELECT count(*) AS jobs_with_held_until FROM letter_jobs WHERE metadata ? 'heldUntil';

-- Right before merging: transactions open longer than five seconds would hold up the run.
SELECT pid, state, now() - xact_start AS age, left(query, 60) AS query FROM pg_stat_activity
 WHERE datname = current_database() AND xact_start IS NOT NULL AND now() - xact_start > INTERVAL '5 seconds';
```

## Stage A: the website

1. Merge the website's `dev` into `main` (a pull request, the owner's merge).
2. Check: the home and dashboard pages load signed in and signed out, the session cookie carries
   `Secure`, and the Connect page lists only ChatGPT (`LETTER_IRL_CONNECT_APPS` unset) until each
   other app passes its production gate.

## Stage B: the API

1. In the merge window (:10 to :50), merge `dev` into `master` (a pull request, the owner's merge).
2. Watch the API's deploy log: the pre-deploy applies `033` to `064` in one transaction, then the
   new build starts. If the pre-deploy fails, the old build keeps serving and nothing was applied;
   fix the cause and redeploy.
3. Check:
   - `/readyz` answers 200 with the new `X-Build-Commit`;
   - the boot log shows `boot.thread_pool` with size 16;
   - the ledger's newest row is `064_admin_command_retention.sql`;
   - the maintenance and admin services are on the new build.
4. Re-run the admin provisioning for production **from a checkout at the promoted commit**, never
   from an older one: it applies the grants of the code it runs (`038`, `053` and `063` need it).
   Then elevate on the production panel with an operator's own secret.
5. The first maintenance run on the new build: every task completes, and the refund sweep holds
   any `refund_pending` order whose refund already ended, with one alert each (#759).
6. Refresh the production connectors (ChatGPT, then each other app), and re-paste the app
   instructions in the OpenAI portal.
7. A canary: buy a Starter pack, send one real letter from the card and one from the confirmation
   page, claim a gift code, refund the pack.
8. Once it has settled (a day without a rollback), delete `ADMIN_TOTP_SECRET` from the admin
   service.

## Stage C: the decided switches

One change at a time, each with its check, in this order:

- `LETTER_IRL_GIFT_LETTERS_ENABLED=true` (on at launch, after GIFT-01).
- `STRIPE_CHECKOUT_DOMAIN`, then refresh the connector, then switch the domain on in Stripe
  ([stripe-custom-domain.md](stripe-custom-domain.md)).
- `CONTENT_RETENTION_MODE=enforce`, only once a rollback to the old build is ruled out, then watch
  the first enforced run and check the quarantine the same day.
- The non-root image (`RAILWAY_DOCKERFILE_PATH=Dockerfile.api` on the API and maintenance, the API's
  start command cleared), if decided; the steps are in [deployment.md](deployment.md).
- `LETTER_IRL_CONNECT_APPS` on the website, one app at a time as each passes its production gate.

## Stage D: the renderer

`LETTER_IRL_PRINT_RENDERER=pdf`, after PRINT-02's sends pass. From here the rollback floor is
migration `039`: never roll back below it while a queued or held letter, or an unexpired draft,
carries a renderer version ([deployment.md](deployment.md)).

## Stage E: arrive-by

`LETTER_IRL_ARRIVE_BY_ENABLED=true`, after #697 and SCHEDULE-01, and once the operator alert and
heartbeat URLs are proven.

## Stage F: the paid options

One per deploy, each after its live prices exist and its test has passed on DEV: room to write
(two and three pages), postcard sizes, certified mail (also the website's part and a provisioning
re-run). Stationery, saved designs, signatures, the words editor, postcard layouts and collages,
address requests, the home, card upload, the envelope reveal and the studio card stay unset until
their owner's word.

## The flags

| Flag | Service | Launch | Before turning on | Rollback |
| --- | --- | --- | --- | --- |
| `LETTER_IRL_SEND_CONFIRMATION_ENABLED` | API | `true` (required) | website stage A | cannot be off in production |
| `LETTER_IRL_GIFT_LETTERS_ENABLED` | API | on, stage C | GIFT-01; the website's `/g` page | queued gift letters still print their card |
| `LETTER_IRL_PRINT_RENDERER` | API | `pdf`, stage D | PRINT-02 sends | floor: migration `039` while rendered mail is live |
| `LETTER_IRL_ARRIVE_BY_ENABLED` | API | stage E | #697, SCHEDULE-01 | held mail still goes out with it off |
| `LETTER_IRL_ROOM_TO_WRITE_ENABLED` | API, maintenance | stage F | its two prices | under the renderer floor |
| `LETTER_IRL_POSTCARD_SIZES_ENABLED` | API, maintenance | stage F | its two prices | not below #596's build while such postcards are live |
| `LETTER_IRL_CERTIFIED_MAIL_ENABLED` | API, maintenance | stage F | its prices, the website's part, provisioning | pause the outbox before rolling back while certified letters wait |
| `LETTER_IRL_STATIONERY_ENABLED`, `..._CUSTOM_STATIONERY_ENABLED` | API | unset | the owner's word | `pdf-2` mail must be gone before rolling back |
| `LETTER_IRL_SIGNATURES_ENABLED` | API | unset | the owner's word, the policy wording | `pdf-4` mail |
| `LETTER_IRL_POSTCARD_LAYOUTS_ENABLED` | API | unset | the owner's word | `pdf-3` postcards |
| `LETTER_IRL_ADDRESS_REQUESTS_ENABLED` | API | unset | retention wording; the website's `/address` page | the old build does not sweep requests |
| `LETTER_IRL_HOME_ENABLED`, `..._WORDS_EDITOR_ENABLED`, `..._POSTCARD_COLLAGES_ENABLED`, `..._CARD_UPLOAD_ENABLED`, `..._ENVELOPE_REVEAL_ENABLED`, `..._STUDIO_CARD_ENABLED` | API | unset | the owner's word | none |
| `LETTER_IRL_IMAGE_GEN_MODE` | API | `off` | check the current value first | meaning differs between builds |
| `CONTENT_RETENTION_MODE` | maintenance | `report`, then `enforce` in stage C | the rule below | never `enforce` while a rollback is possible |
| `LETTER_IRL_OUTBOX_DISPATCH_ENABLED` | API, maintenance | `true` | | `false` pauses the printer queue (new build only) |

## Migrations

All of `033` to `064` apply in one transaction, with a 60-second lock timeout. None breaks the old
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

- **Before stage D,** rolling back the API means redeploying `master`'s previous build. The schema
  stays at `064`, which the old build tolerates. Tokens could send again (the old build ignores
  token scopes), and gift letters would not be handled, so keep gift letters off if a rollback is
  likely.
- **Pause before rolling back below a floor:** set `LETTER_IRL_OUTBOX_DISPATCH_ENABLED=false` on the
  API and maintenance while the new build still runs, so nothing is sent by a build that cannot
  print it.
- **Never leave `CONTENT_RETENTION_MODE=enforce` set while a rollback to the old build is
  possible:** the old build's enforce path has known defects.
- **The admin panel:** `ADMIN_TOTP_SECRET` stays until the promotion has settled, because the old
  panel needs it.

## After the promotion

- Close the issues that waited for production.
- Move the pre-deploy command off `railway.toml` before 2026-12-01 (#703).
- Record the Auth0 check results, and the date, in [auth0-tenant-configuration.md](auth0-tenant-configuration.md).
- Update [status.md](status.md).
