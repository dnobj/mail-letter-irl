# Letter IRL Project Status

**Last Updated:** September 28, 2026
**Purpose:** Current product scope, architecture, environment state, and open work

---

## Overview

Letter IRL is live in production in ChatGPT. The next promotion is the launch version (#158). It
brings other MCP apps (Claude, Claude Code, Codex, VS Code, Hermes and more), sending only by the
person, and the ChatGPT plugin submission. The plan is `C:\letter-irl-scripts\plans\launch-plan.md`,
outside the repository. Releases go to development first and are promoted to production after
automated and manual acceptance.

## Product

An authenticated user can create, preview, and send physical US letters and 6x9 postcards from
ChatGPT, Claude and other MCP apps, and manage their account on letterirl.com.

- **Mail:** text-only letters, letters with a header image, letters with an enclosed image, and
  postcards. Every send starts from a preview draft. Under the send rule (#470,
  `LETTER_IRL_SEND_CONFIRMATION_ENABLED`, on in development), only the person sends: with our
  card's **Send**, or on the website's confirmation page, whose link `request_send` gives an app
  that shows no card ([letter-send-flow.md](letter-send-flow.md)).
- **Printing:** PostGrid prints the legacy HTML in Open Sans (#526). Our own renderer (#534) lays
  letters out in Tinos, previews the page as it prints, and uploads its own PDF. Letter previews
  use it behind `LETTER_IRL_PRINT_RENDERER=pdf`, which is turned on in development once #540
  merges, for PRINT-02. Gift pages and postcards are still to move onto it.
- **Paying:** prepaid letter packs (2, 5 or 50 letters), bought in the conversation
  (`create_pack_checkout`) or on the website; **Pay & Send**, which buys and sends one previewed item
  in a single Stripe-hosted checkout; and promo codes. Both checkouts are external Stripe Checkout,
  offered only in apps that take purchases (ChatGPT); other apps point to the website (#475).
- **Gift letters:** free sends that print a card for the recipient, with a code for a letter of
  their own while the chain's budget lasts ([gift-letters.md](gift-letters.md)). Built behind
  `LETTER_IRL_GIFT_LETTERS_ENABLED`: on in development, where GIFT-01 steps 1 to 9 passed, and on
  in production at launch (the owner's decision of 2026-09-23, #158).
- **Images:** attachments, `imageUrl` handoff, the upload widget (including ChatGPT Library picks),
  and `generate_image_for_mail`, which spends the user's Letter IRL image generations or routes the
  request to ChatGPT's free built-in generator. Claude is never offered image generation (#490),
  and `LETTER_IRL_IMAGE_GEN_MODE=off` removes it everywhere. In Claude the upload card sends the
  photo itself, behind `LETTER_IRL_CARD_UPLOAD_ENABLED` (#474 phase 3, on in development).
- **Account:** saved return address, balance, order and purchase history, purchase status, feature
  requests. One account per **confirmed email address**: Auth0 mints a subject per sign-in method,
  and a post-login Action links the methods that share an address, so a person who signs in with
  Google and with a password has one balance and one history. A sign-in that carries no confirmed
  address opens no account and says so, rather than opening one under an invented address
  ([account-switching-guide.md](account-switching-guide.md),
  [auth0-tenant-configuration.md](auth0-tenant-configuration.md)). A request to delete an account
  is carried out as an erasure. The operator queues it from the admin panel, and maintenance removes
  the content and identity and keeps the money records, anonymised ([account-erasure.md](account-erasure.md)).

The MCP surface is 24 tools and 6 widgets. Two more are listed only while their switch is on:
`request_send` with the send rule, and `upload_photo_chunk` with card upload
([tool-apis.md](tool-apis.md), [ui-widgets.md](ui-widgets.md)). Each app gets its own words and tool
list from its profile, which the server reads from the sign-in token (#473, #484, #475).
Tool names and schemas are treated as stable compatibility contracts. Widget template URIs are
versioned (`WIDGET_TEMPLATE_VERSION` in `src/mcp/widgetUris.ts`). Since v38 every card talks to its host through
one bridge (`widgets/shared/host.js`), which speaks MCP Apps outside ChatGPT, so Claude draws them.
Since v40 a card's Send sends in Claude, and since v41 a reopened card there asks the server what
became of its draft (#474). Since v32 the two image letter tools each have
their own template name, served from the letter card (#411). Since v33 every card shows the
website's mark, and an empty preview or pack card suggests a higher thinking effort to Instant users.
Since v34 an empty image letter or postcard card lets the person choose or upload an image that the
card cannot pass back, and previews it by link (#414). Since v35 a send or checkout refused because the same
mail went out in the last 24 hours offers **Send another copy** or **Pay for another copy** (#412). Since v36 a gift
letter preview shows the card the recipient receives ([gift-letters.md](gift-letters.md)). Since v37 a refused call
shows the server's sentence rather than the host's wrapper around it (#434).

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

Production (`master`) was last promoted on 2026-09-16 (#416, `27e160a`) and carries migrations
through `032_error_text_minimisation.sql`. The next promotion is the launch version (#158), 49 commits
ahead on 2026-09-28, with migrations `033` to `037`:

- ChatGPT card hardening: the website's logo and the Instant tip (#417), chat-image recovery (#418),
  the same-mail check (#419), and the server's sentence on a refused call (#434);
- gift letters (#422, migration `033`), with the admin and seed-code fixes (#431, #438, migration `034`
  ending the zero-letter promo codes);
- one account per confirmed email address (#423), the identity scopes and `get_profile` (#425, #426).
  **Its Auth0 half is manual and per tenant**: the two Post Login Actions and the `Account Linking`
  machine-to-machine application must be in place in a tenant before the code that depends on them
  is deployed against it, and LINK-01 run afterwards;
- account erasure and its follow-up alert (#446, #455, #452, migrations `035` and `036`);
- retention enforce fixes (#450), the outbox switch (#451) and the maintenance heartbeat (#445);
- the checkout domain `pay.letterirl.com` (#443) and the submission materials and portal gates (#442);
- other MCP apps: app profiles (#479), the send rule and `request_send` (#480), read-and-draft
  personal access tokens (#481, migration `037`), tool text per app (#486), purchases per app (#489),
  no AI images in Claude (#491, #493), and the cards on MCP Apps with photo upload (#494, #496,
  #498, #499, #502).

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
- **Authentication:** each MCP app signs in with its own client document, imported into Auth0 per
  environment: ChatGPT, Claude, Claude Code, Codex, VS Code and Hermes in development. In production,
  only ChatGPT's is imported until the launch promotion. All use an exact `/mcp` audience with
  `mail:read`, `mail:draft`, `mail:send`. The server tells the apps apart by the token's client
  (`src/auth/clientProfiles.ts`). The website and REST API use the same Auth0 API since 2026-09-14.
  Personal access tokens read and draft only (#470).
  ([auth0-setup.md](auth0-setup.md), [auth0-tenant-configuration.md](auth0-tenant-configuration.md))
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

- **Launch:** the launch version, its promotion and the per-app checks (#158, #471).
- **Other MCP apps:** each app's gate in [manual-tests.md](manual-tests.md) (CLIENT-xx), the website's
  Connect page (website #38), and the production Auth0 imports (#465).
- **ChatGPT plugin submission:** pre-submission; owner tasks in
  [app-submission/owner-checklist.md](app-submission/owner-checklist.md), and the Plugin Directory
  gaps in #476.
- **Content retention enforcement:** development enforces (`CONTENT_RETENTION_MODE=enforce`,
  `RETENTION-01` passed 2026-09-24); production switches at the launch promotion (#153). The
  upload-link and feature-request sweeps are separate and always enforce.
- **Operator audit purge:** the 2-year purge of operator audit rows is tracked in #398.
- **Gift letters:** GIFT-01 step 4 (the paper print and an iPhone scan) and the printed card's
  copy (#487) before production switches the programme on; the website's claim page ships with the
  website's promotion.
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
