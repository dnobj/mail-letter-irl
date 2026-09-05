# Letter IRL Prototype

This repository contains the Letter IRL build documentation, an MCP server scaffold, and prototype Apps SDK widgets. The server code is written in TypeScript and designed to register four tools (`quote_and_preview_letter`, `send_letter`, `get_order_status`, `get_account_balance`).

## Project Structure
- `docs/` — Modular Markdown documentation covering requirements, flows, APIs, roadmap, and engineering plan.
- `src/contracts/` — Shared TypeScript interfaces used across modules.
- `src/logging/` — Structured logging utility with redaction helpers.
- `src/services/` — Domain services (credits, orders, preview generation).
- `src/store/` — Persistence adapters (in-memory stub by default).
- `src/mcp/` — MCP glue code (schemas, tool registration, stdio and HTTP transport entrypoints).
- `manifest.json` — Public manifest describing Letter IRL tools/schemas, served at `/manifest.json` when the HTTP server runs.
- `src/tools/` — MCP tool handlers wired to services and logging.
- `src/cli/` — Developer tooling including the flow exerciser harness.
- `widgets/` — HTML prototypes for the Apps SDK widget templates referenced in `_meta.openai/outputTemplate`.

## Getting Started
1. Install dependencies (requires Node.js 18+):
   ```bash
   npm install
   ```
2. Run the server scaffold (logs registered tools):
   ```bash
   npm run start
   ```
3. Execute the end-to-end flow exerciser (covers Flows A–C with logging output):
   ```bash
   npm run flow
   ```
4. Run the MCP stdio server (for local development or tests that prefer stdin/stdout):
   ```bash
   npm run mcp:stdio
   ```
   Set `LETTER_IRL_DEFAULT_USER_ID` to override the stub user identity passed to the backend.
5. Run the streamable HTTP MCP server (required for ChatGPT Apps submissions):
   ```bash
   npm run mcp:http
   ```
   Configure `LETTER_IRL_HTTP_HOST`, `LETTER_IRL_HTTP_PORT`, `LETTER_IRL_ALLOWED_HOSTS`, `LETTER_IRL_ALLOWED_ORIGINS`, `LETTER_IRL_DEFAULT_ORIGIN`, `LETTER_IRL_WIDGET_PATH`, and (optionally) `LETTER_IRL_MANIFEST_ROUTE` as needed. Defaults cover `127.0.0.1`/`localhost` with ports so local calls succeed, and the server automatically protects against missing `Origin` headers. Use `http://<host>:<port>/mcp` as the Apps SDK endpoint, `/widgets/<name>.html` for widget assets, and `/manifest.json` (by default) when ChatGPT asks for the manifest URL.
6. Generate TypeScript output (optional if bundling):
   ```bash
   npm run build
   ```

## Next Steps
- Implement the real `@openai/mcp-sdk` integration inside the interface layer, registering tools with the Apps runtime.
- Replace placeholder persistence with a durable adapter or the Apps SDK `user_data` API while keeping the repository interfaces intact.
- Expand structured logging sinks (e.g., pipe to Datadog) as needed; the shared logger module already centralizes redaction.
- Connect the HTML widget prototypes to the Apps SDK loader of choice, ensuring `window.renderContext` and `window.openai` are correctly wired.
- Validate requirements against updated OpenAI Apps SDK documentation (see `docs/openai-app-sdk-notes.md`).

## Configuration
Letter IRL reads the following environment variables at runtime:

- `LETTER_IRL_HTTP_HOST` / `LETTER_IRL_HTTP_PORT` — bind address for the MCP HTTP server (default `127.0.0.1:8090`).
- `LETTER_IRL_ALLOWED_HOSTS` / `LETTER_IRL_ALLOWED_ORIGINS` — comma-delimited allowlists for host and origin headers.
- `LETTER_IRL_WIDGET_PATH`, `LETTER_IRL_MANIFEST_ROUTE`, `LETTER_IRL_OPENID_ROUTE`, `LETTER_IRL_PROTECTED_RESOURCE_ROUTE` — override default asset and metadata routes (`/widgets`, `/manifest.json`, `/.well-known/openid-configuration`, `/.well-known/oauth-protected-resource`).
- `LETTER_IRL_PUBLIC_BASE_URL` — external HTTPS base URL (e.g., your ngrok domain) used in manifest and OAuth metadata.
- `LETTER_IRL_REQUIRE_AUTH` — set to `false` to disable OAuth enforcement during local testing (default `true`).
- `LETTER_IRL_OAUTH_ISSUER`, `LETTER_IRL_OAUTH_JWKS_URI`, `LETTER_IRL_OAUTH_AUTH_ENDPOINT`, and `LETTER_IRL_OAUTH_TOKEN_ENDPOINT` — the real Auth0 authorization server. Letter IRL publishes only protected-resource metadata in normal CIMD mode.
- `LETTER_IRL_MCP_RESOURCE` / `LETTER_IRL_OAUTH_AUDIENCE` — the same exact environment-specific HTTPS `/mcp` URL for the dedicated Auth0 MCP API.
- `LETTER_IRL_OAUTH_SCOPES` — identity scopes plus `mail:read`, `mail:draft`, and `mail:send`; tools advertise and enforce the minimum product scope.
- `LETTER_IRL_OAUTH_ALLOWED_ALGORITHMS` — must be `RS256`.
- `LETTER_IRL_DEPLOYMENT_ENVIRONMENT` and the matching issuer allowlist variable — prevent development/production tenant crossover at startup.
- `LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY` / `CHATGPT_STATIC_CLIENT_ID` — temporary environment-specific rollback only; disabled for Auth0 public CIMD.
- `LETTER_IRL_DEFAULT_USER_ID` — fallback user ID when auth is disabled.

See `docs/oauth-cimd-migration-plan.md` for the approved ChatGPT/Auth0 architecture.
