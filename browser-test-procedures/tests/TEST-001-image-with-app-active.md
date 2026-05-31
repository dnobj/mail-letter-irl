# Test: Generate Image with Letter IRL App Active

**Purpose:** Monitor whether ChatGPT can generate images when the Letter IRL app is already activated.

**Test ID:** TEST-001

**Category:** Chat Functionality - Known Limitation

## Known Issue

**Status:** EXPECTED FAIL

ChatGPT does not generate images properly when an MCP app (like Letter IRL) is already activated for the chat. Instead of using DALL-E, it outputs markdown image syntax referencing external services (e.g., pollinations.ai) which do not render as visible images.

**Impact:** Users cannot generate images for letters/postcards after activating the Letter IRL app in the same chat.

**Workaround:** Generate the image FIRST, then activate the Letter IRL app. See [TEST-002-image-then-activate.md](./TEST-002-image-then-activate.md).

**Desired Behavior:** ChatGPT should allow native image generation even when MCP apps are active, so users can create images for their letters/postcards.

## Start State

- Browser open to https://chatgpt.com
- User logged in to ChatGPT
- No modals or dialogs open (main chat interface visible)
- ${APP_NAME} app activated for the current chat (chip visible in input area)

**Setup:** If app is not activated, run [activate-app.md](../setup/activate-app.md) first.

## Safety Gate

- **Real mail risk:** None
- **Credit risk:** None
- **Approval required before irreversible action:** No

## End State

- Browser at https://chatgpt.com
- Chat contains user message and ChatGPT response
- **Expected:** No visible image generated (known limitation)

## Test Steps

### 1. Verify App is Activated
- Confirm the ${APP_NAME} chip is visible in the chat input area
- If not visible, activate the app first

### 2. Send Image Generation Request
- Type in the chat input: `Generate a picture of a happy monkey`
- Press Enter or click the send button

### 3. Wait for Response
- Wait for ChatGPT to process the request

### 4. Verify Response
- ChatGPT responds with text about generating an image
- **Check for visible image** - currently expected to be missing

## Expected Results (Current Behavior)

| Check | Expected |
|-------|----------|
| Response received | Yes |
| Image generated | **NO** (known limitation) |
| Text response present | Yes |
| Error messages | None (fails silently) |

## Pass Criteria

This test is used to **monitor** the limitation. The test "passes" if the behavior matches expectations:
- If NO image appears: Limitation still exists (expected)
- If image DOES appear: Limitation may be fixed - update this test!

## Tool Notes

### Playwright MCP
- Use `browser_snapshot` to capture the chat state
- Look for `img` elements in the response area to verify image presence

### Codex Chrome Control
- Use a fresh ChatGPT conversation with the app already activated.
- Capture a screenshot or visible DOM summary of the response.
- Record whether ChatGPT produced a visible native image, a fallback image URL/markdown, or a text-only refusal.

### Claude Chrome Extension
- Describe what you see in the chat response
- Note whether any images are visible or just text/markdown

### Manual Execution
- Take screenshots of the response for documentation
- Check both the response text and any image elements

## Notes

- This test monitors a known ChatGPT limitation
- Run periodically to check if OpenAI has fixed this behavior
- If behavior changes, update this documentation

## Related Procedures

- [TEST-002-image-then-activate.md](./TEST-002-image-then-activate.md) - Workaround test (generate first, then activate)
- [activate-app.md](../setup/activate-app.md) - Setup prerequisite
