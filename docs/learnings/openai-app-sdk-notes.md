# OpenAI Apps SDK Notes

**Last Updated:** May 30, 2026  
**Purpose:** Capture practical OpenAI Apps SDK learnings for Letter IRL

## Current Status

Letter IRL is integrated as an MCP-backed ChatGPT app with OAuth, Streamable HTTP, server-side tool registration, and custom Apps SDK widgets. The development app has verified visibility for 17 tools, including `generate_image`, `upload_image`, `get_started`, postcard tools, letter tools, account/order tools, return-address tools, and feature-request capture.

## Recent Learnings

- ChatGPT can cache an app's visible tool list after reconnect. Using the app detail panel's Refresh action may be necessary before newly deployed tools appear.
- Mobile widget rendering can appear delayed on Android; in observed tests, switching away from and back to the conversation caused the widget to render. Keep this in mind when testing widget lifecycle issues.
- `generate_image` should remain early in the runtime tool order because ChatGPT appears more likely to expose and use earlier tools in constrained surfaces.
- Runtime `outputSchema` should describe `structuredContent`, not widget-only `_meta`. Letter IRL deliberately sends preview HTML and image preview blobs through `_meta` to keep model context small.
- Server instructions are now part of the MCP initialization surface and should contain durable, concise behavior rules rather than long marketing copy.

## Widget Bridge Notes

- Existing widgets use `window.openai` compatibility fields and methods such as `toolOutput`, `toolResponseMetadata`, and `callTool`.
- Newer Apps SDK guidance exposes MCP Apps bridge notifications for tool results and approved tool input. Migrate during a planned widget refresh, with regression testing across desktop and mobile ChatGPT.
- Host CSS variables are now available through host context. Adopt them when refreshing widget styling so cards better match ChatGPT themes.

## Verification Checklist

- Regenerate the manifest after tool or schema changes:

```bash
npm run manifest:generate
```

- Run submission-facing tests:

```bash
npm run test:submission
```

- In ChatGPT developer mode, verify the connected app shows the expected tools and widget templates after pressing Refresh.
