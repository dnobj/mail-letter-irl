# MCP Debugging Notes

**Last Updated:** September 23, 2026
**Purpose:** Transport-level troubleshooting for the MCP endpoint

This document captures lessons learned while wiring the Letter IRL MCP server into ChatGPT Apps (November 2025). Refer here when troubleshooting connector issues. For widget problems see [learnings/widget-debugging-notes.md](learnings/widget-debugging-notes.md); for OAuth see [learnings/chatgpt-auth0-oauth-learnings.md](learnings/chatgpt-auth0-oauth-learnings.md).

## 1. HTTP Transport Requirements
- **Use the Streamable HTTP transport** (`StreamableHTTPServerTransport`). The Apps SDK expects HTTPS and SSE support; stdio is limited to local tests.
- **Allowed hosts/origins:** configure `LETTER_IRL_ALLOWED_HOSTS`, `LETTER_IRL_ALLOWED_ORIGINS`, and `LETTER_IRL_DEFAULT_ORIGIN` so both `localhost`/`127.0.0.1` (dev) and your tunnel domain (e.g., ngrok) are permitted.
- **Endpoint paths:** the MCP endpoint is `/mcp` (with `/mcp/sse` for the SSE fallback). The same process serves `/healthz`, `/readyz`, `/manifest.json`, the `/.well-known/*` OAuth metadata and the plugin portal's `/.well-known/openai-apps-challenge`, `/widgets/<name>.html`, `/webhooks/stripe`, `/purchase/start` and `/purchase/return`, and the dashboard's `/api/*` routes. The dispatch in `src/mcp/httpServer.ts` is the complete list.

## 2. Tunneling Tips
- `ngrok http 8090` (or `cloudflared tunnel --url http://localhost:8090`) exposes the local server with a valid TLS cert that ChatGPT accepts.
- Use the ngrok inspector (`http://127.0.0.1:4040`) to inspect `/mcp` requests; it reveals JSON errors even when the server console stays quiet.

## 3. Initialization Gotchas
- ChatGPT sends two `initialize` JSON-RPC calls in quick succession (protocol versions `2025-03-26` then `2025-06-18`).
- **Do not set `sessionIdGenerator`** on `StreamableHTTPServerTransport` unless you want to enforce per-session state. Leaving it unset avoids the "Invalid Request: Server already initialized" 400 response on the second initialize.
- Because we removed session tracking, `Mcp-Session-Id` headers are no longer required for subsequent requests.

## 4. Manual Testing Scripts
These scripts date from November 2025 and hardcode a retired ngrok hostname and the pre-CIMD registration endpoint. Pass your own URL, and override the exported variables before relying on them.

- `scripts/run-mcp-http.sh` starts the HTTP server with tunnel-oriented env vars and logs output to `logs/mcp-http.log`.
- `scripts/test-mcp-endpoint.sh <url>` issues a POST with `Accept: application/json, text/event-stream` to mimic Apps SDK traffic. Use it to verify headers reach the tunnel.
- `scripts/test-initialize.sh` sends an explicit `initialize` request for debugging handshake issues.

## 5. Common Errors & Fixes
| Error | Cause | Fix |
| --- | --- | --- |
| `Invalid Host header` | Host not in `LETTER_IRL_ALLOWED_HOSTS` | Add tunnel hostname (with and without port) to env var. |
| `Invalid Origin header` | Missing `Origin` header or not in allowlist | Set `LETTER_IRL_DEFAULT_ORIGIN` fallback and expand `LETTER_IRL_ALLOWED_ORIGINS`. |
| `Not Acceptable: Client must accept text/event-stream` | `Accept` header missing JSON/SSE combo | Ensure client sends `Accept: application/json, text/event-stream`. |
| `Bad Request: Mcp-Session-Id header is required` | Session IDs enabled but header missing | Avoid setting `sessionIdGenerator` unless the client keeps a session ID. |
| `Invalid Request: Server already initialized` | Second initialize rejected due to session enforcement | Same fix: disable session IDs or handle reinitialization logic. |

## 6. Widgets & Manifest
- ChatGPT loads widgets as MCP resources (`ui://widgets/<name>.html@v<N>`), not over HTTP; `/widgets/<WidgetName>.html` is a convenience for checking the HTML over the tunnel. See [ui-widgets.md](ui-widgets.md).
- The SDK has no manifest API. Tool schemas reach clients through `mcpServer.registerTool(...)` in `src/mcp/registerTools.ts`; `/manifest.json` is built separately by `src/mcp/manifest.ts`.

Having this checklist handy should make future MCP/App debugging much faster. Update it whenever a new edge case surfaces.
