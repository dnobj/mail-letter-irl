# Letter IRL - OpenAI Apps SDK Submission Materials

**Last Updated:** December 29, 2025
**Target Platform:** ChatGPT App Directory
**Submission Status:** Pre-submission

See also: [demo-scenarios.md](./demo-scenarios.md) for the recommended submission video flows and narration ideas.

---

## App Description

> **Letter IRL** lets you send real, physical letters and postcards through the mail — all from a conversation with ChatGPT.
>
> Compose a heartfelt letter to a friend, send a thank-you note with a photo, or mail a postcard of your AI-generated artwork. Letter IRL handles printing and delivery via USPS.
>
> **Features:**
> - Text-only letters, letters with header images (letterhead), or letters with enclosed photos
> - 6×9 postcards with custom front images
> - Address validation to ensure deliverability
> - Saved return address for convenience
> - Preview before sending — no surprises
>
> **How it works:**
> 1. Tell ChatGPT what you want to send and to whom
> 2. Review the preview (free, no commitment)
> 3. Confirm to send — we print and mail it
>
> Pre-paid Letter Packs required. US addresses only.

---

## Test Cases Overview

OpenAI requires three types of test prompts for each major use case:

| Type | Purpose | Quantity |
|------|---------|----------|
| **Direct Prompts** | User explicitly names your tool/action | 5+ per use case |
| **Indirect Prompts** | User states a goal without naming the tool | 5+ per use case |
| **Negative Prompts** | Requests that should NOT trigger your app | Several |

These help OpenAI measure:
- **Recall**: Does your app trigger when it should?
- **Precision**: Does it avoid false triggers?
- **Correctness**: Does it behave properly?

---

## Use Case 1: Send a Text-Only Letter

### Direct Prompts
1. "Send a letter to my mom thanking her for the birthday gift"
2. "I want to mail a physical letter to John Smith at 123 Main St, Springfield, IL 62701"
3. "Write and send a condolence letter to my neighbor at 456 Oak Ave, Portland, OR"
4. "Use Letter IRL to send a thank you note to my boss"
5. "Create a letter for my pen pal and mail it to their address in Texas"

### Indirect Prompts
1. "My grandmother doesn't use email. How can I send her a message she can hold in her hands?"
2. "I want to surprise my friend with something more personal than a text"
3. "What's a thoughtful way to thank someone who helped me move?"
4. "I need to send a formal written notice to someone"
5. "Can you help me write something to mail to my parents for their anniversary?"

### Negative Prompts
1. "Send an email to john@example.com" → Email, not physical mail
2. "Write a letter for me to copy and paste" → No mailing requested
3. "Draft a cover letter for my job application" → Document, not mail
4. "Send a text message to my friend" → SMS, not letter
5. "Mail this to someone in London, UK" → Non-US address

### Expected Behavior
- Tool: `quote_and_preview_letter` creates draft
- Widget: Shows letter preview with addresses
- User confirms → `send_letter` with draft ID
- Response: Order confirmation with tracking

---

## Use Case 2: Send a Letter with Photo

### Direct Prompts
1. "Send a letter with this vacation photo to my parents"
2. "Mail a letter to grandma with the family photo I just uploaded"
3. "I want to send a physical letter with an image enclosed"
4. "Use Letter IRL to send this picture to my friend with a note"
5. "Send a thank you letter with the attached photo"

### Indirect Prompts
1. "I took a great photo and want to share it with someone who doesn't have a smartphone"
2. "How can I send this picture to my grandparents in a way they can hang on their fridge?"
3. "I want to share this memory with my aunt in a meaningful way"
4. "Can you help me send this image to someone as a keepsake?"
5. "My uncle would love this photo but he's not online"

### Negative Prompts
1. "Edit this photo for me" → Image editing, not mailing
2. "Post this photo to Instagram" → Social media, not mail
3. "Email this photo to my friend" → Email, not physical
4. "Print this photo" → Local printing, not mailing

### Expected Behavior
- Tool: `quote_and_preview_letter_with_image` (inline) or `quote_and_preview_letter_with_header_image` (header)
- Image processed and shown in widget preview
- Reduced character limit displayed (800 for inline, 1100 for header)

---

## Use Case 3: Send a Postcard

### Direct Prompts
1. "Send a postcard with this image to my friend"
2. "I want to mail a postcard of this AI art I just generated"
3. "Create a postcard from this vacation photo and send it to my sister"
4. "Use Letter IRL to send a 6x9 postcard"
5. "Mail a postcard with this drawing to my nephew"

### Indirect Prompts
1. "I made this cool image and want to share it as something physical"
2. "This would look great on someone's refrigerator"
3. "I want to send a quick hello to my friend with a fun picture"
4. "Can you turn this into something I can mail?"
5. "My niece would love to get this in the mail"

### Negative Prompts
1. "Design a postcard template for me" → Design only, no mailing
2. "What size should a postcard be?" → Information query
3. "Send a postcard to Paris, France" → Non-US address

### Expected Behavior
- Tool: `quote_and_preview_postcard`
- Image resized to 6×9 at 300 DPI
- Widget shows front (image) and back (message) preview
- Message limit: ~400 characters

---

## Use Case 4: Check Account & Order Status

### Direct Prompts
1. "How many letters do I have left?"
2. "Check my Letter IRL balance"
3. "What's the status of my last letter?"
4. "Show me my recent orders from Letter IRL"
5. "Did my postcard to grandma get delivered?"

### Indirect Prompts
1. "Can I afford to send another letter?"
2. "Did my mail get sent yet?"
3. "What happened to the letter I sent last week?"
4. "How many more things can I mail?"
5. "Is my postcard on its way?"

### Expected Behavior
- Tool: `get_account_balance`, `get_order_status`, or `list_orders`
- Read-only operations, no confirmation needed
- Shows credit balance, order history, delivery status

---

## Use Case 5: Manage Return Address

### Direct Prompts
1. "Save my return address as 123 Main St, Austin, TX 78701"
2. "What's my saved return address?"
3. "Update my return address"
4. "Clear my saved return address"
5. "Set my default sender address"

### Indirect Prompts
1. "I moved — I need to update my mailing info"
2. "Use my home address for all my letters"
3. "Don't make me type my address every time"
4. "What address will show as the sender?"
5. "I don't want a return address saved anymore"

### Expected Behavior
- Tools: `set_return_address`, `get_return_address`, `clear_return_address`
- Address validated via PostGrid before saving
- `clear_return_address` requires `confirm: true`

---

## Error Handling Test Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Invalid address (e.g., "123 Fake St, Nowhere, XX 00000") | Clear error: "Address is invalid or undeliverable" |
| Letter too long (>1600 chars for text-only) | Clear error with character/line count |
| No image provided for postcard | Clear error explaining image is required |
| Insufficient credits | Preview shows `canSendNow: false` with explanation |
| Draft expired (after 24 hours) | Clear error suggesting to create new preview |
| Non-US address | Clear error: "US addresses only" |
| Send without preview | Error: "draftId required from quote_and_preview" |
| Wrong draft type (letter draft to send_postcard) | Clear error explaining the mismatch |

---

## Tool Annotations Verification

| Tool | readOnly | openWorldHint | idempotentHint | destructiveHint |
|------|----------|---------------|----------------|-----------------|
| `quote_and_preview_letter` | true | - | - | - |
| `quote_and_preview_letter_with_header_image` | true | - | - | - |
| `quote_and_preview_letter_with_image` | true | - | - | - |
| `quote_and_preview_postcard` | true | - | - | - |
| `send_letter` | false | ✅ | ✅ | - |
| `send_postcard` | false | ✅ | ✅ | - |
| `get_account_balance` | true | - | - | - |
| `get_order_status` | true | - | - | - |
| `list_orders` | true | - | - | - |
| `set_return_address` | false | ✅ | - | - |
| `get_return_address` | true | - | - | - |
| `clear_return_address` | false | - | - | ✅ |

Run verification: `npx tsx scripts/verify-tool-annotations.ts`

---

## Pre-Submission Checklist

### Tool & Schema Requirements
- [x] Tool names are human-readable verbs (`send_letter`, `get_account_balance`)
- [x] Tool descriptions accurately reflect behavior
- [x] Tool annotations correct (`openWorldHint`, `idempotentHint`, `destructiveHint`)
- [x] Input schemas define all required parameters
- [x] Output schemas match actual responses

### Privacy & Compliance
- [x] Privacy policy published at `https://letterirl.com/privacy`
- [x] Terms of service at `https://letterirl.com/terms`
- [x] Data minimization (only collect what's needed)
- [x] No sensitive data collection (SSN, health, financial)
- [x] Clear data retention policy documented

### User Experience
- [x] Widgets render correctly in light mode
- [x] Widgets render correctly in dark mode
- [x] Previews shown before irreversible actions
- [x] Error messages are clear and actionable
- [x] No trial/demo limitations — full functionality

### Authentication
- [x] OAuth 2.1 + PKCE implemented
- [x] Multiple identity providers (Google, Microsoft, Apple, GitHub, Email)
- [x] Token validation working
- [ ] Test OAuth flow with fresh account

### Platform Testing
- [ ] Test all use cases in ChatGPT web
- [ ] Test in ChatGPT iOS app
- [ ] Test in ChatGPT Android app
- [ ] Test with Developer Mode enabled
- [ ] Verify mobile widget layouts

---

## Submission Portal Information

**Portal URL:** https://platform.openai.com/apps-manage

**Required Materials:**
- App name: Letter IRL
- App description: (see above)
- App icon: `https://letterirl.com/logo.jpg`
- Privacy policy URL: `https://letterirl.com/privacy`
- Terms of service URL: `https://letterirl.com/terms`
- MCP server endpoint: `https://api.letterirl.com/mcp`
- Test cases: (this document)
- Screenshots: (capture from testing)

**Test Account:**
- Use development environment for reviewer testing
- Provide promo code for free credits if needed

---

## References

- [OpenAI App Submission Guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines/)
- [Research Use Cases](https://developers.openai.com/apps-sdk/plan/use-case/)
- [Testing Guide](https://developers.openai.com/apps-sdk/deploy/testing)
- [Submit Your App](https://developers.openai.com/apps-sdk/deploy/submission/)
