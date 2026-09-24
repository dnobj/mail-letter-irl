# Letter IRL - OpenAI Apps SDK Submission Materials

**Last Updated:** September 23, 2026
**Target Platform:** ChatGPT App Directory
**Submission Status:** Pre-submission

See also: [demo-scenarios.md](./demo-scenarios.md) for demo flows, and
[owner-checklist.md](./owner-checklist.md) for the portal's gates and the release record.

---

## Reviewer Setup

Reviewers test the production app, at one endpoint: `https://api.letterirl.com/mcp`.

- **Sign-in.** Auth0 with Client ID Metadata Documents (CIMD).
  - ChatGPT's client authenticates with `private_key_jwt`, the method its CIMD document declares.
  - It uses the authorization code flow with PKCE S256, against the `/mcp` API. That API grants only
    `mail:read`, `mail:draft` and `mail:send`.
  - In the app's OAuth settings, leave **OIDC enabled** off
    ([chatgpt-connector-oidc-setting.md](../learnings/chatgpt-connector-oidc-setting.md)).
  - The OAuth cases CIMD-06 to CIMD-10 in [manual-tests.md](../manual-tests.md) are run separately,
    in a browser. Reading code does not stand in for them.
- **Reviewer account.** An email-and-password account with a confirmed address and no
  multi-factor step, prepared before submission:
  - enough prepaid letters for every case below, added in the admin panel
    (`account.adjust_letters`);
  - a saved return address;
  - one earlier letter, so the order and status cases have history.

  Its address and password go in the portal's reviewer notes, never in Git.
- **Real mail.** Every send prints and mails a real letter or postcard through USPS.
  - Send only to the controlled address given in the reviewer notes, which Letter IRL receives.
  - Every send needs a preview first, then an explicit confirmation.
- **Payment.** Reviewers do not pay: the account's prepaid letters cover every send case. The
  checkout cases stop at the checkout link, and nothing is charged unless the Stripe page is completed.

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
> Sending needs payment: prepaid letters from a Letter Pack, or Pay & Send for a single letter. Both
> are paid on Stripe's hosted checkout. US addresses only.

---

## Portal Test Cases

The portal asks for five positive and three negative cases. Run them in order on the reviewer
account. A positive case is one Letter IRL should handle. A negative case is one it should not be
used for at all.

### Positive

| # | Prompt | Expected |
|---|--------|----------|
| P1 | "What can Letter IRL do?" | `get_started` shows the getting-started card: what Letter IRL mails, how to pay (a letter pack, or Pay & Send for one letter), and example prompts. Nothing is drafted. |
| P2 | "Write a short thank-you note to [the controlled address] and show me a preview." | `quote_and_preview_letter` validates both addresses, creates a draft and shows the letter preview card. The card has both addresses and the cost in letters. Nothing is mailed. |
| P3 | After P2: "Send it." | ChatGPT asks to confirm, because the tool is marked destructive. On confirmation, `send_letter` sends that draft from the prepaid balance. Its timeline reads: order placed, letter taken from the balance, accepted by the print provider. There is no carrier tracking (`trackingSupport: estimated_only`). The balance drops by the letters the preview named. |
| P4 | "Make a postcard for [the controlled address] with a photo of a lighthouse." | An image comes from ChatGPT's own generation, from `generate_image_for_mail` while the account has Letter IRL generations left, or from an upload. `quote_and_preview_postcard` then shows the front and the message side. Nothing is mailed until a separate send is confirmed. |
| P5 | "How many letters do I have left, and what happened to my last letter?" | `get_account_balance`, and `list_orders` or `get_order_status`, answer read-only: letters remaining, then the last order's status and timeline. No confirmation is asked, because nothing changes. |

### Negative

| # | Prompt | Expected |
|---|--------|----------|
| N1 | "Send an email to john@example.com saying I'll be late." | Letter IRL is not used: this is email, not physical mail. |
| N2 | "Draft a cover letter for my job application." | Letter IRL is not used: this is writing only, with nothing to mail. |
| N3 | "Print this photo on my home printer." | Letter IRL is not used: this is local printing, not mail. |

---

## Commerce and Safeguard Cases

These cover the payment paths and the safeguards around sending. The owner runs them in the final
pass (see [owner-checklist.md](./owner-checklist.md)). Reviewers may run the ones marked
*reviewer*.

| Case | Setup | Steps | Expected |
|------|-------|-------|----------|
| Pack checkout (*reviewer*) | Any account | "I'd like to buy more letters." | `list_letter_packs` lists the packs with prices. Choosing one runs `create_pack_checkout`, which shows the pack card: pack, price, order number and a link. The link opens Letter IRL's start page at `api.letterirl.com`, which forwards to Stripe-hosted Checkout. Nothing is paid in the widget. Stop before paying. |
| Pack checkout, paid | Owner, development (Stripe test mode) | Complete the Stripe page with a test card | The card polls `get_purchase_status` and shows "Paid. 2 letters added to your account." (for the starter pack). The balance rises by the pack's letters. |
| Payment details in chat (*reviewer*) | Any account | "Charge my card now for more letters." | No card details are asked for or taken in the conversation. The only way to pay is the checkout link. |
| Pay & Send | Owner, an account with no letters | Preview a letter, then choose **Pay & Send** on the card | `create_mail_checkout` opens a checkout for this one letter. After payment the card shows "Paid - preparing mail", and "With the printer" once the print provider accepts the job. The letter is mailed without a second confirmation, because paying for it was the confirmation. |
| Pay & Send refused with letters in hand (*reviewer*) | The reviewer account | Preview a letter, then ask to pay for it instead of using letters | The card offers **Send**, not Pay & Send. A direct request is refused: the draft can be sent from the existing prepaid balance. Nobody pays for a letter they already own. |
| Payment pending | Owner, a Pay & Send or pack checkout | Open the checkout and do not pay | The card shows "Checkout open - waiting for payment", and `get_purchase_status` answers `pending_payment`. Nothing is mailed or credited. An unpaid checkout expires, and the pack card then says "This checkout expired before it was paid. Nothing was charged." |
| Payment failed | Owner, development (Stripe test mode) | Pay with a test card that is declined | Stripe's page refuses the card and nothing is charged; the card keeps waiting. A payment that fails after checkout shows "The payment did not go through. Nothing was charged." and offers a new checkout. |
| Duplicate confirmation (*reviewer*) | After P3 | "Send that same letter again." | The send is refused as a possible duplicate of mail sent in the last 24 hours. The card says "This same letter was sent or paid for recently. Send another copy only if you want two." and offers **Send another copy**, which sends only on that second, explicit click (#412). |
| Image generations used up | An account with no Letter IRL image generations left | "Generate an image of a lighthouse for my postcard." | `generate_image_for_mail` does not generate. It says "This account has no Letter IRL image generations left. Letter packs and letter purchases include in-turn generations." and points to ChatGPT's own image generation, which the postcard then uses. |
| Image generation available (*reviewer*) | An account with generations left | The same prompt | The image is generated. The answer says one generation was used and how many remain. |
| Image upload fallback (*reviewer*) | ChatGPT on mobile, or an image ChatGPT cannot pass to the app | Ask for a postcard of a photo from the device | `upload_image` shows the upload card. Choosing a file uploads it through ChatGPT's file bridge, and `confirm_uploaded_image` hands the link to the postcard preview. |

---

## Prompt Bank for Recall and Precision

Beyond the portal's eight, these prompts check that Letter IRL triggers when it should (recall)
and stays out when it should not (precision).

### Use Case 1: Send a Text-Only Letter

**Direct Prompts**
1. "Send a letter to my mom thanking her for the birthday gift"
2. "I want to mail a physical letter to John Smith at 123 Main St, Springfield, IL 62701"
3. "Write and send a condolence letter to my neighbor at 456 Oak Ave, Portland, OR"
4. "Use Letter IRL to send a thank you note to my boss"
5. "Create a letter for my pen pal and mail it to their address in Texas"

**Indirect Prompts**
1. "My grandmother doesn't use email. How can I send her a message she can hold in her hands?"
2. "I want to surprise my friend with something more personal than a text"
3. "What's a thoughtful way to thank someone who helped me move?"
4. "I need to send a formal written notice to someone"
5. "Can you help me write something to mail to my parents for their anniversary?"

**Negative Prompts**
1. "Send an email to john@example.com" → Email, not physical mail
2. "Write a letter for me to copy and paste" → No mailing requested
3. "Draft a cover letter for my job application" → Document, not mail
4. "Send a text message to my friend" → SMS, not letter
5. "Mail this to someone in London, UK" → Non-US address: Letter IRL may answer, but refuses to draft it

**Expected Behavior**
- Tool: `quote_and_preview_letter` creates a draft
- Widget: the letter preview with addresses and the cost in letters
- The user confirms, then `send_letter` sends that draft
- Response: a timeline ending "Accepted by print provider". There is no carrier tracking.

### Use Case 2: Send a Letter with Photo

**Direct Prompts**
1. "Send a letter with this vacation photo to my parents"
2. "Mail a letter to grandma with the family photo I just uploaded"
3. "I want to send a physical letter with an image enclosed"
4. "Use Letter IRL to send this picture to my friend with a note"
5. "Send a thank you letter with the attached photo"

**Indirect Prompts**
1. "I took a great photo and want to share it with someone who doesn't have a smartphone"
2. "How can I send this picture to my grandparents in a way they can hang on their fridge?"
3. "I want to share this memory with my aunt in a meaningful way"
4. "Can you help me send this image to someone as a keepsake?"
5. "My uncle would love this photo but he's not online"

**Negative Prompts**
1. "Edit this photo for me" → Image editing, not mailing
2. "Post this photo to Instagram" → Social media, not mail
3. "Email this photo to my friend" → Email, not physical
4. "Print this photo" → Local printing, not mailing

**Expected Behavior**
- Tool: `quote_and_preview_letter_with_image` (inline) or `quote_and_preview_letter_with_header_image` (header)
- The image is processed and shown in the widget preview
- The text limit is shorter with an image: 800 characters inline, 1,100 with a header, against
  1,600 for text only

### Use Case 3: Send a Postcard

**Direct Prompts**
1. "Send a postcard with this image to my friend"
2. "I want to mail a postcard of this AI art I just generated"
3. "Create a postcard from this vacation photo and send it to my sister"
4. "Use Letter IRL to send a 6x9 postcard"
5. "Mail a postcard with this drawing to my nephew"

**Indirect Prompts**
1. "I made this cool image and want to share it as something physical"
2. "This would look great on someone's refrigerator"
3. "I want to send a quick hello to my friend with a fun picture"
4. "Can you turn this into something I can mail?"
5. "My niece would love to get this in the mail"

**Negative Prompts**
1. "Design a postcard template for me" → Design only, no mailing
2. "What size should a postcard be?" → Information query
3. "Send a postcard to Paris, France" → Non-US address: Letter IRL may answer, but refuses to draft it

**Expected Behavior**
- Tool: `quote_and_preview_postcard`
- The image is fitted to 6×9 at 300 DPI
- The widget shows the front (image) and the back (message)
- Message limit: 500 characters, or 350 on a gift postcard, whose foot carries the gift card

### Use Case 4: Check Account & Order Status

**Direct Prompts**
1. "How many letters do I have left?"
2. "Check my Letter IRL balance"
3. "What's the status of my last letter?"
4. "Show me my recent orders from Letter IRL"
5. "Did my postcard to grandma get delivered?"

**Indirect Prompts**
1. "Can I afford to send another letter?"
2. "Did my mail get sent yet?"
3. "What happened to the letter I sent last week?"
4. "How many more things can I mail?"
5. "Is my postcard on its way?"

**Expected Behavior**
- Tool: `get_account_balance`, `get_order_status`, or `list_orders`
- Read-only operations, no confirmation needed
- Shows letters remaining, order and purchase history, and each order's status and timeline. There
  is no carrier tracking, so a question about delivery gets the status, never a claim that the item
  arrived.

### Use Case 5: Manage Return Address

**Direct Prompts**
1. "Save my return address as 123 Main St, Austin, TX 78701"
2. "What's my saved return address?"
3. "Update my return address"
4. "Clear my saved return address"
5. "Set my default sender address"

**Indirect Prompts**
1. "I moved — I need to update my mailing info"
2. "Use my home address for all my letters"
3. "Don't make me type my address every time"
4. "What address will show as the sender?"
5. "I don't want a return address saved anymore"

**Expected Behavior**
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
| Not enough letters | Preview shows `canSendNow: false` with an explanation, and the card offers Pay & Send or a letter pack |
| Draft expired (after 24 hours) | Clear error suggesting to create new preview |
| Non-US address | Clear error: "US addresses only" |
| Send without preview | Error: "draftId required from quote_and_preview" |
| Wrong draft type (letter draft to send_postcard) | Clear error explaining the mismatch |
| A refused send, seen on the card | The card shows the server's sentence alone, never the host's wrapper around it (#434) |

---

## Tool Annotations Verification

| Tool | readOnlyHint | openWorldHint | idempotentHint | destructiveHint |
|------|--------------|---------------|----------------|-----------------|
| `quote_and_preview_letter` | - | ✅ | - | - |
| `quote_and_preview_letter_with_header_image` | - | ✅ | - | - |
| `quote_and_preview_letter_with_image` | - | ✅ | - | - |
| `send_letter` | - | ✅ | ✅ | ✅ |
| `create_mail_checkout` | - | ✅ | ✅ | ✅ |
| `create_pack_checkout` | - | ✅ | - | ✅ |
| `list_letter_packs` | ✅ | - | - | - |
| `redeem_promo_code` | - | - | ✅ | - |
| `get_purchase_status` | ✅ | - | - | - |
| `get_order_status` | ✅ | - | - | - |
| `get_account_balance` | ✅ | - | - | - |
| `get_profile` | ✅ | - | - | - |
| `list_orders` | ✅ | - | - | - |
| `set_return_address` | - | ✅ | ✅ | ✅ |
| `get_return_address` | ✅ | - | - | - |
| `clear_return_address` | - | - | ✅ | ✅ |
| `quote_and_preview_postcard` | - | ✅ | - | - |
| `send_postcard` | - | ✅ | ✅ | ✅ |
| `submit_feature_request` | - | - | - | - |
| `get_started` | ✅ | - | - | - |
| `upload_image` | - | - | - | - |
| `generate_image_for_mail` | - | ✅ | - | - |
| `confirm_uploaded_image` | - | - | ✅ | - |

This mirrors `buildAnnotations()` in `src/mcp/registerTools.ts`, which is authoritative. The
preview tools are **not** read-only: each call creates a draft record, and each validates addresses
with PostGrid ([learnings/tool-annotation-decision.md](../learnings/tool-annotation-decision.md)).
The destructive column follows OpenAI's app-review guidance, which asks for `destructiveHint` on any
tool that can cause an irreversible outcome (sending mail that cannot be recalled, overwriting the
saved address, starting a payment) even through indirect side effects; the `confirm: true` checks and
transactional idempotency are the safeguards to describe in the justification, not a reason to omit
the annotation.

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

A published policy and a policy the code enforces are different claims, so they are listed apart.

Published:
- [x] Privacy policy at `https://letterirl.com/privacy`
- [x] Terms of service at `https://letterirl.com/terms`

Implemented:
- [x] Card details are entered only on Stripe's page. The app never sees them, and collects no SSN or
      health data.
- [x] Error columns and logs hold error classes, not message text or personal data (#394,
      migrations 031 and 032).
- [ ] Every retention period the privacy page states is enforced by a job (#153, open).
- [ ] An account can be deleted on request, end to end (#289, open).

### User Experience
- [x] Widgets render correctly in light mode
- [x] Widgets render correctly in dark mode
- [x] Previews shown before irreversible actions
- [x] Error messages are clear and actionable
- [x] No trial/demo limitations — full functionality

### Authentication
- [x] OAuth 2.1 with PKCE, through Auth0 CIMD (`private_key_jwt`)
- [x] Sign-in with Google, Microsoft, GitHub, or email and password. Sign in with Apple is not
      offered at launch (#437).
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
- Test cases: the portal test cases above
- Screenshots: optional

**Test Account:**
- Production, with the reviewer account described in [Reviewer Setup](#reviewer-setup)
- Its credentials and the controlled mail address go in the portal's reviewer notes, never in Git

---

## References

- [Submit plugins](https://developers.openai.com/plugins/deploy/submission)
- [OpenAI App Submission Guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines/)
- [Research Use Cases](https://developers.openai.com/apps-sdk/plan/use-case/)
- [Testing Guide](https://developers.openai.com/apps-sdk/deploy/testing)
