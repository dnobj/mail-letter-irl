# OpenAI Apps SDK Owner Checklist

Last updated: May 31, 2026

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
- [ ] Confirm checkout occurs externally on `letterirl.com`, not embedded inside the ChatGPT app experience.
- [ ] Confirm reviewer materials describe purchases as simulated/test-mode when using development, or provide a reviewer account with preloaded letter sends.

### Submission Assets

- [ ] Confirm final app name: `Letter IRL`.
- [ ] Confirm final app icon/logo URL: `https://letterirl.com/logo.jpg`.
- [ ] Capture final screenshots from production-ready flows.
- [ ] Locate previously recorded demo videos.
- [ ] Review demo videos against `docs/app-submission/demo-scenarios.md`.
- [ ] Decide whether existing demo videos are final, need edits, or should be re-recorded.
- [ ] Store or link final demo asset locations in this checklist.
- [ ] Confirm app description and short metadata match `docs/chatgpt-app-submission.md`.
- [ ] Confirm localization fields, if required by the submission portal.

### Reviewer Materials

- [ ] Finalize reviewer test prompts and expected responses in `docs/app-submission/openai-test-cases.md`.
- [ ] Prepare a reviewer test account or reviewer-friendly login path, if OpenAI requests one.
- [ ] Prepare a reviewer Letter Pack, promo code, or preloaded letter-send path so reviewers can test send flows without paying.
- [ ] Confirm reviewer instructions clearly state that Letter IRL sends real physical USPS mail.
- [ ] Confirm reviewer instructions explain that users must buy pre-paid letter sends before mailing.
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
- [ ] Test account balance and order status.
- [ ] Test OAuth linking with a fresh account.
- [ ] Verify production MCP endpoint and OAuth endpoints are live. May 31, 2026 check: endpoints are reachable, but production manifest/widget metadata appears stale and needs remediation before submission.

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
- [ ] Production app, MCP server, OAuth, widget CSP, privacy policy, and terms are verified.
- [ ] Final screenshots and demo/video assets are ready.
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
