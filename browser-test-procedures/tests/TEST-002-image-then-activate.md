# Test: Generate Image First, Then Activate Letter IRL App

**Purpose:** Verify that users can generate an image first, then activate the Letter IRL app to use that image for sending a letter or postcard.

**Test ID:** TEST-002

**Category:** Chat Functionality - Workaround

## Background

This test documents the workaround for the known limitation where ChatGPT cannot generate images after an MCP app is activated. By generating the image FIRST, users can then activate the app and use the generated image.

## Start State

- Browser open to https://chatgpt.com
- User logged in to ChatGPT
- New chat (no existing conversation)
- No modals or dialogs open (main chat interface visible)
- Letter IRL app NOT activated yet

## End State

- Browser at https://chatgpt.com
- Chat contains:
  - User's image generation request
  - ChatGPT response with **visible generated image**
- ${APP_NAME} app activated (chip visible in input area)
- User can now use Letter IRL tools with the generated image

## Safety Gate

- **Real mail risk:** None
- **Credit risk:** None unless follow-up preview/send steps are added
- **Approval required before irreversible action:** Yes, if the run moves beyond image generation into sending mail

## Test Steps

### 1. Start a New Chat
- Click **New chat** in the sidebar (or use Ctrl+Shift+O)
- Verify a fresh chat interface is displayed
- Verify NO app chips are visible in the input area

### 2. Send Image Generation Request (Before App Activation)
- Type in the chat input: `Generate a picture of a happy monkey`
- Press Enter or click the send button

### 3. Wait for Image Generation
- Wait for ChatGPT to generate the image (10-30 seconds)
- Verify a **visible image** appears in the response

### 4. Activate Letter IRL App
- Click the **+** button on the left side of the chat input
- Hover over **... More** to expand the submenu
- Click **${APP_NAME}** from the submenu
- Verify the app chip appears in the input area

### 5. Verify Final State
- The generated image should still be visible in the chat
- The Letter IRL app should be active
- User should now be able to reference the image for a letter/postcard

## Expected Results

| Check | Expected |
|-------|----------|
| Image generated | **YES** |
| Image visible in chat | **YES** |
| App activated successfully | YES |
| Image persists after activation | YES |

## Pass Criteria

- ChatGPT generates a visible image of a happy monkey
- The image remains visible after activating the Letter IRL app
- The app can be used for subsequent messages in the chat

## Fail Criteria

- No image is generated
- Image disappears after activating the app
- App fails to activate

## Tool Notes

### Playwright MCP
- Use `browser_wait_for` after requesting image generation (10-30 seconds)
- Check for `img` elements in the chat response
- Verify the app chip element after activation

### Codex Chrome Control
- Use a fresh ChatGPT conversation with no app chip active at first.
- Capture a screenshot after the generated image appears.
- After activating the app, verify ChatGPT can still reference the existing image without opening `upload_image` first.

### Claude Chrome Extension
- Describe when the image appears in the chat
- Note the image content (should match "happy monkey" request)

### Manual Execution
- Image generation can take 10-30 seconds - be patient
- Take a screenshot of the generated image for verification

## Notes

- This is the recommended workflow for users who want to include generated images in their letters/postcards
- Generate images BEFORE activating the Letter IRL app
- The image can then be referenced when composing the letter

## Related Procedures

- [TEST-001-image-with-app-active.md](./TEST-001-image-with-app-active.md) - Documents the limitation (app active first)
- [activate-app.md](../setup/activate-app.md) - App activation procedure
