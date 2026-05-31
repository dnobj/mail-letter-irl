# Test Catalog

This document lists all test procedures with their purpose, category, and dependencies.

## Execution Methods

Tests can be executed using any of these methods:
- **Playwright MCP** - Via the `manual-tester` Claude agent
- **Codex Chrome Control** - Via the Codex Chrome Extension and the user's logged-in Chrome profile
- **Claude Chrome Extension** - Interactive browser testing
- **Manual** - Human tester following documented steps

See [../README.md](../README.md) for details on each method.

## Test Index

| ID | Name | Category | Status |
|----|------|----------|--------|
| [TEST-001](./TEST-001-image-with-app-active.md) | Image with App Active | Known Limitation | Expected Fail |
| [TEST-002](./TEST-002-image-then-activate.md) | Image Then Activate | Workaround | Active |
| [TEST-003](./TEST-003-send-text-letter.md) | Send Text Letter | Letter Sending | Active |
| [TEST-004](./TEST-004-send-header-image-letter.md) | Send Header Image Letter | Letter Sending | Active |
| [TEST-005](./TEST-005-send-inline-image-letter.md) | Send Inline Image Letter | Letter Sending | Active |
| [TEST-006](./TEST-006-send-postcard.md) | Send Postcard | Letter Sending | Active |
| [TEST-007](./TEST-007-zero-credit-send-gating.md) | Zero-Credit Send Gating | Credits | Active |
| [TEST-008](./TEST-008-purchase-letter-pack.md) | Purchase Letter Pack | Credits | Active |

## Test Details

### TEST-001: Image with App Active

**Purpose:** Monitor whether ChatGPT can generate images when the Letter IRL app is already activated.

**Category:** Known Limitation

**Expected Result:** FAIL (limitation monitoring)

**Prerequisites:**
- App connected to account
- App activated for current chat

**Notes:** This test monitors a known ChatGPT limitation where DALL-E doesn't work properly with MCP apps active.

---

### TEST-002: Image Then Activate

**Purpose:** Verify the workaround - generate image first, then activate app.

**Category:** Workaround

**Expected Result:** PASS

**Prerequisites:**
- App connected to account
- App NOT activated yet

**Notes:** This is the recommended workflow for users who need generated images in their letters.

---

### TEST-003: Send Text Letter

**Purpose:** Verify basic text-only letter sending through the app.

**Category:** Letter Sending - Basic

**Expected Result:** PASS

**Prerequisites:**
- App connected to account
- Test user has credits

**Notes:** This is the simplest letter type with no image requirements.

---

### TEST-004: Send Header Image Letter

**Purpose:** Verify sending a letter with a header image.

**Category:** Letter Sending - Images

**Expected Result:** PASS

**Prerequisites:**
- App connected to account
- Test user has credits
- Image available (generate first or use existing)

**Depends On:** TEST-002 workflow (generate image first)

---

### TEST-005: Send Inline Image Letter

**Purpose:** Verify sending a letter with an inline image in the body.

**Category:** Letter Sending - Images

**Expected Result:** PASS

**Prerequisites:**
- App connected to account
- Test user has credits
- Image available (generate first or use existing)

**Depends On:** TEST-002 workflow (generate image first)

---

### TEST-006: Send Postcard

**Purpose:** Verify sending a postcard (different format from letters).

**Category:** Letter Sending - Postcard

**Expected Result:** PASS

**Prerequisites:**
- App connected to account
- Test user has credits
- Image available (REQUIRED for postcards)

**Depends On:** TEST-002 workflow (generate image first)

---

### TEST-007: Zero-Credit Send Gating

**Purpose:** Verify that zero-balance users get clear guidance and cannot send without purchasing letters.

**Category:** Credits - Insufficient Balance

**Expected Result:** PASS

**Prerequisites:**
- App connected to account
- Test user has 0 letters remaining

**Notes:** Run before TEST-008 when validating the full empty-account-to-purchase journey.

---

### TEST-008: Purchase Letter Pack

**Purpose:** Verify the dev website Letter Pack purchase flow using Stripe test checkout and confirm ChatGPT sees the updated balance.

**Category:** Credits - Purchase Flow

**Expected Result:** PASS

**Prerequisites:**
- Development website available
- Test user can log in to the website
- Stripe checkout is in test mode

**Depends On:** TEST-007 when validating the zero-credit recovery flow.

## Categories

### Known Limitation
Tests that document known issues or limitations. Expected to fail until the underlying issue is resolved.

### Workaround
Tests that verify workarounds for known limitations.

### Letter Sending
Core functionality tests for sending letters and postcards through the app.

### Credits
Tests that validate balance, insufficient-credit handling, purchase flows, and ChatGPT/app balance propagation.

## Suggested Test Order

For a complete test run, execute in this order:

1. **TEST-007** - Verify zero-credit behavior if starting from an empty account
2. **TEST-008** - Purchase a dev Letter Pack if credits are needed
3. **TEST-001** - Verify app-active image behavior
4. **TEST-002** - Verify image-first workaround
5. **TEST-003** - Basic text letter
6. **TEST-004** - Header image letter
7. **TEST-005** - Inline image letter
8. **TEST-006** - Postcard

Tests 3-6 require available letters for actual sends. If the account has zero letters, run TEST-008 before the send tests or keep them preview-only.

## Codex Chrome Control Notes

- Use the development config by default unless the run request explicitly says production.
- Prefer creating a fresh ChatGPT conversation for each test so the start state is clean.
- Capture a screenshot or short observation when a widget appears, when a tool list appears, and when an error occurs.
- Stop before clicking or confirming any action that would call `send_letter` or `send_postcard` unless the user explicitly approves that send during the run.
- If ChatGPT or Auth0 requires login, pause and ask the user to complete login in Chrome.
