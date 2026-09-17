# UI Widgets

**Last Updated:** September 16, 2026

Letter IRL registers six OpenAI Apps SDK widgets as MCP resources with `ui://` URIs and `text/html;profile=mcp-app`. Widget template URIs are versioned (`ui://widgets/<name>.html@v<N>` via `src/mcp/widgetUris.ts`) because the native mobile apps cache widget metadata aggressively (issue #235); bump `WIDGET_TEMPLATE_VERSION` on any widget change — a digest-pinning test enforces this — and the legacy unversioned URI stays registered as a transition alias for stale clients. Tool results keep model-facing data in `structuredContent` and send large render payloads, such as preview HTML and compressed letter-image previews, through widget-only `_meta`.

Two more template names serve an existing card rather than a new widget (`WIDGET_VARIANTS` in `src/mcp/registerTools.ts`, #411): `LetterHeaderImagePreviewCard` and `LetterInlineImagePreviewCard` both serve `LetterPreviewCard.html`, one for each image letter tool. The server stamps every preview template with the tool that draws it, as `<meta name="letter-irl-preview-tool">`, because a card cannot otherwise tell which preview to repeat: the host passes no tool name, and the two image letter tools take identical input. Only the preview templates carry the stamp, and the versioned variant URIs are listed in `resources/list` next to the cards'. `LetterPreviewCard` is stamped only at v32 and later (`previewToolFor`). Before v32 all three letter tools pointed at it, and an image call may carry no image arguments at all, so its legacy URI and older versions go out unstamped.

## Registered Widgets

- `LetterPreviewCard`: Shows text-only, header-image, and enclosed-image letter drafts. Reads letter preview HTML from `_meta.previewHtml`, displays delivery/cost context, and can call `send_letter` only after the user explicitly confirms.
- `PostcardPreviewCard`: Shows postcard front and back previews from `_meta.previewFrontHtml` and `_meta.previewBackHtml`, then can call `send_postcard` only after explicit user confirmation.
- **Both preview cards recover from a lost preview call (#411).** On ChatGPT web, a preview call approved with "Allow once" can vanish: no request reaches the API, yet the host draws the card with no result and the model says the preview is ready. A card with no result waits 25 seconds for a text-only letter, or 45 seconds for an image letter or a postcard, so that a slow but live call can still deliver its own result. A text-only preview checks two addresses in turn, each allowed 10 seconds, and an image preview first downloads its image. The card then shows "No preview is showing on this card" with **Create my preview**. The button repeats the stamped tool through `callTool` with the host's `toolInput`, unchanged, and draws the result through the normal render path. The card never calls by itself. After 60 seconds without an answer the button can be pressed again. Whichever preview arrives first is drawn, and any later one is left unused. When the result carries no `_meta`, the letter card draws the text from the arguments, and an image letter shows "Image not shown on this card" where its image would be. The card offers no button, only advice to ask again in the chat, in these cases:
  - the page has no stamp;
  - the host passed no usable arguments, or an attached image in a form other than the file object the server reads (the server would otherwise fall back to the most recent upload, which may be a different picture);
  - the host cannot call tools;
  - a text-only stamp arrives with image arguments.

  A host result that arrives later replaces the card's own draft until the card first tries to send it or pay for it, whether or not that attempt succeeds. Both drafts hold the same mail, and the host's is the one the model knows, so a send from the card and a send from the chat land on one draft, which the server sends once. A send that failed on the card's side may still have gone out, and the server recognises a repeat only for the same draft, so the card never switches after an attempt. Two drafts can still both be sent when the card sends its own before a slow host result arrives and the user then confirms a send in the chat (#412).
- **Both preview cards keep what they did in `widgetState`** as `{v: 1, draftId, sent?, checkout?, orderId?, checkoutUrl?}`: the draft shown, a successful send, or a created checkout with its `https` link. A reopened conversation gets its `widgetState` back but no tool result. A reopened card that sent its mail shows **With the printer** with the order id and no buttons. One that opened a checkout follows that order with `get_purchase_status` and **Check status**. It shows the kept link when its first status check finds the order unpaid, or cannot tell, and then leaves the link in place, as the live card does. Either way it never offers the preview, the send or the payment again, even if a host replays the result. A reopened card that only showed a preview offers **Create my preview** at once, because no result is coming. Its message says that if the mail was already sent, for example from the chat, there is nothing more to do.
- `ImageUploadCard`: Opens a file picker fallback for image handoff problems, uploads a photo, and calls `confirm_uploaded_image` with the resulting `imageUrl`. When the host exposes `window.openai.selectFiles` (plan/region-gated), it also offers a "Choose from Library" button that picks a file already in the user's ChatGPT Library and reuses the same confirm/follow-up handoff without re-uploading; because pick-time download URLs are temporary, a fresh URL is re-resolved via `getFileDownloadUrl` when the user confirms.
- `GetStartedCard`: Presents onboarding guidance, purchase prerequisite messaging, and example prompts for new users.
- `ImageRoutingCard`: The `generate_image_for_mail` result, in one of two states. **Generated**: the image made in-turn with one of the user's Letter IRL image generations, a credit line with the generations remaining, and the image URL with a Copy button so it can be handed to a preview tool. **Redirect** (no generations left, the global daily ceiling reached, generation turned off or unconfigured, or the provider failed): an explanation and the prompt with a Copy button, so the user can resend it without mentioning Letter IRL and let ChatGPT's built-in generator make it free. On desktop (`redirectStyle: "handoff"`) the card says replying "go ahead" is enough; on mobile (`"resend"`) it asks for the copy-and-resend. It deliberately does not call `sendFollowUpMessage` (see [learnings/generate-image-removal-decision.md](learnings/generate-image-removal-decision.md)).
- `PackCheckoutCard`: Shows a letter pack checkout with the pack, the price, the order id and the Stripe link as a real anchor. Rendered without a tool result (ChatGPT has dropped the first consequential call after "Allow once", issue #322), it waits five seconds and then offers to create the checkout itself through `callTool`, using the pack from `toolInput` when present and otherwise listing the packs via `list_letter_packs`. While a checkout is open it polls `get_purchase_status` in the preview cards' visibility-gated shape (3 s for the first minute, then 15 s, for ten minutes, plus a Check status button) and replaces the link with the outcome: paid with the letters added, still being credited, expired or failed with a new-checkout offer when the pack is known, or the server's message for refunds and holds. A checkout the card created, and any status it has shown, take precedence over a later `openai:set_globals`. The card keeps the order it shows and the last status it saw in `widgetState`. A reload, or the return page's link back into the conversation, reopens the card instance. A reopened instance resumes from that kept state whether or not the host replays the tool result, provided the host delivers the kept state no later than the result. It draws the kept order and status at once, reads the status once straight away when it can call tools, polls at the slow interval for up to nine minutes, and never opens the checkout by itself. Its link points at the API's `/purchase/start` page (`checkoutStartUrl`) and a tap goes through `openExternal`, so for the allowlisted API origin ChatGPT appends the `redirectUrl` that the start page keeps in a same-site cookie and the return page turns into **Back to your conversation** (#372); a plain fallback link appears if the host call opens nothing. Both pages log one line per request (`purchase.start`, `purchase.return`) carrying presence, host and outcome fields only, never the link, the cookie or the checkout session.

## Runtime Bridge Notes

- Widgets currently use the `window.openai` compatibility bridge, including `toolOutput`, `toolResponseMetadata`, `callTool`, and `sendFollowUpMessage` where needed.
- A result returned to a widget through `callTool` is visible to that widget only; the model never sees it (#366). On 2026-09-12 the checkout card created a checkout this way and the model could not name the order afterwards. Rule: every widget-initiated action leaves a customer-readable trace on the card (for a checkout, the order id and the purchase outcome), and nothing relies on `sendFollowUpMessage` to inform the model: `docs/learnings/generate-image-removal-decision.md` records that call resolving without posting the message on-device (2026-08-21). The conversation-side fallback is a read-only tool the model can call itself, which is why `list_orders` lists pack purchases (#365).
- Current OpenAI guidance prefers MCP Apps bridge notifications for new widget work, including tool-result and tool-input notifications. Treat a future bridge migration as a focused widget task, not as part of routine tool changes.
- Widget resource metadata includes canonical `ui` metadata plus legacy `openai/*` aliases for compatibility. The connector detail panel renders our `ui.csp` back verbatim, which is how we know the canonical key is the one being read (issue #228).

### Content Security Policy

The declared policy (`WIDGET_CSP_CANONICAL` in `src/mcp/registerTools.ts`) allows
only what a widget genuinely loads: our API origin (the upload widget's
diagnostic beacon, and the temp-image URL the image card can fall back to),
OpenAI's static and user-content hosts, and Stripe plus the letter-pack origin as
redirect targets. Everything else a widget displays is a `data:` URI produced
server-side, so it needs no host at all.

One host is **deliberately excluded**: the Azure blob host behind ChatGPT Library
picks. Trusting it would mean trusting all of Azure blob storage for a thumbnail
that the next screen renders anyway, so `ImageUploadCard` degrades to an
explanatory line instead. The picked image is unaffected - it reaches the server
over the `window.openai` bridge and is fetched from Node, outside CSP's reach.
See `docs/learnings/widget-csp-enforcement.md` for the evidence and for how to
reproduce enforcement locally (dev-mode ChatGPT never enforces it).

## UX and Safety Guidelines

- Never auto-send mail from a widget. Irreversible actions must stay behind explicit confirmation.
- Keep previews mobile-friendly and resilient to delayed or repeated render lifecycle events.
- Clearly show recipient context before confirmation when available.
- Prefer direct conversation image reuse or `imageUrl` handoff before opening the upload widget.

## Pay & Send Preview Actions

When prepaid balance is sufficient, letter and postcard preview widgets retain
their existing Send action. When it is insufficient, the widgets render the
server-provided alternatives:

- **Pay & Send** calls `create_mail_checkout`, displays the exact physical item
  and amount, and opens Stripe with `window.openai.openExternal`.
- **Buy a Letter Pack** calls `list_letter_packs`, replaces itself with one
  button per pack size showing letters and price, and each of those calls
  `create_pack_checkout` for that size. It no longer opens
  `LETTER_IRL_PACKS_URL`; that variable remains only as a website fallback.
  A website URL carries no identity, so a customer not signed in there bought
  letters that never reached the account the card could see.

After opening checkout, the widget refreshes `get_purchase_status` **only while
the document is visible**, and immediately when it becomes visible again.
Browsers throttle timers in a hidden iframe, and paying means being in another
tab, so a timer alone could not cover the window it existed for. Refreshing
stops once payment is confirmed: the remaining hop to provider acceptance is
owned by the hourly maintenance job, so there is nothing a short poll could
observe. A **Check status** button covers the rest, and webhook delay shows as
processing rather than failure. Stripe Checkout is reached as a redirect
target; the full widget policy is under [Content Security Policy](#content-security-policy).
