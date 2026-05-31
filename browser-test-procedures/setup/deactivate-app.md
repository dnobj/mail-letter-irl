# Deactivate ${APP_NAME} App for Current Chat

**Purpose:** Disable the ${APP_NAME} app for the current ChatGPT conversation.

**When to use:** When you want to stop using Letter IRL in the current chat, or when testing app activation/deactivation flows.

## Start State

- Browser open to https://chatgpt.com
- User logged in to ChatGPT
- No modals or dialogs open (main chat interface visible)
- ${APP_NAME} app currently activated for the chat (visible as chip in input area)

## End State

- Browser at https://chatgpt.com
- No modals or dialogs open (main chat interface visible)
- ${APP_NAME} app deactivated (chip no longer visible in input area)

## Prerequisites

- ${APP_NAME} app is currently active in the chat

## Procedure

### 1. Locate the App Chip
- Find the **${APP_NAME}** chip/button in the chat input area (to the right of the + button)

### 2. Remove the App

**Option A - Click directly (Recommended):**
- Click the **${APP_NAME}** chip directly
- The chip will be removed from the input area

**Option B - Hover then click X:**
- Hover over the **${APP_NAME}** text
- An **X** icon will appear to the right of the app name
- Click the **X** icon to remove the chip

### 3. Verify Deactivation
- The ${APP_NAME} chip should no longer be visible in the chat input area
- Letter IRL tools will no longer be available in this conversation

## Tool Notes

### Playwright MCP
| Step | Element | Selector Pattern |
|------|---------|------------------|
| App chip | Button | `button "${APP_NAME}, click to remove"` |
| X icon | Within the chip | The X appears on hover within the chip |

### Claude Chrome Extension
- Describe the chip visually: "Click the Letter IRL chip/tag in the input area"
- The X icon only appears on hover

### Manual Execution
- The X icon only appears on hover - it's not visible by default
- Clicking directly on the chip text also works to remove it

## Notes

- Deactivating the app only affects the current chat; it does not disconnect the app from your account
- To reactivate, use the [activate-app.md](./activate-app.md) procedure

## Related Procedures

- [activate-app.md](./activate-app.md) - Enable the dev app for a chat
