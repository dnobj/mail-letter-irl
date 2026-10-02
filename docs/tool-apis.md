# MCP Tool API Specifications

**Last Updated:** October 1, 2026  
**Purpose:** Practical reference for the MCP tools exposed by Letter IRL

The runtime MCP registry is the source of truth. The checked-in `manifest.json` is generated from that registry with `npm run manifest:generate`, and submission-facing tests verify that the manifest, widget list, and runtime tool registry stay aligned.

Letter IRL currently exposes **24 tools** and **6 widgets**. Four more are listed only while their switch is on: `request_send` while the send rule is on, `upload_photo_chunk` while card upload is on, and `set_arrival_date` and `cancel_scheduled_mail` while arrival dates are on. The tools are:

## Onboarding

- `get_started`: Show a short getting-started guide with setup steps and example prompts. Read-only. Uses `ui://widgets/GetStartedCard.html@v<N>`.

## Letter Drafts and Sending

All four preview tools accept an optional `sendAsGift` ([gift-letters.md](gift-letters.md)): `true`
sends the draft as the account's gift letter, free and with a printed card for the recipient;
omitted, a gift letter is used only when the balance cannot pay. A gift preview returns `giftCard`
(`state`: `funded` or `unfunded`, and a `description`), and any preview returns
`giftLettersAvailable` when the account has some and a gift letter could pay for the mail. Both are absent while gift letters are off.

While room to write is offered (`LETTER_IRL_ROOM_TO_WRITE_ENABLED` on, with our renderer and Pay & Send, #586),
the three letter previews lay a letter out on up to three pages. A longer letter returns `pages` (2 or 3),
is paid with Pay & Send (`canSendNow` false, its eligibility priced for its pages), and is never a gift
letter: `sendAsGift: true` on it is refused. Only a letter longer than three pages is refused, "too long for
three pages: three pages is the longest letter we print", without line counts. Otherwise every preview is one
page, as before.

While `LETTER_IRL_ARRIVE_BY_ENABLED` is on, all four preview tools also accept an optional
`arriveBy` (YYYY-MM-DD, #535): the date the mail should arrive by. The preview works back to the
day it goes to the printer, holds the draft to it, and returns `schedule` (`arriveBy`, `mailOn`,
`releasesAt`, `earliestArrival`, `latestArrival`), with `deliveryEstimate` saying when it goes to
the printer. A date too soon, too late or not a date is refused with the dates on offer; an empty
`arriveBy` counts as none. While the flag is off, `arriveBy` is not served, nor in `/manifest.json`;
an app that cached it and passes it anyway is refused, since those four tools then pass unknown
fields through to the preview rather than drop them
([letter-send-flow.md](letter-send-flow.md#confirmed-send-transaction)). Every preview also returns
`arrivalWindow` (`earliestArrival`, `latestArrival`) while the flag is on, with a date or without:
the dates that can be chosen now, for a card's date picker, not when this mail arrives. It is left out
while the flag is off, and when no date can be scheduled.

While stationery is offered (`LETTER_IRL_STATIONERY_ENABLED` on, and `LETTER_IRL_PRINT_RENDERER=pdf`,
#563), the three letter previews also accept:
- `stationery`: `classic` (a plain page), `monogram`, `botanical`, `celebration`, `typewriter` or `handwritten`, in any case.
  Typewriter and Handwritten set the whole letter in a typeface of their own (Cousine, Caveat). Left
  out, the account's last choice is used, or Classic with none: the model leaves it out unless the user asks
  for a style or for a plain page, so an ordinary letter never resets the account's choice. Every theme but Classic prints the preview's date, written out, at the top right.
- `monogram`: for `monogram` only, asked for or remembered. One to three letters, as written; spaces and full stops are dropped.
  Left out, the initials of the return address's name are used, in capitals, skipping titles at its start and suffixes at its end
  ("Dr. Pat Rivera Jr." is PR).
- `headline`: for `celebration` only, asked for or remembered. One line above the letter, which takes three of the page's lines.

A preview that asks for no theme is drawn in the account's remembered one: the theme it last chose,
in a preview's `stationery`, `set_stationery` or the letter card. With nothing remembered, it is
Classic. A theme a preview asks for, Classic included, is remembered once its draft exists. Only the
theme is remembered; initials and a headline belong to one letter.

Each preview then returns `stationery`: its `theme`, the `dateLine`, `monogram` and `headline` it
prints, and `source`, which is `asked`, `remembered` or `default` (Classic, nothing chosen). The
preview's narration names a theme, and says when it was the account's last choice. The refusals say
what to change:
- an unknown theme;
- initials or a headline with a theme that does not print them;
- initials that are not one to three letters;
- a headline too long for its line, with how much of it fits;
- characters the font cannot draw: the text is checked in the typeface its theme sets it in, so
  Handwritten refuses Greek or Hebrew that Classic prints, naming the theme, and suggests another
  stationery when Classic would print the characters. A theme the call did not name, the account's
  remembered one, says so first;
- a letter the headline or the theme's typeface pushes past its page, with the line counts, and the
  ways out that would fit; while room to write is offered, past three pages, without the counts.

While stationery is not offered, the three fields are not served, nor in `/manifest.json`, and
the output has no `stationery`. An app that cached them and passes a theme, initials or a headline
anyway is refused rather than printed on a plain page. Classic is always accepted. Postcards take
none of them.

- `quote_and_preview_letter`: Create a free draft preview for a text-only physical letter. Requires a real U.S. recipient address, `bodyText`, and `signOff`; sender is optional when a saved return address exists. Creates a draft, so it is not read-only. Uses `ui://widgets/LetterPreviewCard.html@v<N>`.
- `quote_and_preview_letter_with_header_image`: Create a free draft preview for a letter with a header image at the top. Accepts an attached image or `imageUrl`. Creates a draft and uses `ui://widgets/LetterHeaderImagePreviewCard.html@v<N>`, which serves the letter card under its own name so the card knows which preview to repeat (#411).
- `quote_and_preview_letter_with_image`: Create a free draft preview for a letter with an enclosed image after the signature. Accepts an attached image or `imageUrl`. Creates a draft and uses `ui://widgets/LetterInlineImagePreviewCard.html@v<N>`, the letter card under its own name for the same reason.
- `send_letter`: Send a letter from a prior draft. Requires `draftId` and `confirm: true`. Idempotent retries with the same draft return the existing order rather than charging twice. The same letter sent, paid for or awaiting payment from the account in the last 24 hours refuses the call unless `sendAnotherCopy: true` is passed, which the model does only after the user asks for another copy ([letter-send-flow.md](letter-send-flow.md#the-same-mail-twice)). Sent with an arrival date (#535), the answer carries `schedule` (`arriveBy`, `mailOn`) and `cancellable`, and while the mail waits for its mail date its status is `scheduled`, with a line saying when it goes to the printer and that it can be cancelled free until then.
- `request_send`: Listed only while the send rule is on ([letter-send-flow.md](letter-send-flow.md)). Returns the letterirl.com page where the person checks a previewed draft and sends it themselves. Sends nothing, and is read-only. For a preview with an arrival date, it carries `schedule` (`arriveBy`, `mailOn`), and its link text says when, once sent, the mail goes to the printer (#535).
- `set_stationery`: Listed only while stationery is offered (#563). Changes a letter preview's stationery without previewing again, and the account remembers the theme for its next preview. Takes `draftId` and `stationery` (`classic`, `monogram`, `botanical`, `celebration`, `typewriter` or `handwritten`), and `monogram` and `headline` as the letter previews take them. They are checked in the same words, the text is checked in the theme's typeface, and the letter is laid out again in the theme, so a headline or a wider typeface that pushes it past its page is refused. The page is drawn again from the draft's own content, with the small copy of its picture and a gift letter's card page as they were, and the draft records it, `pdf-2` for a theme and `pdf-1` for Classic. Returns `stationery`, a `message` that says nothing has been sent, and the page for the card in `_meta`. It also returns what the letter costs now, since a restyle can change its pages (#586): `pages` above one, `canSendNow`, `reasonCannotSend` and `sendEligibility`; the message says when the pages changed. While room to write is offered, a letter is laid out again on up to three pages and a gift letter on one; otherwise on one. Refused, as `set_arrival_date` is, for a draft that is not the caller's, already sent, expired, or with a live Pay & Send order, and for a postcard or a preview the legacy HTML drew. Sends nothing. Not read-only, not destructive and idempotent. The cards may call it too (`openai/widgetAccessible`).
- `set_arrival_date`: Listed only while `LETTER_IRL_ARRIVE_BY_ENABLED` is on (#535). Sets, moves or clears a preview's arrival date without previewing again. Takes `draftId`, and `arriveBy` (YYYY-MM-DD), which is checked as the previews check theirs and refused in the same words; left out, the date is cleared and the mail goes to the printer as soon as it is sent. Returns `schedule` (absent once cleared), `deliveryEstimate` and a `message` that says nothing has been sent. Refused for a draft that is not the caller's, already sent, expired, or with a live Pay & Send order, whose payment sends the mail with the dates it has ([letter-send-flow.md](letter-send-flow.md#confirmed-send-transaction)). Sends nothing. Not read-only, not destructive (a draft expires on its own) and idempotent. The cards may call it too (`openai/widgetAccessible`).
- `cancel_scheduled_mail`: Listed only while `LETTER_IRL_ARRIVE_BY_ENABLED` is on (#535). Cancels a letter or postcard sent with an arrival date while it waits for its mail date, free until it goes to the printer. Takes `orderId` and `confirm: true`; without `confirm: true` nothing happens. Returns `status: "cancelled"`, `alreadyCancelled`, `returned` (`kind` `letters` or `gift_letter`, and `count`: whole letters of two credits each, or the gift letter) and a `message`. The message also says when part or none of it came back usable: refunded with its pack, or expired while the mail was held. A repeat answers as already cancelled and returns nothing more. Refused, with a sentence saying what to do, for an order that is not found, has no arrival date, has gone to the printer, is going right now, or is Pay & Send (support email). Destructive, since a cancelled order must be sent again, and idempotent. The cards may call it too (`openai/widgetAccessible`). The website cancels through `POST /api/letters/:letterId/cancel` ([letter-send-flow.md](letter-send-flow.md#confirmed-send-transaction)).
- `get_draft_status`: Card-only: hidden from the model (`ui.visibility: ["app"]`, `openai/visibility: "private"`) and asked by the preview cards in a host that keeps no state for them ([ui-widgets.md](ui-widgets.md)). Says whether a preview's draft is `ready`, `sent` (with its `orderId`), `expired` or `not_found` (#535 for the rest). A ready draft comes with its arrival dates when it has them (`schedule`: `arriveBy`, `mailOn`) and its `deliveryEstimate` with those dates. A sent one says where its order stands, read from the letter, never the draft: `orderStatus` `scheduled` while it waits for its mail date, `cancelled`, or `sent` once the outbox has taken it; its `schedule`; and `cancellable`, which is false for Pay & Send. A letter it cannot read leaves those out. Dates it cannot read are left out rather than refused. Read-only; a draft that is not the caller's reads as `not_found`. While stationery is offered, a ready letter drawn by our renderer also carries its `stationery` now (Classic for a page without a theme), with its page in `_meta.previewHtml`, so a card shown its preview's first answer again draws the style the draft has (#563). A ready letter of more than one page also carries its `pages` now (#586), as a restyle may have changed them.

## Buying Letters and Pay & Send

- `list_letter_packs`: List the packs available to buy, with how many letters each adds and what it costs. Read-only. Packs whose Stripe Price has not resolved are omitted rather than offered, because buying one would fail.
- `create_pack_checkout`: Create a Stripe-hosted checkout for one pack size (`starter`, `regular`, `power`). Payment adds letters to the balance; it does not send anything, so the customer still chooses and sends afterward. Uses `ui://widgets/PackCheckoutCard.html@v<N>`.
- `create_mail_checkout`: Create a Stripe-hosted Pay & Send checkout for one previewed letter or postcard draft. Paying sends that exact item; see [Pay & Send Details](#pay--send-details).
- `get_purchase_status`: Read the status of a pack or Pay & Send purchase by `orderId`. Read-only. Has no widget of its own; `PackCheckoutCard` and the preview cards poll it through `callTool`.
- `redeem_promo_code`: Redeem a promo code, or a gift code printed on a letter, to add letters. A gift code or seed campaign reports `giftLetters`. Returns `redeemed: false` with the reason for an invalid, expired or spent code - an ordinary answer rather than an error.

## Postcards

- `quote_and_preview_postcard`: Create a free draft preview for a 6x9 physical postcard with a front image and back message. Accepts an attached image or `imageUrl`; sender is optional when a saved return address exists. Creates a draft and uses `ui://widgets/PostcardPreviewCard.html@v<N>`.
- `send_postcard`: Send a postcard from a prior draft. Requires `draftId` and `confirm: true`. Idempotent retries with the same draft return the existing order rather than charging twice. Refuses the same postcard sent recently unless `sendAnotherCopy: true` is passed, as `send_letter` does. Sent with an arrival date, it answers as `send_letter` does.

## Account, Orders, and Return Address

- `get_profile`: The profile ChatGPT records for a connected account - a stable account id and the confirmed email address. Marked `_meta["openai/profile"]`, which is how ChatGPT finds it; called by ChatGPT with the connection's credentials when it links an account; the model can call it too; the narration carries only the address, while the id travels in `structuredContent` (#424). Read-only.
- `get_account_balance`: Check remaining pre-paid letter sends plus image-generation quota metadata, and `giftLettersRemaining` when the account holds gift letters (not counted in `lettersRemaining`). Read-only.
- `list_orders`: List recent mailed letters and postcards (recipient, delivery status; ids for `get_order_status`) and letter pack purchases (payment status, letters, amount; ids for `get_purchase_status`). Mail sent with an arrival date also carries `arriveBy`, `mailOn` and `cancellable`, and reads as `scheduled` while it waits for its mail date (#535, [status-labels.md](status-labels.md)). Read-only.
- `get_order_status`: Retrieve the latest timeline for a specific order, or the most recent order when `orderId` is omitted. Mail sent with an arrival date also carries `arriveBy`, `mailOn` and `cancellable`, reads as `scheduled` while it waits, and its timeline says when it goes to the printer. Read-only.
- `set_return_address`: Validate and save the user's default return address for future letters and postcards.
- `get_return_address`: Retrieve the saved return address. Read-only.
- `clear_return_address`: Clear the saved return address. Requires `confirm: true` and is marked destructive, as are `send_letter`, `send_postcard`, `set_return_address`, `create_mail_checkout` and `create_pack_checkout` (irreversible outcomes: mail that cannot be recalled, an overwritten address, a payment; see [learnings/tool-annotation-decision.md](learnings/tool-annotation-decision.md)).

## Images

- `generate_image_for_mail`: Uses `ui://widgets/ImageRoutingCard.html@v<N>`. Hybrid image tool for requests addressed to Letter IRL. With Letter IRL image generations remaining (pack/JIT grants plus a one-time starter allowance) it generates in-turn via the OpenAI Images API and returns an imageUrl for previews; with none left, or past the global daily ceiling, it returns a redirect card with a copy-ready prompt for free built-in generation. Never hard-fails. See docs/learnings/generate-image-removal-decision.md Addendum 3.
- `upload_image`: Open the image upload widget as a fallback when direct attachment or `imageUrl` handoff does not work. Uses `ui://widgets/ImageUploadCard.html@v<N>`. Its `cardUploadAvailable` tells the card whether it may send the photo itself in an app with no file store (#474), which is true only while `LETTER_IRL_CARD_UPLOAD_ENABLED` is on. Its `context` is what the photo is for: `postcard`, `header_image` or `inline_image`. A model may describe it in its own words instead (in CLIENT-01 step 14 Claude sent a whole sentence), so the server reads such a description as one of the three, or as none (`src/utils/uploadContext.ts`), before the card or the recent upload sees it.
- `confirm_uploaded_image`: Internal widget relay that confirms an uploaded image and returns the `imageUrl` plus next-step guidance. Its `context` is read the same way, so a context in other words no longer keeps the recent upload from matching its preview.
- `upload_photo_chunk` (#474, phase 3): the upload card's way to send a photo in an app with no file store, such as Claude.
  - **Who sees it:** listed and callable only while `LETTER_IRL_CARD_UPLOAD_ENABLED` is on. Off, it is not registered, so a call gets the MCP SDK's "not found" error, and a card drawn before the switch went off says upload is not available. Card-only, like `get_draft_status`: hidden from the model, and called by the card with no prompt. It needs the drafting scope (`mail:draft`), and the photo is always the caller's own.
  - **Input:** `uploadId` (a UUID the card makes), `index`, `total` (at most 24), `data` (base64, at most 512 Ki characters, a multiple of 4), and optionally `context` (`postcard`, `header_image` or `inline_image`).
  - **Order:** chunks go in order. The first chunk of a new upload replaces any the account left unfinished. A chunk sent again is answered as before and starts nothing. That holds for the chunk just received, and for any chunk of an upload being finished or just finished, which waits for that upload's answer. While the account's last photo is still being saved, a new upload is refused with "Your last photo is still being saved. Please try again in a moment.", so the last upload started is the photo held. The card waits for each answer, so it meets this only when an answer was lost and the person starts another photo while the last is still being saved; the sentence tells them what to do. A chunk out of order drops the upload with "That upload was interrupted. Choose the photo again."
  - **Answer:** `{uploadId, received, total, done}`, plus the photo's `width` and `height` once `done`.
  - **The photo:** on the last chunk the server checks the photo by its own bytes (an image of a kind it takes, big enough to print, within the decode limits). It then stores it privately, as the account's **only** uploaded photo, replacing the one before. It records `letterirl-upload:latest` as the account's recent upload, so the next preview with no image uses the photo. The image service resolves that reference only to the photo of the account the preview is for. It is never served at an address, and it is kept 15 minutes.
  - **Limits per account:** one upload in progress or being saved; at most 8 MiB of photo; ten minutes to send it; `LETTER_IRL_PHOTO_UPLOADS_PER_DAY` uploads started in a rolling 24 hours (default 20; a chunk sent again does not count). Across the process, at most 64 MiB of chunks and photos being kept are held at once ("Photo uploads are busy right now. Please try again in a minute."). The chunks are held in the API process's memory, so a restart mid-upload means choosing the photo again.
  - **Errors:** every refusal is a sentence the card shows as it is. So is the image service's, for a photo it will not take. Any other failure, such as the image store being down, is logged by its class and answered "The photo could not be kept just now. Please try again."

## Feedback

- `submit_feature_request`: Capture unsupported formats, workflows, integrations, or product-improvement requests.

## Pay & Send Details

### `create_mail_checkout`

Input: `{ draftId: string, sendAnotherCopy?: boolean }`.

Creates or reuses the one active hosted checkout for an authenticated user's
pending letter or postcard draft. The tool never accepts a price, currency,
Stripe Price ID, recipient, or mail content. It returns the commerce `orderId`,
hosted `checkoutUrl`, exact server-configured amount/currency, product
description, expiry, and current order status. Payment is authorization to mail
the immutable draft; the model must not call `send_letter` or `send_postcard`
after payment. A new checkout for mail sent, paid for or awaiting payment in the
last 24 hours is refused unless `sendAnotherCopy` is true
([letter-send-flow.md](letter-send-flow.md#the-same-mail-twice)).

While the send rule is on, the tool is card-only like the send tools (#475):
the preview card's **Pay & Send** button calls it, and no app shows it to its
model. It is listed only for an app that takes purchases (ChatGPT today). As
a guard for a future app, a call from one that takes no purchases, shows no
card, or can't keep card-only tools from its model answers with the
confirmation link instead ([letter-send-flow.md](letter-send-flow.md#who-can-send-the-send-rule-470)).

### `get_purchase_status`

Input: `{ orderId: string }`.

Returns sanitized, owner-scoped purchase state: `pending_payment`, `processing`,
`submitted`, `payment_failed`, `refund_pending`, `refunded`, `on_hold`, or
`cancelled`. It exposes no card, billing, address, content, or raw Stripe data.

For a letter-pack order it also returns the pack's figures, absent (never
null) on Pay & Send orders: `letters` in the pack, `lettersRemaining` still on
the account (active and unexpired), `lettersRefunded` returned as cash so far,
`perLetterCents` (the pack price divided by its letter count, rounded down),
`refundableAmountCents` (what a proportional refund of the remaining letters
would come to, `0` unless the pack is fulfilled and untouched by an earlier
proportional refund), and `amountRefundedCents`. These are the numbers an
operator reads before touching a refund in Stripe (#323). The pack message
never says a refund will be issued; refund requests go to
`support@letterirl.com` with the order id, and a person decides.

### Preview eligibility

Preview tools retain `canSendNow` for compatibility and now also return
`sendEligibility`, containing prepaid eligibility, Pay & Send availability and
exact price, and the configured letter-pack destination.

## Schema Notes

- Three files define tool schemas, and they reach different places:
  - `src/zodSchemas.ts` holds the Zod input and output shapes that `src/mcp/registerTools.ts` passes to `mcpServer.registerTool`. The SDK turns them into the JSON Schema returned by MCP `tools/list`, which is what ChatGPT reads, and validates calls against them. **A contract change that ChatGPT must see goes here.** `src/contracts/outputConformance.ts` proves at compile time that each tool's output type matches its served output schema.
  - `src/schemas.ts` holds the JSON schemas on each tool module's definition object. `/manifest.json` and the checked-in `manifest.json` are generated from these, not from the Zod shapes, so the two must be changed together.
  - `src/mcp/toolSchemas.ts` holds Zod input schemas that type the registration maps and back `tests/unit/mcp/schemaConsistency.test.ts`. Nothing serves them.
- Registration iterates the tool list in `src/server.ts` and **silently skips** any tool missing from the Zod input or output map in `registerTools.ts`.
- Adding a tool therefore touches: `src/tools/<tool>.ts`; its export in `src/tools/index.ts`; the `tools` array in `src/server.ts` (order matters, see [learnings/openai-app-sdk-notes.md](learnings/openai-app-sdk-notes.md)); `src/zodSchemas.ts` and both maps in `src/mcp/registerTools.ts`; `src/schemas.ts`; `src/mcp/toolSchemas.ts`; then `npm run manifest:generate` and `npm run test:submission`.
- Tool responses split data intentionally:
  - `structuredContent`: compact model-facing fields validated by the runtime output schema.
  - `content`: short model narration.
  - `_meta`: widget-only fields such as preview HTML and compressed letter-image previews.
- Preview tools create database draft records, so they are write tools even though they do not send mail or charge the user.
- Send tools require a draft and explicit confirmation. The assistant must not claim mail was sent unless the corresponding send tool succeeds.

## Verification

Run these after tool, schema, or widget changes:

```bash
npm run manifest:generate
npm run test:submission
```
