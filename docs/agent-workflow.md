# Agent Work and Delivery Workflow

**Last Updated:** August 2, 2026
**Status:** Active
**Purpose:** Define Letter IRL's multi-agent planning, implementation, verification, and release workflow

---

## Overview

This is Letter IRL's project adaptation of the private
[code-teem](https://github.com/pettheory/code-teem) orchestration playbook, pinned at `v0.5.0`, commit
`ec487cf50ffd4924d44d6b5c57e21762fe361478` (2026-08-02). Switchyard (`sy`, formerly
claude-reach/session-bridge) is the reference session control plane. This document supplements
`AGENTS.md`; repository and safety rules there still apply.

## 1. Operating Model

The owner normally communicates only with `LIRL · Master`. The Master turns high-level goals into a
durable backlog, delegates bounded work, reconciles results, and owns release gates. Specialist workers
perform investigation, planning, implementation, review, and testing.

The current `LIRL · Master` is deliberately an owner-facing Codex cockpit, not a Switchyard-owned
headless worker. It must use native Codex completion waits while delegations run and an independently
scheduled Codex heartbeat as its parked-session backstop. Switchyard's Claude watchdog protects
headless Claude workers; do not claim it can wake a live Codex cockpit. A future headless Master may be
adopted into a cockpit on demand when the cross-engine control plane supports that lifecycle end to end.

There are two session classes:

- **Cockpit:** open in a human-facing assistant UI. The UI process owns its transcript. Read it or use
  the platform's supported nudge/handoff channel, but never attach another programmatic writer.
- **Worker:** a durable headless session owned by the orchestration layer. It can be resumed, awaited,
  and adopted into a UI for inspection when idle. Recurring loop scheduling is planned Switchyard work,
  not a currently assumed project capability.

One writer per session is a hard invariant: competing attachments silently fork transcript history.
One writing worker also owns one issue, branch, and isolated worktree. The human checkout is never a
worker surface.

Use the established names:

```text
LIRL · Master
LIRL · Plan · <topic>
LIRL · Build · #<issue>
LIRL · Review · #<issue or PR>
LIRL · Test · Browser
LIRL · Ops · #<issue> · <environment>
LIRL · Investigate · <topic>
```

Session inventory is ephemeral and stays outside Git in the Master's local operations directory. Merge
`sy list` (Claude) with `sy codex-list` (Codex), then annotate role, machine, cwd, state,
branch/worktree, and reuse notes. GitHub issues, plans, branches, PRs, and test records—not transcripts
or the inventory—are the work ledger.

## 2. Engine and Machine Dispatch

Write worker briefs against capabilities, not a particular model's tool names. Every brief states the
goal, context, constraints, trust level, deliverable, done criteria, worktree, and prohibited actions.

Current dispatch defaults:

- Prefer Claude Code workers through Switchyard for new research, planning, implementation, and
  routine automated verification. This uses the owner's larger Claude capacity without changing the
  owner-facing workflow.
- Keep Codex as the Master, GitHub/release coordinator, OpenAI and ChatGPT specialist, and embedded-
  browser surface.
- Review work from one model family with the other before merging material authentication,
  authorization, privacy, payment, credit, fulfillment, database, migration, or ACID changes.
- For high-stakes irreversible decisions, obtain independent proposals or verification from both
  families and treat disagreement as a reason for focused human review.

Machine choice is also a dispatch detail. Select by required capabilities, record the executing machine
with the session, and keep trust, limits, pause controls, and audit enforcement on that machine.

## 3. Completion, Monitoring, and Recovery

Switchyard's preferred Claude-worker delegation sequence is:

1. Select or create a headless worker in the correct cwd and trust mode.
2. Read `get_bridge_info.recommendedResultSchema`, then dispatch asynchronously with
   `continue_session` and that result schema. At minimum request status, summary, branch/PR, tests,
   blockers, and deliberately untouched scope.
3. Call `await_job` for the returned job id. `outcome: timeout` means it is still running; await again.
   Use `get_job` only for a cheap snapshot.
4. Inspect both `resultStructured` and `resultSchemaError`. A malformed handoff does not make an
   otherwise successful job fail, but it must be repaired or manually interpreted before advancing.
5. Validate the handoff against Git, GitHub, tests, and deployed state rather than trusting prose alone.

Switchyard's Codex adapter is currently synchronous and does not expose Claude's `jobId`, result schema,
or `await_job` contract. For Codex-managed tasks, use the platform's native task wait/completion tools
with the same discipline. A wrapper or client timeout is not evidence that the worker failed: inspect
the job/session record, transcript, process ownership, branch, and worktree, then resume instead of
restarting from scratch.

Every delegation must end in one of two safe states: the Master is actively awaiting the completion
signal, or an independently running watchdog/heartbeat appropriate to that session type is armed before
the Master ends its turn. For the current Codex cockpit, that is the Codex heartbeat; for headless Claude
workers, it is the Switchyard watchdog. Never end with “I'll report when it finishes” while neither is
armed. A watchdog is a finite backstop with backoff and a give-up cap, not a substitute for normal job
completion.

On failure, preserve the existing branch/worktree and create or resume a successor with a precise
remaining-work brief. Do not redo completed work or duplicate external mutations.

## 4. Backlog and Planning Gates

Every open issue has exactly one workflow state: `status: future`, `status: investigate`,
`status: planning`, `status: ready`, `status: in progress`, `status: validation`, or `status: blocked`.
Type labels such as bug, security, operations, documentation, or enhancement are separate.

Start non-trivial work with a goal, current context, constraints, and observable done criteria. Search
existing issues, plans, PRs, branches, and active workers before creating anything. A ready issue requires
a merged linked plan, scope and non-goals, file-level guidance, acceptance criteria, automated and manual
tests, rollout and rollback, dependencies, and resolved material decisions.

Plans cover architecture, data and API contracts, security/privacy, ACID and external side effects,
environment separation, configuration, migrations, compatibility, observability, tests, rollout,
rollback, risks, and owner-gated actions. Planning workers may publish documentation and issues but do
not silently continue into runtime implementation.

## 5. Parallel Work and Live-System Lanes

Parallelism is limited by shared mutable resources, not available agents:

- Read-only investigation and independent review may run broadly in parallel.
- Documentation writers serialize on overlapping files.
- Build workers use isolated worktrees and are sequenced or narrowed when their likely file sets overlap.
- A shared DEV deployment, database, Auth0 tenant, ChatGPT app registration, provider sandbox, or manual-
  test account is a single live-system lane. One worker announces acquisition and cleanup before another
  uses it.
- Production has zero autonomous live-system workers without explicit owner authorization.

Worktree isolation is a project convention, not a Switchyard-enforced control: the Master must create or
select the worktree first and set the worker's `cwd` to it. Before dispatching overlapping builds,
compare their branch diffs. Never point two engines at the same working tree. Never switch a shared
CLI's global account; inject the required identity per command so concurrent repositories are not broken
elsewhere on the machine.

Use Switchyard trust mechanically: read-only audits use `readonly`; writing workers use the narrowest
trusted path and mode that permits their task; `auto` is only for explicitly trusted isolated worktrees.
Set finite `maxTurns` and `maxBudgetUsd` caps and keep the global pause/audit controls enabled.

## 6. Pull Request and Browser Verification

Every PR links its issue and plan, describes configuration/migration effects, and records lint,
type-check, automated-test, and focused-regression evidence. Known baseline failures must be separated
from new failures. The author updates affected requirements, architecture decisions, inline docs, and
manual tests in the same PR.

For every user-visible, protocol, authentication, payment, or deployment-sensitive PR, an agent creates
or updates durable cases in `docs/manual-tests.md`. Execute focused cases against a local or isolated
preview before merge when one exists. Because shared Railway DEV deploys from `dev`, execute the shared-
DEV cases after merge and successful deployment, keep the issue in validation until evidence passes,
and use a follow-up fix PR for failures. Production-host smoke cases are owner-gated and are not an
autonomous DEV requirement. The record includes the issue/PR, exact commit or deployed revision,
environment, preconditions, constrained test data, steps, expected and actual results, pass/fail,
evidence, cleanup, and limitations. Run the full applicable agent-driven manual suite between major PR
groups and before production promotion.

Prefer a per-worker Playwright-class browser with a clean profile. Until a repository-owned browser kit
and named launch configuration exist, `LIRL · Test · Browser` owns the documented operational procedure
and serialized shared-DEV lane. Use the embedded browser for cockpit exploration and the human's browser
only when their existing identity is genuinely required. Letter IRL's shared DEV/ChatGPT/Auth0 surfaces
remain a single serialized lane even if workers own separate browsers. For assertions, prefer
DOM/accessibility, console, and network evidence; screenshots are for human review.

The human evaluates product quality and approves credentials, MFA, production, irreversible actions, and
material product choices. Agents verify objective correctness. Batch optional human UX review around a
development release candidate rather than making the owner repeat mechanical tests for each PR.

## 7. Triggered Review Matrix

Authors handle obvious documentation and test ripple effects in their PR. After merge, dispatch only the
independent checks implicated by the changed paths:

| Change                                             | Required independent follow-up                                 |
| -------------------------------------------------- | -------------------------------------------------------------- |
| Public API, MCP transport, OAuth, PAT, admin route | Security/privacy review and DEV protocol smoke                 |
| Payment, credits, fulfillment, webhook, outbox     | Cross-engine ACID/recovery review and sandbox tests            |
| Database migration or transaction boundary         | Real disposable-PostgreSQL ordering/concurrency/rollback tests |
| Widget or customer flow                            | DEV browser test on desktop and narrow/mobile viewport         |
| Requirements, plans, architecture decisions        | Documentation/code consistency check                           |
| Any merged release group                           | Full applicable DEV regression suite                           |

Autonomous audits run only against merged mainline, deduplicate open and closed issues, bound their output,
and may propose issues or PRs but never merge, deploy, or mutate a live system.

## 8. Credentials, Human Attention, and Closure

Credentials and test identities remain outside Git in documented ignored files or an approved secret
store. Never include passwords, PATs, bearer tokens, billing data, or reusable OAuth artifacts in prompts,
logs, issues, plans, or handoffs. Use the narrowest practical scope and lifetime, and revoke temporary
credentials after testing.

Maintain [owner-attention.md](owner-attention.md) as one prioritized, deduplicated owner attention queue.
Each item says what is blocked, the recommendation, what happens if the owner does nothing, and the owning
issue or task. GitHub remains the authoritative backlog; the queue is only an attention view. Workers send
new owner needs to the Master, which consolidates them and surfaces only newly urgent or materially changed
items. Take safe defaults without interrupting; stop for credentials/MFA, production, irreversible actions,
or product decisions with no defensible default. When a user must enter another task, name the exact task
and action. Never put credentials, tokens, MFA codes, billing details, customer data, or other secrets in
the queue.

Work closes only when acceptance criteria and verification are complete, documentation and rollback are
current, review/manual-test findings are resolved, the PR and issue reflect reality, temporary resources
are cleaned up, and newly discovered work is captured rather than silently expanding scope.

## See Also

- [manual-tests.md](manual-tests.md) - Durable focused and release-group manual test cases
- [owner-attention.md](owner-attention.md) - Prioritized non-secret owner decisions and gates
- [testing.md](testing.md) - Automated testing strategy and commands
- [deployment.md](deployment.md) - DEV/production deployment boundaries and gates
- [acid-transaction-standard.md](acid-transaction-standard.md) - Transaction and external-side-effect standard
- [status.md](status.md) - Current product and implementation status
