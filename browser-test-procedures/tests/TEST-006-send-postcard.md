# Test: Send Postcard

**Purpose:** Verify that users can send a postcard through the Letter IRL app.

**Test ID:** TEST-006

**Category:** Letter Sending - Postcard

## Background

This tests sending a postcard, which has a different format than letters. Postcards have:
- An image on one side (front)
- A short message and address on the other side (back)
- Limited text space compared to letters

**Image Requirement:** A postcard REQUIRES an image for the front side.

## Start State

- Browser open to https://chatgpt.com
- User logged in to ChatGPT
- New chat (no existing conversation)
- No modals or dialogs open (main chat interface visible)
- An image available (either generate first OR use existing from Images gallery)

## End State

- Browser at https://chatgpt.com
- Chat contains the postcard composition conversation with image
- Postcard draft created (or confirmation)
- ${APP_NAME} app activated (chip visible in input area)

## Prerequisites

- ${APP_NAME} app already connected to account
- Test user has available credits
- An image is available to use (REQUIRED for postcards)

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

### 3. Request to Send a Postcard
- Type in the chat input: `I want to send a postcard using that image`
- Press Enter or click the send button
- Wait for ChatGPT to respond

### 4. Provide Postcard Message
- When prompted, provide a short postcard message:
  ```
  Greetings from the jungle!
  Wish you were here!
  - Test User
  ```

### 5. Provide Recipient Address
- When prompted for address, provide:
  - Name: Test User
  - Address: 123 Test Street
  - City: Test City
  - State: MO
  - ZIP: 63101

### 6. Confirm Postcard Details
- Review the postcard preview/summary
- Verify the image will be on the front
- Verify the message and address on the back
- Confirm the postcard should be sent

### 7. Verify Postcard Creation
- Check that a postcard draft is created
- Verify image is associated with the postcard
- Note any confirmation message or postcard ID

## Expected Results

| Check | Expected |
|-------|----------|
| Image generated/available | YES |
| App activates successfully | YES |
| Image persists after app activation | YES |
| ChatGPT understands postcard request | YES |
| Postcard format selected (not letter) | YES |
| Image included for postcard front | YES |
| Short message accepted | YES |
| Postcard draft/confirmation created | YES |

## Pass Criteria

- Postcard is created (not a letter)
- Image is successfully included for the postcard front
- Message and address fit postcard format
- The workflow completes without errors

## Fail Criteria

- System creates a letter instead of postcard
- Image cannot be referenced or included
- Postcard creation fails with error
- Message rejected as too long for postcard format

## Tool Notes

### Playwright MCP
- Wait for image generation before proceeding
- Verify the draft type is "postcard" not "letter"
- Check that image is associated with the draft

### Codex Chrome Control
- Reuse a generated or attached image from the same conversation when possible.
- Verify ChatGPT calls or offers `quote_and_preview_postcard`, not a letter preview tool.
- Capture a screenshot when the postcard preview appears and stop before send unless approved.

### Claude Chrome Extension
- Note the type of mail item being created
- Describe the postcard preview layout

### Manual Execution
- Postcard messages should be kept short
- Verify the system identifies this as a postcard, not a letter

## Notes

- Postcards have shorter message limits than letters
- The image is critical for postcards - it's the main visual element
- The "generate first, then activate" workflow is recommended
- Postcard dimensions: typically 4x6 or 5x7 inches

## Related Procedures

- [TEST-002-image-then-activate.md](./TEST-002-image-then-activate.md) - Image generation workaround
- [TEST-003-send-text-letter.md](./TEST-003-send-text-letter.md) - Text-only letter
- [TEST-004-send-header-image-letter.md](./TEST-004-send-header-image-letter.md) - Header image letter
