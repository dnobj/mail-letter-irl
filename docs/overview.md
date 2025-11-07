# Scope and Goals

## Product Snapshot
- **Product name:** Letter IRL
- **Primary objective:** Enable ChatGPT users to draft, review, and mail physical letters using the Apps SDK integration.
- **Target release:** v1 prototype for OpenAI Apps SDK review.

## Core Outcomes for v1
- Draft a physical letter with standard ChatGPT assistance.
- Present an exact print preview prior to mailing.
- Require explicit user approval before queuing any physical mail.
- Track statuses for previously sent letters within ChatGPT.
- Display the sender's Letter IRL credit balance.

## Business Model (v1)
- Users pre-hold **Letter IRL credits** (1 credit = one standard one-page First Class letter).
- Multi-page letters may cost additional credits, but the UI only shows the total required amount provided by the server.
- Credits are maintained server-side and scoped per authenticated user identity.

## OpenAI Review Constraints
- No letter is mailed without explicit human confirmation.
- Users must see the full preview, recipient, and total credit cost before approval.
- Read-only tool calls must be clearly separable from mutating calls.

## Explicit Non-Goals
- Payments or credit purchases.
- Batch, bulk, or campaign mailings.
- Special delivery classes (certified, registered, signature-required).
- Legal compliance automations, notarization, or authenticity QR codes.
- Automatic verification of letter authenticity (kept on roadmap).

## Hand-off Notes
- This specification is designed for engineers (human or Codex) to begin implementing both the MCP server and Apps SDK widgets.
- The next recommended artifact after this documentation is a server skeleton with stubbed tool handlers and widget templates.
