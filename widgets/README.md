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
- With no result after the wait, offers **Create my preview**, which repeats the stamped preview tool through `callTool` (#411; see `docs/ui-widgets.md`), with a tip for Instant users under it
- For an image attached or generated in the chat, which it cannot pass back, offers **Choose from library** and **Upload the image** instead, and previews the chosen file by link (#414)
- Registered as MCP resource with `ui://widgets/LetterPreviewCard.html@v<N>` URI, and served for the image letter tools as `LetterHeaderImagePreviewCard` and `LetterInlineImagePreviewCard`
- Served as `text/html;profile=mcp-app`, which tells ChatGPT to inject the runtime bridge

See `docs/learnings/widget-debugging-notes.md` for implementation details.

## Header logo

Every widget's `.logo` and `.dark .logo` rules are written by `scripts/build-widget-logo.ts`, which inlines the website's mark from `assets/brand/`. Do not edit those two rules by hand: re-run the script, then bump `WIDGET_TEMPLATE_VERSION`.
