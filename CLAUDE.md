# Letter IRL - Project Context

## What This Is

Letter IRL is a physical letter mailing service for ChatGPT. Users compose letters through conversation, and the system prints and mails them via PostGrid.

## Project Structure (Two Repositories)

Both repositories use the same branching strategy: `feature/*` → `dev` → `main/master`

| Repository | Purpose | Deployed To |
|------------|---------|-------------|
| `letter-irl` (this repo; GitHub `dnobj/mail-letter-irl`) | MCP server / API | Railway → api.letterirl.com |
| `letter-irl-website` (GitHub `dnobj/mail-letter-irl-website`) | Marketing site + user dashboard | Railway → letterirl.com |

**letter-irl (API):**
- MCP server for ChatGPT/AI assistants
- REST API for dashboard
- Stripe webhooks
- Hourly maintenance cron (`npm run maintenance`): outbox recovery, status sync, retention sweeps

**letter-irl-website:**
- Next.js 16 with `@auth0/nextjs-auth0`
- Marketing pages
- User dashboard (credits, letters, account)
- Sibling checkout: `../letter-irl-website`

## Critical Facts

**Primary Goal: OpenAI Apps SDK**
- We are building for the **OpenAI Apps SDK** (ChatGPT apps platform)
- MCP (Model Context Protocol) is the *implementation protocol*, not the goal
- Apps SDK submission is in preparation; see `docs/app-submission/owner-checklist.md`
- MCP client support (Claude Desktop, etc.) is a compatible side benefit

**Hosting & Infrastructure**
- **Railway** for hosting - NOT Vercel
- **Neon PostgreSQL** for database - NOT other databases
- **Transactional outbox** (`letter_jobs`) plus an hourly Railway cron - NOT pg-boss (removed), NOT Redis. The API process starts no polling timers

**Development vs Production Environments**
- Two fully isolated environments exist for all services
- **Database**: Neon has `production` and `dev` branches - always specify which when querying
- **Auth0**: Separate tenants for prod vs dev
- **PostGrid**: Live mode (prod) vs test mode (dev)
- **Stripe**: Live mode (prod) vs test mode (dev)
- See `docs/infrastructure.md` for full environment details

**External Services**
- **Auth0** - OAuth 2.1 + PKCE authentication
  - Website uses `@auth0/nextjs-auth0` SDK (Regular Web App)
  - MCP server uses DCR (Dynamic Client Registration) for ChatGPT clients
  - Both share the same Auth0 tenant and user pool
- **Stripe** - Payments and webhooks
- **PostGrid** - Physical letter printing/mailing

## Technology Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 22, strict ESM TypeScript compiled with `tsc` |
| Server | Custom HTTP (MCP SDK) |
| Database | PostgreSQL 17 (Neon serverless) |
| Mail dispatch | Transactional outbox (`letter_jobs`) + hourly maintenance cron |
| Auth | Auth0 OAuth 2.1 + PKCE |
| Payments | Stripe |
| Mail Provider | PostGrid |
| Hosting | Railway |

## Key Documentation

When you need more detail, read these docs:

- `docs/index.md` - Full documentation index
- `docs/status.md` - Current state, architecture, progress
- `docs/infrastructure.md` - External services configuration
- `docs/letter-send-flow.md` - How letters are sent (drafts, credits, jobs)
- `docs/database-schema.md` - Complete schema reference (SQL migrations remain authoritative)
- `docs/user-stories.md` - Acceptance criteria and test coverage
- `docs/standards.md` - Documentation standards (follow when updating docs)

## Learnings (Important Gotchas)

Check `docs/learnings/` for debugging notes and integration quirks:
- `openai-app-sdk-notes.md` - Apps SDK status and action items
- `chatgpt-auth0-oauth-learnings.md` - OAuth debugging
- `chatgpt-connector-oidc-setting.md` - untick OIDC on every ChatGPT connector (#424)
- `claude-desktop-mcp.md` - MCP client setup

## Common Commands

```bash
npm run dev          # Development with watch
npm run start        # Production mode
npm run db:migrate   # Run migrations
npm run verify       # Lint, build, unit and submission tests (mirrors the CI `checks` job)
npm run admin:dev    # Admin panel against .env.admin.local (docs/admin-panel-guide.md)
```
