# OpenAI Apps SDK Notes

**Last Updated:** September 18, 2026  
**Purpose:** Capture practical OpenAI Apps SDK learnings for Letter IRL

## Current Status

Letter IRL is integrated as an MCP-backed ChatGPT app with OAuth, Streamable HTTP, server-side tool registration, and custom Apps SDK widgets. The server now registers 22 tools ([tool-apis.md](../tool-apis.md)). On May 30, 2026 the development app showed 17, including `generate_image` (later renamed `generate_image_fallback`, removed Aug 2026), `upload_image`, `get_started`, postcard tools, letter tools, account/order tools, return-address tools, and feature-request capture.

## Recent Learnings

- ChatGPT can cache an app's visible tool list after reconnect. Using the app detail panel's Refresh action may be necessary before newly deployed tools appear. On 2026-09-17 the Refresh button sat on the app's own page under Settings, Plugins, in its Information section. The page's `...` menu offered Reconnect, Disconnect and Delete, but not Refresh, and Disconnect also uninstalls the app.
- Mobile widget rendering can appear delayed on Android; in observed tests, switching away from and back to the conversation caused the widget to render. Keep this in mind when testing widget lifecycle issues.
- (Historical) While `generate_image_fallback` existed it was kept early in the runtime tool order because ChatGPT appears more likely to expose and use earlier tools in constrained surfaces. The tool was removed Aug 2026 (docs/learnings/generate-image-removal-decision.md); the first-12 exposure observation still applies to the remaining tools.
- Runtime `outputSchema` should describe `structuredContent`, not widget-only `_meta`. Letter IRL deliberately sends preview HTML and image preview blobs through `_meta` to keep model context small. (While generation existed, its small capability URL stayed in `structuredContent` so the model could chain it into previews.)
- Server instructions are now part of the MCP initialization surface and should contain durable, concise behavior rules rather than long marketing copy.

## Widget Bridge Notes

- Existing widgets use `window.openai` compatibility fields and methods such as `toolOutput`, `toolResponseMetadata`, and `callTool`.
- ChatGPT may expose hidden result metadata inside `toolResponseMetadata.mcp_tool_result._meta`, while older hosts used flat `toolResponseMetadata`. Widgets that need hidden data should normalize both shapes.
- A widget's own `callTool` gets the server's `_meta` back on a successful result (PREVIEW-01), but not on a refused one. When a card's `send_letter` was refused as a duplicate on 2026-09-17, the card saw only the text (DUPLICATE-01). Yet the server does send `_meta` on that error result, which `tests/unit/mcp/duplicateMailRefusal.test.ts` pins over a real MCP transport. The host either rejects the call with the message or resolves it without `_meta`, and the card cannot tell which. Put anything a card must act on after a refused call in the result's text. Match it with `includes`, because a host may also put its own words in front of a rejection's message.
- The portable MCP Apps `ui/notifications/tool-result` message is another supported result path. Keep `openai:set_globals` during the compatibility window because widget values can arrive after initial load.
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
