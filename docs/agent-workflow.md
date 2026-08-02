# Agent Work and Delivery Workflow

This is Letter IRL's project adaptation of the private code-teem orchestration playbook, pinned at
`v0.5.0` (2026-08-02). Switchyard (`sy`, formerly claude-reach/session-bridge) is the reference session
control plane. This document supplements `AGENTS.md`; repository and safety rules there still apply.

## 1. Operating Model

The owner normally communicates only with `LIRL · Master`. The Master turns high-level goals into a
durable backlog, delegates bounded work, reconciles results, and owns release gates. Specialist workers
perform investigation, planning, implementation, review, and testing.

There are two session classes:

- **Cockpit:** open in a human-facing assistant UI. The UI process owns its transcript. Read it or use
  the platform's supported nudge/handoff channel, but never attach another programmatic writer.
- **Worker:** a durable headless session owned by the orchestration layer. It can be resumed, awaited,
  scheduled, and adopted into a UI for inspection when idle.

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

Session inventory is ephemeral and stays outside Git. Generate the durable-headless portion from
`sy list` when possible and annotate role, machine, cwd, state, branch/worktree, and reuse notes. GitHub
issues, plans, branches, PRs, and test records—not transcripts or the inventory—are the work ledger.

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

Switchyard's preferred delegation sequence is:

1. Select or create a headless worker in the correct cwd and trust mode.
2. Dispatch asynchronously with `continue_session` and a result schema. At minimum request status,
   summary, branch/PR, tests, blockers, and deliberately untouched scope.
3. Call `await_job` for the returned job id. `outcome: timeout` means it is still running; await again.
   Use `get_job` only for a cheap snapshot.
4. Validate the handoff against Git, GitHub, tests, and deployed state rather than trusting prose alone.

For Codex-managed tasks, use the platform's thread wait/completion tools with the same discipline.
A wrapper or client timeout is not evidence that the worker failed: inspect the job/session record,
transcript, process ownership, branch, and worktree, then resume instead of restarting from scratch.

Every delegation must end in one of two safe states: the Master is actively awaiting the completion
signal, or the Master is registered with the Switchyard idle watchdog before ending its turn. Never end
with “I'll report when it finishes” while neither is armed. The watchdog is a backstop with backoff and
a finite give-up cap, not a substitute for normal job completion.

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

Before dispatching overlapping builds, compare their branch diffs. Never point two engines at the same
working tree. Never switch a shared CLI's global account; inject the required identity per command so
concurrent repositories are not broken elsewhere on the machine.

## 6. Pull Request and Browser Verification

Every PR links its issue and plan, describes configuration/migration effects, and records lint,
type-check, automated-test, and focused-regression evidence. Known baseline failures must be separated
from new failures. The author updates affected requirements, architecture decisions, inline docs, and
manual tests in the same PR.

For every user-visible, protocol, authentication, payment, or deployment-sensitive PR, an agent creates
or updates durable manual cases and executes the focused cases in DEV. The record includes the issue/PR,
exact commit or deployed revision, environment, preconditions, constrained test data, steps, expected and
actual results, pass/fail, evidence, cleanup, and limitations. Run the full applicable agent-driven
manual suite between major PR groups and before production promotion.

Prefer a per-worker Playwright-class browser with a clean profile. Use the embedded browser for cockpit
exploration and the human's browser only when their existing identity is genuinely required. Letter IRL's
shared DEV/ChatGPT/Auth0 surfaces remain a single serialized lane even if workers own separate browsers.
For assertions, prefer DOM/accessibility, console, and network evidence; screenshots are for human review.

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

Maintain one owner attention queue. Each item says what is blocked, the recommendation, and what happens
if the owner does nothing. Take safe defaults without interrupting; stop for credentials/MFA, production,
irreversible actions, or product decisions with no defensible default. When a user must enter another task,
name the exact task and action.

Work closes only when acceptance criteria and verification are complete, documentation and rollback are
current, review/manual-test findings are resolved, the PR and issue reflect reality, temporary resources
are cleaned up, and newly discovered work is captured rather than silently expanding scope.
