# ChatGPT App Integration Learnings

This log captures short notes discovered while connecting Letter IRL to the ChatGPT Apps SDK in November 2025.

## 2025-11-07 — Tool Content Type Validation
- The MCP Inspector rejects tool responses whose `content` items have `type: "json"`; only the standard literal values (`text`, `image`, `audio`, `resource`, `resource_link`) are permitted.
- Resolution: emit a brief textual summary in `content` (e.g., `"Balance: 5 credits"`) and keep the detailed data plus metadata inside `structuredContent`. Widgets still render from `structuredContent`.
- Symptom in ChatGPT: tool call returned HTTP 200 but surfaced error code 424 with the message “issue retrieving your balance.” MCP Inspector showed `ZodError invalid_union` at `content[0].type`.

## 2025-11-07 — Initialization Flow
- ChatGPT sends two `initialize` requests with different `protocolVersion` values. Enabling `sessionIdGenerator` in the Streamable HTTP transport caused the second initialize to fail with “Server already initialized.”
- Resolution: remove the custom session ID generator so the transport remains stateless. `Mcp-Session-Id` headers are no longer required for subsequent requests.

## 2025-11-08 — OAuth Reality Check
- Google Identity Platform / Firebase Auth does **not** expose RFC 7591 dynamic client registration to external developers; you must create OAuth clients manually in the console, so ChatGPT’s connector flow can’t auto-register there.citestackoverflow.com/questions/30385666/which-well-known-openid-providers-is-a-new-site-expected-to-support
- We added a `/oauth/register` stub that returns a pre-provisioned client ID to unblock testing, but a production deployment should rely on an identity provider that supports RFC 7591 (e.g., Auth0/Okta CIC).
- If you want to stay on Google Cloud, the recommended best-of-breed approach is: Auth0 for identity (dynamic registration), Firestore/Cloud Run/etc. for data, with the MCP server validating Auth0-issued tokens.

Update this file whenever a new integration quirk is uncovered.
