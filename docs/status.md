# Letter IRL Project Status

**Last Updated:** September 16, 2026
**Purpose:** Current product scope, architecture, environment state, and open work

---

## Overview

Letter IRL is live in production and preparing for OpenAI Apps SDK submission. Releases go to
development first and are promoted to production after automated and manual acceptance.

## Product

An authenticated user can create, preview, and send physical US letters and 6x9 postcards from
ChatGPT, and manage their account on letterirl.com.

- **Mail:** text-only letters, letters with a header image, letters with an enclosed image, and
  postcards. Every send starts from a preview draft and needs explicit confirmation.
- **Paying:** prepaid letter packs (2, 5 or 50 letters), bought in the conversation
  (`create_pack_checkout`) or on the website; **Pay & Send**, which buys and sends one previewed item
  in a single Stripe-hosted checkout; and promo codes. Both checkouts are external Stripe Checkout.
- **Images:** attachments, `imageUrl` handoff, the upload widget (including ChatGPT Library picks),
  and `generate_image_for_mail`, which spends the user's Letter IRL image generations or routes the
  request to ChatGPT's free built-in generator.
- **Account:** saved return address, balance, order and purchase history, purchase status, feature
  requests.

The MCP surface is 22 tools and 6 widgets ([tool-apis.md](tool-apis.md), [ui-widgets.md](ui-widgets.md)).
Tool names and schemas are treated as stable compatibility contracts. Widget template URIs are
versioned (`WIDGET_TEMPLATE_VERSION`, 31 on `dev`).

## Environments

| Layer | Production | Development |
| --- | --- | --- |
| Backend | `master` -> Railway production | `dev` -> Railway development |
| Website | `main` -> Railway production | `dev` -> Railway development |
| Admin panel | `letter-irl-admin-prod`, tailnet-only, full mode | `letter-irl-admin`, tailnet-only |
| Database | Neon production branch | Neon `dev` branch (independent, never copied from production) |
| Payments | Stripe live | Stripe test |
| Mail provider | PostGrid live | PostGrid test / dummy |
| Auth | production Auth0 tenant | development Auth0 tenant |

See [infrastructure.md](infrastructure.md) for identifiers and URLs.

### What is promoted

Production (`master`) was last promoted on 2026-09-14 and carries migrations through
`031_provider_error_minimisation.sql`. `dev` is ahead with the retention follow-ups that are not yet
in production:

- deletion of stale upload links 24 hours after the last upload (#397);
- deletion of feature requests 12 months after submission (#400);
- error classes instead of message text in the remaining writers, and migration
  `032_error_text_minimisation.sql` (#401);
- the related documentation (#391, #392, #399).

## Architecture

- **Runtime:** strict ESM TypeScript compiled with `tsc`, run with Node 22 on Railway.
- **Database:** Neon PostgreSQL 17 through pooled connection strings and a five-client pool.
  Migrations run as Railway's pre-deploy command, from `railway.toml` until Railway stops reading it
  on 2026-12-01 ([deployment.md](deployment.md)).
- **Mail dispatch:** a transactional `letter_jobs` outbox with immediate provider submission. The API
  starts no queue, polling or cleanup timers; pg-boss has been removed.
- **Maintenance:** a one-shot hourly Railway cron (`npm run maintenance`) that runs the retention
  sweeps, retries outbox work, reconciles commerce and pack refunds, recovers image reservations,
  removes expired temporary images, syncs provider status every six hours, and runs daily cleanup.
- **Temporary images:** a private Railway S3-compatible bucket with a 15-minute TTL.
- **Authentication:** ChatGPT uses a manually imported Auth0 CIMD application per environment and an
  exact `/mcp` audience with `mail:read`, `mail:draft`, `mail:send`. The website and REST API use the
  same Auth0 API since 2026-09-14. Other MCP clients use personal access tokens.
  ([auth0-setup.md](auth0-setup.md))
- **Operator access:** a separate admin panel service per environment, reachable only over the owner's
  tailnet. The public API returns 404 for every legacy admin path.
  ([admin-panel-guide.md](admin-panel-guide.md))
- **Availability:** production API and website stay warm; development API and website use Railway
  Serverless.

## Safety Properties

- Draft consumption, order creation, credit deduction, and outbox insertion commit atomically.
- A draft can produce at most one Letter IRL order, and a letter has one outbox row with a stable
  provider idempotency key.
- A provider outcome that does not prove what happened is held for an operator, never resubmitted.
- Only a verified, paid Stripe event can fund or fulfil an order.
- Letter text, addresses and upload links are never written to logs, diagnostics, error columns or
  audit rows ([security-and-policy.md](security-and-policy.md)).
- Production and development database, payment, provider and identity settings stay isolated, and the
  boot validator refuses crossed configuration ([deployment.md](deployment.md)).

## Verification

- **CI:** `.github/workflows/ci.yml` runs lint, build, unit and submission tests, plus the
  real-PostgreSQL integration suites, on every pull request to `dev` or `master`.
- **Local:** `npm run verify` and `npm run test:integration:local` mirror the two CI jobs.
- **Manual:** [manual-tests.md](manual-tests.md) records each acceptance run against development and
  production.
- **Dependencies:** `npm audit --omit=dev` must report zero vulnerabilities before a production deploy.

## Open Work

- **Apps SDK submission:** pre-submission; owner tasks in
  [app-submission/owner-checklist.md](app-submission/owner-checklist.md).
- **Content retention enforcement:** the letter and draft content sweep runs in report mode
  (`CONTENT_RETENTION_MODE` unset) until the enforce-path defects tracked in #153 are fixed. The
  upload-link and feature-request sweeps are separate and always enforce.
- **Operator audit purge:** the 2-year purge of operator audit rows is tracked in #398.
- **Railway config-as-code:** move the pre-deploy migration command out of `railway.toml` before
  2026-12-01.
- **Remaining CIMD cases:** CIMD-06, CIMD-07, CIMD-09 and CIMD-10 in
  [manual-tests.md](manual-tests.md).
- **Agentic Commerce Protocol:** planned for when OpenAI makes it available to apps like Letter IRL;
  see [acp-implementation-guide.md](acp-implementation-guide.md).

## Release Path

1. Feature branches target `dev`.
2. Railway deploys development automatically, running migrations first.
3. CI, then the documented manual tests, run against development.
4. Backend `dev` is promoted to `master`, and website `dev` to `main`, only after acceptance.

## Key Documents

- [Infrastructure](infrastructure.md)
- [Deployment](deployment.md)
- [Railway Setup](railway-setup.md)
- [Letter Send Flow](letter-send-flow.md)
- [Just-in-Time Purchase Plan](just-in-time-purchase-plan.md)
- [Admin Panel Guide](admin-panel-guide.md)
- [Manual Tests](manual-tests.md)
- [OpenAI Submission Checklist](app-submission/owner-checklist.md)
