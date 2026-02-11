# ChatGPT App Directory Submission

**Last Updated:** February 10, 2026
**Purpose:** Single source of truth for Letter IRL's OpenAI Apps Directory submission

---

## Overview

Letter IRL is an MCP-based ChatGPT app for sending physical letters and postcards. This document tracks submission requirements against the [current OpenAI guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines/) and lists remaining action items.

**App Summary:** Users compose letters through ChatGPT conversation, preview them in a custom widget, and mail them via USPS — all without leaving ChatGPT.

---

## Technical Compliance Status

### Transport & Protocol

| Requirement | Status | Details |
|-------------|--------|---------|
| HTTPS endpoint | Done | `https://api.letterirl.com/mcp` on Railway |
| Streamable HTTP transport | Done | manifest.json updated to `streamableHttp` |
| manifest.json served | Done | `GET /manifest.json` handler in httpServer.ts |

### OAuth & Authentication (RFC 9470)

| Requirement | Status | Details |
|-------------|--------|---------|
| Protected resource metadata | Done | `/.well-known/oauth-protected-resource` returns RFC 9470 format (`resource`, `authorization_servers`, `scopes_supported`) |
| Authorization server metadata | Done | `/.well-known/oauth-authorization-server` with correct fields |
| DCR endpoint | Done | `/oauth/register` returns static client with review redirect |
| PKCE (S256) | Done | `code_challenge_methods_supported: ["S256"]` |
| Production redirect URI | Done | `https://chatgpt.com/connector_platform_oauth_redirect` |
| Review redirect URI | Done | `https://platform.openai.com/apps-manage/oauth` |
| Token validation | Done | JWT verified against Auth0 JWKS (iss, exp, aud, sub) |
| `securitySchemes` per tool | Not implemented | Optional — tools inherit server default. Low rejection risk. |

### Tool Annotations

All 13 tools have annotations set via `buildAnnotations()` in `registerTools.ts`:

| Tool | readOnly | openWorld | destructive | idempotent |
|------|----------|-----------|-------------|------------|
| get_account_balance | true | - | - | - |
| get_order_status | true | - | - | - |
| get_return_address | true | - | - | - |
| list_orders | true | - | - | - |
| quote_and_preview_letter | - | true | - | - |
| quote_and_preview_letter_with_header_image | - | true | - | - |
| quote_and_preview_letter_with_image | - | true | - | - |
| quote_and_preview_postcard | - | true | - | - |
| send_letter | - | true | - | true |
| send_postcard | - | true | - | true |
| set_return_address | - | true | - | true |
| clear_return_address | - | - | true | true |
| submit_feature_request | - | - | - | - |

Note: Quote/preview tools are NOT `readOnlyHint: true` because they create draft records. See `docs/learnings/tool-annotation-decision.md`.

### Tool Response Format

| Requirement | Status | Details |
|-------------|--------|---------|
| `structuredContent` (model + widget) | Done | Lean data only, no HTML |
| `content` (narration for model) | Done | Human-readable summary per tool |
| `_meta` (widget-only heavy data) | Done | Preview HTML, base64 images kept out of model context |

### Widget Resources

| Requirement | Status | Details |
|-------------|--------|---------|
| Widgets registered as MCP resources | Done | `ui://widgets/LetterPreviewCard.html`, `ui://widgets/PostcardPreviewCard.html` |
| MIME type `text/html+skybridge` | Done | Signals ChatGPT to inject `window.openai` runtime |
| `openai/widgetDomain` | Done | Set to `https://api.letterirl.com` (app's own domain) |
| `openai/widgetCSP` | Done | `connect_domains`, `resource_domains` declared |
| `openai/widgetPrefersBorder` | Done | Set to `true` |
| No `frame_domains` (avoids extra review) | Done | We don't use iframes |

### Content Security Policy

CSP is declared via MCP resource metadata (not HTTP headers), per the Apps SDK pattern:

```json
{
  "connect_domains": ["https://chatgpt.com", "https://api.letterirl.com"],
  "resource_domains": ["https://*.oaistatic.com"]
}
```

---

## Guideline Compliance

### App Fundamentals

- [x] Clear purpose (physical letter mailing — beyond ChatGPT's native capabilities)
- [x] Complete app (not demo/trial — real PostGrid, Stripe, Auth0 integrations)
- [x] Stable and tested (unit tests, flow exerciser, error handling on all paths)
- [x] Clear naming ("Letter IRL" — unambiguous, not a generic dictionary word)
- [x] No crashes, hangs, or inconsistent behavior
- [x] No misleading designs or impersonation

### Tool Requirements

- [x] Human-readable verb names (`send_letter`, `get_order_status`, etc.)
- [x] Unique names within app
- [x] Descriptions match behavior, mention side effects
- [x] Correct annotations (readOnlyHint, openWorldHint, destructiveHint)
- [x] Minimal inputs — only data required for the operation
- [x] No hidden side effects — `send_letter` requires `confirm: true`
- [x] Idempotent where applicable (draft consumption prevents double-sends)
- [x] Tool names are final — **names, signatures, and descriptions lock after publication**

### Commerce & Monetization

- [x] Physical goods only (printed letters delivered via USPS)
- [x] External checkout (Stripe Checkout on `letterirl.com`, not embedded in ChatGPT)
- [x] No advertisements
- [x] No subscriptions or digital-only products

**Risk area — "credits" terminology:** The guidelines prohibit "tokens, credits" as digital products. Our credit system is prepayment for physical goods (like postage stamps or arcade tokens). The credits have no standalone value and always redeem for a physical letter. Framing in submission: *"Users pre-purchase letter sends (physical mail delivery). The balance shown represents remaining physical letter deliveries, not a digital currency."*

### Safety

- [x] OpenAI usage policy compliant
- [x] General audience suitable (ages 13+)
- [x] Addresses user requests directly (no cross-selling in tool responses)
- [x] No unrelated content or redirects
- [x] Rate limiting enforced (tiered: 10/30/100 req/min by user trust level)
- [x] No third-party API usage without authorization (PostGrid, Stripe, Auth0 all contracted)

### Privacy

- [x] Privacy policy published at `https://letterirl.com/privacy`
- [x] Terms of service published at `https://letterirl.com/terms`
- [x] Data minimization (only email, name, addresses, letter content)
- [x] Response minimization (addresses masked to city/state after sending)
- [x] No PCI data (Stripe handles payment)
- [x] No PHI, SSN, or credential collection
- [x] Destructive actions require explicit confirmation (`send_letter` needs `confirm: true`)
- [x] Write actions clearly labeled (openWorldHint, destructiveHint)

### Fair Play (new guideline)

- [x] No competitive language in tool descriptions
- [x] No manipulation of model selection behavior
- [x] Descriptions accurately reflect value without disparaging alternatives

---

## Submission Materials

### Portal Fields

| Field | Status | Value |
|-------|--------|-------|
| App name | Ready | Letter IRL |
| Short description | Ready | Send beautifully formatted physical letters via USPS |
| Long description | TODO | Write 2-3 paragraph value prop |
| Category | Ready | Productivity |
| Icon (512x512 PNG) | Ready | `/mnt/c/letter-irl-website/public/icon-512.png` (133KB) |
| Screenshots | TODO | 3-5 images of key flows |
| Privacy Policy URL | Ready | https://letterirl.com/privacy |
| Terms of Service URL | Ready | https://letterirl.com/terms |
| Support email | Ready | support@letterirl.com |
| Website | Ready | https://letterirl.com |
| MCP server URL | Ready | https://api.letterirl.com/mcp |
| Country availability | Ready | US only |

### Demo Account

| Item | Status | Details |
|------|--------|---------|
| Account exists | Ready | demo@letterirl.com (Email/Password auth) |
| Pre-loaded credits | Ready | 100 credits (50 letters) |
| Sample order history | Ready | 5 orders in various statuses |
| No signup required | Ready | Auto-registration on OAuth |
| No 2FA | Ready | No 2FA on demo account |
| Rate limits | Ready | Unlimited for demo account |

### Developer Verification

- [ ] Organization verified on [platform.openai.com](https://platform.openai.com/settings/organization/general)
- [ ] Owner role confirmed

---

## Remaining Action Items

### Before Submission (priority order)

1. **Verify organization** on OpenAI Platform Dashboard
2. **Write long description** for app directory listing (2-3 paragraphs)
3. **Create screenshots** (3-5 images): composing a letter, preview widget, send confirmation, order tracking, account balance
4. **Test full flow** in ChatGPT Developer Mode:
   - Letter: compose -> preview widget -> send -> status check
   - Postcard flow
   - Account balance / order history
   - Return address save/clear
   - Error cases (insufficient credits, invalid address)
   - Widget rendering (both LetterPreviewCard and PostcardPreviewCard)
5. **Register app** in OpenAI Platform Dashboard
6. **Share demo credentials** with OpenAI in submission notes
7. **Submit for review**

### Post-Submission (if rejected, address these)

- Add `securitySchemes` declarations to tool definitions (currently optional, tools inherit server auth)
- Reframe "credits" language if flagged (use "letter sends remaining" instead)

---

## Common Rejection Reasons (from guidelines)

1. Incorrect or missing tool annotations (readOnlyHint, openWorldHint, destructiveHint)
2. Missing or inaccessible privacy policy
3. Demo account requiring signup or 2FA
4. Overly broad data collection in tool inputs
5. Misleading or promotional tool descriptions
6. Missing Content Security Policy
7. Hidden or implicit side effects
8. Requesting full conversation history in tool inputs
9. `frameDomains` usage (triggers extra review scrutiny)

---

## Pre-Submission Verification Commands

After deploying to production:

```bash
# Protected Resource Metadata (RFC 9470)
curl https://api.letterirl.com/.well-known/oauth-protected-resource | jq .

# Authorization Server Metadata
curl https://api.letterirl.com/.well-known/oauth-authorization-server | jq .

# DCR endpoint
curl -X POST https://api.letterirl.com/oauth/register | jq .

# Manifest
curl https://api.letterirl.com/manifest.json | jq .

# Health check
curl https://api.letterirl.com/healthz
```

---

## Key Warnings

- **Tool names/signatures lock after publication.** Changes require resubmission and re-review. Get names right before submitting.
- **EU data residency projects cannot submit.** Must use global residency.
- **One version under review at a time.** No parallel submissions.
- **Review timelines vary.** Apps SDK is in beta; no SLA on review time.

---

## References

- [App Submission Guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines/)
- [Submit Your App](https://developers.openai.com/apps-sdk/deploy/submission/)
- [MCP Server Build Guide](https://developers.openai.com/apps-sdk/build/mcp-server/)
- [Authentication](https://developers.openai.com/apps-sdk/build/auth/)
- [MCP Apps in ChatGPT](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt/)
- [ChatGPT UI (Widgets)](https://developers.openai.com/apps-sdk/build/chatgpt-ui/)

## See Also

- [apps-sdk-guidelines.md](apps-sdk-guidelines.md) — Detailed compliance analysis per guideline section
- [app-submission/openai-test-cases.md](app-submission/openai-test-cases.md) — Test cases and prompts for review
- [learnings/openai-app-sdk-notes.md](learnings/openai-app-sdk-notes.md) — SDK notes and integration learnings
- [infrastructure.md](infrastructure.md) — External services configuration
