# MCP Tool API Specifications

**Last Updated:** May 30, 2026  
**Purpose:** Practical reference for the MCP tools exposed by Letter IRL

The runtime MCP registry is the source of truth. The checked-in `manifest.json` is generated from that registry with `npm run manifest:generate`, and submission-facing tests verify that the manifest, widget list, and runtime tool registry stay aligned.

Letter IRL currently exposes **17 tools**:

## Onboarding

- `get_started`: Show a short getting-started guide with setup steps and example prompts. Read-only. Uses `ui://widgets/GetStartedCard.html`.

## Letter Drafts and Sending

- `quote_and_preview_letter`: Create a free draft preview for a text-only physical letter. Requires a real U.S. recipient address, `bodyText`, and `signOff`; sender is optional when a saved return address exists. Creates a draft, so it is not read-only. Uses `ui://widgets/LetterPreviewCard.html`.
- `quote_and_preview_letter_with_header_image`: Create a free draft preview for a letter with a header image at the top. Accepts an attached image or `imageUrl`. Creates a draft and uses `ui://widgets/LetterPreviewCard.html`.
- `quote_and_preview_letter_with_image`: Create a free draft preview for a letter with an enclosed image after the signature. Accepts an attached image or `imageUrl`. Creates a draft and uses `ui://widgets/LetterPreviewCard.html`.
- `send_letter`: Send a letter from a prior draft. Requires `draftId` and `confirm: true`. Idempotent retries with the same draft return the existing order rather than charging twice.

## Postcards

- `quote_and_preview_postcard`: Create a free draft preview for a 6x9 physical postcard with a front image and back message. Accepts an attached image or `imageUrl`; sender is optional when a saved return address exists. Creates a draft and uses `ui://widgets/PostcardPreviewCard.html`.
- `send_postcard`: Send a postcard from a prior draft. Requires `draftId` and `confirm: true`. Idempotent retries with the same draft return the existing order rather than charging twice.

## Account, Orders, and Return Address

- `get_account_balance`: Check remaining pre-paid letter sends plus image-generation quota metadata. Read-only.
- `list_orders`: List recent letter and postcard orders. Read-only.
- `get_order_status`: Retrieve the latest timeline for a specific order, or the most recent order when `orderId` is omitted. Read-only.
- `set_return_address`: Validate and save the user's default return address for future letters and postcards.
- `get_return_address`: Retrieve the saved return address. Read-only.
- `clear_return_address`: Clear the saved return address. Requires `confirm: true` and is marked destructive.

## Images

- `generate_image_fallback`: FALLBACK ONLY — generates artwork through Letter IRL when ChatGPT's built-in image generation is unavailable, has failed, or its image could not be handed off (or when the user explicitly asks Letter IRL to generate). Normal image requests should use built-in generation. Returns a widget preview and an image URL path for follow-up preview tools. Uses the versioned `GenerateImageCard` widget template.
- `upload_image`: Open the image upload widget as a fallback when direct attachment or `imageUrl` handoff does not work. Uses `ui://widgets/ImageUploadCard.html`.
- `confirm_uploaded_image`: Internal widget relay that confirms an uploaded image and returns the `imageUrl` plus next-step guidance.

## Feedback

- `submit_feature_request`: Capture unsupported formats, workflows, integrations, or product-improvement requests.

## Schema Notes

- Every tool has a JSON input and output schema in the runtime tool definition.
- The MCP SDK registration also passes Zod `inputSchema` and `outputSchema` shapes for runtime validation.
- Tool responses split data intentionally:
  - `structuredContent`: compact model-facing fields validated by the runtime output schema.
  - `content`: short model narration.
  - `_meta`: widget-only fields such as preview HTML and generated image previews.
- Preview tools create database draft records, so they are write tools even though they do not send mail or charge the user.
- Send tools require a draft and explicit confirmation. The assistant must not claim mail was sent unless the corresponding send tool succeeds.

## Verification

Run these after tool, schema, or widget changes:

```bash
npm run manifest:generate
npm run test:submission
```

# Pay & Send tools

## `create_mail_checkout`

Input: `{ draftId: string }`.

Creates or reuses the one active hosted checkout for an authenticated user's
pending letter or postcard draft. The tool never accepts a price, currency,
Stripe Price ID, recipient, or mail content. It returns the commerce `orderId`,
hosted `checkoutUrl`, exact server-configured amount/currency, product
description, expiry, and current order status. Payment is authorization to mail
the immutable draft; the model must not call `send_letter` or `send_postcard`
after payment.

## `get_purchase_status`

Input: `{ orderId: string }`.

Returns sanitized, owner-scoped purchase state:
`pending_payment`, `processing`, `sent`, `payment_failed`, `refund_pending`,
`refunded`, or `cancelled`. It exposes no card, billing, address, content, or raw
Stripe data.

Preview tools retain `canSendNow` for compatibility and now also return
`sendEligibility`, containing prepaid eligibility, Pay & Send availability and
exact price, and the configured letter-pack destination.
