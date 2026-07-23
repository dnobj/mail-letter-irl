# ChatGPT App Submission

Last verified: July 23, 2026

This document is a derived checklist for Letter IRL's OpenAI submission. Official OpenAI and MCP docs are the source of truth; this file tracks how the current codebase lines up with them.

For owner-managed submission tasks such as organization verification, screenshots, demo videos, reviewer promo codes, and final portal materials, see `docs/app-submission/owner-checklist.md`.

## Current submission posture

- Transport: Streamable HTTP MCP server at `https://api.letterirl.com/mcp`
- Auth: Auth0 public CIMD with authorization code + PKCE S256, exact `/mcp`
  audience/resource, per-tool scopes, and `mcp/www_authenticate` challenges
- UI: Widgets served as MCP resources with `text/html;profile=mcp-app`
- Onboarding: supported via app description, app instructions, and the `get_started` tool/widget
- Compatibility manifest: runtime-derived at `/manifest.json`; checked-in `manifest.json` is a generated snapshot

## Submission-critical facts

- Letter IRL drafts, previews, and mails real physical letters and postcards through USPS.
- Users must buy pre-paid letter sends on `letterirl.com` before sending mail.
- For OpenAI submission and user-facing commerce copy, use `Letter Packs`, `pre-paid letter sends`, or `letters remaining`; avoid framing the product as generic digital credits or tokens.
- There is no assumed auto-greet hook when the app is merely selected; onboarding must happen through supported conversational/tool surfaces.
- Delivery timing is estimated, not guaranteed.

## Runtime checklist

- [x] `/.well-known/oauth-protected-resource`
- [x] Protected-resource metadata points to the real Auth0 issuer
- [ ] Owner verifies Auth0 discovery advertises CIMD after DEV configuration
- [x] Letter IRL does not synthesize authorization-server/CIMD capabilities
- [x] Tool-level `securitySchemes`
- [x] `_meta["mcp/www_authenticate"]` on auth-required tool errors
- [x] Widget MIME `text/html;profile=mcp-app`
- [x] Read/write annotations align with actual side effects
- [x] Runtime-derived manifest and widget inventory
- [x] First-run onboarding surface (`get_started`)

## Pre-submission commands

Run these from `mail-letter-irl`:

```bash
npm run lint
npm run test:submission
npm run test:run
curl https://api.letterirl.com/.well-known/oauth-protected-resource | jq .
curl https://api.letterirl.com/.well-known/oauth-authorization-server | jq .
curl https://api.letterirl.com/manifest.json | jq .
```

Run these from `mail-letter-irl-website`:

```bash
npm run lint
npm run build
```

## Submission materials

- App name: `Letter IRL`
- Submitting organization: `Objective Works` / DBA `Letter IRL` (see `docs/company-and-accounts.md`)
- App description: `Draft, preview, and mail real physical letters and postcards through USPS from ChatGPT. To send mail, first buy pre-paid letter sends on letterirl.com.`
- Privacy policy: `https://letterirl.com/privacy`
- Terms: `https://letterirl.com/terms`
- Support email: `support@letterirl.com`
- Country availability: U.S.

## Remaining work before submission

- [x] Complete OpenAI Platform identity verification for `Objective Works` as the registered organization / `Letter IRL` as the DBA. Completed on May 31, 2026.
- [x] Confirm your OpenAI Platform account has the `Owner` role for the submitting organization. `dnicholl@objective.works` is listed as Organization Owner.
- [x] Confirm the OpenAI project used for submission has global data residency. Dashboard `GEOGRAPHY` column shows `Global`.
- [x] Verify the production MCP server and OAuth endpoints are live on the public domains you will submit. May 31, 2026 check: `api.letterirl.com` manifest, OAuth metadata, MCP CORS preflight, and unauthenticated auth challenge all advertise the canonical production domain.
- [ ] Review the production widget CSP and confirm it allows only the exact required domains
- [ ] Review submission copy for Letter Packs / pre-paid letter sends wording and remove generic credit/token framing from user-facing materials
- [ ] Capture final submission assets: logo, screenshots, app description, company URL, privacy policy URL, support contact, and localization fields
- [ ] Locate and review final demo videos using `docs/app-submission/owner-checklist.md`
- [ ] Finalize reviewer test prompts and expected responses using `docs/app-submission/openai-test-cases.md`
- [ ] Run the full pre-submission command checklist against production-ready code
- [ ] Do one final manual ChatGPT pass for the highest-risk flows: onboarding, postcard preview, generated-image reuse, upload fallback, send confirmation, and OAuth linking
- [ ] Decide whether any remaining known issues need a mitigation note in reviewer test instructions before submission

## Notes from latest OpenAI guidance

- All submissions must come from a verified individual or organization.
- Only users with the `Owner` role can submit apps for review.
- Submission currently requires a publicly accessible MCP server, a defined widget CSP, screenshots, test prompts/responses, company and privacy policy URLs, and localization information.
- Review is tied to the exact submitted version. If you need to change it while under review, withdraw and resubmit the draft.

## Source links

- OpenAI Apps SDK submission guidelines: `https://developers.openai.com/apps-sdk/app-submission-guidelines/`
- OpenAI metadata guidance: `https://developers.openai.com/apps-sdk/build/optimize-metadata/`
- OpenAI auth guidance: `https://developers.openai.com/apps-sdk/build/auth/`
- OpenAI UI guidance: `https://developers.openai.com/apps-sdk/build/chatgpt-ui/`
- MCP authorization spec: `https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization`
