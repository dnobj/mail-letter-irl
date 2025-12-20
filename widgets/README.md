# Letter IRL Widget

This widget renders inside ChatGPT via the OpenAI Apps SDK.

## LetterPreviewCard.html

Shows the letter preview before sending, including:
- Rendered letter content (as it will appear when printed)
- Cost in credits
- Delivery class and estimated days
- Ready/Cannot send status
- Saved return address note (if applicable)

### Data Source

Receives data via `window.openai.toolOutput` from the `quote_and_preview_letter` MCP tool.

### Key Implementation Notes

- Uses `openai:set_globals` event to receive data (data arrives after widget loads)
- Shows loading shimmer animation until data arrives
- Registered as MCP resource with `ui://widgets/LetterPreviewCard.html` URI
- Uses `text/html+skybridge` MIME type for ChatGPT runtime injection

See `docs/learnings/widget-debugging-notes.md` for implementation details.
