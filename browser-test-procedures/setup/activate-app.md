# Activate ${APP_NAME} App for Current Chat

**Purpose:** Enable the ${APP_NAME} app for use in the current ChatGPT conversation.

**When to use:** When starting a new chat where you want to test Letter IRL functionality.

## Start State

- Browser open to https://chatgpt.com
- User logged in to ChatGPT
- No modals or dialogs open (main chat interface visible)
- ${APP_NAME} app already created and connected

## End State

- Browser at https://chatgpt.com
- No modals or dialogs open (main chat interface visible)
- ${APP_NAME} app activated for the current chat
- Letter IRL tools available in the conversation

## Prerequisites

- ${APP_NAME} app already created (see [add-app.md](./add-app.md))

## Handling Login Interruptions

If at any point the test is interrupted with a login request (Auth0), use the test credentials from `../config/.env.{environment}`:
- **Email:** `${USERNAME}`
- **Password:** `${PASSWORD}`

## Procedure

### 1. Open the App Picker
- Click in the chat input box.
- Type `@` to open the app picker.

### 2. Select the Dev App
- Click **${APP_NAME}** from the app picker.
- If multiple similarly named apps appear, select the entry that matches the test environment.

### 3. Handle Login (if prompted)
- If an Auth0 login page appears, enter the test credentials
- After successful auth, you'll be returned to the chat

### 4. Verify Activation
- The app should now be active for the current chat
- Verify that the app chip is visible in the composer before submitting the test prompt.
- You can also verify by asking ChatGPT what tools are available for the app.

## Tool Notes

### Playwright MCP
| Step | Element | Selector Pattern |
|------|---------|------------------|
| Composer | Textbox | `textarea` or `div[contenteditable="true"]` |
| App picker | Text trigger | Type `@` in the composer |
| App option | Menu item | `${APP_NAME}` |

### Claude Chrome Extension
- Use natural language: "Click the composer, type @, and select the dev Letter IRL app."

### Manual Execution
- If the `@` app picker does not show `${APP_NAME}`, open **Settings > Apps**, confirm the app is connected, then return to the chat and refresh the page.
- Older ChatGPT builds exposed apps under the `+` menu and a `More` submenu. Prefer the `@` picker when available because it matched the May 31, 2026 desktop UI during manual testing.

## Notes

- Login is typically only required on first use or after token expiration
- This activates the app for the current chat only; new chats require re-activation
- The app uses the development Auth0 tenant: `dev-ky21dxn3qmi71hjl.us.auth0.com`
