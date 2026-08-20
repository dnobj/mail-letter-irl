# UI Widgets

**Last Updated:** August 20, 2026

Letter IRL registers five OpenAI Apps SDK widgets as MCP resources with `ui://` URIs and `text/html;profile=mcp-app`. Tool results keep model-facing data in `structuredContent` and send large render payloads, such as preview HTML and generated image thumbnails, through widget-only `_meta`.

## Registered Widgets

- `LetterPreviewCard`: Shows text-only, header-image, and enclosed-image letter drafts. Reads letter preview HTML from `_meta.previewHtml`, displays delivery/cost context, and can call `send_letter` only after the user explicitly confirms.
- `PostcardPreviewCard`: Shows postcard front and back previews from `_meta.previewFrontHtml` and `_meta.previewBackHtml`, then can call `send_postcard` only after explicit user confirmation.
- `GenerateImageCard`: Shows a lightweight generated-image preview from `_meta.generatedImagePreview` and relays the generated image URL for use with postcard or letter preview tools.
- `ImageUploadCard`: Opens a file picker fallback for image handoff problems, uploads a photo, and calls `confirm_uploaded_image` with the resulting `imageUrl`. When the host exposes `window.openai.selectFiles` (plan/region-gated), it also offers a "Choose from Library" button that picks a file already in the user's ChatGPT Library and reuses the same confirm/follow-up handoff without re-uploading; because pick-time download URLs are temporary, a fresh URL is re-resolved via `getFileDownloadUrl` when the user confirms.
- `GetStartedCard`: Presents onboarding guidance, purchase prerequisite messaging, and example prompts for new users.

## Runtime Bridge Notes

- Widgets currently use the `window.openai` compatibility bridge, including `toolOutput`, `toolResponseMetadata`, `callTool`, and `sendFollowUpMessage` where needed.
- Current OpenAI guidance prefers MCP Apps bridge notifications for new widget work, including tool-result and tool-input notifications. Treat a future bridge migration as a focused widget task, not as part of routine tool changes.
- Widget resource metadata includes canonical `ui` metadata plus legacy `openai/*` aliases for compatibility.

## UX and Safety Guidelines

- Never auto-send mail from a widget. Irreversible actions must stay behind explicit confirmation.
- Keep previews mobile-friendly and resilient to delayed or repeated render lifecycle events.
- Clearly show recipient context before confirmation when available.
- Prefer direct conversation image reuse or `imageUrl` handoff before opening the upload widget.

# Pay & Send preview actions

When prepaid balance is sufficient, letter and postcard preview widgets retain
their existing Send action. When it is insufficient, the widgets render the
server-provided alternatives:

- **Pay & Send** calls `create_mail_checkout`, displays the exact physical item
  and amount, and opens Stripe with `window.openai.openExternal`.
- **Buy a Letter Pack** opens the configured `LETTER_IRL_PACKS_URL`.

After opening checkout, the widget polls `get_purchase_status` for a bounded
period and shows webhook delay as processing rather than failure. Widget CSP is
limited to the configured Letter IRL endpoint and Stripe-hosted Checkout.
