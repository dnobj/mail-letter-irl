# Test: Send Text-Only Letter

**Purpose:** Verify that users can send a basic text-only letter through the Letter IRL app.

**Test ID:** TEST-003

**Category:** Letter Sending - Text Only

## Background

This tests the simplest letter type: a plain text letter with no images. The user composes the letter content and provides recipient address information.

## Start State

- Browser open to https://chatgpt.com
- User logged in to ChatGPT
- New chat (no existing conversation)
- No modals or dialogs open (main chat interface visible)
- ${APP_NAME} app NOT activated yet

## End State

- Browser at https://chatgpt.com
- Chat contains the letter composition conversation
- Letter draft created (or confirmation of letter creation)
- ${APP_NAME} app activated (chip visible in input area)

## Prerequisites

- ${APP_NAME} app already connected to account
- Test user has available credits (or test environment allows free sends)

## Safety Gate

- **Real mail risk:** Can send real mail
- **Credit risk:** May consume one pre-paid letter send
- **Approval required before irreversible action:** Yes. Stop after preview unless the user explicitly approves sending during the test run.

## Test Steps

### 1. Start a New Chat
- Click **New chat** in the sidebar (or use Ctrl+Shift+O)
- Verify a fresh chat interface is displayed

### 2. Activate Letter IRL App
- Click the **+** button on the left side of the chat input
- Hover over **... More** to expand the submenu
- Click **${APP_NAME}** from the submenu
- Verify the app chip appears in the input area

### 3. Request to Send a Letter
- Type in the chat input: `I want to send a letter to myself`
- Press Enter or click the send button
- Wait for ChatGPT to respond

### 4. Provide Letter Content
- When prompted, provide the letter content:
  ```
  Dear Future Me,

  This is a test letter sent through Letter IRL.

  Best regards,
  Test User
  ```

### 5. Provide Recipient Address
- When prompted for address, provide:
  - Name: Test User
  - Address: 123 Test Street
  - City: Test City
  - State: MO
  - ZIP: 63101

### 6. Confirm Letter Details
- Review the letter preview/summary provided by ChatGPT
- Confirm the letter should be sent

### 7. Verify Letter Creation
- Check that a letter draft is created or letter is queued for sending
- Note any confirmation message or letter ID

## Expected Results

| Check | Expected |
|-------|----------|
| App activates successfully | YES |
| ChatGPT understands letter request | YES |
| Letter content accepted | YES |
| Address information accepted | YES |
| Letter draft/confirmation created | YES |
| No error messages | YES |

## Pass Criteria

- Letter IRL app successfully processes the text-only letter request
- A letter draft is created or confirmation is received
- The workflow completes without errors

## Fail Criteria

- App fails to activate
- ChatGPT doesn't understand the letter request
- Letter creation fails with error
- Address validation fails unexpectedly

## Tool Notes

### Playwright MCP
- Use `browser_type` for entering letter content and address fields
- Use `browser_wait_for` after each submission for ChatGPT response
- Look for confirmation elements or draft creation messages

### Codex Chrome Control
- Use a fresh ChatGPT conversation and activate the configured app from the input composer.
- Prefer preview-only validation unless the user explicitly approves the send.
- Capture a screenshot when the `LetterPreviewCard` appears and record whether the send button is visible/enabled.

### Claude Chrome Extension
- Follow the conversational flow naturally
- Describe any error messages or unexpected responses

### Manual Execution
- The exact prompts from ChatGPT may vary
- Be prepared to provide information in different orders if ChatGPT asks differently

## Notes

- This is the simplest letter type with no image requirements
- The exact prompts from ChatGPT may vary
- Test may require credits; check test account balance

## Related Procedures

- [activate-app.md](../setup/activate-app.md) - App activation procedure
- [TEST-004-send-header-image-letter.md](./TEST-004-send-header-image-letter.md) - Letter with header image
