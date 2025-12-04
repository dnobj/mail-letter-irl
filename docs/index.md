# Letter IRL Documentation Index

**Last Updated:** December 4, 2025

Welcome to the Letter IRL documentation. This is a physical letter mailing service integrated with ChatGPT via MCP (Model Context Protocol).

---

## Quick Start

- [STATUS.md](STATUS.md) - **Start here** - Project overview, current state, architecture
- [LETTER-SEND-FLOW.md](LETTER-SEND-FLOW.md) - How letters are sent (draft system, credits, jobs)
- [DATABASE-SCHEMA.md](DATABASE-SCHEMA.md) - Complete database schema (12 tables)
- [USER-STORIES.md](USER-STORIES.md) - User stories for test coverage and acceptance criteria
- [PERSONAS.md](PERSONAS.md) - User personas for product design and testing
- [TESTING.md](TESTING.md) - Testing strategy and guide

---

## Core Documentation

### Architecture & Design
- [Overview](overview.md) - Product goals, objectives, and business constraints
- [Functional Requirements](functional-requirements.md) - Identity, credits, order lifecycle, auditing
- [Engineering Plan](engineering-plan.md) - Module boundaries, logging, testing strategy

### User Flows
- [User Flows](user-flows.md) - Step-by-step flows for sending letters, checking status, buying credits
- [LETTER-SEND-FLOW.md](LETTER-SEND-FLOW.md) - Technical implementation of the send flow

### API & Tools
- [MCP Tool APIs](tool-apis.md) - JSON schemas and behaviors for MCP tools
- [UI Widgets](ui-widgets.md) - Apps SDK template layouts and interactions

### Database & Data Model
- [DATABASE-SCHEMA.md](DATABASE-SCHEMA.md) - Complete table definitions, indexes, triggers
- [Account and Credits](account-credits.md) - Credit data model and validation rules

---

## Technical Guides

### Setup & Deployment
- [Database Setup](database-setup.md) - Neon PostgreSQL configuration
- [DEPLOYMENT.md](DEPLOYMENT.md) - Railway deployment guide
- [INFRASTRUCTURE.md](INFRASTRUCTURE.md) - Infrastructure overview

### Integrations
- [Auth0 Configuration](auth0-tenant-configuration.md) - OAuth setup with 5 identity providers
- [Stripe Integration](acp-stripe-integration.md) - Payments and webhooks
- [PostGrid Testing](TESTING-POSTGRID.md) - Letter provider integration

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

- [Implementation Roadmap](IMPLEMENTATION-ROADMAP.md) - Original development phases
- [Job Queue Implementation](job-queue-implementation.md) - pg-boss setup guide
- [Service Providers](service-providers.md) - Provider architecture (Dummy, PostGrid)
- [OAuth Plan](oauth-plan.md) - Original OAuth design
- [MCP SSE Plan](mcp-sse-plan.md) - SSE transport implementation
- [MCP Debugging](mcp-debugging.md) - Transport troubleshooting
- [App Integration Learnings](app-integration-learnings.md) - Integration quirks
- [ChatGPT Auth0 Learnings](chatgpt-auth0-oauth-learnings.md) - OAuth debugging notes
- [OpenAI App SDK Notes](openai-app-sdk-notes.md) - SDK observations

---

## Security & Policy

- [Security and Policy](security-and-policy.md) - Consent, PII, abuse prevention, audit trails
- [Address Validation](ADDRESS-VALIDATION.md) - Address handling
- [Image Support](IMAGE-SUPPORT.md) - Image handling in letters

---

## Business

- [Business Overview](BUSINESS-OVERVIEW.md) - Business context
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
