# Repository Guidelines

## Project Structure & Module Organization
Source TypeScript lives in `src/`, with entrypoints such as `server.ts` (HTTP/MCP server), `cli/` for harness utilities, `mcp/` for protocol transports, and feature modules under `auth/`, `services/`, `tools/`, and `store/`. Contract definitions sit in `schemas.ts` and `zodSchemas.ts`. End-to-end fixtures and helper runners are under `test/`, while `snapshots/` captures known-good responses used during manual verification. Persist reference assets in `data/` and UI widgets in `widgets/`; transient run output should land in `logs/`. Document client endpoints in `manifest.json`.

## Build, Test, and Development Commands
- `npm run dev`: Start the TSX watcher against `src/server.ts` for rapid iteration.
- `npm run start`: Launch the compiled server once without watching.
- `npm run build`: Type-check and emit JavaScript via `tsc -p tsconfig.json`.
- `npm run lint`: Enforce ESLint + Prettier formatting across the repo.
- `npm run flow`: Exercise the CLI harness in `src/cli/flowHarness.ts`.
- `npm run mcp:stdio` / `npm run mcp:http`: Spin up the two MCP transport servers for local client testing.

## Coding Style & Naming Conventions
Use TypeScript with strict ESM modules and two-space indentation. Prefer named exports for shared utilities; default exports are reserved for single-entry files (e.g., `server.ts`). Classes/interfaces use PascalCase, functions and variables use camelCase, and constants that mirror configuration keys stay in UPPER_SNAKE_CASE. Keep file names lowercase with descriptive suffixes (`*.service.ts`, `*.tool.ts`, `*.schema.ts`). Run `npm run lint` before submitting to ensure ESLint, the import plugin, and Prettier agree.

## Testing Guidelines
Add lightweight integration scripts under `test/` (mirroring the existing `minimalServer.ts`) and execute them with `tsx test/<file>.ts` after building. Co-locate protocol snapshots in `snapshots/` and update them only when behavior changes intentionally; document the reason in the PR. When adding new logic, pair it with at least one test that hits the relevant service/tool and verify both the happy path and failure cases. Keep coverage in step with nearby modules and note any manual validation when automation is impractical.

## Commit & Pull Request Guidelines
Follow the existing history: short, imperative summaries (e.g., “Add Auth0 sample MCP server”) without trailing punctuation, optionally prefixed with the subsystem (“Auth”, “Tools”). Each PR should include a brief description of the change, linked issue or ticket, testing evidence (commands run, snapshot diffs), and screenshots or logs when UX or protocol contracts shift. Highlight any new environment variables, manifest updates, or external dependencies so downstream agents can reproduce the setup confidently.

## Infrastructure Truths
Letter IRL runs separate production and development cloud environments. Treat `master` as the production backend branch and `dev` as the development backend branch. Railway auto-deploys from those branches to separate backend services, and the companion website repo auto-deploys from `main` (prod) and `dev` (dev) to separate Railway services.

Neon is also split by environment: production uses the primary production database/branch, and development uses a separate dev database/branch isolated from production. When making deployment or data-impacting changes, preserve this dev/prod separation and verify assumptions against `docs/infrastructure.md` and `docs/deployment.md`.

## Organization Context
Use `docs/company-and-accounts.md` as the non-secret source of truth for Letter IRL's organization and account ownership context. The current organization identity is `objective.works` (`dnicholl@objective.works`) with `Letter IRL` as the DBA/product name; do not store credentials or private billing details in repo documentation.

## Agent Platform Strategy
When adding support for ChatGPT, Claude, Cursor, OpenClaw, Codex, Copilot, Zapier, or other agentic systems, keep core product behavior platform-neutral and add thin packaging/adapters around the stable MCP/API capability layer. See `docs/agent-platform-strategy.md`.
