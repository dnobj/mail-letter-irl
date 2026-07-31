# Agent Work and Delivery Workflow

This document defines how Letter IRL turns high-level product goals into a reviewable backlog and
delivers that backlog through coordinated coding-assistant tasks. It supplements `AGENTS.md`; repository
and security rules in `AGENTS.md` still apply.

## 1. Define and Classify the Work

Start each non-trivial workstream with:

- **Goal:** the user or business outcome.
- **Context:** relevant product, code, infrastructure, and prior decisions.
- **Constraints:** scope limits, safety boundaries, compatibility needs, and owner-gated actions.
- **Done when:** observable acceptance and verification criteria.

Classify each backlog item before assigning implementation:

- **Future / discussion:** promising but not yet approved or sufficiently defined.
- **Investigation:** a question, defect, or risk whose cause and scope are not yet established.
- **Planned / ready:** an approved, detailed plan with acceptance criteria and known dependencies.
- **Implementation / review / test:** active delivery work linked to its plan and GitHub issue.

Do not present a future idea or an investigation as implementation-ready. Update the classification as
evidence and decisions make the work better defined.

## 2. Investigate and Plan

Use read-only investigation to establish current behavior, documentation, risks, and feasible options.
Record assumptions and distinguish observed facts from recommendations. For significant work, create a
durable plan in the repository before implementation. A detailed plan should include:

- the intended outcome and non-goals;
- current behavior and affected components;
- proposed design and ordered implementation slices;
- data, API, security, compatibility, deployment, and rollback considerations;
- automated and manual test cases;
- acceptance criteria, dependencies, and owner-gated steps.

Create or update a GitHub issue that links to the plan. Label or state the item's classification clearly
so another task can tell whether it needs discussion, investigation, planning, or implementation.

## 3. Assign and Execute

Use one task/chat for one coherent outcome. Reuse that task for closely related continuation when its
history is useful. Split work only when outcomes are independently reviewable or genuinely parallel.

Delegated work must be bounded and include the goal, context, constraints, expected deliverable, and
done criteria. Read-heavy investigation, targeted review, and independent test analysis are good
parallel assignments. Parallel write-heavy work must use separate branches/worktrees, with one owner
per branch and no concurrent edits to the same files.

The coordinating task owns scope and architectural decisions, tracks dependencies and blockers, and
reconciles delegated results into the plan, issue, and next assignment. Delegated tasks must report when
they finish or need user input; the coordinator should check active work regularly without duplicating it.

## 4. Verify Every Pull Request

Every PR must link its GitHub issue and durable plan, identify configuration or migration impacts, and
include evidence for relevant lint, type-check, automated tests, and focused regressions. Known baseline
failures must be separated explicitly from new failures.

Create or update durable manual test cases for every user-visible, protocol, authentication, payment, or
deployment-sensitive PR. The live browser-testing task executes the PR-specific cases in DEV and records
the environment, build/commit, steps, result, and useful screenshots or logs. Run the full applicable
manual suite between major groups of merged PRs and before a production release.

External or destructive actions remain owner-gated when they require account access, MFA, billing,
production impact, irreversible data changes, or authority beyond the approved task. Complete all safe,
reversible preparation first, then state the exact action required from the owner.

## 5. Close and Reconcile

Work is complete only when:

- acceptance criteria are met and verification evidence is recorded;
- documentation, generated artifacts, and rollback instructions are current where applicable;
- review feedback and manual-test results are resolved;
- the PR and linked issue accurately reflect completion or remaining follow-up;
- newly discovered work is captured and classified rather than silently expanding the current scope.

After each completed item, the coordinator reports the outcome, remaining risks or owner actions, and
the next highest-priority ready item. Periodically close, supersede, or reclassify stale issues and PRs so
the backlog remains trustworthy.
