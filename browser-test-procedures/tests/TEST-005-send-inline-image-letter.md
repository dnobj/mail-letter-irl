# Test: Send Letter with Inline Image

**Purpose:** Verify that users can send a letter with an inline image through the Letter IRL app.

**Test ID:** TEST-005

**Category:** Letter Sending - Inline Image

## Background

This tests sending a letter that includes an inline image embedded within the letter text content. Unlike header images, inline images appear within the body of the letter, between paragraphs of text.

**Image Requirement:** The inline image must be provided/referenced during letter composition.

## Start State

- Browser open to https://chatgpt.com
- User logged in to ChatGPT
- New chat (no existing conversation)
- No modals or dialogs open (main chat interface visible)
- An image available (either generate first OR use existing from Images gallery)

## End State

- Browser at https://chatgpt.com
- Chat contains the letter composition conversation with image
- Letter draft created with inline image (or confirmation)
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

### 3. Request Letter with Inline Image
- Type in the chat input: `I want to send a letter with that image included inline in the middle of the text`
- Press Enter or click the send button
- Wait for ChatGPT to respond

### 4. Provide Letter Content with Image Placement
- When prompted, provide the letter content indicating where the image should go:
  ```
  Dear Friend,

  I wanted to share something that made me smile today.

  [INSERT IMAGE HERE]

  Isn't that just wonderful? I hope it brightens your day too!

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
- Verify the inline image is included in the correct position
- Confirm the letter should be sent

### 7. Verify Letter Creation
- Check that a letter draft is created with the inline image
- Verify image appears within the letter body (not as header)
- Note any confirmation message or letter ID

## Expected Results

| Check | Expected |
|-------|----------|
| Image generated/available | YES |
| App activates successfully | YES |
| Image persists after app activation | YES |
| ChatGPT understands inline image request | YES |
| Letter includes inline image | YES |
| Image positioned within text body | YES |
| Letter draft/confirmation created | YES |

## Pass Criteria

- Image is successfully included inline within the letter text
- Letter draft shows the image in the correct position (within body, not header)
- The workflow completes without errors

## Fail Criteria

- Image cannot be referenced after app activation
- Inline image not included in letter
- Image appears in wrong position (header instead of inline)
- Letter creation fails with error

## Tool Notes

### Playwright MCP
- Wait for image generation before proceeding
- Check the letter preview/draft to verify image placement
- Look for image within the letter body, not at the top

### Codex Chrome Control
- Reuse a previously generated image in the same conversation when possible.
- Verify ChatGPT calls or offers `quote_and_preview_letter_with_image`, not header-image preview.
- Capture a screenshot when the inline-image preview appears and stop before send unless approved.

### Claude Chrome Extension
- Note the position of the image in the letter preview
- Describe whether it appears within the text or at the top

### Manual Execution
- The exact placement may depend on how you specify the location
- Take screenshots of the preview to verify inline positioning

## Notes

- The "generate first, then activate" workflow is recommended due to ChatGPT's image generation limitation with MCP apps
- Inline images appear within the letter body, between text paragraphs
- The exact placement may depend on how the user specifies the location
- Image dimensions may be adjusted to fit within the letter body

## Related Procedures

- [TEST-002-image-then-activate.md](./TEST-002-image-then-activate.md) - Image generation workaround
- [TEST-004-send-header-image-letter.md](./TEST-004-send-header-image-letter.md) - Header image letter
- [TEST-006-send-postcard.md](./TEST-006-send-postcard.md) - Postcard (image required)
