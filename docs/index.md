# Letter IRL Documentation Index

Welcome to the Letter IRL build documentation. Each section below links to a focused specification artifact for engineers implementing the MCP server and Apps SDK widgets.

- [Scope and Goals](overview.md) — Product snapshot, objectives, business constraints, and non-goals for v1.
- [Core User Flows](user-flows.md) — Step-by-step flows for drafting, sending, tracking, and checking credits.
- [Functional Requirements](functional-requirements.md) — Identity, credits, order lifecycle, auditing, and safety obligations.
- [MCP Tool API Specifications](tool-apis.md) — JSON Schemas, behaviors, and metadata for all four MCP tools.
- [UI Widgets](ui-widgets.md) — Expected inputs, layouts, and interaction patterns for Apps SDK templates.
- [Account and Credits Model](account-credits.md) — Data model, validation rules, and credit heuristics.
- [Security, Privacy, and Policy Requirements](security-and-policy.md) — Consent, PII safeguards, abuse prevention, and audit trails.
- [Out-of-Scope and Future Enhancements](future-roadmap.md) — Roadmap considerations that shape today’s design decisions.
- [OpenAI App SDK Status Notes](openai-app-sdk-notes.md) — Current understanding of the Apps SDK as of 2025-10-29, with verification action items.
- [MCP Debugging Notes](mcp-debugging.md) — Tunneling, transport, and initialization troubleshooting for Apps SDK integration.
- [ChatGPT App Integration Learnings](app-integration-learnings.md) — Running log of integration quirks and fixes.
- [App Instructions](app-instructions.md) — Manifest guidance for collecting addresses before calling tools.
- [Engineering Plan and Modular Architecture](engineering-plan.md) — Module boundaries, logging roadmap, and testing strategy for scalable development.

For implementation readiness, pair this documentation with a server skeleton that registers the specified tools, enforces credit logic, wires the associated widgets, and follows the modular plan for independent development.
