# Agent Platform Strategy

Last updated: April 16, 2026

Letter IRL should support many agentic systems over time, but the product architecture should not be shaped around any single client. Treat ChatGPT, Claude, Cursor, OpenClaw, Codex, Copilot, Zapier, and future agent platforms as distribution channels over the same durable capability layer.

Core principle:

> One product capability layer, many thin platform packages.

## Goals

- Keep Letter IRL portable across MCP clients and agent ecosystems.
- Preserve the same safe physical-mail workflow everywhere.
- Minimize platform-specific business logic.
- Make packaging, onboarding, and marketplace listings reusable.
- Let new agent systems be added through docs, manifests, skills, and adapters rather than core rewrites.

## Capability Layers

| Layer | Purpose | Should Be Platform-Specific? |
| --- | --- | --- |
| Core services | Credits, drafts, letters, postcards, providers, status, users | No |
| Public API / MCP tools | Stable tool contracts, auth challenges, errors, side-effect boundaries | Mostly no |
| Client adapters | Transport quirks, OAuth/PAT setup, widget support, client limitations | Yes |
| Agent packages | Skills, prompts, install snippets, marketplace metadata, demos | Yes |
| Marketing / onboarding | Platform-specific copy and examples | Yes |

The core flow should remain canonical across every client:

```text
draft / quote -> preview -> explicit confirmation -> send -> status / history
```

## Design Patterns

### Keep Tool Contracts Stable

Avoid letting each platform invent its own behavior. If ChatGPT, Claude, Cursor, and OpenClaw all call the same capability, they should see the same tool names, schemas, error codes, and safety requirements whenever possible.

Good:

- Stable preview/send/status tools.
- Stable structured errors such as `INSUFFICIENT_CREDITS`, `DRAFT_EXPIRED`, `DRAFT_NOT_OWNED`, `MISSING_CONFIRMATION`, and `ADDRESS_INVALID`.
- Stable draft IDs and idempotent send behavior.

Avoid:

- ChatGPT-only send semantics.
- Client-specific draft models.
- Platform-specific confirmation rules.

### Enforce Confirmation Server-Side

Physical mail is a real-world side effect. Every platform may draft, quote, preview, and prepare, but sending must require explicit user confirmation enforced by the backend.

Do not rely only on prompt instructions or platform UI to prevent accidental sends.

### Treat Widgets as Progressive Enhancement

ChatGPT widgets are useful, but many MCP clients may ignore widgets or render only text/tool responses. Text responses should remain understandable and safe without widget support.

Design every flow so that:

- A rich widget improves the experience.
- A plain tool response still gives enough context to proceed safely.
- Confirmation still works without visual widgets.

### Support OAuth and Token-Based Auth

Different agent platforms have different auth capabilities. Continue supporting:

- OAuth for interactive clients that support browser-based auth.
- Personal access tokens for custom agents, headless environments, and clients without OAuth.

Future token improvements should consider scoped capabilities such as:

- `draft:write`
- `mail:send`
- `mail:read`
- `credits:read`
- `status:read`

### Preserve Idempotency

Agents retry. Networks fail. Models sometimes repeat actions. Keep sends idempotent by draft and consider explicit idempotency keys for future automation APIs.

Critical invariant:

- Repeating a confirmed send for the same draft must not double-charge or double-mail.

### Separate Packaging from Product Logic

Adding support for a new agent system should usually mean adding one or more of:

- Install docs.
- MCP config snippets.
- Skills or prompt packs.
- Marketplace metadata.
- Smoke tests.
- Client-specific known limitations.

It should not require changing core mail, credit, or status logic unless the use case reveals a genuine product gap.

## Reusable Agent Pack Direction

Long-term, maintain a reusable agent package that can be adapted to multiple ecosystems.

Potential structure:

```text
letter-irl-agent-pack/
├─ README.md
├─ .mcp.json
├─ AGENTS.md
├─ skills/
│  └─ letter-irl-mail/
│     └─ SKILL.md
├─ examples/
│  ├─ chatgpt-prompts.md
│  ├─ claude-prompts.md
│  └─ business-workflows.md
└─ platform/
   ├─ claude-code.md
   ├─ cursor.md
   ├─ openclaw.md
   ├─ codex.md
   ├─ copilot.md
   └─ zapier.md
```

This can start as documentation and later become a separate repository or package.

## Platform Compatibility Checklist

For each agent platform, track:

- Tool discovery works.
- Authentication works.
- Letter preview works.
- Missing-confirmation path blocks safely.
- Confirmed send works in development or a controlled test environment.
- Status/history works.
- Image support behavior is known.
- Widget behavior is known.
- OAuth/PAT recommendation is documented.
- Known limitations are documented.

## Initial Platform Priorities

| Priority | Platform | Rationale |
| --- | --- | --- |
| 1 | ChatGPT / OpenAI Apps | Primary product surface and app submission target. |
| 2 | Claude / Claude Code | Strong MCP audience and good remote-MCP fit. |
| 3 | Cursor | Large developer-agent audience and MCP directory potential. |
| 4 | OpenAI Codex | Natural fit for Codex users and OpenAI ecosystem reuse. |
| 5 | OpenClaw | Useful early-adopter channel with bundle/skill potential. |
| 6 | VS Code / GitHub Copilot | Large developer reach; useful once generic MCP docs are solid. |
| 7 | Zapier / Copilot Studio | Business automation channel; likely needs approval and workflow features. |

## Architecture Watchlist

Decisions to revisit as platform support grows:

- Whether tool names should be versioned or grouped by capability.
- Whether personal access tokens need scopes and expiration controls.
- Whether business/organization accounts are needed for team workflows.
- Whether approval links are needed for headless automation.
- Whether status webhooks should be added for agents and workflow tools.
- Whether address book and sender profiles should become first-class primitives.
- Whether an official agent-pack repo should live beside the backend and website repos.

## Related Docs

- `docs/use-cases.md`
- `docs/user-stories.md`
- `docs/personas.md`
- `docs/mcp-authentication.md`
- `docs/mcp-website-integration.md`
- `docs/chatgpt-app-submission.md`
