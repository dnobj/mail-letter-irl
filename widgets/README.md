# Letter IRL Widget

This widget renders inside ChatGPT via the OpenAI Apps SDK.

## LetterPreviewCard.html

Shows the letter preview before sending, including:
- Rendered letter content (as it will appear when printed)
- Cost in letters
- Delivery class and estimated days
- Ready/Cannot send status
- Saved return address note (if applicable)

### Data Source

Receives data via `window.openai.toolOutput` from the three letter preview tools.

### Key Implementation Notes

- Uses `openai:set_globals` event to receive data (data arrives after widget loads)
- Shows loading shimmer animation until data arrives
- With no result after the wait, offers **Create my preview**, which repeats the stamped preview tool through `callTool` (#411; see `docs/ui-widgets.md`)
- Registered as MCP resource with `ui://widgets/LetterPreviewCard.html@v<N>` URI, and served for the image letter tools as `LetterHeaderImagePreviewCard` and `LetterInlineImagePreviewCard`
- Served as `text/html;profile=mcp-app`, which tells ChatGPT to inject the runtime bridge

See `docs/learnings/widget-debugging-notes.md` for implementation details.
