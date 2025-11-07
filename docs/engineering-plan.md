# Engineering Plan and Modular Architecture

This plan outlines how to evolve the Letter IRL prototype into a production-ready, modular codebase with first-class debugging and logging. Each module should define narrow interfaces so teams (or Codex agents) can build and test pieces independently.

## Target Module Breakdown

### 1. Interface Layer (Apps SDK Bridge)
- Responsibilities: Translate Apps SDK tool invocations into internal commands; register schemas and `_meta` definitions; standardize correlation IDs per request.
- Key Interfaces:
  - `execute(toolName: string, payload: unknown, context: BridgeContext): Promise<AppResponse>`
  - Emits structured logs at entry/exit levels.

### 2. Validation Layer
- Implement with Zod or JSON Schema to normalize inputs before they reach domain logic.
- Export typed helpers such as `validateQuotePreview(input): ParsedQuotePreview`.
- On validation failure: return typed error (e.g., `ValidationError`) and log at `warn` severity with redacted payload summaries.

### 3. Domain Services
- **CreditService** — Functions for checking balances, reserving credits, and emitting domain events (e.g., `creditsDeducted`).
- **OrderService** — Manages order creation, status updates, and timeline generation.
- **PreviewService** — Generates HTML/PDF previews and caches them for thumbnails.
- Each service should expose Promise-based APIs and accept a logger + persistence interface.

### 4. Persistence Layer
- Start with a file-backed adapter for local dev, mirroring the future Apps SDK `user_data` interface (`loadUser(userId)`, `saveUser(userState)`).
- Abstract behind `AccountRepository` and `OrderRepository` interfaces so a future database (or SDK storage) swaps in without touching services.

### 5. Logging & Observability Module
- Wrap pino/winston (or console fallback) to expose `logger.child({ correlationId })`.
- Provide helpers: `logToolStart(toolName, context)`, `logToolSuccess(toolName, resultSummary)`, `logToolFailure(toolName, error)`.
- Ensure redaction utility centralizes removal of PII before logs leave the process.

### 6. Widget Bundle
- Package HTML/JS templates with TypeScript types describing expected props.
- Expose `renderPreviewCard(data: PreviewCardData)` style functions to encourage reuse/testing.

## Recommended Next Steps
1. **Logging Implementation** — Add the logging module, instrument every tool handler, and document log schemas for operations teams.
2. **Validation Integration** — Replace ad-hoc checks with Zod schemas, returning granular error codes surfaced to widgets.
3. **Persistence Adapter** — Introduce a repository abstraction with a JSON file adapter; add tests verifying order + credit lifecycle persists across runs.
4. **Flow Exerciser** — Create a CLI integration harness that executes Flows A–C end-to-end, asserting log entries and state transitions.
5. **Module Testing** —
   - Unit tests per service (CreditService, OrderService, PreviewService).
   - Contract tests ensuring interface layer passes only validated data to services.
   - Snapshot tests for widgets using supplied data fixtures.

## Testing & Debugging Strategy
- Maintain deterministic fixtures for letters, addresses, and credit balances to replicate issues.
- Capture correlation IDs from logs in test output so failures map directly to traceable requests.
- Provide a `DEBUG=letter-irl:*` environment variable convention to toggle verbose logging in development.
- Plan for optional future integration with the Apps SDK event logs or external observability tools (e.g., Datadog) by keeping log payloads structured (JSON lines).

## Modular Build Guidance
- Keep each module in its own directory (`src/interface`, `src/services`, `src/persistence`, `src/logging`, `src/widgets`).
- Export TypeScript interfaces from `src/contracts/` so tooling and tests consume the same contracts.
- Avoid cross-module imports that bypass interfaces; use dependency injection to supply concrete adapters at runtime.

This modular roadmap supports parallel development, thorough testing, and rapid debugging once real print/mail integrations are added.
