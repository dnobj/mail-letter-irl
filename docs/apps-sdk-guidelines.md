# OpenAI Apps SDK Guidelines

Last verified: March 17, 2026

This file records the subset of current Apps SDK guidance that materially affects Letter IRL. Treat it as a derived engineering reference, not the normative spec.

## Metadata

- Keep app and tool descriptions concise and capability-focused.
- Include operationally necessary prerequisites, such as pre-purchased letter sends on `letterirl.com`.
- Avoid long planner instructions, decision trees, or promotional copy in tool descriptions.
- Prefer a small number of clear example prompts over large blocks of instructional prose.

## Auth

- Expose protected resource metadata and authorization server metadata.
- Prefer Client ID Metadata Documents; keep DCR only as fallback.
- Add `securitySchemes` to tool metadata.
- Return `_meta["mcp/www_authenticate"]` on auth-required tool errors so ChatGPT can trigger linking flows.

## UI

- Register widgets as MCP resources with `ui://` URIs.
- Use `text/html;profile=mcp-app`.
- Keep inline UI lightweight and purpose-built.
- Do not assume an automatic greeting hook when the app is selected.

## Onboarding

- Use supported surfaces only:
  - app description
  - app instructions
  - conversational responses
  - optional onboarding tool/widget
- Letter IRL uses the `get_started` tool for first-run help and broad prompts like `what can you do?`

## Delivery messaging

- Use conservative, estimated delivery guidance.
- Preferred wording for Letter IRL:
  - `Mailed in 1-2 business days; usually arrives in 1-2 weeks. USPS timing varies and can take longer.`
- Do not imply guaranteed delivery dates or confirmed carrier tracking where only estimated status is available.

## Verification surfaces

- `npm run lint`
- `npm run test:submission`
- `npm run test:run`
- `npm run manifest:generate`

## Source links

- OpenAI metadata guidance: `https://developers.openai.com/apps-sdk/build/optimize-metadata/`
- OpenAI auth guidance: `https://developers.openai.com/apps-sdk/build/auth/`
- OpenAI UI guidance: `https://developers.openai.com/apps-sdk/build/chatgpt-ui/`
- OpenAI connect guide: `https://developers.openai.com/apps-sdk/guides/connect-from-chatgpt/`
- OpenAI submission guidelines: `https://developers.openai.com/apps-sdk/app-submission-guidelines/`
