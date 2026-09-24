# OpenAI Apps SDK Owner Checklist

**Last Updated:** September 23, 2026
**Purpose:** Owner-managed submission tasks, assets, and the final readiness gate

This checklist tracks the non-code items the project owner needs to gather, verify, or decide before submitting Letter IRL for OpenAI Apps SDK review. Keep secrets, private billing details, private tax IDs, and passwords out of this file.

## Current Status

- Submission status: pre-submission
- Submitting organization: `Objective Works`
- OpenAI organization ID: `org-sGKDRRMOeTxvkxhnsvnCRa6J`
- OpenAI submission project: `Mail Letter IRL` (`proj_6tiqBTLBrGtxtdVz6ms1Acdd`)
- DBA / product name: `Letter IRL`
- Owner/contact account: `dnicholl@objective.works`
- Dedicated ChatGPT testing account: `dnicholl@letterirl.com`
- Previous ChatGPT testing account: `dnicholl@objective.works`
- Primary personal ChatGPT account, kept separate: `openai@davidnicholl.com`
- Organization verification: completed on May 31, 2026
- Primary submission docs: `docs/chatgpt-app-submission.md`, `docs/app-submission/openai-test-cases.md`, `docs/app-submission/demo-scenarios.md`

## Owner Tasks

### Auth0 CIMD

Done: CIMD registration is enabled and a strict third-party CIMD client is imported in both tenants
(production import 2026-09-05), with the dedicated `/mcp` API granting only `mail:read`, `mail:draft`
and `mail:send`. The client authenticates with `private_key_jwt`, the method ChatGPT's CIMD document
declares; the earlier `token_endpoint_auth_method: none` target was unachievable. The website and
REST API use the same API since 2026-09-14. Details: [auth0-setup.md](../auth0-setup.md) and
[auth0-tenant-configuration.md](../auth0-tenant-configuration.md).

Remaining:

- [ ] Close CIMD-06, CIMD-07, CIMD-09 and CIMD-10 in [manual-tests.md](../manual-tests.md).
- [ ] Decide when to turn off OIDC Dynamic Client Registration in the development tenant, which
      [development.md](../development.md) records as still enabled as rollback inventory.
- [ ] Wherever the app's OAuth settings are entered for submission, leave **OIDC enabled** off.
      ChatGPT pre-ticks it because Auth0 publishes OpenID discovery, and with it on nobody can
      connect: Auth0 issues no ID token to the strict CIMD client
      ([chatgpt-connector-oidc-setting.md](../learnings/chatgpt-connector-oidc-setting.md), #424).

### OpenAI Platform Access

- [x] Confirm `Objective Works` organization verification is approved by OpenAI.
- [x] Confirm the submitting account has the `Owner` role in the OpenAI organization. `dnicholl@objective.works` is listed as Organization Owner.
- [x] Confirm the app will be submitted from the intended OpenAI organization/project: `Objective Works` / `Mail Letter IRL` (`proj_6tiqBTLBrGtxtdVz6ms1Acdd`).
- [x] Confirm the selected OpenAI project has global data residency and is eligible for app review. Dashboard `GEOGRAPHY` column shows `Global`.
- [ ] Use the dedicated `dnicholl@letterirl.com` ChatGPT account for focused Letter IRL testing.
- [ ] Keep the primary `openai@davidnicholl.com` ChatGPT account separate from app testing and review prep.
- [x] Record the final OpenAI organization/project names in `docs/company-and-accounts.md` once confirmed.

### Public Company and Support Information

- [x] Confirm company / organization name: `Objective Works`.
- [ ] Confirm DBA / product name: `Letter IRL`.
- [ ] Confirm company URL: `https://letterirl.com`.
- [ ] Confirm support email: `support@letterirl.com`.
- [ ] Confirm privacy policy URL: `https://letterirl.com/privacy`.
- [ ] Confirm terms of service URL: `https://letterirl.com/terms`.
- [ ] Confirm country availability: U.S. only.

### Product and Commerce Framing

- [ ] Use user-facing language: `Letter Packs`, `pre-paid letter sends`, or `letters remaining`.
- [ ] Avoid user-facing submission language that frames the product as generic digital `credits`, `tokens`, or a subscription.
- [ ] Confirm submission materials explain that Letter Packs are prepaid physical mail sends for real USPS letters/postcards.
- [ ] Describe checkout as it runs: a card opens Letter IRL's own start page
      (`https://api.letterirl.com/purchase/start`), which hands off to Stripe-hosted Checkout, and
      nothing is paid inside the widget. Never claim embedded payment. If Stripe's custom domain is
      adopted (#373), update this line.
- [ ] The listing sells physical mail only: no digital generation credits, and no upsell of
      image-generation capacity.
- [ ] Reviewers use production and the prepared reviewer account, with letters preloaded; nothing in
      the reviewer materials points at development.

### Submission Assets

- [ ] Confirm final app name: `Letter IRL`.
- [ ] Confirm final app icon/logo URL: `https://letterirl.com/logo.jpg`.
- [ ] Screenshots and demo videos are optional in the current review guide. Capture them if they
      help reviewers follow a flow, against `docs/app-submission/demo-scenarios.md`, and link them
      here; they do not block submission.
- [ ] Confirm app description and short metadata match `docs/chatgpt-app-submission.md`.
- [ ] Confirm localization fields, if required by the submission portal.

### Reviewer Materials

- [ ] Finalize reviewer test prompts and expected responses in `docs/app-submission/openai-test-cases.md`.
- [ ] Prepare the reviewer account in [Reviewer Setup](./openai-test-cases.md#reviewer-setup): email
      and password, a confirmed address, no multi-factor step, prepaid letters for every case, a
      saved return address and one earlier letter. Its credentials go in the portal's reviewer
      notes, never in Git.
- [ ] Give reviewers a controlled mail address that Letter IRL receives, in the reviewer notes.
- [ ] Confirm reviewer instructions clearly state that Letter IRL sends real physical USPS mail.
- [ ] Confirm reviewer instructions explain that sending needs payment: prepaid letters, or Pay &
      Send for a single letter.
- [ ] Confirm reviewer instructions explain preview-before-send and explicit confirmation behavior.
- [ ] Document any known limitations or mitigations, especially mobile image handoff limitations.

### Manual Final Pass

- [ ] Test onboarding / `get_started` flow in ChatGPT.
- [ ] Test text-only letter preview.
- [ ] Test letter with generated or reused image.
- [ ] Test postcard preview.
- [ ] Test upload fallback path.
- [ ] Test insufficient letter balance flow.
- [ ] Test explicit send confirmation in a controlled environment.
- [ ] Run the [commerce and safeguard cases](./openai-test-cases.md#commerce-and-safeguard-cases):
      pack checkout, Pay & Send, pending and failed payment, duplicate confirmation, image
      generations used up, and the upload fallback.
- [ ] Test account balance and order status.
- [ ] Test OAuth linking with a fresh account.
- [x] Verify production MCP endpoint and OAuth endpoints are live. May 31, 2026 check: `api.letterirl.com` manifest, OAuth metadata, MCP CORS preflight, and unauthenticated auth challenge all advertise the canonical production domain.

## Plugin Portal Gates

The portal's submission steps as of September 2026 (With MCP, Universal endpoint;
`https://developers.openai.com/plugins/deploy/submission`). Record each gate's outcome in the
[release record](#release-record) below.

- [ ] **Launch build.** Production runs the launch promotion from `dev` (#158), which carries
      #412, #426, #434 and gift letters, and the production connector has been refreshed. The
      reviewer materials describe that build, so this comes before preparing the reviewer account.
- [ ] **Pay & Send on.** `JIT_PURCHASE_ENABLED=true` on the production API. The reviewer
      materials promise it; it was on on 2026-09-23.
- [ ] **Access.** The submitting account has Apps Management write access in `Objective Works` /
      `Mail Letter IRL`.
- [ ] **Listing.** Name, descriptions, logo, category, website, support, privacy and terms URLs,
      and release notes, matching `docs/chatgpt-app-submission.md`.
- [ ] **Domain verification.** In MCP configuration the portal issues a token for
      `https://api.letterirl.com/mcp`; the challenge host is the MCP host. Set
      `OPENAI_APPS_CHALLENGE_TOKEN` on the production API service, wait for the redeploy, and check
      that `curl -si https://api.letterirl.com/.well-known/openai-apps-challenge`
      answers 200 with the token as the whole body. Then press Verify. The path answers 404 while the
      variable is unset.
- [ ] **Scan Tools.** The portal discovers all 23 tools with their annotations. Record any warning.
- [ ] **Starter prompts.** The listing's prompts for customers, from
      [Starter Prompts](./openai-test-cases.md#starter-prompts); not the reviewer's test cases.
- [ ] **Test cases.** Five positive and three negative, from `openai-test-cases.md` (#406).
- [ ] **Availability.** United States only.
- [ ] **Attestations and submit.**
- [ ] **Publish.** A separate step after approval. Publish, refresh the production connector, and
      repeat the final manual pass.

### Guidance changes to re-check before submitting

- [ ] **Configurable permission prompts (June 2026).** A fresh end-to-end test in ChatGPT that each
      destructive tool's annotation still brings the host's prompt, and that the app's own
      confirmation (the preview and the explicit send) still stands on top of it.
- [x] **`openai/visibility` deprecated for `_meta.ui.visibility` (July 2026).** Neither key is used
      in `src/`, so nothing needs migrating (checked 2026-09-23).
- [ ] **Stable OAuth callback and CIMD id (August 2026).** They rely on RFC 9207 issuer
      identification, which the production Auth0 discovery did not advertise on 2026-09-16. Keep
      the imported CIMD client; do not swap it for the stable URL without testing the swap.

## Release Record

One row per gate for the submitted version. Evidence is sanitised: status codes, commit ids,
timestamps and screenshot names, never tokens, cookies or personal data.

| Gate | Date | Commit | Environment | Result | Evidence |
| --- | --- | --- | --- | --- | --- |
| Launch build on production (commit) | | | production | | |
| Pay & Send on | | | production | | |
| Access | | | production | | |
| Listing | | | production | | |
| Domain verification | | | production | | |
| Scan Tools | | | production | | |
| Starter prompts | | | production | | |
| Test cases (5 positive, 3 negative) | | | production | | |
| Availability (United States) | | | production | | |
| Permission prompts, end to end | | | production | | |
| Stable OAuth callback and CIMD id (RFC 9207) re-checked | | | production | | |
| Final manual pass | | | production | | |
| Attestations and submitted | | | production | | |
| Approved and published | | | production | | |

## Demo Video Tracking

Use this section to track existing or newly recorded demo assets.

| Asset | Status | Location | Notes |
| --- | --- | --- | --- |
| Submission overview video | Unknown | TBD | Locate prior recording or re-record. |
| Letter with inline image demo | Unknown | TBD | Should match the cat/apology or equivalent prose-plus-image flow. |
| Postcard with edited/photo image demo | Unknown | TBD | Should show image-to-postcard preview and explicit review before send. |
| Screenshots | Unknown | TBD | Capture final portal-ready screenshots from production-ready flows. |

## Ready-to-Submit Gate

Do not submit until all are true:

- [x] OpenAI organization verification is approved.
- [x] Owner role and project eligibility are confirmed.
- [ ] Production app, MCP server, OAuth, widget CSP, privacy policy, and terms are verified. MCP server and OAuth endpoints passed canonical-domain checks on May 31, 2026.
- [ ] Every plugin portal gate above has passed and is recorded in the release record.
- [ ] Reviewer prompts and instructions are final.
- [ ] Submission language consistently uses Letter Packs / pre-paid letter sends for user-facing commerce.
- [ ] Known limitations are documented honestly.
- [ ] A final manual ChatGPT smoke test has passed.

## Related Docs

- `docs/chatgpt-app-submission.md`
- `docs/app-submission/openai-test-cases.md`
- `docs/app-submission/demo-scenarios.md`
- `docs/company-and-accounts.md`
- `docs/use-cases.md`
