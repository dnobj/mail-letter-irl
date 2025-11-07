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
   Configure `LETTER_IRL_HTTP_HOST`, `LETTER_IRL_HTTP_PORT`, `LETTER_IRL_ALLOWED_HOSTS`, `LETTER_IRL_ALLOWED_ORIGINS`, `LETTER_IRL_DEFAULT_ORIGIN`, `LETTER_IRL_WIDGET_PATH`, and (optionally) `LETTER_IRL_MANIFEST_ROUTE` / `LETTER_IRL_MANIFEST_FILE` as needed. Defaults cover `127.0.0.1`/`localhost` with ports so local calls succeed, and the server automatically protects against missing `Origin` headers. Use `http://<host>:<port>/mcp` as the Apps SDK endpoint, `/widgets/<name>.html` for widget assets, and `/manifest.json` (by default) when ChatGPT asks for the manifest URL.
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
