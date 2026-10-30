# OpenAI Apps SDK Owner Checklist

**Last Updated:** October 30, 2026
**Purpose:** Owner-managed submission tasks, assets, and the final readiness gate

This checklist tracks the non-code items the project owner needs to gather, verify, or decide before submitting Letter IRL for OpenAI Apps SDK review. Keep secrets, private billing details, private tax IDs, and passwords out of this file.

## Current Status

- Submission status: pre-submission
- Submitting organization: `Objective Works`
- OpenAI organization ID: recorded privately
- OpenAI submission project: `Mail Letter IRL` (ID recorded privately)
- DBA / product name: `Letter IRL`
- Owner/contact account, ChatGPT testing accounts and the owner's personal account (kept separate): recorded privately (#730)
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
- [x] Confirm the submitting account has the `Owner` role in the OpenAI organization. The organization account is listed as Organization Owner.
- [x] Confirm the app will be submitted from the intended OpenAI organization/project: `Objective Works` / `Mail Letter IRL` (ID recorded privately).
- [x] Confirm the selected OpenAI project has global data residency and is eligible for app review. Dashboard `GEOGRAPHY` column shows `Global`.
- [ ] Use the dedicated testing ChatGPT account for focused Letter IRL testing.
- [ ] Keep the owner's personal ChatGPT account separate from app testing and review prep.
- [x] Record the final OpenAI organization and project (`Mail Letter IRL`); their IDs are kept privately (#730).

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
      (`https://api.letterirl.com/purchase/start`), which hands off to Stripe-hosted Checkout on
      Letter IRL's checkout domain, `pay.letterirl.com` (#373, switched on in Stripe at launch), and
      nothing is paid inside the widget. Never claim embedded payment.
- [ ] The listing sells physical mail only: no digital generation credits, and no upsell of
      image-generation capacity.
- [ ] Reviewers use production and the prepared reviewer account, with letters preloaded; nothing in
      the reviewer materials points at development.

### Submission Assets

- [ ] Confirm final app name: `Letter IRL`.
- [ ] Confirm final app icon/logo URL: `https://letterirl.com/icon-512.png`. The Plugin Directory
      needs a square logo of 48 to 4,096 px (#476); `logo.jpg` is 242x156.
- [ ] **Record the demo (owner).** The Plugin Directory requires a demo recording URL covering the
      main use cases and tools on the supported platforms (#476). Record it against
      `docs/app-submission/demo-scenarios.md`, with the send rule on (the person presses Send on
      the card), and link it here.
- [ ] **Short description, 30 characters or fewer.** Proposed: `Mail real letters & postcards`
      (29). The long description stays within 4,000 characters.
- [ ] **Category.** Proposed: Communication.
- [ ] **Support URL.** The listing needs an HTTPS support page, not only an email:
      `https://letterirl.com/support` (website #45, live on letterirl.com once the website is
      promoted).
- [ ] **Website URL.** Set the app's website to `https://letterirl.com`. In development ChatGPT's
      "Website" reads Unavailable, and the "Open in Letter IRL" button on an expanded card opened the
      connector's server URL instead (#662 probe, 2026-10-08). Check where that button goes once the
      listing has its website.
- [ ] **Developer Identity.** The portal checks the verified developer, Objective Works, against the
      name, website, support, privacy and terms pages. Website #45 names Objective Works as the
      operator on the privacy, terms and support pages and in the footer, for the owner's sign-off.
- [ ] **App instructions.** Once the launch build is on production (the send rule on, image
      generation off), paste the "Tool-Use Instructions" block from
      [app-instructions.md](../app-instructions.md) into the portal's app-instructions field, replacing
      any copy pasted before. Paste it again whenever one of those switches, or address requests,
      changes in production. Since #673 it is the served instructions word for word (a test keeps it
      so). An older copy told the model to call the send tools itself and called tools "read-only",
      which ChatGPT flags as a "Suspicious Instruction" (#670).
- [ ] Confirm the listing in `plugin/plugin.json` and the
      [App Description](./openai-test-cases.md#app-description) say the same things.
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

The portal's submission steps as read on October 30, 2026
(`https://developers.openai.com/plugins/deploy/submission` and
`https://developers.openai.com/plugins/plugin-guidelines`). Apps are now plugins in the Plugin
Directory. A plugin is uploaded as a ZIP whose `plugin.json` carries the listing and the review
details; the package is [`plugin/`](../../plugin/README.md). The first release is offered in
**ChatGPT only**, in the **Productivity** category (owner decision, 2026-10-30); Codex is added as
an update after approval, once its plugin route has been run end to end. Record each gate's outcome
in the [release record](#release-record) below.

- [ ] **Checkout on our own domain.** The guidelines allow commerce for physical goods only, with
      checkout outside ChatGPT "on your own domain". Stripe must serve Checkout on
      `pay.letterirl.com` ([stripe-custom-domain.md](../stripe-custom-domain.md)): a pack checkout
      and a Pay & Send open on that host before submitting.
- [ ] **Package.** Build the ZIP as [plugin/README.md](../../plugin/README.md) says, then
      **Upload new or existing plugin**, choose the verified developer (Objective Works), and resolve
      the **Metadata & Skills** findings. Remote servers connect under **MCPs** (**With MCP**).
      `mcp.json` declares OAuth with CIMD under `extensions.com.openai.auth`, as OpenAI's package
      guide documents, though the generic Agent Plugins schema it names does not list that block. If
      the upload refuses it, remove the block: the server's discovery already leads ChatGPT to CIMD.
- [ ] **Sign-in client.** Production Auth0 does not return RFC 9207 `iss`, so ChatGPT signs in with
      its per-callback CIMD document, `https://chatgpt.com/oauth/{callback_id}/client.json`. After
      connecting the MCP server, read the client document and redirect URI on the server's
      management page, and compare them with the ChatGPT application production Auth0 already
      imported. A new callback id means importing that document too, and production has one
      application slot of ten left.
- [ ] **Commerce declaration.** `review.commerce` is true, and `review.commerce_description` says
      packs are prepaid mailings redeemable only for printed mail, never credits or tokens.
- [ ] **Served copy matches the declaration.** The guidelines want each tool's description to match
      its behaviour, and the declaration says checkout opens outside ChatGPT. `get_started` and
      `get_account_balance` still say a pack can be bought "right here" or "without leaving the
      conversation", and so does the manifest's description. That copy is reworded, deployed to
      production and the connector refreshed before the scan (#852).
- [ ] **Review details in the dashboard.** The demo recording URL, and the reviewer account's
      sign-in and notes (with the controlled mail address), go in the **Review details** form,
      never in the ZIP.
- [ ] **Launch build.** Production runs the launch promotion from `dev` (#158) with stages A to G
      and the live checks of [launch-promotion.md](../launch-promotion.md) done, so the launch cut
      (#816) is on: group 1, each group 2 feature whose step passed, and group 3 off. The production
      connector has been refreshed after the last switch. The reviewer materials describe
      that build, so this comes before preparing the reviewer account.
- [ ] **Pay & Send on.** `JIT_PURCHASE_ENABLED=true` on the production API. The reviewer
      materials promise it; it was on on 2026-09-23.
- [ ] **Access.** The submitting account has Apps Management write access in `Objective Works` /
      `Mail Letter IRL`.
- [ ] **Listing.** Name, descriptions, logo, category, website, support, privacy and terms URLs,
      and release notes, as `plugin/plugin.json` sets them (`tests/unit/mcp/pluginPackage.test.ts`
      holds them to the portal's limits). If the portal's category list has a closer fit than
      Productivity, choose it there.
- [ ] **Domain verification.** In MCP configuration the portal issues a token for
      `https://api.letterirl.com/mcp`; the challenge host is the MCP host. Set
      `OPENAI_APPS_CHALLENGE_TOKEN` on the production API service, wait for the redeploy, and check
      that `curl -si https://api.letterirl.com/.well-known/openai-apps-challenge`
      answers 200 with the token as the whole body. Then press Verify. The path answers 404 while the
      variable is unset.
- [ ] **Scan Tools.** The portal discovers the tools production serves. At the launch cut that
      is 34, the list in `tests/unit/mcp/__snapshots__/tools-list.chatgpt-launch.json`
      ([Tool Annotations Verification](./openai-test-cases.md#tool-annotations-verification) says
      which are left out), with the card-only `send_letter`, `send_postcard`,
      `create_mail_checkout` and `get_draft_status` among them. If a group 2 feature stayed off,
      that file was re-recorded to match and is the count to expect, and the feature is out of
      [openai-test-cases.md](./openai-test-cases.md) (the app description, its launch feature case,
      and the count and list under Tool Annotations Verification) and out of `longDescription` and
      `release_notes` in `plugin/plugin.json`. Production serves 24 before
      stages C to G, and each switch adds its tools, so scan only after the last switch and a
      connector refresh. Record any warning, and give each tool's three hint
      justifications from [Justifications for the portal](./openai-test-cases.md#justifications-for-the-portal).
- [ ] **Starter prompts.** The listing's prompts for customers, `defaultPrompt` in `plugin/plugin.json`, from
      [Starter Prompts](./openai-test-cases.md#starter-prompts); not the reviewer's test cases.
- [ ] **Test cases.** Exactly five positive and three negative, `review.test_cases` in
      `plugin/plugin.json`, from [Portal Test Cases](./openai-test-cases.md#portal-test-cases) (#406).
      Run the positive cases on the reviewer account before submitting.
- [ ] **Availability.** United States only.
- [ ] **Attestations and submit.**
- [ ] **Publish.** A separate step after approval. Publish, refresh the production connector, and
      repeat the final manual pass.

### Guidance changes to re-check before submitting

- [ ] **Configurable permission prompts (June 2026).** A fresh end-to-end test in ChatGPT that each
      destructive tool's annotation still brings the host's prompt, and that the app's own
      confirmation (the preview and the explicit send) still stands on top of it.
- [ ] **`openai/visibility` deprecated for `_meta.ui.visibility` (July 2026).** Neither key was
      used in `src/` on 2026-09-23. The send rule (#470) now emits both on `send_letter`,
      `send_postcard` and `create_mail_checkout` (#475) while `LETTER_IRL_SEND_CONFIRMATION_ENABLED`
      is on, so that ChatGPT keeps the tools from its model and the card can still call them.
      Production requires the rule (#730). After the promotion that carries it, confirm in
      ChatGPT that the model cannot call `send_letter` or `create_mail_checkout`, and that the
      card's Send and Pay & Send buttons still can (docs/letter-send-flow.md, Rollout).
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
| Checkout on pay.letterirl.com | | | production | | |
| Package uploaded, metadata findings resolved | | | production | | |
| Sign-in client (CIMD document) checked | | | production | | |
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
