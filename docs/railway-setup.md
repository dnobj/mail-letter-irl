# Railway Setup Guide

**Last Updated:** September 23, 2026
**Purpose:** Exact Railway services, commands, branches, variables, and Serverless policy

Letter IRL uses one Railway project with `production` and `development` environments. Environment isolation is achieved with per-environment variables and branch deployment settings, not separate Railway projects.

## Service Matrix

| Service | Source | Production branch | Development branch | Runtime |
| --- | --- | --- | --- | --- |
| `letter-irl-api` | backend repo | `master` | `dev` | HTTP API/MCP |
| `mail-letter-irl-website` | website repo | `main` | `dev` | Next standalone server |
| `letter-irl-maintenance` / `letter-irl-maintenance-dev` | backend repo | `master` (`letter-irl-maintenance`) | `dev` (`-dev`) | hourly cron |
| `letter-irl-images` | Railway bucket | environment-owned | environment-owned | private S3-compatible storage |
| `letter-irl-admin` / `letter-irl-admin-prod` | backend repo, `Dockerfile.admin` | `master` (`-prod`) | `dev` | tailnet-only admin panel, no public domain |

Production API and website remain warm. Development API and website use Railway Serverless. The cron service is scheduled, not continuously running. The admin services are configured in the dashboard, not by config-as-code; their variables and settings are in [admin-panel-guide.md](admin-panel-guide.md).

## API Settings

**Do not set the build, start or pre-deploy commands in the dashboard.** They are
committed: `nixpacks.toml` holds build and start, `railway.toml` holds the
pre-deploy command, and Railway's config-as-code overrides dashboard values. The
block below records what those files produce so this guide can be checked against
them; it is not a list of things to type in. Railway stops reading these files on
2026-12-01 (config-as-code is deprecated); see the deadline note in
[deployment.md](deployment.md).

Healthcheck path and region are dashboard settings and do have to be set here.


```text
Build command: npm run build
Pre-deploy command: npm run db:migrate:prod
Start command: npm start
Healthcheck path: /healthz
Production region: US East
Development region: US West (current; review separately before changing)
```

Important API variables:

```env
NODE_ENV=production
LETTER_IRL_DEPLOYMENT_ENVIRONMENT=<development or production - REQUIRED on API and maintenance>
DATABASE_URL=<environment-specific Neon pooled URL>
TEMP_IMAGE_STORE=bucket
TEMP_IMAGE_BUCKET_NAME=<reference to bucket name>
TEMP_IMAGE_BUCKET_ENDPOINT=<reference to S3 endpoint>
TEMP_IMAGE_BUCKET_REGION=<reference to S3 region>
TEMP_IMAGE_BUCKET_ACCESS_KEY_ID=<reference to bucket access key>
TEMP_IMAGE_BUCKET_SECRET_ACCESS_KEY=<reference to bucket secret>
LETTER_IRL_ALLOWED_HOSTS=<comma-separated public hostnames>
LETTER_IRL_ALLOWED_ORIGINS=<comma-separated allowed origins>
```

`LETTER_IRL_ALLOWED_HOSTS` and `LETTER_IRL_ALLOWED_ORIGINS` are **hard
production refusals** (`http.allowed_hosts_required`,
`http.allowed_origins_required`). Their fallbacks allowlist localhost, which
would leave DNS-rebinding protection open, so the validator refuses rather than
defaulting. Provisioning a production API without them yields a boot failure.

`NODE_ENV=production` is set in **both** environments (bucket enforcement
needs it), so it cannot identify the environment. It does **not** carry Neon
TLS: node-postgres merges the parsed connection string *over* the `ssl` option,
so a URL with `?sslmode=require` decides the posture on its own and one without
`sslmode` is refused in production whatever `NODE_ENV` says. See
`src/db/index.ts:32-37` and the `database.tls_*` rules in `docs/deployment.md`.
`LETTER_IRL_DEPLOYMENT_ENVIRONMENT` is the identity signal the boot validator
(issue #155) resolves; an unlabeled service resolves to production mode,
fail-closed, and **refuses to boot regardless of its other variables** — the
missing label is itself a fatal validation error.

Purchase and fulfillment variables the validator requires in production (and
warns about in development):

```env
LETTER_PROVIDER=postgrid
LETTER_PROVIDER_API_KEY=<live PostGrid key in production; test key in development>
LETTER_PROVIDER_CONFIG={"mode":"live"}
STRIPE_SECRET_KEY=<sk_live_ in production; sk_test_ in development - never crossed>
STRIPE_WEBHOOK_SECRET=<whsec_ for that environment's webhook endpoint>
STRIPE_PRICE_STARTER=<price_ id>
LETTER_IRL_MAIL_SENDING_ENABLED=<true to allow sending; refuses new sends when false>
# The outbox switch (#444): false pauses everything going to the printer, queued mail included.
# Set it on the API AND the maintenance service. Unset or blank means on; write false to pause.
LETTER_IRL_OUTBOX_DISPATCH_ENABLED=<true; false pauses the outbox>
# The send rule (#470, docs/letter-send-flow.md): only the person finishes a send, from our card or
# the website's confirmation page. Off unless explicitly true. API service only.
LETTER_IRL_SEND_CONFIRMATION_ENABLED=<true once the confirmation page is live>
# The website's own Auth0 application's Client ID: the only token that may confirm a send.
LETTER_IRL_WEBSITE_CLIENT_ID=<the website application's Client ID in this tenant>
# Where the confirmation link points. Defaults to LETTER_IRL_GIFT_LANDING_BASE_URL.
LETTER_IRL_WEBSITE_BASE_URL=<https://letterirl.com, or the development website's address>
LETTER_IRL_BETA_GATE_ENABLED=<true to restrict access to the invited cohort>
LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING=<global letters per day>
LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP=<letters per account per day>
# At least the dearest pack's price (the Power Pack, 9000): the default, 6000, is below it,
# so no account could buy that pack (2026-09-28).
LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS=<spend per account per day, in cents; default 6000>
# The four daily limits can also be set, for everyone or one account, in the admin panel's Limits page
# (migration 038), with no redeploy; these variables are the values in force when none is set there.
# Where the operator is told a daily limit refused someone: an https URL that takes a plain-text POST,
# such as a healthchecks.io check's /fail URL. A capability: treat it as a secret. API service only.
LETTER_IRL_OPERATOR_ALERT_URL=<https URL, or unset for the admin panel's alert alone>
# Gift letters (docs/gift-letters.md): off unless explicitly true. API service only.
LETTER_IRL_GIFT_LETTERS_ENABLED=<true to turn the programme on; unset keeps it off>
LETTER_IRL_GIFT_DAILY_SEND_CAP=<gift sends per UTC day, all accounts; default 20; 0 stops them>
LETTER_IRL_GIFT_LANDING_BASE_URL=<the website the printed QR opens; default https://letterirl.com>
# Letter previews drawn by our own renderer, printed from our PDF (#534, docs/letter-send-flow.md).
# Read at preview time only; a letter prints with the version its draft recorded. API service only.
LETTER_IRL_PRINT_RENDERER=<pdf to turn it on; unset keeps the legacy HTML>
LETTER_IRL_ARRIVE_BY_ENABLED=<true to offer arrival dates on previews (#535); unset is off>
# Stationery on the three letter previews (#563): offered only while LETTER_IRL_PRINT_RENDERER is pdf.
LETTER_IRL_STATIONERY_ENABLED=<true to offer themes on letter previews; unset is off>
# Postcard layouts (#594, docs/letter-send-flow.md): a border with a caption, or "Greetings from" a place,
# offered only while LETTER_IRL_PRINT_RENDERER is pdf. API service only: the print draws a stored front whatever the flag.
LETTER_IRL_POSTCARD_LAYOUTS_ENABLED=<true to offer postcard layouts on postcard previews; unset is off>
# Postcard collages (#616, docs/image-support.md): two to four photos drawn as one front. API service only. It needs neither
# our renderer nor Pay & Send: the print draws the stored picture whatever the flag.
LETTER_IRL_POSTCARD_COLLAGES_ENABLED=<true to offer collages of two to four photos on postcard previews; unset is off>
# Address requests (#604, docs/tool-apis.md): a private link asking someone for their address. API service only.
# The link lives on LETTER_IRL_WEBSITE_BASE_URL. Its days and the caps per account have defaults (7; 10 waiting, 20 a day).
LETTER_IRL_ADDRESS_REQUESTS_ENABLED=<true to list request_address, get_address_request and cancel_address_request; unset is off>
LETTER_IRL_ADDRESS_REQUEST_LINK_DAYS=<days a link works, 1 to 30; default 7>
LETTER_IRL_ADDRESS_REQUEST_WAITING_CAP=<requests an account may have waiting, 1 to 100; default 10>
LETTER_IRL_ADDRESS_REQUEST_DAILY_CAP=<requests an account may make in 24 hours, 1 to 500; default 20>
# Maintenance service: how long a closed address request, and any address given, is kept (#604; the owner's value).
LETTER_IRL_ADDRESS_REQUEST_RETENTION_DAYS=<days after it closes, or after its link expires unanswered, 1 to 365; default 7>
# Signatures (#608, docs/tool-apis.md#signatures): a saved picture of the person's signature, and /api/signature for the
# website. Offered only while LETTER_IRL_PRINT_RENDERER is pdf. API service only; production waits for the owner.
LETTER_IRL_SIGNATURES_ENABLED=<true to list set_signature, get_signature, clear_signature and set_letter_signature; unset is off>
# The letter card's envelope reveal (#576, docs/ui-widgets.md): cards only, nothing prints differently.
LETTER_IRL_ENVELOPE_REVEAL_ENABLED=<true to open previews from an envelope; unset is off>
# The studio card (#580, docs/ui-widgets.md): the letter card laid out with Style, Words and Delivery tabs. Cards only.
LETTER_IRL_STUDIO_CARD_ENABLED=<true to lay letter cards out as a studio; unset is off>
# The mail options (#578, docs/pricing-and-credits.md): each flag sells its options through Pay & Send,
# at their own prices, and needs their Stripe Prices below. API and maintenance services.
LETTER_IRL_ROOM_TO_WRITE_ENABLED=<true to preview and sell two- and three-page letters; unset is off>
LETTER_IRL_POSTCARD_SIZES_ENABLED=<true to preview and sell 4x6 and 11x6 postcards, with LETTER_IRL_PRINT_RENDERER=pdf; unset is off>
LETTER_IRL_CERTIFIED_MAIL_ENABLED=<true to sell certified mail letters through Pay & Send (#625), which needs their two prices below; unset is off>
LETTER_IRL_SCHEDULE_LEAD_DAYS=<business days from the mail date to the arrival date; default 7, production refuses less than 3>
LETTER_IRL_SCHEDULE_HORIZON_DAYS=<calendar days ahead an arrival date may be; default 60>
# Photo upload through the card in apps with no file store (#474, docs/deployment.md): off unless
# explicitly true. API service only.
LETTER_IRL_CARD_UPLOAD_ENABLED=<true to let the upload card send photos in Claude; unset keeps it off>
LETTER_IRL_PHOTO_UPLOADS_PER_DAY=<uploads an account may start in 24 hours; default 20>
STRIPE_PRICE_REGULAR=<price_ id>
STRIPE_PRICE_POWER=<price_ id>
STRIPE_CURRENCY=usd
# At launch, in both environments: the custom Checkout host (docs/stripe-custom-domain.md, #373).
STRIPE_CHECKOUT_DOMAIN=<bare host such as pay.letterirl.com; unset keeps checkout.stripe.com only>
# Amounts are read from these Prices at startup - do not mirror them here (#275).
```

The endpoint behind `STRIPE_WEBHOOK_SECRET` must subscribe to every event
`processStripeWebhookEvent` dispatches on. An event it is not subscribed to
does not fail loudly - Stripe never sends it, and the state change it carries
is simply missed. For a refund that means the customer keeps both the money
and the letters, because nothing but the webhook revokes them. The list is:

- `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`
- `refund.created`, `refund.updated`, `refund.failed`, `charge.refunded`
- `charge.dispute.created`, `charge.dispute.closed`

`OPENAI_APPS_CHALLENGE_TOKEN` holds the ChatGPT plugin portal's domain-verification token (#407).
The API serves it at `/.well-known/openai-apps-challenge` and answers 404 while it is unset. Set
it on the production API service when the portal issues a token at submission. The token is
served publicly, so it is not a secret, but it belongs to the portal's record, not to Git.

Confirm it in the Stripe Dashboard under Developers, Webhooks, for each
environment's endpoint, and again after any endpoint is recreated.

A refund for less than the order amount that the app did not issue is never
applied to a balance. It opens a critical `stripe_partial_refund_unmatched`
alert for an operator instead (#323).

`STRIPE_CURRENCY` is load-bearing, not decorative: every Price must be
denominated in it or the catalog refuses to price that product, which in
production is a `/readyz` 503 and a refused purchase. It defaults to `usd`, so
set it explicitly and keep the two environments in agreement — it was in no
manifest entry until #278, which meant `npm run preflight:cutover` reported
full parity while development and production disagreed about it.

In development set `LETTER_PROVIDER_CONFIG={"mode":"test"}`. When
`JIT_PURCHASE_ENABLED=true`, also set `STRIPE_JIT_LETTER_PRICE_ID`,
`STRIPE_JIT_POSTCARD_PRICE_ID`, and — if Pay & Send sells in a different
currency from the packs — `JIT_CURRENCY`.

The mail options' prices (#578) are needed only while their flags are on,
with Pay & Send:

- `LETTER_IRL_ROOM_TO_WRITE_ENABLED`: `STRIPE_JIT_LETTER_TWO_PAGES_PRICE_ID` and
  `STRIPE_JIT_LETTER_THREE_PAGES_PRICE_ID`;
- `LETTER_IRL_POSTCARD_SIZES_ENABLED`: `STRIPE_JIT_POSTCARD_4X6_PRICE_ID` and
  `STRIPE_JIT_POSTCARD_11X6_PRICE_ID`;
- `LETTER_IRL_CERTIFIED_MAIL_ENABLED` (#625): `STRIPE_JIT_LETTER_CERTIFIED_PRICE_ID` and
  `STRIPE_JIT_LETTER_CERTIFIED_RECEIPT_PRICE_ID`.

In Stripe test mode, `npx tsx scripts/create-option-prices.ts` makes all of these Prices at the amounts the product
table pins and writes the variable lines (#624; see [deployment.md](deployment.md), the Pay & Send rollout).

Without them, production refuses to boot and development warns. The flags stay
unset in production until the owner approves the prices. Leave a flag unset
rather than `false`: the cutover preflight reads variable names, not values, so a
flag set to `false` still makes it demand that option's prices.

Letter packs and gift letters pay only for one-page letters and 6x9 postcards
(#579): the options above are always paid per send, with Pay & Send, whatever
the balance.

**Do not delete the old `*_AMOUNT_CENTS` variables until this build is the one
serving** — the previous image's validator requires them in production, and
removing them early bricks that image on its next restart.

**Amounts are not configured here.** They are read from each Stripe Price at
startup (#275). Until that change there was a second copy in the environment
that had to equal the Price's unit amount, with no automated check that it did —
so a drifted pair charged one figure and booked another, and the webhook only
caught it after the customer had paid, moving the order to `refund_pending`.

Set the price in Stripe; there is nothing to mirror. A price that cannot be
resolved — archived, mistyped, or in another account — disables that product's
checkout and makes `/readyz` report `prices` failing, before any customer is
charged rather than after.

The preflight (`npm run preflight:cutover -- --env <environment>`) verifies the
price ids are *set* — it reads names, never values. Committed variables require
an explicit service **Redeploy** to reach the running instance (issue #213).

Content retention variables, read only by the maintenance service (`src/cli/runMaintenance.ts`):

```env
# Only the exact word `enforce` makes the sweep clear content; anything else,
# including unset, runs the daily report. Set on development first, then on
# production after RETENTION-01 passes there (#153).
CONTENT_RETENTION_MODE=
# On when unset. Any value other than true/1/yes/on/enabled - including a typo -
# skips the retention pass entirely, report included.
CONTENT_RETENTION_ENABLED=
# Sent-letter content period in days. Default 90; below 2 or unparseable falls back to 90.
CONTENT_RETENTION_DAYS=
# Rows per sweep. Default 500; outside 1-5000 or unparseable falls back to 500.
CONTENT_RETENTION_BATCH_SIZE=
# Outbox rows retried per maintenance run. Default 25.
MAINTENANCE_OUTBOX_BATCH_SIZE=
```

None of these is in `ENV_VAR_MANIFEST` yet, so `npm run preflight:cutover` does not report them.

Use Railway variable references to the bucket service. Do not copy bucket credentials into Git, screenshots, logs, or documentation. The application also accepts Railway's standard `BUCKET`, `AWS_ENDPOINT_URL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` names.

Leave `ADMIN_ENABLED` unset. A `true` value fails API startup, and there is no public admin route in
either environment. The admin panel is its own Railway service with no public domain, reachable only over
the owner's tailnet; its setup is in [admin-panel-guide.md](admin-panel-guide.md).

## Maintenance Settings

The maintenance service is `letter-irl-maintenance` in production and `letter-irl-maintenance-dev` in
development (the names in Railway's service list on 2026-09-23). Create each from the backend repository:

```text
Build command: npm run build
Start command: npm run maintenance
Cron schedule: 0 * * * *
Restart policy: never/on failure only as supported for cron
Public domain: none
```

Reference the same backend variables used by the API, including the environment-specific database and bucket references. The command closes all clients and exits. Investigate any run that is still active near the next hour.

`MAINTENANCE_HEARTBEAT_URL` is the maintenance service's own: an external monitor's ping URL (for example a healthchecks.io check), called after every run that finishes. The monitor alerts when the calls stop, which covers a run that never happens and one that keeps failing ([operational-acceptance.md](operational-acceptance.md), #408). Unset, nothing is called. It must be https; anything else only warns (`maintenance.heartbeat_url_invalid`). It is a capability, so keep it in Railway only.

## Website Settings

```text
Build command: npm run build
Start command: npm start
Healthcheck path: /api/health
NEXT_TELEMETRY_DISABLED=1
```

The website package starts `.next/standalone/server.js`; do not override it with `next start`.

## Branch Deployment

For each service and environment, set the source branch explicitly:

- backend production: `master`
- backend development: `dev`
- website production: `main`
- website development: `dev`

Keep automatic deploys enabled. A feature branch must reach `dev` through a PR before it can deploy to development.

## Serverless Policy

- Production API: disabled
- Production website: disabled
- Development API: enabled July 16, 2026; `1.34s` cold health response accepted
- Development website: enabled July 16, 2026; `1.38s` cold health response accepted

After enabling, leave development idle for more than ten minutes. Confirm Railway reports both services asleep, then test MCP connect, image/widget rendering, login, and dashboard access. Disable Serverless if first-use recovery exceeds three seconds or any flow fails.

The public post-wake health, manifest, OAuth metadata, CORS, and homepage checks passed in July 2026, and the authenticated ChatGPT widget and image flows have since passed against development (see [manual-tests.md](manual-tests.md)). Re-run them after any Serverless change.

## Budget Controls

At the Railway workspace/project billing level:

- configure an email usage alert at `$7`;
- configure a hard usage limit at `$20`;
- review per-service memory after each runtime upgrade;
- expect idle spend to stay close to the Hobby plan minimum.

The July 2026 local API benchmark measured approximately `106.7 MB` RSS for compiled Node versus `219.3 MB` for the prior `tsx` runtime. Railway measurements can differ, but a sustained return toward the earlier 300+ MB API baseline should be investigated.

The `$7` email alert and `$20` hard limit were verified active on July 16, 2026.

Current development placement is API and website in Railway US West, maintenance in Railway US East, and Neon in AWS US East 1. This is documented configuration, not a recommendation; measure database latency and bucket-transfer behavior before consolidating regions.

## Verification

- Deploy status is successful in both environments.
- `/healthz` and `/api/health` return successfully.
- Migrations show issue #69's `021_jit_commerce_foundation.sql` before `022_admin_audit.sql`.
- Maintenance logs show one short run and clean process exit.
- Maintenance logs show `recent_uploads.swept` and no `recent_uploads.sweep_failed`.
- Maintenance logs show `feature_requests.swept` and no `feature_requests.sweep_failed`.
- An image remains retrievable after API restart for its documented 15 minutes.
- Development sleeps after ten idle minutes.
- Neon suspends after five database-idle minutes.

See [idle-cost-operations.md](idle-cost-operations.md) for observation and rollback procedures.
