# Architecture review: September 2026

Recorded September 7 from the September 5 source review of DEV commit
`daa6bf1`. This is a set of recommendations for evaluation, not an approved
implementation plan or a runtime/security audit. Revalidate findings against
the implementation before scheduling changes.

## Direction and foundations to preserve

Keep one deployable application with clearer internal module boundaries. There
is no demonstrated need for a rewrite or microservices. Organize business
capabilities around mail composition, commerce, fulfillment, accounts, and media;
keep HTTP, MCP, and widget presentation as adapters around them.

Preserve the existing provider interfaces, atomic mail-creation operation,
transactional outbox, recovery behavior, production TypeScript build, and real
PostgreSQL integration checks. The [ACID Transaction Standard](acid-transaction-standard.md)
remains authoritative: extracting files must not change transaction ownership,
lock order, idempotency, or handling of uncertain provider outcomes.

## Recommendations to evaluate

| Priority | Evidence at reviewed revision | Proposed improvement |
| --- | --- | --- |
| 1 | Tool contracts overlap in `src/schemas.ts`, `src/zodSchemas.ts`, and `src/mcp/toolSchemas.ts`, including image compatibility handling. | Define one authoritative contract per tool, derive types and schemas where practical, and isolate explicit platform adaptations. Preserve exact served-schema tests; do not assume generated schemas preserve every host requirement. |
| 2 | `src/services/commerceService.ts` combines checkout, payment events, entitlement changes, refunds/disputes, repairs, and maintenance. | Extract cohesive checkout, payment-event, refund/dispute, and recovery modules. Keep transaction boundaries and caller-owned database clients explicit. |
| 3 | `widgets/LetterPreviewCard.html` and `widgets/PostcardPreviewCard.html` embed substantial styling, host integration, checkout handling, and status polling. | Share design tokens, host bridge, purchase-status controller, and controls, built into the standalone HTML artifacts required by the host. Keep product-specific preview behavior separate. |
| 4 | `src/mcp/httpServer.ts` combines startup, transport setup, routing, authentication wiring, and resource serving. `src/mcp/registerTools.ts` combines schemas, widget resources, metadata, and result formatting. | Make startup a small assembly point. Separate route groups, MCP transport, widget resources, and presentation. Preserve route ordering, authentication, and legacy-route denial. |
| 5 | `src/server.ts` builds context through `src/store/fileAccountStore.ts`. Despite its name, this store queries PostgreSQL, loads balance/quota/recent orders, and exposes a no-op `persist()`. | Introduce a clearly named account-query interface and lightweight identity context. Load orders and quota only when needed, after checking all tool consumers and failure behavior. |
| 6 | The hardened `src/admin/` boundary coexists with a large legacy `src/api/adminApiHandler.ts`; public legacy routes are deliberately denied. | Inventory operator capabilities and consolidate behind the hardened-local boundary. Retire legacy code only after proving recovery-operation coverage; coordinate with issue #162. |

Extract responsibilities incrementally rather than performing a wholesale
directory rename. Establish public module interfaces and enforce allowed import
directions so the separation remains meaningful. Avoid generic abstraction layers
that add indirection without reducing coupling or duplication.

## Additional considerations

- Greeting cards will benefit from separating mail product, layout, and provider
  capability concepts. Settle product requirements first; this review does not
  authorize greeting-card implementation or speculative extensibility.
- Agent documentation drifts from implementation: at the reviewed revision,
  `AGENTS.md` says there is no CI while `.github/workflows/ci.yml` runs build,
  unit, submission, and PostgreSQL checks. Prefer references to authoritative
  commands/workflows over duplicated changeable facts.
- Coordinate with existing commerce and admin work, including issues #69 and
  #162, before assigning overlapping refactors.

## Suggested evaluation and delivery sequence

1. Revalidate each finding and inventory existing plans, open work, consumers,
   and dependency boundaries. Record accept/defer/reject with rationale.
2. Start with contract consolidation, lightweight tool context, and shared
   widget infrastructure: compare expected benefit, migration cost, and risk.
3. For selected changes, create bounded implementation issues with linked
   plans, ownership, compatibility requirements, and acceptance criteria.
4. Decompose commerce and transport incrementally once their invariants and
   module interfaces are documented. Address admin through its existing plan.

Each implementation plan should specify behavior to preserve, affected public
contracts, test evidence, and rollback strategy. Schema work needs served MCP
contract checks; widget work needs letter/postcard, checkout, mobile, and host
integration checks; financial/fulfillment work needs the real PostgreSQL
concurrency, replay, and recovery gates required by the ACID standard.

Completion of the review means explicit decisions and actionable scoped plans,
not implementation of every recommendation. Production deployment remains a
separate owner decision.

## Review limits

This review inspected source and repository configuration. It did not execute
tests, benchmark request costs, inspect live deployments, or establish security
findings. File size and overlapping responsibilities identify candidates for
investigation, not proof that a refactor will improve reliability.
