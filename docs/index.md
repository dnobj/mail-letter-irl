# Letter IRL Documentation Index

**Last Updated:** May 30, 2026
**Purpose:** Central navigation hub for all Letter IRL documentation

Welcome to the Letter IRL documentation. This is a physical letter mailing service integrated with ChatGPT via MCP (Model Context Protocol).

---

## Quick Start

- [status.md](status.md) - **Start here** - Project overview, current state, architecture
- [use-cases.md](use-cases.md) - Market-facing and workflow-facing use cases
- [letter-send-flow.md](letter-send-flow.md) - How letters and postcards are sent (draft system, credits, jobs)
- [status-labels.md](status-labels.md) - Letter status values across all layers (DB, API, Dashboard, PostGrid)
- [database-schema.md](database-schema.md) - Complete database schema (13 tables)
- [user-stories.md](user-stories.md) - User stories for test coverage and acceptance criteria
- [personas.md](personas.md) - User personas for product design and testing
- [testing.md](testing.md) - Testing strategy and guide

---

## Core Documentation

### Architecture & Design
- [Overview](overview.md) - Product goals, objectives, and business constraints
- [Use Cases](use-cases.md) - Product, marketing, and integration use cases
- [Functional Requirements](functional-requirements.md) - Identity, credits, order lifecycle, auditing
- [Engineering Plan](engineering-plan.md) - Module boundaries, logging, testing strategy

### User Flows
- [User Flows](user-flows.md) - Step-by-step flows for sending letters, checking status, buying credits
- [letter-send-flow.md](letter-send-flow.md) - Technical implementation of the send flow (letters and postcards)

### API & Tools
- [MCP Tool APIs](tool-apis.md) - JSON schemas and behaviors for MCP tools
- [Agent Platform Strategy](agent-platform-strategy.md) - Cross-platform MCP and agent packaging strategy
- [UI Widgets](ui-widgets.md) - Apps SDK template layouts and interactions
- [OpenAI Apps SDK Guidelines](apps-sdk-guidelines.md) - Current Apps SDK implementation notes for Letter IRL

### Database & Data Model
- [database-schema.md](database-schema.md) - Complete table definitions, indexes, triggers
- [Account and Credits](account-credits.md) - Credit data model and validation rules

---

## Technical Guides

### Setup & Deployment
- [Environment Files](env-files.md) - All `.env` files explained (dev, admin, test)
- [Database Setup](database-setup.md) - Neon PostgreSQL configuration
- [deployment.md](deployment.md) - Railway deployment guide
- [infrastructure.md](infrastructure.md) - Infrastructure overview

### Integrations
- [Auth0 Configuration](auth0-tenant-configuration.md) - OAuth setup with 5 identity providers
- [Stripe Integration](acp-stripe-integration.md) - Payments and webhooks
- [PostGrid Testing](testing-postgrid.md) - Letter provider integration

### Credit System
- [Credit API Implementation](credit-api-implementation.md) - Credit service internals
- [Credit Packages](credit-packages-spec.md) - Pricing and package specs
- [Credit Purchase Flow](credit-purchase-flow.md) - Stripe checkout integration
- [Pricing and Credits](pricing-and-credits.md) - Pricing strategy

### Admin
- [Admin Panel Guide](admin-panel-guide.md) - Local-only admin dashboard
- [Dashboard Implementation](dashboard-implementation.md) - Dashboard API details

---

## Historical / Reference

These documents were created during development and may be partially outdated:

- [Implementation Roadmap](implementation-roadmap.md) - Original development phases
- [Job Queue Implementation](job-queue-implementation.md) - pg-boss setup guide
- [Service Providers](service-providers.md) - Provider architecture (Dummy, PostGrid)
- [OAuth Plan](oauth-plan.md) - Original OAuth design
- [MCP SSE Plan](mcp-sse-plan.md) - SSE transport implementation
- [MCP Debugging](mcp-debugging.md) - Transport troubleshooting
- [App Integration Learnings](learnings/app-integration-learnings.md) - Integration quirks
- [ChatGPT Auth0 Learnings](learnings/chatgpt-auth0-oauth-learnings.md) - OAuth debugging notes
- [OpenAI App SDK Notes](learnings/openai-app-sdk-notes.md) - SDK observations
- [Tool Annotation Decision](learnings/tool-annotation-decision.md) - MCP tool annotation correctness

---

## Security & Policy

- [Security and Policy](security-and-policy.md) - Consent, PII, abuse prevention, audit trails
- [Address Validation](address-validation.md) - Address handling
- [Image Support](image-support.md) - Image handling in letters

---

## App Submission

Materials for submitting to app directories:

- [OpenAI Apps SDK Owner Checklist](app-submission/owner-checklist.md) - Owner-managed submission tasks, assets, and final readiness gate
- [OpenAI Test Cases](app-submission/openai-test-cases.md) - App description, test cases, and pre-submission checklist
- [Agent Platform Strategy](agent-platform-strategy.md) - Long-term platform support and packaging principles

---

## Business

- [Business Overview](business-overview.md) - Business context
- [Company and Account Ownership](company-and-accounts.md) - Non-secret organization, DBA, and platform account context
- [Future Roadmap](future-roadmap.md) - Out-of-scope features and future plans

---

## Getting Started

### Run the Server
```bash
npm run dev          # Development with watch
npm run start        # Production mode
```

### Run Admin Dashboard (Local Only)
```bash
cp .env.admin.example .env.admin
# Edit .env.admin with production DATABASE_URL
npm run admin
# Visit http://localhost:8788/admin
```

### Run Migrations
```bash
npm run db:migrate
```
