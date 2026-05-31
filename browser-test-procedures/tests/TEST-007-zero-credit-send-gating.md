# Test: Zero-Credit Send Gating

**Purpose:** Verify that Letter IRL handles a user with zero available letters gracefully: previews may still be created, but send attempts should be blocked with clear balance guidance.

**Test ID:** TEST-007

**Category:** Credits - Insufficient Balance

## Background

Letter IRL users can create previews before buying a Letter Pack, but sending requires available letter balance. This test captures the zero-credit state so agents do not mistake an insufficient-balance response for an app/tool failure.

## Start State

- Browser open to https://chatgpt.com
- User logged in to ChatGPT
- `${APP_NAME}` app connected to the test account
- Test Letter IRL/Auth0 account has `0` letters remaining
- No modals or dialogs open

## End State

- Browser remains in ChatGPT
- Balance has been checked and recorded
- A preview or send attempt confirms that sending is unavailable with zero letters
- No mail has been sent

## Prerequisites

- `${APP_NAME}` app already connected to account
- Test account intentionally has zero available letters
- If the account has letters, run [TEST-008](./TEST-008-purchase-letter-pack.md) only after this zero-credit test, or use a separate empty test account

## Safety Gate

- **Real mail risk:** None expected when balance is zero
- **Credit risk:** None expected
- **Approval required before irreversible action:** Yes. Do not approve any send confirmation if credits unexpectedly exist.

## Test Steps

### 1. Start a New Chat
- Open ChatGPT and start a fresh conversation.
- Activate `${APP_NAME}` using the app picker.

### 2. Check Balance
- Ask: `Check my Letter IRL account balance.`
- Verify the response shows `0` letters remaining or otherwise indicates no sends are available.
- Record the OAuth account email shown by the app, because it may differ from the visible ChatGPT account.

### 3. Create a Preview
- Ask for a preview-only text letter:
  ```text
  Create a text-only physical letter preview only. Do not send it.
  Recipient: The Nelson-Atkins Museum of Art, 4525 Oak Street, Kansas City, MO 64111.
  Body: Thank you for making art accessible to the community. This is a safe zero-credit preview test.
  Sign off: Sincerely, Test User.
  ```
- Verify a preview can be created, or record any preview-time insufficient-balance warning.

### 4. Attempt Send Only If Safe
- If ChatGPT offers to send, do not approve unless this test is intentionally being converted into a send test.
- If a send attempt is made without approval, verify it fails or asks the user to buy a Letter Pack.

### 5. Record Guidance
- Confirm ChatGPT or the app explains how to buy letters, such as directing the user to the Letter IRL website or Letter Packs dashboard.

## Expected Results

| Check | Expected |
|-------|----------|
| Balance check works | YES |
| Account identity shown | YES |
| Zero balance is clear | YES |
| Preview does not send mail | YES |
| Send is blocked or requires purchase | YES |
| No credits/mail consumed | YES |

## Pass Criteria

- The app reports zero available letters clearly.
- Any send path is blocked before credit deduction or real-world action.
- The user receives actionable guidance to purchase a Letter Pack.

## Fail Criteria

- The app allows a send with zero letters.
- The app deducts credits or creates a sent order despite a zero balance.
- The error message is vague enough that a tester could confuse it with a tool outage.

## Tool Notes

### Playwright MCP
- Use the balance response text to assert the zero-credit state before running send-related prompts.
- Stop before clicking any ChatGPT confirmation button if the balance unexpectedly shows available letters.

### Codex Chrome Control
- Use a fresh conversation and activate the app with `@`.
- Capture the balance response and any preview/error widget.
- If ChatGPT or Auth0 asks for login, use `browser-test-procedures/config/.env.{environment}` without printing secret values.

### Claude Chrome Extension
- Ask Claude to verify the balance first, then create a preview-only letter.
- Explicitly tell Claude not to approve send confirmations.

### Manual Execution
- Keep the account in a known zero-balance state before starting.
- If the account has available letters, this test is no longer valid; either use another account or spend/reset the dev balance intentionally.

## Notes

- Letter balance and image-generation quota are separate. A zero letter balance does not necessarily mean image generation is unavailable.
- In the May 31, 2026 dev run, a zero-balance account blocked sends and app image generation initially reported quota exhaustion until a Letter Pack purchase refreshed account entitlements.

## Related Procedures

- [TEST-008-purchase-letter-pack.md](./TEST-008-purchase-letter-pack.md) - Purchase simulated dev letters
- [TEST-003-send-text-letter.md](./TEST-003-send-text-letter.md) - Text letter send after credits exist
