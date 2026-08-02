# Owner Attention Queue

**Last Updated:** August 2, 2026
**Status:** Active
**Purpose:** Keep the small set of Letter IRL decisions and actions that genuinely require Dave visible, prioritized, and separate from routine autonomous work

---

## How This Queue Works

The Master owns this queue. Workers report owner-only gates to the Master; they do not repeatedly interrupt
Dave. GitHub issues, plans, pull requests, and test records remain the authoritative work ledger. This file
is only the prioritized attention view.

Order items as follows:

1. Active blockers and time-sensitive gates
2. Production, breaking, irreversible, security, billing, credential, or MFA actions
3. Product or architecture decisions needed soon
4. Strategy conversations and research decisions
5. Deferred questions

Never record passwords, tokens, MFA codes, secrets, customer information, private billing details, or
credential values. Record only the safe location/procedure and the exact human action required. Routine,
reversible DEV work continues while non-blocking items wait.

## Active Blockers

| Priority | Owner action                                                                                                                                                                       | Why / blocked work                                                                                              | Tracking                                                                                                | Recommended next step                                                                       | Status          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------- |
| P0       | In Chrome, sign into the DEV Letter IRL website using the designated primary test identity, then sign into ChatGPT; reply `done` in the named Ops task without pasting credentials | Issue #160 account-switching and DEV PAT/Claude acceptance cannot finish without authenticated primary sessions | [Issue #160](https://github.com/dnobj/mail-letter-irl/issues/160); task `LIRL · Ops · #160 · Auth0 DEV` | Complete both browser sign-ins when convenient; the Ops owner can then resume independently | Waiting on Dave |

## Decisions Needed Soon

No immediate product decision blocks current DEV engineering. The research issues below should return
recommendations before asking Dave to choose.

| Priority | Decision                                                        | Why it matters                                                                                                                | Tracking                                                          | Working direction                                                                                     | Status                   |
| -------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------ |
| P1       | Choose the initial greeting-card physical format and MVP scope  | Greeting cards are the near-term flagship but Letter IRL currently supports only letters and postcards                        | [Issue #176](https://github.com/dnobj/mail-letter-irl/issues/176) | Research provider feasibility and recommend a constrained U.S.-only MVP first                         | Research/planning queued |
| P1       | Select the primary launch customer segment and persona          | Positioning, onboarding, visual identity, roadmap, and acquisition should optimize for a clear first customer                 | [Issue #177](https://github.com/dnobj/mail-letter-irl/issues/177) | Score existing use cases/personas; use premium/minimal as the provisional product and brand direction | Research queued          |
| P1       | Approve each production-launch stage when its gate is satisfied | Private beta, limited public beta, and general availability should happen sequentially with explicit production authorization | [Issue #179](https://github.com/dnobj/mail-letter-irl/issues/179) | Define evidence-based gates first; no stage promotion is pre-authorized                               | Planning queued          |

## Strategy Conversations

| Priority | Conversation                                                                | Tracking                                                          | Current position                                                                                             | Status          |
| -------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------- |
| P2       | Decide stage-specific business targets and acceptable unit economics        | [Issue #181](https://github.com/dnobj/mail-letter-irl/issues/181) | Existing metric categories are useful, but targets and decision thresholds need research and Dave's judgment | Planning queued |
| P2       | Confirm the customer-facing delivery-status promise after provider research | [Issue #178](https://github.com/dnobj/mail-letter-irl/issues/178) | Promise only verifiable provider facts; clearly label estimates and uncertainty                              | Research queued |

## Deferred Questions

| Priority | Question                                                                                                    | Tracking                                                          | Revisit when                                                                    | Status |
| -------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------ |
| P3       | Should Letter IRL offer a subscription tied to birthday/anniversary reminders and assisted recurring cards? | [Issue #180](https://github.com/dnobj/mail-letter-irl/issues/180) | Primary segment, greeting-card MVP, and baseline unit economics are established | Future |

## Resolved Decisions and Standing Context

- Fulfillment geography is United States only. International mail remains future work.
- Letter IRL does not research recipient addresses; ChatGPT or another agent may research them, and the user
  must verify any researched or inferred address before sending.
- The current commercial model combines pay per send with prepaid credits.
- Premium/minimal is the provisional visual direction for both product experience and brand/site design;
  the selected primary segment should refine it.
- Production rollout should proceed in sequence: private beta, limited public beta, then general availability.

Move completed one-time actions out of the active tables after recording durable evidence in the owning
issue or plan. Keep standing decisions here only while they materially prevent repeated questions.
