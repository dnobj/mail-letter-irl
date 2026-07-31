# OpenAI Apps SDK Guidelines

Last verified: May 30, 2026

This file records the subset of current Apps SDK guidance that materially affects Letter IRL. Treat official OpenAI documentation as the normative source.

## May 2026 Updates to Track

- ChatGPT reads MCP server `instructions` from the initialization result. Letter IRL now provides concise server-level instructions that reinforce preview-before-send, confirmation, U.S.-only addresses, image handoff order, and feature-request fallback behavior.
- Tool registrations should include `outputSchema` for structured responses. Letter IRL now passes runtime Zod output schemas to `mcpServer.registerTool`, matching the compact `structuredContent` returned to ChatGPT.
- Apps widgets can receive tool result metadata and approved tool input through newer MCP Apps bridge notifications. Letter IRL widgets still use the `window.openai` compatibility bridge, which is acceptable for current behavior but should be revisited before a major widget rewrite.
- ChatGPT now provides standardized host CSS variables through host context. Letter IRL widgets should adopt these variables opportunistically when doing substantial UI refresh work.

## Metadata

- Keep app and tool descriptions concise and capability-focused.
- Include operationally necessary prerequisites, such as pre-paid letter sends from `letterirl.com`.
- Avoid long planner instructions, decision trees, or promotional copy in individual tool descriptions.
- Use server instructions and app instructions for durable behavior rules.

## Auth

- Expose protected-resource metadata with the exact `/mcp` resource, real Auth0
  issuer, and product scopes. Clients discover authorization-server and CIMD
  capabilities from Auth0 itself; Letter IRL must not synthesize them.
- Use the OpenAI-hosted CIMD URL as the public client ID with authorization code,
  PKCE S256, and `token_endpoint_auth_method: none`.
- Add `securitySchemes` to tool metadata.
- Return `_meta["mcp/www_authenticate"]` on auth-required tool errors so ChatGPT can trigger account-linking flows.
- Keep ChatGPT CIMD separate from Claude/PAT authentication. The static DCR shim
  is an explicitly flagged rollback only.
- Keep OAuth config non-secret in docs; never commit credentials, private keys, or billing details.

## UI

- Register widgets as MCP resources with `ui://` URIs.
- Use `text/html;profile=mcp-app`.
- Keep inline UI lightweight and purpose-built.
- Put large render artifacts in `_meta`, not `structuredContent`.
- Do not assume an automatic greeting hook when the app is selected.

## Tool Responses

- Return all three response surfaces where useful:
  - `structuredContent`: compact, schema-validated data for the model and widget.
  - `content`: short narration for the model.
  - `_meta`: widget-only payloads such as preview HTML or image preview data.
- Preview tools are write tools because they create draft records, even though they do not send mail.
- Send tools must require explicit confirmation and must be idempotent for retry safety.

## Delivery Messaging

- Use conservative, estimated delivery guidance.
- Preferred wording for Letter IRL:
  - `Mailed in 1-2 business days; usually arrives in 1-2 weeks. USPS timing varies and can take longer.`
- Do not imply guaranteed delivery dates or confirmed carrier tracking where only estimated status is available.

## Verification Surfaces

- `npm run lint`
- `npm run test:submission`
- `npm run test:run`
- `npm run manifest:generate`

## Source Links

- Apps SDK changelog: `https://developers.openai.com/apps-sdk/changelog`
- MCP server guide: `https://developers.openai.com/apps-sdk/build/mcp-server`
- ChatGPT UI guide: `https://developers.openai.com/apps-sdk/build/chatgpt-ui`
- Auth guide: `https://developers.openai.com/apps-sdk/build/auth/`
- Connect guide: `https://developers.openai.com/apps-sdk/guides/connect-from-chatgpt/`
- Submission guidelines: `https://developers.openai.com/apps-sdk/app-submission-guidelines/`
