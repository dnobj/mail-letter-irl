# Letter IRL Documentation Index

**Last Updated:** September 16, 2026
**Purpose:** Central navigation hub for all Letter IRL documentation

Letter IRL prints and mails real US letters and postcards composed in ChatGPT. This repository is the
API: an MCP server for the OpenAI Apps SDK, the dashboard's REST API, Stripe webhooks, and the hourly
maintenance job.

---

## Quick Start

- [status.md](status.md) - **Start here** - current state, architecture, open work
- [development.md](development.md) - local setup, workflow, adding a tool or endpoint
- [letter-send-flow.md](letter-send-flow.md) - how letters and postcards are sent (drafts, payment, outbox)
- [database-schema.md](database-schema.md) - schema narrative; SQL migrations remain authoritative
- [testing.md](testing.md) - suites, commands and CI
- [ACID Transaction Standard](acid-transaction-standard.md) - required rules for durable mutations
- [standards.md](standards.md) - documentation conventions

---

## Product

- [Use Cases](use-cases.md) - product, marketing, and integration use cases
- [User Flows](user-flows.md) - sending, status, balance, buying packs, promo codes
- [User Stories](user-stories.md) - stories and acceptance criteria
- [Personas](personas.md) - user personas for design and testing
- [Business Overview](business-overview.md) - users, model, goals, positioning
- [Pricing and Credits](pricing-and-credits.md) - letter packs, Pay & Send, specifications, refunds
- [Letter Packages](credit-packages-spec.md) - pack definitions (plus planned ACP feed material)
- [Account and Credits](account-credits.md) - how credits, letters and balances relate
- [Gift Letters](gift-letters.md) - free sends that print a card with a code for the recipient (built, off by default)
- [Just-in-Time Purchase Plan](just-in-time-purchase-plan.md) - Pay & Send design record (shipped)
- [Future Roadmap](future-roadmap.md) - out-of-scope features and plans

---

## MCP Tools, Widgets and the Apps SDK

- [MCP Tool APIs](tool-apis.md) - the 22 tools, schemas, and how to add one
- [UI Widgets](ui-widgets.md) - the 6 widgets, bridge notes, CSP
- [Status Labels](status-labels.md) - letter status values across database, API, dashboard, PostGrid
- [OpenAI Apps SDK Guidelines](apps-sdk-guidelines.md) - Apps SDK guidance that affects Letter IRL
- [App Instructions](app-instructions.md) - app description, onboarding copy, assistant instructions
- [Tool Description Style Guide](tool-description-style-guide.md) - how to write tool descriptions
- [Agent Platform Strategy](agent-platform-strategy.md) - cross-platform MCP and agent packaging
- [MCP Authentication](mcp-authentication.md) - OAuth and personal access tokens for non-ChatGPT clients
- [MCP Website Integration](mcp-website-integration.md) - website spec for MCP users and tokens (Dec 2025)
- [Image Support](image-support.md) - image sources, processing, and print specifications
- [Address Validation](address-validation.md) - PostGrid address verification in the preview tools

---

## Setup, Deployment and Operations

- [Environment Files](env-files.md) - every `.env` file and what reads it
- [Database Setup](database-setup.md) - creating and connecting to Neon
- [Infrastructure](infrastructure.md) - cloud topology, runtime architecture, maintenance tasks
- [Deployment](deployment.md) - release process and boot validation rules
- [Railway Setup](railway-setup.md) - services, commands, variables, Serverless policy
- [Idle-Cost Operations](idle-cost-operations.md) - cost controls and rollback runbook
- [Admin Panel Guide](admin-panel-guide.md) - the tailnet-only operator panel in both environments
- [Manual Tests](manual-tests.md) - manual acceptance cases and their run records
- [Testing with the Dummy Provider](testing-dummy-provider.md) - local sends without mailing anything
- [Testing PostGrid](testing-postgrid.md) - PostGrid in test mode
- [MCP Debugging](mcp-debugging.md) - transport troubleshooting
- [Service Providers](service-providers.md) - mail provider architecture (Dummy, PostGrid, DIY) and routing
- [Company and Account Ownership](company-and-accounts.md) - organization, DBA and platform accounts

---

## Authentication

- [Auth0 Setup](auth0-setup.md) - current ChatGPT/Auth0 architecture
- [Auth0 Tenant Configuration](auth0-tenant-configuration.md) - tenant-by-tenant settings and records
- [OAuth CIMD Migration Plan](oauth-cimd-migration-plan.md) - design record for the CIMD migration (shipped)

---

## Security, Privacy and Legal

- [Security and Policy](security-and-policy.md) - consent, personal data, abuse prevention, retention, payment invariants
- [Privacy Policy](privacy-policy.md) - published privacy policy
- [Terms of Service](terms-of-service.md) - published terms

---

## App Submission

- [ChatGPT App Submission](chatgpt-app-submission.md) - how the codebase meets OpenAI's requirements
- [OpenAI Apps SDK Owner Checklist](app-submission/owner-checklist.md) - owner-managed tasks and the readiness gate
- [OpenAI Test Cases](app-submission/openai-test-cases.md) - test prompts, expected behavior, tool annotations
- [Demo Scenarios](app-submission/demo-scenarios.md) - demo scenarios for submission videos and reviewers

---

## Learnings

Debugging notes and decision records.

- [OpenAI App SDK Notes](learnings/openai-app-sdk-notes.md) - Apps SDK observations
- [App Integration Learnings](learnings/app-integration-learnings.md) - integration quirks
- [ChatGPT Auth0 OAuth Learnings](learnings/chatgpt-auth0-oauth-learnings.md) - OAuth debugging
- [OAuth Metadata Is a Contract](learnings/oauth-metadata-is-a-contract.md) - where ChatGPT actually reads OAuth scopes
- [ChatGPT Connector OIDC Setting](learnings/chatgpt-connector-oidc-setting.md) - untick OIDC on every ChatGPT connector, or the first link fails (#424)
- [DCR Static Client Workaround](learnings/dcr-static-client-workaround.md) - the rollback-only registration shim
- [Claude Desktop MCP](learnings/claude-desktop-mcp.md) - MCP client setup
- [Generate Image Removal Decision](learnings/generate-image-removal-decision.md) - image generation history and the hybrid tool
- [Widget CSP Enforcement](learnings/widget-csp-enforcement.md) - widget Content Security Policy evidence
- [Widget Debugging Notes](learnings/widget-debugging-notes.md) - widget lifecycle and bridge debugging
- [Suite Address Verification](learnings/suite-address-verification.md) - USPS secondary-unit handling
- [Tool Annotation Decision](learnings/tool-annotation-decision.md) - MCP tool annotation correctness
- [Layout Options Research](learnings/layout-options-research.md) - letter layout research

---

## Future Plans

Not built yet.

- [ACP Implementation Guide](acp-implementation-guide.md) - Agentic Commerce Protocol checkout inside ChatGPT, once OpenAI makes it available to apps like Letter IRL
- [ACP Quickstart](acp-quickstart.md) - the phased ACP plan
- [ACP Stripe Integration](acp-stripe-integration.md) - Shared Payment Token handling for ACP
- [ACP Purchase Flow](credit-purchase-flow.md) - the planned in-ChatGPT purchase flow

---

## Historical / Reference

Kept for context. Most carry a banner saying what has changed; treat anything here as possibly stale.

- [Overview](overview.md) - original v1 scope (Nov 2025)
- [Functional Requirements](functional-requirements.md) - original v1 requirements; its logging rule is superseded
- [Engineering Plan](engineering-plan.md) - original modularization plan
- [Implementation Roadmap](implementation-roadmap.md) - original development phases
- [Job Queue Implementation](job-queue-implementation.md) - pg-boss design, superseded by the transactional outbox
- [Credit API Implementation](credit-api-implementation.md) - pre-ledger credit design and the REST endpoint list
- [Mail Provider Comparison](mail-provider-comparison.md) - provider research
- [PostGrid API Research](postgrid-api-research.md) - PostGrid research notes
- [Account Switching Guide](account-switching-guide.md) - switching accounts; its `switch_account` tool was removed
- [OAuth Plan](oauth-plan.md) - original Google Cloud/Firestore identity plan (never built)
- [MCP SSE Plan](mcp-sse-plan.md) - SSE transport plan
- [Generated Image Result Bridge Plan](generated-image-result-bridge-plan.md) - `_meta` partitioning design
- [Admin Interface Modernization Plan](admin-interface-modernization-plan.md) - superseded local-only admin plan; see the Admin Panel Guide
- [Archived Dashboard Implementation](archive/dashboard-implementation.md), [quick reference](archive/dashboard-quick-reference.md), [setup guide](archive/dashboard-setup-guide.md) - the first customer dashboard

---

## Getting Started

### Run the Server

```bash
npm run dev          # Development with watch
npm run build        # Compile to dist/
npm start            # Run the compiled server
npm run verify       # Lint, build, unit and submission tests
```

### Admin Operations

Operator work happens in the admin panel, a separate tailnet-only Railway service in each
environment; production runs in full mode. The public API returns 404 for every legacy `/admin*`
path. Setup, access, commands and the production gates are in [admin-panel-guide.md](admin-panel-guide.md).
For a local panel against the development database, run `npm run admin:dev`.

### Run Migrations

```bash
npm run db:migrate
```

Migrations are forward-only and also run as Railway's pre-deploy command; see
[db/README.md](../db/README.md).
