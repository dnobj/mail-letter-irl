# Use Cases

Last updated: April 16, 2026

This document tracks market-facing and workflow-facing use cases for Letter IRL. Use cases overlap with user stories, but they are not the same thing:

- Use cases describe why someone would use Letter IRL in the real world.
- User stories describe what the product must do, with acceptance criteria that can become tests.
- Personas describe who the user is and what they care about.

Use this file for positioning, roadmap planning, app-directory submissions, demos, and integration strategy. Link to `docs/user-stories.md` when a use case becomes specific enough to test.

## How to Track Ideas

Use the idea tracker for rough possibilities, early customer signals, and integration concepts. Promote an idea into a full use case section when it becomes important enough to evaluate seriously.

Recommended fields:

- **Current fit:** How well the current product supports the idea today.
- **Gaps:** What prevents the idea from working smoothly.
- **Feature requests:** Product or platform changes that would make the use case stronger.
- **Next step:** The smallest useful validation step.

## Summary Matrix

| Use Case | Primary Audience | Primary Surface | Related Personas | Related Stories |
| --- | --- | --- | --- | --- |
| Personal thank-you or occasion letter | Consumers | ChatGPT, Claude, website | Sarah, Eleanor, Nina | US-LETTER-01, US-LETTER-02, US-CREDIT-01 |
| Postcard from a photo or generated image | Consumers, creatives | ChatGPT, Claude | Sarah, David | US-POSTCARD-01, US-POSTCARD-02, US-POSTCARD-03 |
| Client follow-up or professional thank-you | Small business | ChatGPT, Claude, agentic systems | David, Marcus | US-LETTER-01, US-LETTER-02, US-LETTER-05, US-CREDIT-04 |
| Relationship maintenance workflow | Consumers, professionals | ChatGPT, Claude, automations | Marcus, Eleanor | US-LETTER-04, US-LETTER-05, US-CREDIT-08 |
| Agentic physical-mail action | Developers, agent builders | MCP clients, OpenClaw, Cursor, Codex, Claude Code | Morgan, Jordan | US-MCP-01, US-MCP-03, US-MCP-04, US-DCR-01 |
| Business automation / CRM follow-up | SMB, operators | Zapier, Copilot Studio, custom agents | David, Jordan | US-MCP-01, US-LETTER-03, US-LETTER-04, US-EDGE-03 |
| Reviewer/demo walkthrough | App reviewers, internal QA | ChatGPT app submission | Nina, Sarah, David | US-MCP-13, US-MCP-14, US-MCP-15 |

## Idea Tracker

| Idea | Audience | Current Fit | Gaps / Risks | Feature Requests | Next Step |
| --- | --- | --- | --- | --- | --- |
| Thank-you notes for family, friends, hosts, gifts, and favors | Consumers | Strong fit: text-only letters, preview, confirmation, credits | Saved recipients would reduce repeat friction | Address book / saved recipients; reusable sender profile | Use in ChatGPT submission examples and marketing copy |
| Sympathy, condolence, and difficult-message letters | Consumers | Good fit: AI helps with tone, preview provides confidence | Sensitive content needs careful tone and user control | More explicit tone controls; optional templates | Add prompt examples and safety guidance |
| Birthday, holiday, and seasonal cards | Consumers | Partial fit: postcards and letters work today | Not true folded greeting cards; seasonal templates absent | Greeting card mail type; seasonal templates; saved occasions | Track as future product line |
| Postcards from travel photos or AI-generated images | Consumers, creatives | Strong fit on desktop/web with image support | ChatGPT mobile image handoff is unreliable | Better mobile image fallback; direct upload from website; image reuse library | Keep as demo scenario, but note mobile caveat |
| Client thank-you after meetings, appointments, or purchases | Small business | Strong fit for low-volume personalized letters | Business users may want saved branding, saved recipients, receipts | Address book; business sender profiles; exportable receipts; branded header defaults | Add business landing-page copy and test prompts |
| Real estate follow-up postcards | Small business | Partial fit: postcards work, personalization works | Repeated recipient entry and image/template setup may be tedious | Saved recipients; postcard templates; CRM import; campaign batches | Validate with 1-2 real estate example workflows |
| Donor stewardship thank-you letters | Nonprofits | Partial fit: personalized physical thank-yous are compelling | Needs batching, donor data import, and approval workflow | CSV/CRM import; small-batch review queue; org accounts | Keep as candidate future business use case |
| Customer appreciation after support resolution | SMB, customer success | Partial fit: single sends work well | Automation and audit trail become important | Zapier/Copilot integration; approval queue; webhooks | Prototype via MCP/custom agent before building native CRM features |
| Agentic physical-mail action for OpenClaw, Claude Code, Cursor, Codex, Copilot | Developers, agent builders | Good fit: MCP tools, OAuth/PAT docs, preview/confirm safety model | Packaging and auth vary by client | Agent pack; platform-specific install docs; smoke tests | Create `docs/agent-marketplaces.md` and packaging checklist |
| CRM or Zapier-triggered follow-up drafts | SMB, automation users | Partial fit: MCP/PAT can support custom agents | Headless auth, approval, and sender/recipient management need care | Zapier integration; approval links; webhooks; scoped PATs | Research Zapier/Copilot Studio packaging after ChatGPT submission |
| Recurring relationship maintenance reminders | Consumers, professionals | Partial fit: sending works, reminders do not | Needs scheduling/reminders and address book | Reminder system; saved recipients; occasion dates | Consider website/account feature after core submission |
| International mail | Consumers, expats, businesses | Not currently fit: product is U.S.-only | Provider, pricing, address validation, policy complexity | International provider support; pricing model; expanded validation | Keep as explicit future use case / feature request |
| Bulk personalized campaigns | Businesses | Weak fit by design; anti-persona risk | Spam/abuse, deliverability, rate limits, compliance | Small-batch approval workflow only, not bulk spam tooling | Keep constrained: "small-batch personalized", not mass mail |

## UC-001: Personal Thank-You or Occasion Letter

**User goal:** Send a warm, personal physical letter without buying stamps, envelopes, or formatting the letter manually.

**Typical prompt:**

> Help me write and mail a thank-you letter to my aunt for hosting Thanksgiving. Make it warm and specific, then show me the preview before sending.

**Why this works:**

- ChatGPT/Claude help with tone, structure, and emotional nuance.
- Letter IRL converts the conversational draft into real USPS mail.
- Preview and confirmation reduce anxiety around sending a paid, physical item.

**Related docs:**

- `docs/personas.md`: Sarah, Eleanor, Nina
- `docs/user-stories.md`: US-LETTER-01, US-LETTER-02, US-CREDIT-01
- `docs/app-submission/openai-test-cases.md`: Use Case 1

## UC-002: Postcard From a Photo or Generated Image

**User goal:** Turn a vacation photo, family photo, edited image, or AI-generated image into a real postcard.

**Typical prompt:**

> Make this photo into a cheerful postcard for my friend who missed the trip. Add a short note on the back and show me the preview.

**Why this works:**

- Image generation/editing creates a natural bridge into physical mail.
- Postcards are visually memorable and demo well.
- The use case shows why an AI-native mail service is more than a web form.

**Related docs:**

- `docs/personas.md`: Sarah, David
- `docs/user-stories.md`: US-POSTCARD-01, US-POSTCARD-02, US-POSTCARD-03
- `docs/app-submission/demo-scenarios.md`: Scenario 2

## UC-003: Client Follow-Up or Professional Thank-You

**User goal:** Send a polished physical follow-up after a meeting, purchase, appointment, referral, or service call.

**Typical prompt:**

> Draft a short professional thank-you letter to this client after our consultation. Keep it sincere, not salesy, and wait for my approval before sending.

**Why this works:**

- Physical mail helps business communication stand out from email.
- AI helps personalize without making the user start from a blank page.
- Transaction history and status tracking matter for business users.

**Related docs:**

- `docs/personas.md`: David, Marcus
- `docs/user-stories.md`: US-LETTER-01, US-LETTER-02, US-LETTER-05, US-CREDIT-04

## UC-004: Relationship Maintenance Workflow

**User goal:** Keep in touch with family, friends, clients, donors, or professional contacts through recurring physical correspondence.

**Typical prompt:**

> Help me send a quick check-in letter to my grandmother. Mention the kids, keep it simple, and make sure it feels like me.

**Why this works:**

- Letter IRL removes the logistical friction from a meaningful habit.
- AI can help users who know what they feel but struggle to phrase it.
- Status and history help regular senders avoid losing track.

**Related docs:**

- `docs/personas.md`: Marcus, Eleanor
- `docs/user-stories.md`: US-LETTER-04, US-LETTER-05, US-CREDIT-08

## UC-005: Agentic Physical-Mail Action

**User goal:** Give an AI agent a safe, user-confirmed way to take a real-world physical action: mailing a letter or postcard.

**Typical prompt:**

> Use Letter IRL to draft a physical follow-up letter from this conversation. Preview it first and do not send until I explicitly confirm.

**Target systems:**

- ChatGPT / OpenAI Apps and connectors
- Claude / Claude Code
- Cursor
- VS Code / GitHub Copilot
- OpenAI Codex
- OpenClaw
- Custom MCP clients

**Why this works:**

- Most agentic tools operate in software only; Letter IRL gives agents a tangible output.
- MCP makes the capability portable across clients.
- Explicit preview and confirmation are essential safety rails.

**Related docs:**

- `docs/personas.md`: Morgan, Jordan
- `docs/user-stories.md`: US-MCP-01, US-MCP-03, US-MCP-04, US-DCR-01
- `docs/mcp-authentication.md`
- `docs/mcp-website-integration.md`

## UC-006: Business Automation / CRM Follow-Up

**User goal:** Use an agent or workflow automation to draft and send approved physical follow-ups from business events.

**Example workflows:**

- After a sales call, draft a personalized thank-you letter.
- After a real estate showing, draft a postcard to the prospect.
- After a donation, draft a donor thank-you note.
- After a support resolution, draft a customer appreciation letter.

**Why this works:**

- Small businesses often want personal touches but lack time.
- Physical mail can be high-signal when used selectively.
- Agent workflows can prepare drafts while still requiring user approval before sending.

**Likely surfaces:**

- Zapier
- Microsoft Copilot Studio
- Custom internal agents
- CRM-adjacent MCP clients

**Related docs:**

- `docs/personas.md`: David, Jordan
- `docs/user-stories.md`: US-MCP-01, US-LETTER-03, US-LETTER-04, US-EDGE-03

## UC-007: Reviewer / Demo Walkthrough

**User goal:** Show app reviewers or prospective users that Letter IRL safely drafts, previews, and sends physical mail through a conversational flow.

**Demo requirements:**

- Show that Letter IRL sends real physical USPS mail.
- Show the pre-paid credit requirement clearly.
- Show preview before send.
- Show explicit confirmation before send.
- Show status or account state after sending.

**Related docs:**

- `docs/chatgpt-app-submission.md`
- `docs/app-submission/openai-test-cases.md`
- `docs/app-submission/demo-scenarios.md`
- `docs/user-stories.md`: US-MCP-13, US-MCP-14, US-MCP-15

## Candidate Future Use Cases

Track these as possibilities, not commitments:

- Greeting cards and seasonal cards
- Sympathy and condolence notes
- Donor stewardship for nonprofits
- Patient/client follow-up for professional services
- Handwritten-style premium letters
- Address book / saved recipients
- International mail
- Bulk-but-personalized small-batch campaigns

## Feature Request Themes

These themes recur across multiple use cases:

| Theme | Helps Use Cases | Notes |
| --- | --- | --- |
| Address book / saved recipients | UC-001, UC-003, UC-004, business automation | Likely one of the highest-leverage future features because many use cases involve repeated recipients. |
| Sender profiles / business identities | UC-003, UC-006 | Helps business users keep return address, branding, and tone consistent. |
| Templates and occasion presets | UC-001, UC-002, seasonal cards | Useful for onboarding and marketing, but should not make messages feel generic. |
| Approval workflows | UC-005, UC-006 | Critical for agentic and automation surfaces; physical mail should remain user-confirmed. |
| Platform packaging docs | UC-005 | Needed for Claude Code, Cursor, OpenClaw, Codex, Copilot, and custom MCP clients. |
| Mobile image fallback | UC-002 | Important because postcard demos are strong, but mobile image handoff is a known weak spot. |
| Webhooks/status notifications | UC-006 | Helps agents and automations know what happened after send. |
| Small-batch workflows | UC-003, UC-006 | Potential business feature, but should be constrained to avoid spam/bulk-mail positioning. |

## Maintenance Notes

- Add use cases here before turning them into user stories.
- Cross-reference personas and user stories when the use case becomes concrete.
- Add feature requests to `docs/user-stories.md` or the feedback system once they need acceptance criteria.
- Keep platform-specific packaging ideas aligned with `docs/agent-platform-strategy.md`.
- Keep anti-use-cases aligned with `docs/personas.md`, especially bulk spam, scams, or abusive mail.
- Keep app-directory examples aligned with `docs/app-submission/openai-test-cases.md`.
