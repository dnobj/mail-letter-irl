# Test: Send Letter with Header Image

**Purpose:** Verify that users can send a letter with a header image through the Letter IRL app.

**Test ID:** TEST-004

**Category:** Letter Sending - Header Image

## Background

This tests sending a letter that includes a header image at the top of the letter. The image appears above the letter text content. This requires the user to have an image available before composing the letter.

**Image Requirement:** The header image must be provided/referenced during letter composition.

## Start State

- Browser open to https://chatgpt.com
- User logged in to ChatGPT
- New chat (no existing conversation)
- No modals or dialogs open (main chat interface visible)
- An image available (either generate first OR use existing from Images gallery)

## End State

- Browser at https://chatgpt.com
- Chat contains the letter composition conversation with image
- Letter draft created with header image (or confirmation)
- ${APP_NAME} app activated (chip visible in input area)

## Prerequisites

- ${APP_NAME} app already connected to account
- Test user has available credits
- An image is available to use (see Image Preparation section)

## Safety Gate

- **Real mail risk:** Can send real mail
- **Credit risk:** May consume one pre-paid letter send and possibly image-generation quota
- **Approval required before irreversible action:** Yes. Stop after preview unless the user explicitly approves sending during the test run.

## Image Preparation (Choose One Method)

### Method A: Generate Image First (Recommended)
1. Start a new chat WITHOUT activating the app
2. Request: `Generate a picture of a happy monkey`
3. Wait for DALL-E to generate a visible image
4. Then activate the Letter IRL app (image persists in chat)

### Method B: Use Existing Image from Gallery
1. Navigate to https://chatgpt.com/images
2. Note an available image (e.g., "Joyful capuchin in the jungle")
3. Start a new chat and activate the app
4. Reference the image by description when composing

### Method C: Upload Image File
1. Use an image file from local filesystem
2. When composing, use the "Add photos & files" option

## Test Steps

### 1. Prepare Image (Using Method A)
- Click **New chat** in the sidebar
- Type: `Generate a picture of a happy monkey`
- Wait for visible image to appear
- Verify image is displayed in chat

### 2. Activate Letter IRL App
- Click the **+** button on the left side of the chat input
- Hover over **... More** to expand the submenu
- Click **${APP_NAME}** from the submenu
- Verify the app chip appears in the input area

### 3. Request Letter with Header Image
- Type in the chat input: `I want to send a letter with that image as a header`
- Press Enter or click the send button
- Wait for ChatGPT to respond

### 4. Provide Letter Content
- When prompted, provide the letter content:
  ```
  Hello!

  I hope this letter with the monkey header image brings you joy!

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
- Review the letter preview/summary
- Verify the header image is included
- Confirm the letter should be sent

### 7. Verify Letter Creation
- Check that a letter draft is created with the header image
- Note any confirmation message or letter ID

## Expected Results

| Check | Expected |
|-------|----------|
| Image generated/available | YES |
| App activates successfully | YES |
| Image persists after app activation | YES |
| ChatGPT understands header image request | YES |
| Letter includes header image | YES |
| Letter draft/confirmation created | YES |

## Pass Criteria

- Image is successfully included as a header in the letter
- Letter draft shows the image in header position
- The workflow completes without errors

## Fail Criteria

- Image cannot be referenced after app activation
- Header image not included in letter
- Letter creation fails with error
- Image appears in wrong position (inline instead of header)

## Tool Notes

### Playwright MCP
- Wait for image generation (10-30 seconds) before proceeding
- Verify `img` element presence before activating app
- Check draft confirmation for image inclusion

### Codex Chrome Control
- Reuse a previously generated image in the same conversation when possible.
- Verify ChatGPT calls or offers `quote_and_preview_letter_with_header_image`, not text-only preview.
- Capture a screenshot when the header-image preview appears and stop before send unless approved.

### Claude Chrome Extension
- Describe when the generated image appears
- Note whether the letter preview shows the image in header position

### Manual Execution
- The "generate first, then activate" workflow is critical
- Take screenshots of the letter preview to verify image placement

## Notes

- The "generate first, then activate" workflow is recommended due to ChatGPT's image generation limitation with MCP apps
- Header images appear at the top of the letter, before the text content
- Image dimensions may be adjusted to fit the letter format

## Related Procedures

- [TEST-002-image-then-activate.md](./TEST-002-image-then-activate.md) - Image generation workaround
- [TEST-003-send-text-letter.md](./TEST-003-send-text-letter.md) - Text-only letter
- [TEST-005-send-inline-image-letter.md](./TEST-005-send-inline-image-letter.md) - Inline image letter
