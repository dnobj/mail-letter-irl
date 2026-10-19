# MCP Debugging Notes

**Last Updated:** October 19, 2026
**Purpose:** Transport-level troubleshooting for the MCP endpoint

This document captures lessons learned while wiring the Letter IRL MCP server into ChatGPT Apps (November 2025). Refer here when troubleshooting connector issues. For widget problems see [learnings/widget-debugging-notes.md](learnings/widget-debugging-notes.md); for OAuth see [learnings/chatgpt-auth0-oauth-learnings.md](learnings/chatgpt-auth0-oauth-learnings.md).

## 1. HTTP Transport Requirements
- **The handler is SDK v2's `createMcpHandler`** (`@modelcontextprotocol/server` 2.3.1, mounted with `toNodeHandler` from `@modelcontextprotocol/node`, #477). One handler serves both protocol revisions from one server factory: 2026-07-28 requests (no `initialize`; each request names its revision in `_meta`, and `server/discover` answers the per-app instructions), and 2025-era requests statelessly, one server per request. Answers are JSON only (`responseMode: "json"`). Every cacheable result says `ttlMs: 0` and `cacheScope: "private"`, because the tools, instructions and cards differ by app and by flag. stdio uses `serveStdio` and is limited to local tests.
- **Checks before the handler:** v2's handler checks no Host, no Origin and no token. `src/mcp/httpServer.ts` runs the limiter, the sign-in, the account limiter and then the Host and Origin allow-lists (`src/mcp/mcpEndpoint.ts`) before handing the request over, with the same 403 answers SDK v1's transport gave.
- **Which revision a client speaks:** each `mcp.client_request` log line carries `protocolVersion`: a revision date, `none` or `other`.
- **Allowed hosts/origins:** configure `LETTER_IRL_ALLOWED_HOSTS`, `LETTER_IRL_ALLOWED_ORIGINS`, and `LETTER_IRL_DEFAULT_ORIGIN` so both `localhost`/`127.0.0.1` (dev) and your tunnel domain (e.g., ngrok) are permitted.
- **Endpoint paths:** the MCP endpoint is `/mcp`, streamable HTTP only (POST; a preflight is answered, and GET answers 405). The legacy SSE transport is retired (#730): it ran at GET `/mcp` with `/messages` in both deployments (`/mcp/sse` by default), and `/messages`, `/mcp/sse` and `/mcp/sse/messages` now answer 410. The same process serves `/healthz`, `/readyz`, `/manifest.json`, the `/.well-known/*` OAuth metadata and the plugin portal's `/.well-known/openai-apps-challenge`, `/widgets/<name>.html`, `/webhooks/stripe`, `/purchase/start` and `/purchase/return`, and the dashboard's `/api/*` routes. The dispatch in `src/mcp/httpServer.ts` is the complete list.

## 2. Tunneling Tips
- `ngrok http 8090` (or `cloudflared tunnel --url http://localhost:8090`) exposes the local server with a valid TLS cert that ChatGPT accepts.
- Use the ngrok inspector (`http://127.0.0.1:4040`) to inspect `/mcp` requests; it reveals JSON errors even when the server console stays quiet.

## 3. Initialization Gotchas
- ChatGPT sends two `initialize` JSON-RPC calls in quick succession (protocol versions `2025-03-26` then `2025-06-18`).
- **No sessions.** The 2025-era leg is stateless, a fresh server for each request, so a second `initialize` is answered like the first, and `Mcp-Session-Id` is neither issued nor required. GET and DELETE answer 405. (Under SDK v1 this needed `sessionIdGenerator` left unset.)

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
