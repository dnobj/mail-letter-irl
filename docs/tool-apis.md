# MCP Tool API Specifications

**Last Updated:** September 16, 2026  
**Purpose:** Practical reference for the MCP tools exposed by Letter IRL

The runtime MCP registry is the source of truth. The checked-in `manifest.json` is generated from that registry with `npm run manifest:generate`, and submission-facing tests verify that the manifest, widget list, and runtime tool registry stay aligned.

Letter IRL currently exposes **22 tools** and **6 widgets**:

## Onboarding

- `get_started`: Show a short getting-started guide with setup steps and example prompts. Read-only. Uses `ui://widgets/GetStartedCard.html@v<N>`.

## Letter Drafts and Sending

All four preview tools accept an optional `sendAsGift` ([gift-letters.md](gift-letters.md)): `true`
sends the draft as the account's gift letter, free and with a printed card for the recipient;
omitted, a gift letter is used only when the balance cannot pay. A gift preview returns `giftCard`
(`state`: `funded` or `unfunded`, and a `description`), and any preview returns
`giftLettersAvailable` when the account has some. Both are absent while gift letters are off.

- `quote_and_preview_letter`: Create a free draft preview for a text-only physical letter. Requires a real U.S. recipient address, `bodyText`, and `signOff`; sender is optional when a saved return address exists. Creates a draft, so it is not read-only. Uses `ui://widgets/LetterPreviewCard.html@v<N>`.
- `quote_and_preview_letter_with_header_image`: Create a free draft preview for a letter with a header image at the top. Accepts an attached image or `imageUrl`. Creates a draft and uses `ui://widgets/LetterHeaderImagePreviewCard.html@v<N>`, which serves the letter card under its own name so the card knows which preview to repeat (#411).
- `quote_and_preview_letter_with_image`: Create a free draft preview for a letter with an enclosed image after the signature. Accepts an attached image or `imageUrl`. Creates a draft and uses `ui://widgets/LetterInlineImagePreviewCard.html@v<N>`, the letter card under its own name for the same reason.
- `send_letter`: Send a letter from a prior draft. Requires `draftId` and `confirm: true`. Idempotent retries with the same draft return the existing order rather than charging twice. The same letter sent, paid for or awaiting payment from the account in the last 24 hours refuses the call unless `sendAnotherCopy: true` is passed, which the model does only after the user asks for another copy ([letter-send-flow.md](letter-send-flow.md#the-same-mail-twice)).

## Buying Letters and Pay & Send

- `list_letter_packs`: List the packs available to buy, with how many letters each adds and what it costs. Read-only. Packs whose Stripe Price has not resolved are omitted rather than offered, because buying one would fail.
- `create_pack_checkout`: Create a Stripe-hosted checkout for one pack size (`starter`, `regular`, `power`). Payment adds letters to the balance; it does not send anything, so the customer still chooses and sends afterward. Uses `ui://widgets/PackCheckoutCard.html@v<N>`.
- `create_mail_checkout`: Create a Stripe-hosted Pay & Send checkout for one previewed letter or postcard draft. Paying sends that exact item; see [Pay & Send Details](#pay--send-details).
- `get_purchase_status`: Read the status of a pack or Pay & Send purchase by `orderId`. Read-only. Has no widget of its own; `PackCheckoutCard` and the preview cards poll it through `callTool`.
- `redeem_promo_code`: Redeem a promo code, or a gift code printed on a letter, to add letters. A gift code or seed campaign reports `giftLetters`. Returns `redeemed: false` with the reason for an invalid, expired or spent code - an ordinary answer rather than an error.

## Postcards

- `quote_and_preview_postcard`: Create a free draft preview for a 6x9 physical postcard with a front image and back message. Accepts an attached image or `imageUrl`; sender is optional when a saved return address exists. Creates a draft and uses `ui://widgets/PostcardPreviewCard.html@v<N>`.
- `send_postcard`: Send a postcard from a prior draft. Requires `draftId` and `confirm: true`. Idempotent retries with the same draft return the existing order rather than charging twice. Refuses the same postcard sent recently unless `sendAnotherCopy: true` is passed, as `send_letter` does.

## Account, Orders, and Return Address

- `get_profile`: The profile ChatGPT records for a connected account - a stable account id and the confirmed email address. Marked `_meta["openai/profile"]`, which is how ChatGPT finds it; called by ChatGPT with the connection's credentials when it links an account, not by the model (#424). Read-only.
- `get_account_balance`: Check remaining pre-paid letter sends plus image-generation quota metadata, and `giftLettersRemaining` when the account holds gift letters (not counted in `lettersRemaining`). Read-only.
- `list_orders`: List recent mailed letters and postcards (recipient, delivery status; ids for `get_order_status`) and letter pack purchases (payment status, letters, amount; ids for `get_purchase_status`). Read-only.
- `get_order_status`: Retrieve the latest timeline for a specific order, or the most recent order when `orderId` is omitted. Read-only.
- `set_return_address`: Validate and save the user's default return address for future letters and postcards.
- `get_return_address`: Retrieve the saved return address. Read-only.
- `clear_return_address`: Clear the saved return address. Requires `confirm: true` and is marked destructive, as are `send_letter`, `send_postcard`, `set_return_address`, `create_mail_checkout` and `create_pack_checkout` (irreversible outcomes: mail that cannot be recalled, an overwritten address, a payment; see [learnings/tool-annotation-decision.md](learnings/tool-annotation-decision.md)).

## Images

- `generate_image_for_mail`: Uses `ui://widgets/ImageRoutingCard.html@v<N>`. Hybrid image tool for requests addressed to Letter IRL. With Letter IRL image generations remaining (pack/JIT grants plus a one-time starter allowance) it generates in-turn via the OpenAI Images API and returns an imageUrl for previews; with none left, or past the global daily ceiling, it returns a redirect card with a copy-ready prompt for free built-in generation. Never hard-fails. See docs/learnings/generate-image-removal-decision.md Addendum 3.
- `upload_image`: Open the image upload widget as a fallback when direct attachment or `imageUrl` handoff does not work. Uses `ui://widgets/ImageUploadCard.html@v<N>`.
- `confirm_uploaded_image`: Internal widget relay that confirms an uploaded image and returns the `imageUrl` plus next-step guidance.

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
