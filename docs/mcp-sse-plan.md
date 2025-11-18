# HTTP SSE Transport Plan

## Why SSE is Required
ChatGPT connectors read the manifest `servers` array to discover an SSE endpoint before attempting any tool calls. Our current Letter IRL HTTP server only exposes the `StreamableHTTPServerTransport` path (`src/mcp/httpServer.ts:111`) and the manifest does not advertise an SSE server entry, so ChatGPT falls back to its default and reports `Not found`. We need a dedicated SSE transport (matching OpenAI's examples) plus an explicit manifest stanza.

## Reference Implementation — Pizzaz Node Server
The `pizzaz_server_node` sample runs a pure SSE transport using the MCP SDK:
- `SSEServerTransport` is instantiated with the POST relay path and the response stream (`pizzaz_server_node/src/server.ts:292-317`).
- Each SSE connection is tracked in a `sessions` map keyed by `transport.sessionId`, with cleanup hooks on `onclose`/`onerror` (`pizzaz_server_node/src/server.ts:282-349`).
- The HTTP server exposes two routes: `GET /mcp` for the event stream and `POST /mcp/messages?sessionId=...` for JSON-RPC payloads (`pizzaz_server_node/src/server.ts:351-399`).
- CORS preflight responds with `GET, POST, OPTIONS` so ChatGPT's initial `OPTIONS` check succeeds, and both routes set `Access-Control-Allow-Origin: *` to match the Apps SDK samples.

To run the sample (useful while building Letter IRL):
1. `cd /tmp/apps-sdk-examples && pnpm install && pnpm run build` to generate widget bundles.
2. `pnpm run serve` from the repo root to expose `http://localhost:4444` for shared assets.
3. `cd pizzaz_server_node && pnpm install && pnpm start` to boot the SSE MCP server on port 8000.
4. Optionally run `ngrok http 8000` so ChatGPT Dev Mode can point a connector at `https://<subdomain>.ngrok-free.app/mcp`.

## Letter IRL Implementation Steps
1. **Add an SSE transport module.** Create `src/mcp/sseServer.ts` (or extend `httpServer.ts`) that mirrors the sample's session lifecycle: instantiate `SSEServerTransport` with a `postPath`, keep a `Map<sessionId, { server, transport }>` for cleanup, and forward POST bodies to `transport.handlePostMessage`.
2. **Expose configurable GET + POST routes.** Introduce env vars such as `LETTER_IRL_SSE_PATH=/mcp/sse` and `LETTER_IRL_SSE_MESSAGES_PATH=/mcp/sse/messages`. Guard both with the existing host/origin/Auth0 validation so the SSE transport enforces the same security posture as the streamable HTTP endpoint.
3. **Per-session authentication.** Validate the bearer token before accepting the SSE stream and attach the resulting `AuthenticatedUser` to the `McpServer` context so tool handlers still load the correct user account when requests arrive over the POST channel.
4. **Shared tool registration.** Reuse `registerLetterTools` so each SSE session constructs a new `McpServer` with the same tool definitions/output metadata as the streamable HTTP path. This keeps widgets/tool schemas consistent regardless of transport.
5. **Logging and observability.** Emit log entries when SSE sessions start/stop (session ID, user hash, origin) and when POST requests fail, similar to the sample's console logging. This is critical for debugging tunnel or handshake problems.

## Manifest Update (servers block)
Add an explicit server definition so ChatGPT knows the SSE endpoint and associated POST relay. Example placeholder (substitute your real domain/env vars):
```json
"servers": [
  {
    "type": "mcp",
    "name": "letter-irl-sse",
    "url": "${LETTER_IRL_PUBLIC_BASE_URL}/mcp/sse",
    "healthUrl": "${LETTER_IRL_PUBLIC_BASE_URL}/healthz",
    "transport": {
      "type": "sse",
      "stream": "${LETTER_IRL_PUBLIC_BASE_URL}/mcp/sse",
      "messages": "${LETTER_IRL_PUBLIC_BASE_URL}/mcp/sse/messages"
    },
    "auth": {
      "type": "oauth",
      "scopes": ["openid", "email", "profile"],
      "authorizationServer": "${LETTER_IRL_PUBLIC_BASE_URL}/.well-known/oauth-authorization-server"
    }
  }
]
```
This mirrors the structure described in the Apps SDK docs (transport type `sse`, explicit stream + message URLs, and an auth block pointing at our Auth0 metadata). Update `manifest.json` accordingly once the SSE routes exist.
