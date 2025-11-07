# UI Widgets

Letter IRL relies on four Apps SDK widgets rendered through `_meta.openai/outputTemplate`. Each widget is responsible for presenting server output and gating user actions that trigger additional tool calls.

## LetterPreviewCard
- **Inputs:** `previewHtml`, `requiredCredits`, `canSendNow`, optional masked address summaries, optional current balance.
- **Layout:**
  - Scrollable preview pane rendering `previewHtml` safely.
  - Cost summary showing required credits in Letter IRL credits.
  - Conditional messaging if `canSendNow` is false (e.g., "Not enough credits").
- **Primary action:** Button labeled “Send this letter.” On click, call `window.openai.callTool("send_letter", {..., "confirm": true})` with the same inputs used for the preview.
- **Safety:** Disable or hide the send button when `canSendNow` is false.

## LetterConfirmationCard
- **Inputs:** `orderId`, `currentStatus`, `recipientSummary`, `creditsRemaining`, optional `previewFirstPageHtml`.
- **Layout:**
  - Confirmation icon/text (e.g., “Your letter is queued for print”).
  - Recipient summary showing name and city/state.
  - Remaining credits display.
- **Primary action:** “Track status” button invoking `get_order_status` via `window.openai.callTool` for the returned `orderId`.

## LetterStatusCard
- **Inputs:** `orderId`, `currentStatus`, `statusTimeline`, `previewThumbnailHtml`, `canSendFollowUp`, `followUpSuggestedPrompt`.
- **Layout:**
  - Timeline component listing status entries in chronological order.
  - Thumbnail preview of page one of the letter.
  - CTA for follow-up when `canSendFollowUp` is true.
- **Primary action:** “Send follow-up letter” button calls `window.openai.sendFollowUpMessage` with `followUpSuggestedPrompt`, then re-enters the preview flow.

## BalanceCard
- **Inputs:** `creditsRemaining`, `canSendStandardLetter`, `standardLetterCostCredits`, `message`.
- **Layout:**
  - Prominent display of current credits.
  - Statement of standard letter cost.
  - Friendly guidance or nudges from the `message` field.
- **Future considerations:** Placeholder for “Add credits” remains out-of-scope for v1 but should be easy to activate later.

## General UX Guidelines
- Maintain mobile-friendly, accessible styling.
- Never auto-send letters; every irreversible action must be behind an explicit user click.
- Clearly show destination city and state prior to confirmation to reinforce transparency.
