# Letter IRL Documentation Index

**Last Updated:** July 18, 2026
**Purpose:** Central navigation hub for all Letter IRL documentation

Welcome to the Letter IRL documentation. This is a physical letter mailing service integrated with ChatGPT via MCP (Model Context Protocol).

---

## Quick Start

- [status.md](status.md) - **Start here** - Project overview, current state, architecture
- [use-cases.md](use-cases.md) - Market-facing and workflow-facing use cases
- [letter-send-flow.md](letter-send-flow.md) - How letters and postcards are sent (draft system, credits, jobs)
- [status-labels.md](status-labels.md) - Letter status values across all layers (DB, API, Dashboard, PostGrid)
- [database-schema.md](database-schema.md) - Schema narrative; SQL migrations remain authoritative
- [user-stories.md](user-stories.md) - User stories for test coverage and acceptance criteria
- [personas.md](personas.md) - User personas for product design and testing
- [testing.md](testing.md) - Testing strategy and guide
- [ACID Transaction Standard](acid-transaction-standard.md) - Required transaction, idempotency, outbox, recovery, and review rules for durable mutations

---

## Core Documentation

### Architecture & Design

- [ACID Transaction Standard](acid-transaction-standard.md) - Authoritative engineering standard for financial and state-changing operations
- [Overview](overview.md) - Product goals, objectives, and business constraints
- [Use Cases](use-cases.md) - Product, marketing, and integration use cases
- [Functional Requirements](functional-requirements.md) - Identity, credits, order lifecycle, auditing
- [Engineering Plan](engineering-plan.md) - Module boundaries, logging, testing strategy

### User Flows

- [User Flows](user-flows.md) - Step-by-step flows for sending letters, checking status, buying credits
- [letter-send-flow.md](letter-send-flow.md) - Technical implementation of the send flow (letters and postcards)
- [Just-in-Time Purchase Plan](just-in-time-purchase-plan.md) - Implementation plan for Pay & Send checkout, fulfillment, refunds, and image entitlements

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
- [Railway Setup](railway-setup.md) - Exact services, commands, branches, and Serverless policy
- [Idle-Cost Operations](idle-cost-operations.md) - Cost controls, observation targets, and rollback runbook

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

- [Admin Interface Modernization Plan](admin-interface-modernization-plan.md) - Approved hardened-local architecture, current-state audit, security model, implementation slices, tests, and rollout gates
- [Admin Operator Guide](admin-panel-guide.md) - Disabled legacy routes and the current hardened-local delivery status
- [Archived Dashboard Implementation](archive/dashboard-implementation.md) - Historical customer-dashboard design, not the current admin panel

---

## Historical / Reference

These documents were created during development and may be partially outdated:

- [Implementation Roadmap](implementation-roadmap.md) - Original development phases
- [Job Queue Implementation](job-queue-implementation.md) - Historical pg-boss design, superseded by the transactional outbox
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

### Admin Operations

The current localhost admin flow is legacy and must not be enabled remotely or treated as a secure
production operating procedure. Keep cloud admin routes disabled and follow the approved
[Admin Interface Modernization Plan](admin-interface-modernization-plan.md) to replace it with a
hardened local-only operator application. Production credential provisioning, the first production
connection, and full mutation mode each require explicit owner approval.

### Run Migrations

```bash
npm run db:migrate
```
