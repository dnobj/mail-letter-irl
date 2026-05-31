# Procedure Template

This is a template for creating new test procedures. Copy this file and fill in the sections.

---

# [Procedure Name]

**Purpose:** [One sentence describing what this procedure accomplishes]

**When to use:** [Describe the scenarios when this procedure should be executed]

## Start State

**Required starting point:** [Describe the exact browser/application state required before starting]

Example:
- ChatGPT home page (https://chatgpt.com)
- User logged in
- No modals or dialogs open

## End State

**Expected ending point:** [Describe the exact browser/application state after successful completion]

Example:
- ChatGPT home page
- No modals or dialogs open
- [Any specific changes that should be visible]

## Prerequisites

- [List any requirements that must be met before running this procedure]
- [e.g., specific apps installed, accounts configured, etc.]

## Safety Gate

- **Real mail risk:** [None / Preview only / Can send real mail]
- **Credit risk:** [None / May consume credits]
- **Approval required before irreversible action:** [Yes / No]

## Handling Login Interruptions

If at any point the test is interrupted with a login request (Auth0), use the test credentials from `../config/.env.{environment}`:
- **Email:** `${USERNAME}`
- **Password:** `${PASSWORD}`

## Procedure

### 1. [First Step Name]
- [Detailed action to take]
- [Expected result]

### 2. [Second Step Name]
- [Detailed action to take]
- [Expected result]

### 3. [Continue as needed...]

## Tool Notes

### Playwright MCP

[Selector patterns and automation tips for the `manual-tester` agent]

| Step | Element | Selector Pattern |
|------|---------|------------------|
| [Step description] | [Element type] | [Selector] |

### Claude Chrome Extension

[Natural language guidance for interactive testing]
- [How to describe elements to the extension]
- [Any interactive notes or things to watch for]

### Codex Chrome Control

[Notes for Codex-driven Chrome testing]
- [Selectors, visible text, or DOM cues that are reliable]
- [When to pause for user login, OAuth, CAPTCHA, payment, or send confirmation]
- [What screenshots or console observations should be captured]

### Manual Execution

[Human tester tips and known UI quirks]
- [Known issues with specific environments (e.g., WSLg submenu bugs)]
- [Visual cues to look for]
- [Common pitfalls to avoid]

## Values

| Field | Dev Value | Production Value |
|-------|-----------|------------------|
| [Field name] | [Dev value] | [Prod value] |

## Notes

- [Any additional information, known issues, or tips]
- [e.g., WSLg submenu rendering issues]

## Related Procedures

- [link-to-related.md](./link-to-related.md) - Brief description

---

## Template Guidelines

1. **Start State and End State are required** - Every procedure must explicitly state:
   - Where the browser should be before starting
   - Where the browser should be after completion

2. **Standard start/end state** - Most procedures should use:
   - **Start:** ChatGPT home page, logged in, no modals open
   - **End:** ChatGPT home page, logged in, no modals open

3. **Exceptions** - Some procedures may have different end states:
   - `remove-app.md` ends at Settings > Apps (for chaining with add-app)
   - Document these explicitly

4. **Login handling** - Always include the login interruption section for procedures that may trigger OAuth flows

5. **Tool Notes** - Include guidance for all three execution methods:
   - Playwright MCP: Selector patterns for automation
   - Codex Chrome Control: browser-control notes, stop points, screenshots/logging
   - Chrome Extension: Natural language descriptions
   - Manual: Human-readable tips and known issues

6. **Keep procedures atomic** - Each procedure should do one thing well. Chain procedures for complex flows.
