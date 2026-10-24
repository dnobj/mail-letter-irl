# Letter IRL - OpenAI Apps SDK Submission Materials

**Last Updated:** October 17, 2026
**Target Platform:** ChatGPT App Directory
**Submission Status:** Pre-submission

See also: [demo-scenarios.md](./demo-scenarios.md) for demo flows, and
[owner-checklist.md](./owner-checklist.md) for the portal's gates and the release record.

---

## Reviewer Setup

Reviewers test the production app, at one endpoint: `https://api.letterirl.com/mcp`.

Two preconditions, both gates in [owner-checklist.md](./owner-checklist.md):

- **Production runs the launch build, with the launch cut on** (approved 2026-10-20, #816, and
  set out in [launch-promotion.md](../launch-promotion.md)): the studio features, arrival dates and
  the paid options, certified mail once its live letter passes, and the live checks done. The home,
  address requests, saved designs and image generation are off. Production must carry the cut, with
  its connector refreshed after the last switch, before the reviewer account is prepared.
- **Pay & Send is on** (`JIT_PURCHASE_ENABLED=true` on the production API, as it was on
  2026-09-23). With it off, `get_started` offers packs only, and the Pay & Send cases below do not
  apply.

The setup itself:

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
    (`account.adjust_balance`);
  - a saved return address;
  - one earlier letter, so the order and status cases have history.

  Its address and password go in the portal's reviewer notes, never in Git.
- **Real mail.** Every send prints and mails a real letter or postcard through USPS.
  - Send only to the controlled address given in the reviewer notes, which Letter IRL receives.
  - Every send needs a preview first, then an explicit confirmation.
- **Payment.** Reviewers do not pay: the account's prepaid letters cover every portal case. The
  checkout cases stop at the checkout link, and nothing is charged unless the Stripe page is completed.
  Certified mail, letters of two or three pages, and 4x6 and 11x6 postcards are paid only with
  Pay & Send, so their cases in [Launch Feature Cases](#launch-feature-cases) stop at the card's
  Pay & Send button.

---

## App Description

> **Letter IRL** lets you send real, physical letters and postcards through the mail — all from a conversation with ChatGPT.
>
> Compose a heartfelt letter to a friend, send a thank-you note with a photo, or mail a postcard of your AI-generated artwork. Letter IRL handles printing and delivery via USPS.
>
> **Features:**
> - Text-only letters, letters with header images (letterhead), or letters with enclosed photos, up to three pages
> - Stationery themes and your signature
> - Postcards in 4×6, 6×9 and 11×6, with a border, a greeting or a collage of photos
> - Mail timed to arrive by a date you choose (USPS does not guarantee First-Class dates), and USPS Certified Mail
> - Address validation to ensure deliverability
> - Saved return address for convenience
> - Preview before sending — no surprises
>
> **How it works:**
> 1. Tell ChatGPT what you want to send and to whom
> 2. Review the preview (free, no commitment)
> 3. Press Send on the preview — we print and mail it. Only you send it: ChatGPT never mails anything on its own
>
> Sending needs payment: prepaid letters from a Letter Pack, or Pay & Send for a single letter. Both
> are paid on Stripe's hosted checkout. US addresses only.

---

## Starter Prompts

For the listing: prompts a customer can adapt, showing the main workflows. They are not the
reviewer's test cases below.

1. "Write a thank-you letter to my grandmother and mail it to her."
2. "Turn this photo into a postcard for my friend in Seattle."
3. "Send a letter to my brother with this picture from our trip."

The portal takes at most three, of 128 characters or fewer (#476). "How many letters do I have
left?" was cut as the least representative; swap it back in for one of these if preferred.

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
| P3 | After P2: "Send it." Then press **Send** on the preview card. | Only the person sends (the send rule, #470). Asked in chat, ChatGPT does not send: it points to the card's **Send** button. Pressing it sends that draft from the prepaid balance through `send_letter`, which only the card can call. The card then shows the order: "Order placed", "Letter deducted from balance", "Accepted by print provider". A standard letter has no carrier tracking (`trackingSupport: estimated_only`); certified mail has a USPS tracking number. The balance drops by the letters the preview named. |
| P4 | "Make a postcard for [the controlled address] with a photo of a lighthouse." | The image comes from ChatGPT's own image generation, or from an upload. Letter IRL makes no images at launch. `quote_and_preview_postcard` then shows the front and the message side. Nothing is mailed until the person presses **Send** on the card. |
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
| Pay & Send refused with letters in hand (*reviewer*) | The reviewer account | Preview a letter, then ask to pay for it instead of using letters | The card offers **Send**, not Pay & Send, and ChatGPT points to it: it can't start a checkout itself, since Pay & Send is the card's alone, like the send tools (#475). A checkout for the draft would be refused anyway: it can be sent from the existing prepaid balance. Nobody pays for a letter they already own. |
| Pay asked in chat | Owner, an account with no letters, after a preview | "Pay for it and send it." | Nothing is charged or mailed. ChatGPT points to the card's **Pay & Send** button: `create_mail_checkout` is card-only and hidden from the model (#475). |
| Payment pending | Owner, a Pay & Send or pack checkout | Open the checkout and do not pay | The card shows "Checkout open - waiting for payment", and `get_purchase_status` answers `pending_payment`. Nothing is mailed or credited. An unpaid checkout expires, and the pack card then says "This checkout expired before it was paid. Nothing was charged." |
| Payment failed | Owner, development (Stripe test mode) | Pay with a test card that is declined | Stripe's page refuses the card and nothing is charged; the card keeps waiting. A payment that fails after checkout shows "The payment did not go through. Nothing was charged." and offers a new checkout. |
| Send asked in chat (*reviewer*) | After a preview | "Send it." | Nothing is mailed. ChatGPT points to the preview card's **Send** button, because only the person sends (#470): the send tools are card-only and hidden from the model. |
| Duplicate confirmation, on the card (*reviewer*) | After P3 | Ask for a preview of the same note to the same address again, then press **Send** on its card | The card says the same letter went out a few minutes ago, or, when the host drops the refusal's details, "This same letter was sent or paid for recently. Send another copy only if you want two." Its button becomes **Send another copy**, which sends only on that second, explicit press (#412). |
| Image request (*reviewer*) | Any account | "Generate an image of a lighthouse for my postcard." | ChatGPT makes the image with its own image generation, and the postcard preview uses it. Letter IRL makes no images at launch (`LETTER_IRL_IMAGE_GEN_MODE=off`), so `generate_image_for_mail` is not listed. |
| Image upload fallback (*reviewer*) | ChatGPT on mobile, or an image ChatGPT cannot pass to the app | Ask for a postcard of a photo from the device | `upload_image` shows the upload card. Choosing a file uploads it through ChatGPT's file bridge, and `confirm_uploaded_image` hands the link to the postcard preview. |

---

## Launch Feature Cases

The launch cut is on at launch (#816; the home, address requests and saved designs are not). Most are tools above; some are inputs of the previews (collages, letters of more pages) or what the cards draw (the studio card, and the envelope, which the website's confirmation page draws too).
The portal takes only the eight cases above, so these are for the owner's final pass and for a
reviewer who asks. Each starts from a preview on the reviewer account, and nothing is mailed until
the person presses **Send** or **Pay & Send** on the card. The full checks are the manual tests named
in the last column ([manual-tests.md](../manual-tests.md)).

| Case | Prompt | Expected | Manual test |
|------|--------|----------|-------------|
| Arrive by a date (*reviewer*) | After a preview: "Make it arrive by [a date two weeks out]." | `set_arrival_date` sets the date on the draft and the card shows when it goes to the printer. After **Send**, the card says it is scheduled. | SCHEDULE-01 |
| Cancel scheduled mail (*reviewer*) | After a scheduled send: "Cancel that letter." | ChatGPT asks first; `cancel_scheduled_mail` then cancels it, with `confirm: true`, and says what came back to the balance. | SCHEDULE-01 |
| Stationery (*reviewer*) | "Put it on the botanical stationery." | `set_stationery` draws the letter again on the theme, with the date line; the next preview remembers it. | STATIONERY-01 |
| Signature | "Sign my letters with this signature" and a photo of it | `set_signature` keeps it; `set_letter_signature` draws it on the letter under the sign-off. `clear_signature` asks first. | SIGNATURE-01 |
| Words and room to write | "Add a paragraph about our trip." | `set_letter_words` draws the page again with the new words. A letter that runs to two or three pages prints on both sides and is paid only with Pay & Send. After the person changes the words on the card's Words tab, a request to change a word still calls `set_letter_words`, whose refusal gives the card's words, rather than answering from the words ChatGPT saw last. | PAGES-01, STUDIO-01 |
| Certified mail | "Send it certified, with a return receipt." | `set_mail_service` makes the draft USPS Certified Mail, paid only with Pay & Send, at its own price. | CERTIFIED-01 |
| Postcard sizes and fronts (*reviewer*) | "Make the postcard 4x6 with a white border and the caption 'Cape Cod'." | `set_postcard_style` draws it again at the size, with the front. Sizes other than 6x9 are paid only with Pay & Send. | POSTCARD-01 |
| Collage (*reviewer*) | "Make a postcard of these three photos." | `quote_and_preview_postcard` draws the photos as one front. | COLLAGE-01 |
| Not an address lookup (*reviewer*, negative) | "Look up my friend Sam Rivera's home address." | Letter IRL does not look addresses up: it asks the person for the address, and never guesses or searches for one. | the server instructions |

Not at launch, so not listed and not reviewed: the home (`open_letter_home`, HOME-01), saved designs
(`save_stationery_design` and the two beside it, STATIONERY-02) and address requests
(`request_address` and the two beside it, ADDRESS-01). Each comes back after the launch, as a tool
change that goes to review.

**Paid options and the reviewer.** Certified mail, letters of two or three pages, and 4x6 and 11x6
postcards are paid only with Pay & Send: letter packs and gift letters pay for one-page letters and
6x9 postcards. The reviewer's prepaid letters cannot send them, so their cases stop at the card's
Pay & Send button, and nothing is charged unless the Stripe page is completed.

### Agent-phrased prompts (#630)

Phrased as an agent acting for a person would phrase them: the job, the cost and the timing up front.
The previews say what sending takes and when the mail usually arrives, in their text as well as their
data (steering r56), so an agent can answer without guessing. Run in ChatGPT; other apps get the same
answer with the cost in letters, or "paid with Pay & Send" without an amount.

| # | Prompt | Expected |
|---|--------|----------|
| A1 | "Mail a one-page thank-you letter to [the controlled address]. Before anything is sent, tell me what it costs and when it will arrive." | `quote_and_preview_letter` shows the card. The reply gives what sending takes (one letter from the balance, or the Pay & Send price) and the delivery estimate ("Mailed in 1-2 business days; usually arrives in 1-2 weeks"). Nothing is mailed. |
| A2 | "Did my last postcard arrive?" (the account's most recent order is a postcard: the order tools do not say which orders are postcards) | `list_orders` or `get_order_status` answers with that order's status. If it reads delivered, the reply calls it an estimate from the printing partner's schedule, not a carrier scan. |
| A3 (negative) | "Find the cheapest way to ship a 2 lb package to Chicago." | Letter IRL is not used: it mails letters and postcards, not parcels. |
| A4 (negative) | "Send a letter to [the controlled address] right now, without showing me anything." | A preview tool may run, but nothing is mailed: the reply points to the card's **Send** button, because only the person sends (#470). |

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
- The person presses **Send** on the card, which calls `send_letter` for that draft
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
- The text limit is the page: on our renderer the letter's lines, with the image, must fit one page,
  or up to three with room to write (a 10,000-character cap a page); the legacy HTML's limits were
  800 characters inline, 1,100 with a header and 1,600 for text only

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
- The image is fitted to the postcard's size (6×9 unless 4×6 or 11×6 is chosen) at 300 DPI
- The widget shows the front (image) and the back (message)
- Message limit at 6×9: 500 characters, or 350 on a gift postcard, whose foot carries the gift card. On our own renderer (#534), 16 lines of the back, or 11 above the gift card. A 4×6 back holds 11 lines (about 350 characters) and an 11×6 back 16 (about 900)

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
  is no carrier tracking for a standard letter, so a question about delivery gets the status, never a
  claim that the item arrived; certified mail has a USPS tracking number.

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
| Invalid address (e.g., "123 Fake St, Nowhere, XX 00000") | Clear error naming what USPS could not verify, with a suggested correction when there is one |
| Letter too long (past three pages with room to write; past one page for a gift letter) | Clear error with the line count and the page limit, or, for a gift letter past one page, that a gift letter pays for one page |
| No image provided for postcard | Clear error explaining image is required |
| Not enough letters | Preview shows `canSendNow: false` with an explanation, and the card offers Pay & Send or a letter pack |
| Draft expired (after 24 hours) | Clear error suggesting to create new preview |
| Non-US address | "Letter IRL currently only supports mailing within the United States." with the address that is not |
| Send without preview | "send_letter requires a draftId from a letter preview tool." |
| Wrong draft type (letter draft to send_postcard) | Clear error explaining the mismatch |
| A refused send, seen on the card | The card shows the server's sentence alone, never the host's wrapper around it (#434) |

---

## Tool Annotations Verification

At the launch cut (approved 2026-10-20, [launch-promotion.md](../launch-promotion.md)), ChatGPT is
served 34 tools, pinned by `tests/unit/mcp/__snapshots__/tools-list.chatgpt-launch.json`: every row
below but `generate_image_for_mail`, `upload_photo_chunk`, the home's `open_letter_home`, the
address requests' three tools and the saved designs' three, all off at launch. With every switch on
and image generation off it would be 41. ChatGPT's upload card hands over its own file store's link, so it is never
served the card's chunked upload. Four of the 34 are card-only: listed, but hidden from the model
and called only by the card (`send_letter`, `send_postcard`,
`create_mail_checkout` and `get_draft_status`). At production's defaults before stages C to G of the promotion, 24
are served. Which switch lists which tool, and for which app, is in `src/mcp/toolCatalog.ts`.

| Tool | readOnlyHint | openWorldHint | idempotentHint | destructiveHint |
|------|--------------|---------------|----------------|-----------------|
| `open_letter_home` | ✅ | - | - | - |
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
| `set_arrival_date` | - | - | ✅ | - |
| `cancel_scheduled_mail` | - | - | ✅ | ✅ |
| `set_stationery` | - | - | ✅ | - |
| `set_mail_service` | - | - | ✅ | - |
| `set_letter_words` | - | - | ✅ | - |
| `set_postcard_style` | - | ✅ | ✅ | - |
| `request_address` | - | - | - | - |
| `get_address_request` | ✅ | - | - | - |
| `cancel_address_request` | - | - | ✅ | ✅ |
| `set_signature` | - | ✅ | - | ✅ |
| `get_signature` | ✅ | - | - | - |
| `clear_signature` | - | - | ✅ | ✅ |
| `set_letter_signature` | - | - | ✅ | - |
| `save_stationery_design` | - | - | ✅ | ✅ |
| `list_stationery_designs` | ✅ | - | - | - |
| `delete_stationery_design` | - | - | ✅ | ✅ |
| `submit_feature_request` | - | - | - | - |
| `get_started` | ✅ | - | - | - |
| `upload_image` | - | - | - | - |
| `confirm_uploaded_image` | - | - | ✅ | - |
| `request_send` | ✅ | - | - | - |
| `get_draft_status` | ✅ | - | - | - |
| `upload_photo_chunk` (card-only, and only where the card sends the photo itself, as in Claude: never served to ChatGPT) | - | - | ✅ | - |
| `generate_image_for_mail` (not listed while image generation is off, as at launch) | - | ✅ | - | - |

### Justifications for the portal

The portal asks for a written justification of the three hints on every tool. `send_letter`,
`send_postcard`, `create_mail_checkout` and `get_draft_status` are card-only: listed, but hidden from
the model and called by the card when the person presses its button (#470, #474, #475).

| Tool | Read-only | Destructive | Open world |
|------|-----------|-------------|------------|
| `get_started` | Yes: shows the guide and the account's state; changes nothing. | No: changes nothing. | No: reads only Letter IRL's own records. |
| `open_letter_home` | Yes: shows the account's home: its open previews, recent mail with scheduled dates and delivery status, and recent recipients; changes nothing. | No: changes nothing. | No: reads only Letter IRL's own records and contacts no one; its links open Letter IRL's own website, USPS's tracking page for certified mail, or this home again in ChatGPT. |
| `get_account_balance`, `get_profile`, `list_orders`, `get_order_status`, `get_purchase_status`, `get_return_address`, `list_letter_packs` | Yes: each reads the calling account's own records, or the fixed pack list. | No: none changes anything. | No: each reads only Letter IRL's own records. |
| `get_address_request`, `get_signature`, `list_stationery_designs` | Yes: each reads the calling account's own records: whether a recipient has answered an address request (and, once they have, the address they gave), whether a signature is saved, or the saved stationery designs. | No: none changes anything. | No: each reads only Letter IRL's own records. |
| `request_send` | Yes: reads a draft and returns the page where the person checks it and sends it themselves; nothing is sent or changed. | No: it sends nothing; the person sends on the page. | No: reads only Letter IRL's own records. |
| `get_draft_status` | Yes: says whether a draft is ready, sent or expired. | No: changes nothing. | No: reads only Letter IRL's own records. |
| `quote_and_preview_letter` and its two image variants, `quote_and_preview_postcard` | No: each creates a draft record for the preview. | No: a draft is free, sends nothing, and expires if unused. | Yes: validates both addresses with PostGrid, a third-party mail service, and the image variants fetch the image from the address the person gave. |
| `set_stationery`, `set_letter_words`, `set_letter_signature` | No: each changes a previewed draft (its stationery, words or signature) and draws it again; `set_stationery` and `set_letter_signature` also remember the choice for the next preview. | No: a draft sends nothing and expires if unused, and another call changes it back. A letter that grows to two or three pages is paid only if the person chooses Pay & Send on the card. | No: each changes only Letter IRL's own draft, drawn by Letter IRL's own renderer. |
| `set_arrival_date`, `set_mail_service` | No: each changes a previewed draft's arrival date or mail service, without drawing it again. | No: a draft sends nothing and expires if unused, and another call changes it back. Certified mail's price is paid only if the person chooses Pay & Send on the card. | No: each changes only Letter IRL's own draft. |
| `set_postcard_style` | No: changes a previewed postcard's size or front layout and draws it again. | No: a draft sends nothing and expires if unused, and another call changes it back. | Yes: on a new size it fetches the picture again from the address the person gave, to crop it to that size. |
| `send_letter`, `send_postcard` | No: sends the draft and spends a prepaid letter. | Yes: mail handed to the printer cannot be recalled. The person presses Send on the card; the model cannot call these. | Yes: the letter goes to PostGrid for printing and USPS mailing. |
| `create_mail_checkout` | No: creates an order and a checkout. | Yes: once paid, the letter is mailed without a further step, and the payment cannot be undone by the person alone. The person presses Pay & Send on the card; the model cannot call it. | Yes: creates a Stripe Checkout session. |
| `create_pack_checkout` | No: creates an order and a checkout. | Yes: starts a payment the person cannot undo alone. | Yes: creates a Stripe Checkout session. |
| `cancel_scheduled_mail` | No: cancels mail held for its arrival date and returns what paid for it to the account, unless that expired or was refunded while it waited; mail paid with Pay & Send is not cancelled here. | Yes: a cancelled order cannot be restored; to go out, the mail must be previewed and sent again. It requires `confirm: true` once the person agrees. | No: the mail waits in Letter IRL's own queue and has not reached the printer, so nothing outside is contacted. |
| `set_return_address` | No: saves an address. | Yes: overwrites the saved return address in place. | Yes: validates the address with PostGrid. |
| `clear_return_address` | No: deletes the saved return address. | Yes: the address is removed. | No: changes only Letter IRL's own record. |
| `request_address` | No: records an address request and returns a private link. | No: it sends nothing to anyone and removes nothing. The person shares the link themselves and can cancel it. | No: it writes only Letter IRL's own record. The recipient answers on Letter IRL's own page. |
| `cancel_address_request` | No: closes a waiting address request, so its link stops working. | Yes: a cancelled link cannot be restored; a new request makes a new link. | No: changes only Letter IRL's own record. |
| `set_signature` | No: saves a picture of the person's signature for their letters. | Yes: it replaces any signature saved before, which cannot be brought back. | Yes: it fetches the picture from the link the person gave, or takes the file they attached through the host. |
| `clear_signature` | No: removes the saved signature. | Yes: the signature cannot be brought back; letters already previewed keep theirs. It requires `confirm: true`. | No: changes only Letter IRL's own record. |
| `save_stationery_design` | No: saves a stationery design for the account. | Yes: saving under a name the account already has replaces that design, which cannot be brought back. | No: writes only Letter IRL's own records. |
| `delete_stationery_design` | No: deletes a saved design. | Yes: the design cannot be brought back; letters already previewed or sent keep theirs. It requires `confirm: true`. | No: changes only Letter IRL's own records. |
| `redeem_promo_code` | No: adds letters to the balance. | No: it only adds, and a spent code is refused if used again. | No: checks only Letter IRL's own records. |
| `submit_feature_request` | No: records a request. | No: adding a request removes nothing. | No: writes only to Letter IRL's own records. |
| `upload_image` | No: opens the upload card, through which the person uploads a photo. | No: it removes nothing. | No: the upload goes through the host's own file store. |
| `confirm_uploaded_image` | No: records the uploaded image as the account's latest upload. | No: it replaces only the pointer to the previous upload. | No: records only Letter IRL's own state. |

The open-world hint now means reaching the public internet or open-ended entities, and a bounded
service may be marked `false` (#476). It stays `true` for the tools that reach PostGrid, Stripe or an
image address the person gave: each reaches a system outside Letter IRL, with effects in the world
(mail or payment), so declaring it is the conservative choice. The owner may re-decide this at
submission; `buildAnnotations()` in `src/mcp/registerTools.ts` is the one place to change it.

This mirrors `buildAnnotations()` in `src/mcp/registerTools.ts`, which is authoritative. The
preview tools are **not** read-only: each call creates a draft record, and each validates addresses
with PostGrid ([learnings/tool-annotation-decision.md](../learnings/tool-annotation-decision.md)).
The destructive column follows OpenAI's app-review guidance, which asks for `destructiveHint` on any
tool that can cause an irreversible outcome (sending mail that cannot be recalled, overwriting the
saved address, starting a payment) even through indirect side effects; the `confirm: true` checks and
transactional idempotency are the safeguards to describe in the justification, not a reason to omit
the annotation.

What each app is served, hints included, is pinned for every switch by
`tests/unit/mcp/servedToolsSnapshot.test.ts`, and `tests/unit/mcp/toolHintCopies.test.ts` checks
that no tool's `_meta` says other hints than its annotations.

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
- [x] Error columns and logs hold error classes, not message text or personal data (migration
      031 for #162, migration 032 for #394).
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

**Portal URL:** https://platform.openai.com/plugins

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
