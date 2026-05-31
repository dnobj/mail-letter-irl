# Reset Dev App Connection

**Purpose:** Remove and re-add the ${APP_NAME} app connection to reset the OAuth flow and clear any stale state.

**When to use:**
- Testing fresh OAuth authorization flow
- Clearing stale tokens or connection issues
- Verifying end-to-end app setup works correctly
- After making changes to MCP server or Auth0 configuration

## Start State

- Browser open to https://chatgpt.com
- User logged in to ChatGPT
- No modals or dialogs open (main chat interface visible)
- The ${APP_NAME} app is currently connected

## End State

- Browser at https://chatgpt.com
- User logged in to ChatGPT
- No modals or dialogs open (main chat interface visible)
- New ${APP_NAME} app connection established with fresh OAuth tokens

## Prerequisites

- Browser open to https://chatgpt.com
- User logged in to ChatGPT
- The ${APP_NAME} app is currently connected

## Credentials

Test credentials are stored in `../config/.env.{environment}`:
- **Email:** `${USERNAME}`
- **Password:** `${PASSWORD}`

See `../config/.env.example` for the template format.

## Procedure

### Step 1: Remove Existing Dev App

Follow the procedure in [remove-app.md](./remove-app.md):

1. Open Settings (click profile in lower-left)
2. Navigate to Apps tab
3. Click on ${APP_NAME}
4. Click Manage > Delete
5. Verify app is removed from "Enabled apps"

### Step 2: Re-Add Dev App

Follow the procedure in [add-app.md](./add-app.md):

1. Click "Create app" button
2. Fill in app details:
   - **Name:** `${APP_NAME}`
   - **MCP Server URL:** `${APP_URL}`
3. Check "I understand and want to continue"
4. Click Create
5. Complete OAuth sign-in flow
6. Verify app appears in "Enabled apps"

### Step 3: Return to Home State

Close the Settings modal to return to the main ChatGPT interface:

1. Click the **X** button in the upper-right corner of the Settings modal
2. Verify the Settings modal is closed and the main chat interface is visible

## Expected Outcome

- Old app connection is removed
- New app connection is established with fresh OAuth tokens
- App appears under both "Drafts" and "Enabled apps"
- MCP tools are available in chat

## Troubleshooting

| Issue | Solution |
|-------|----------|
| App not appearing after creation | Refresh the page and check Apps tab again |
| OAuth flow fails | Check Auth0 dev tenant configuration |
| MCP tools not available | Verify MCP server URL is correct and server is running |
| "Connection refused" errors | Check Railway deployment status |

## Related Procedures

- [remove-app.md](./remove-app.md) - Remove app only
- [add-app.md](./add-app.md) - Add app only (assumes Settings > Apps is open)
