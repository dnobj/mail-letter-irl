# OpenAI App SDK Status

**Last Updated:** December 29, 2025
**Purpose:** Track OpenAI Apps SDK requirements, updates, and action items for Letter IRL submission

## Status Summary (as of December 29, 2025)

Letter IRL is ready for Apps SDK submission with the following features:
- 13 MCP tools exposed via HTTP transport
- OAuth 2.1 + PKCE authentication via Auth0
- Custom UI widgets (LetterPreviewCard, PostcardPreviewCard, etc.)
- Production deployment on Railway at api.letterirl.com
- Postcard support with image processing
- Multiple letter layouts (text-only, header image, inline image)
- Saved return address support

**Next Steps:**
1. Submit to OpenAI Apps directory before end of 2025
2. Complete peer review process
3. Monitor for SDK updates and widget API changes

---

## Historical Notes (as of October 29, 2025)

## Release & Availability Highlights
- Apps launched to all ChatGPT users outside the EU on October 6, 2025, with a public Apps directory slated for later in the year; users in the U.S. can submit peer reviews to help enforce quality.citeturn2open0
- OpenAI previewed the Agentic Commerce Protocol (ACP) to enable future monetization once approved sellers can charge for digital or physical goods through Apps.citeturn2open0

## Server Integration Updates
- Apps SDK servers must respond with `AppInputSchema` definitions (inputs, outputs, and optional metadata) for each tool and can embed structured content (tables, charts, cards) in responses instead of plain text.citeturn2open4
- Tool responses can include `binary` resources (e.g., PDFs) or `text/html` renderings to support previews like the Letter IRL letter snapshot.citeturn2open4
- Servers can maintain per-user state through the `user_data` persistence hooks that store arbitrary JSON securely on OpenAI infrastructure.citeturn2open5
- OpenAI recommends hosting Apps SDK backends via the Streamable HTTP transport so ChatGPT can send requests over HTTPS; stdio transports are for local testing only.citeturn0search3

## Widget & UI Bridge Changes
- Widgets receive their data via `window.renderContext.data` and should call `window.openai.callTool(...)` for tool execution; `window.openai.sendFollowUpMessage(...)` replaces prior chat-request helpers for prompting the assistant after user actions.citeturn2open2
- Developers can request UI changes such as compact mode or external navigation using `window.openai.requestDisplayMode` and `window.openai.openExternal`, enabling richer UX while still respecting safety review constraints.citeturn2open2
- `_meta.openai/outputTemplate` should reference registered template IDs (e.g., `LetterPreviewCard`) packaged with the app; templates may include scripts bundled with the app manifest.citeturn2open2

## Policy & Review Considerations
- Each tool must indicate whether it mutates state; review guidelines emphasize clearly separating read-only tools to help reviewers validate safety.citeturn2open1
- Apps dealing with PII (such as mailing addresses) must follow data retention limits and display transparent previews before irreversible actions, aligning with the published policy checklist in the Apps review guidelines.citeturn2open1

## Action Items for Letter IRL
1. Update widget prototypes to use the current bridge methods (`callTool`, `sendFollowUpMessage`) and register template metadata according to the latest SDK packaging guidance.citeturn2open2
2. Extend the MCP server handshake to emit full schema definitions and resource descriptors so previews can render richer HTML or PDF artifacts.citeturn2open4
3. Implement persistent per-user storage through the SDK’s `user_data` APIs instead of the in-memory stub to satisfy review requirements before submission.citeturn2open5
4. Host the MCP server via the Streamable HTTP transport (with HTTPS in production) before submitting to the Apps directory; keep the stdio server for local tests only.citeturn0search3
5. Re-run the checklist from the October 2025 policy update prior to submission to ensure PII handling and confirmation flows meet the latest standards.citeturn2open1
