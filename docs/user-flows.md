# Core User Flows

## Flow A — Send a New Letter
1. User instructs ChatGPT to draft and mail a letter.
2. ChatGPT drafts the body text and invokes `quote_and_preview_letter` with sender, recipient, body, and sign-off details.
3. The server responds with preview HTML, required credits, and a `canSendNow` flag.
4. ChatGPT presents `LetterPreviewCard` with the preview and cost breakdown.
5. If the user approves, the widget calls `send_letter` via `window.openai.callTool` with `confirm: true`.
6. The server queues the order, deducts credits, and returns confirmation fields that render in `LetterConfirmationCard`.

## Flow B — Check Status / Resend
1. User asks about the status of a recent letter.
2. ChatGPT calls `get_order_status` (without `orderId` to fetch the most recent order by default).
3. The server returns the status timeline, recipient summary, and preview thumbnail.
4. ChatGPT renders `LetterStatusCard`, optionally exposing a follow-up call-to-action.
5. Selecting the CTA sends a follow-up message through `window.openai.sendFollowUpMessage`, prompting ChatGPT to draft a follow-up letter that loops back to Flow A from the preview step.

## Flow C — Check Credits
1. User requests their remaining balance.
2. ChatGPT invokes `get_account_balance`.
3. The server returns remaining credits, whether the user can send a standard letter, and an explanatory message.
4. ChatGPT displays the response with `BalanceCard`.

## Flow Safety Notes
- Only `send_letter` produces irreversible real-world effects; all other tool calls are read-only.
- Explicit `confirm: true` is required in `send_letter` to satisfy OpenAI safety expectations.
