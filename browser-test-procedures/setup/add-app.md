# Add Dev App from Apps Modal

**Purpose:** Create the ${APP_NAME} app in ChatGPT from the Settings > Apps modal.

**When to use:** After removing the dev app connection, or when setting up a fresh test account.

## Start State

- Browser open to https://chatgpt.com
- User logged in to ChatGPT
- Settings modal open, Apps tab selected

**Note:** This procedure starts with Settings > Apps already open to allow chaining from [remove-app.md](./remove-app.md).

## End State

- Browser at https://chatgpt.com
- No modals or dialogs open (main chat interface visible)
- ${APP_NAME} app connected and visible in "Enabled apps"

## Prerequisites

- Settings > Apps modal already open (see Start State)

## Handling Login Interruptions

If at any point the test is interrupted with a login request (ChatGPT or Auth0), use the test credentials from `../config/.env.{environment}`:
- **Email:** `${USERNAME}`
- **Password:** `${PASSWORD}`

## Procedure

### 1. Open Create App Form
- Click **Create app** button (to the right of "Advanced settings")

### 2. Fill in App Details
- **Name:** `${APP_NAME}`
- **MCP Server URL:** `${APP_URL}`
- Leave Description and Icon empty (optional fields)
- Leave Authentication as "OAuth" (default)
- Leave OAuth client ID/secret empty (server handles via DCR)

### 3. Accept Risk Warning
- Check the checkbox: **"I understand and want to continue"**

### 4. Create the App
- Click **Create** button

### 5. Complete OAuth Sign-in
- An OAuth flow will be triggered
- Sign in with your Auth0 credentials (dev tenant)
- After successful auth, you'll be returned to ChatGPT

### 6. Verify
- The app should appear under "Drafts" section
- It will also appear under "Enabled apps" once connected

### 7. Return to Home State
- Click the **X** button in the upper-right corner of the Settings modal
- Verify the Settings modal is closed and the main chat interface is visible

## Tool Notes

### Playwright MCP
| Step | Element | Selector Pattern |
|------|---------|------------------|
| Create app button | Button | `button "Create app"` |
| Name field | Textbox | `textbox "Name"` |
| MCP Server URL field | Textbox | `textbox "MCP Server URL"` |
| Understand checkbox | Checkbox | `checkbox "I understand..."` or `getByTestId('trust-checkbox')` |
| Create button | Button | `button "Create"` |

### Claude Chrome Extension
- Form fields can be described naturally: "Fill in the name field with..."
- The checkbox may need explicit interaction description

### Manual Execution
- The Create button is disabled until both Name and URL are filled AND the checkbox is checked
- OAuth popup may open in a new window - don't close the ChatGPT tab

## Values

Values are loaded from `../config/.env.{environment}`:

| Field | Variable |
|-------|----------|
| Name | `${APP_NAME}` |
| MCP Server URL | `${APP_URL}` |

See `../config/.env.example` for the template.

## Notes

- OAuth authentication uses Auth0 dev tenant: `dev-ky21dxn3qmi71hjl.us.auth0.com`
- After creation, the app appears in "Drafts" (developer mode apps)
- This procedure creates a NEW draft app; to reconnect an existing draft, use a different flow
