# Browser Test Procedures

This directory contains test procedures for the Letter IRL ChatGPT app. These procedures are **tool-agnostic** and can be executed using:

1. **Playwright MCP** - Automated browser testing via the `manual-tester` Claude agent
2. **Codex Chrome Control** - Assisted browser testing through the Codex Chrome Extension
3. **Claude Chrome Extension** - Interactive testing with AI assistance in the browser
4. **Manual Execution** - Human testers following the documented steps

## Directory Structure

```
browser-test-procedures/
├── README.md              # This file
├── _template.md           # Template for creating new procedures
├── config/
│   ├── .env.example       # Template for environment variables
│   ├── .env.development   # Development environment credentials
│   └── .env.production    # Production environment credentials
├── setup/                 # Utility procedures for app configuration
│   ├── activate-app.md    # Enable app for current chat
│   ├── add-app.md         # Create new app connection
│   ├── deactivate-app.md  # Disable app for current chat
│   ├── remove-app.md      # Delete app connection
│   └── reset-app.md       # Remove and re-add app
└── tests/
    ├── index.md           # Test catalog with descriptions
    ├── TEST-001-*.md      # Image generation tests
    ├── TEST-002-*.md
    ├── TEST-003-*.md      # Letter sending tests
    ├── TEST-004-*.md
    ├── TEST-005-*.md
    └── TEST-006-*.md
```

## Quick Start

### 1. Configure Environment

Copy the example config and fill in your test credentials:

```bash
cp config/.env.example config/.env.development
# Edit config/.env.development with your values
```

Environment variables:
- `APP_NAME` - The app display name in ChatGPT (e.g., "(DEV) Mail Letter IRL")
- `APP_URL` - The MCP server endpoint URL
- `USERNAME` - Auth0 test account email
- `PASSWORD` - Auth0 test account password

### 2. Choose Your Execution Method

#### Option A: Playwright MCP (Automated)

Use the `manual-tester` Claude agent to execute procedures automatically:

```
Run TEST-003 using development environment
```

The agent will:
- Read the procedure from this directory
- Load credentials from the appropriate config file
- Execute steps using Playwright browser automation
- Create a test log in `/manual-test-logs/`

#### Option B: Codex Chrome Control (Assisted)

1. Make sure Chrome is open with the Codex Chrome Extension enabled.
2. Ask Codex to run a specific procedure, for example:
   ```
   Run TEST-003 against development with Chrome control
   ```
3. Codex will use the documented procedure, interact with ChatGPT in Chrome, and record observations in `manual-test-logs/`.
4. Codex must pause before any irreversible send action (`send_letter` or `send_postcard`) unless you explicitly approve the send in that test run.

#### Option C: Claude Chrome Extension (Interactive)

1. Open ChatGPT in Chrome with the Claude extension active
2. Ask Claude to help execute the test procedure
3. Claude will guide you through each step interactively
4. Provide observations as Claude requests them

#### Option D: Manual Execution (Human)

1. Open the test procedure file (e.g., `tests/TEST-003-send-text-letter.md`)
2. Follow the documented steps
3. Use credentials from `config/.env.{environment}`
4. Document results in a test log

## Test Naming Convention

Tests follow the pattern: `TEST-###-short-description.md`

| ID | Name | Category |
|----|------|----------|
| TEST-001 | Image with app active | Known Limitation |
| TEST-002 | Image then activate | Workaround |
| TEST-003 | Send text letter | Letter Sending |
| TEST-004 | Send header image letter | Letter Sending |
| TEST-005 | Send inline image letter | Letter Sending |
| TEST-006 | Send postcard | Letter Sending |
| TEST-007 | Zero-credit send gating | Credits |
| TEST-008 | Purchase Letter Pack | Credits |

See [tests/index.md](./tests/index.md) for the full test catalog.

## Credit And Purchase Tests

Use these procedures when a send test fails or cannot proceed because the account has no available letters:

1. Run [TEST-007](./tests/TEST-007-zero-credit-send-gating.md) to document the zero-balance state and verify the app gives clear purchase guidance.
2. Run [TEST-008](./tests/TEST-008-purchase-letter-pack.md) to buy a development Letter Pack using Stripe test checkout.
3. Re-run [TEST-003](./tests/TEST-003-send-text-letter.md), [TEST-004](./tests/TEST-004-send-header-image-letter.md), [TEST-005](./tests/TEST-005-send-inline-image-letter.md), or [TEST-006](./tests/TEST-006-send-postcard.md) after the balance updates.

For development purchases, first confirm the checkout session is in Stripe test mode (`cs_test_`). Use only Stripe's published test payment methods, such as `4242 4242 4242 4242` for a successful card payment.

## Setup Procedures

Setup procedures handle app configuration and are used as prerequisites or utilities:

| Procedure | Purpose |
|-----------|---------|
| `activate-app.md` | Enable app for current chat |
| `add-app.md` | Create new app from Settings > Apps |
| `deactivate-app.md` | Disable app for current chat |
| `remove-app.md` | Delete app connection |
| `reset-app.md` | Complete remove and re-add cycle |

## Procedure Format

Each procedure includes:

- **Purpose** - What the procedure accomplishes
- **Start State** - Required browser state before starting
- **End State** - Expected browser state after completion
- **Prerequisites** - Requirements that must be met first
- **Procedure** - Step-by-step instructions
- **Tool Notes** - Specific guidance for each execution method
- **Safety Gate** - Whether the procedure can create real mail or consume credits
- **Related Procedures** - Links to related procedures

## Creating New Procedures

1. Copy `_template.md` to the appropriate directory
2. Follow the template structure
3. Include all three Tool Notes sections (Playwright MCP, Chrome Extension, Manual)
4. Update `tests/index.md` if adding a new test
5. Use consistent naming: `TEST-###-description.md` for tests

## Test Logs

Write assisted or manual run notes under `manual-test-logs/` using one Markdown file per run. Suggested name:

```bash
manual-test-logs/YYYY-MM-DD-TEST-###-environment.md
```

Record the environment, ChatGPT account when known, app name, steps completed, pass/fail status, screenshots if captured, and whether any send action was stopped or approved.

## Environment Security

**Important:** The `config/.env.development` and `config/.env.production` files contain sensitive credentials and are excluded from git via `.gitignore`. Only `.env.example` is committed.

Never commit real credentials to the repository.
