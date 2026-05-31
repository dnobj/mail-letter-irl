# Remove Dev App from ChatGPT

**Purpose:** Remove the ${APP_NAME} app connection from a ChatGPT account.

**When to use:** When you need to reset the dev app connection (e.g., to test fresh OAuth flow, clear stale tokens, or troubleshoot connection issues).

## Start State

- Browser open to https://chatgpt.com
- User logged in to ChatGPT
- No modals or dialogs open (main chat interface visible)

## End State

- Browser at https://chatgpt.com
- Settings modal open, Apps tab selected
- ${APP_NAME} app removed from "Enabled apps"

**Note:** This procedure intentionally ends at Settings > Apps to allow chaining with [add-app.md](./add-app.md).

## Prerequisites

- Browser open to https://chatgpt.com
- User logged in to ChatGPT

## Handling Login Interruptions

If at any point the test is interrupted with a login request, use the test credentials from `../config/.env.{environment}`:
- **Email:** `${USERNAME}`
- **Password:** `${PASSWORD}`

## Procedure

### 1. Open Settings
- Click on the **profile area** in the lower-left (shows username like "David Nicholl" with "Plus" badge)
- Click **Settings** from the menu

### 2. Navigate to Apps
- In the Settings modal, click **Apps** tab in the left navigation

### 3. Select the Dev App
- Under "Enabled apps" section, click on **${APP_NAME}**
- This opens the app details panel showing connection info, actions, and templates

### 4. Delete the App Connection
- Click the **Manage** button (circle/icon to the right of "Disconnect")
- Click **Delete** from the dropdown menu

### 5. Verify
- The app should no longer appear under "Enabled apps"
- Note: "Mail Letter IRL" may still appear under "Drafts" - this is the draft app definition, not the connection

## Tool Notes

### Playwright MCP
| Step | Element | Selector Pattern |
|------|---------|------------------|
| Profile button | David Nicholl / Plus | Button in lower-left with username |
| Settings | Menu item | `menuitem "Settings"` |
| Apps tab | Tab | `tab "Apps"` |
| Dev app | Button | `button "${APP_NAME} DEV"` |
| Manage | Button | `button "Manage"` (next to Disconnect) |
| Delete | Menu item | `menuitem "Delete"` |

### Claude Chrome Extension
- Navigate step by step: "Click on the profile area in the lower left"
- Settings menu items can be described by their text

### Manual Execution
- The profile area may show different usernames depending on the logged-in account
- The "Manage" dropdown is a small icon that may be easy to miss

## Notes

- The "Drafts" section contains app definitions created in developer mode - these are separate from enabled connections
- Deleting the connection does not delete the draft app definition
- After deletion, the user will need to re-authorize when using the dev app again
