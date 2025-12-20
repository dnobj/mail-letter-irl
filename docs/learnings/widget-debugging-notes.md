# Widget Debugging Notes (December 20, 2025)

## Problem
Widgets render but `window.openai.toolOutput` is `null`, causing widgets to display stale/default data.

## Key Finding #1: Revert to Original Format Made Widgets Disappear
- Commit `37da9cf` reverted to original `cacc39f` format
- Used `mcpServer.resource()` instead of `registerResource()`
- Used `mcpServer.tool()` instead of `registerTool()`
- Put `_meta` inside `structuredContent`
- **Result: Widgets disappeared entirely**

This tells us the newer `registerTool()`/`registerResource()` format IS required for widgets to render at all.

## Timeline of Changes

| Commit | Change | Widget Status |
|--------|--------|---------------|
| `cacc39f` | Original implementation | Worked (per user) |
| `da8a7cf` | Move _meta to top level | ? |
| `d5df76b` | Use registerTool | ? |
| `e596fd5` | Add CSP/domain metadata | ? |
| `348ab3f` | Remove _meta from response | toolOutput: null |
| `7d1df05` | Add _meta back to response | toolOutput: null |
| `37da9cf` | Revert to original | Widgets disappeared |

## Console Output Analysis
```
window.openai: Proxy(Object) with 39 methods
window.openai.toolOutput: null
window.openai.toolResponseMetadata: (not checked)
window.openai.toolInput: (not checked)
```

The widget IS loading (console.log runs), but ChatGPT isn't injecting tool data.

## Focus: LetterPreviewCard Widget

Key data it needs:
- `previewHtml` - The letter preview HTML
- `requiredCredits` - Cost in credits
- `canSendNow` - Boolean
- `reasonCannotSend` - String if can't send
- `draftId` - For send action
- `deliveryClass`, `estimatedDeliveryDays`

## Questions to Answer
1. What exact format does `registerTool` need for `_meta`?
2. Does `_meta` go in tool registration, response, or both?
3. What's the exact structure ChatGPT expects for `structuredContent`?
4. Is there a timing/caching issue?

## Documentation Review (December 20, 2025)

### Correct Tool Registration Format (from docs):
```typescript
server.registerTool(
  "tool_name",
  {
    title: "Human-Readable Title",  // ← WE'RE MISSING THIS!
    inputSchema: { ... },
    _meta: {
      "openai/outputTemplate": "ui://widget/template.html",
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "...",
      "openai/toolInvocation/invoked": "..."
    }
  },
  async (args) => { ... }
);
```

### Correct Resource Registration Format (from docs):
```typescript
server.registerResource(
  "resource_id",
  "ui://widget/template.html",
  {},  // ← EMPTY OPTIONS OBJECT, not { mimeType: ... }
  async () => ({
    contents: [{
      uri: "ui://widget/template.html",
      mimeType: "text/html+skybridge",
      text: "...",
      _meta: {
        "openai/widgetPrefersBorder": true,  // ← WE'RE MISSING THIS
        "openai/widgetDomain": "https://chatgpt.com",
        "openai/widgetCSP": { ... },
        "openai/widgetDescription": "..."
      }
    }]
  })
);
```

### Correct Tool Response Format (from docs):
```typescript
return {
  structuredContent: { ... },  // → window.openai.toolOutput
  content: [{ type: "text", text: "..." }],
  _meta: { ... }  // → window.openai.toolResponseMetadata (optional)
};
```

### Data Flow:
- `structuredContent` → `window.openai.toolOutput`
- `_meta` (response) → `window.openai.toolResponseMetadata`
- `_meta` (tool registration) → tells ChatGPT which widget to render

## Issues Found in Our Implementation:

1. **Missing `title` field** in registerTool options
2. **Wrong options format** in registerResource (we pass `{ mimeType }` but should be `{}`)
3. **Missing `openai/widgetPrefersBorder`** in widget _meta
4. **Reverted to old API** which doesn't support _meta properly

## Finding #2: Old API Doesn't Support Widget _meta
When we reverted to `mcpServer.tool()` and `mcpServer.resource()`:
- Widgets disappeared entirely
- These older APIs don't pass `_meta` to ChatGPT
- Must use `registerTool()` and `registerResource()`

## Current Implementation (commit b43a41a)

Now using the EXACT format from OpenAI docs:

### Resource Registration:
```typescript
mcpServer.registerResource(
  widget.name,
  uri,
  {},  // Empty options
  async () => ({
    contents: [{
      uri,
      mimeType: "text/html+skybridge",
      text: html,
      _meta: {
        "openai/widgetPrefersBorder": true,
        "openai/widgetDomain": "https://chatgpt.com",
        "openai/widgetCSP": { connect_domains: [...], resource_domains: [...] },
        "openai/widgetDescription": "..."
      }
    }]
  })
);
```

### Tool Registration:
```typescript
mcpServer.registerTool(
  tool.name,
  {
    title: tool.description,
    description: tool.description,
    inputSchema: shape,
    annotations,
    _meta: {
      "openai/outputTemplate": "ui://widgets/LetterPreviewCard.html",
      "openai/widgetAccessible": true,
      ...
    }
  },
  async (args) => ({
    structuredContent: result,
    content: [{ type: "text", text: summaryText }],
    _meta: meta
  })
);
```

### Debug Logging Added
Widgets now log:
- `window.openai.toolOutput`
- `window.openai.toolResponseMetadata`
- `window.openai.toolInput`
- `window.openai.widgetState`
- `window.openai.widget`

## Finding #3: Data Arrives AFTER Widget Loads

Console output showed:
- `toolInput: {}` (empty object, not null)
- `toolOutput: null`
- `toolResponseMetadata: null`

The `toolInput: {}` suggests the widget loads BEFORE data is populated.
Per OpenAI docs, must listen for `openai:set_globals` event!

### Fix Applied
Updated widgets to:
1. Define a `render()` function
2. Call `render()` on initial load
3. Listen for `openai:set_globals` event and re-render

```javascript
// Initial render
render();

// Listen for data updates
window.addEventListener("openai:set_globals", () => {
  console.log("openai:set_globals event fired!");
  render();
});
```

## ✅ SOLUTION FOUND (December 20, 2025)

**Root Cause:** Widgets load and execute JavaScript BEFORE ChatGPT populates `window.openai.toolOutput`. The data arrives a few seconds later via the `openai:set_globals` event.

**Solution:** Widgets MUST listen for the `openai:set_globals` event and re-render when it fires.

### Required Widget Pattern:

```javascript
function render() {
  const data = window.openai?.toolOutput ?? {};
  // Update DOM with data
}

// Initial render (data will be null/empty)
render();

// Re-render when data arrives
window.addEventListener("openai:set_globals", () => {
  render();
});
```

### Key Learnings:

1. **`registerTool()` and `registerResource()` are REQUIRED** - The older `tool()` and `resource()` methods don't pass `_meta` to ChatGPT, causing widgets to disappear entirely.

2. **`openai:set_globals` event is REQUIRED** - Data is NOT available on initial widget load. Must listen for this event.

3. **Tool registration format:**
   - Include `title` field
   - Include `_meta` with `openai/outputTemplate` pointing to `ui://` resource

4. **Resource registration format:**
   - Use empty `{}` for options parameter
   - Include `_meta` on content item with CSP, domain, description

5. **Response format:**
   - `structuredContent` → becomes `window.openai.toolOutput`
   - `content` → narration for model
   - `_meta` → becomes `window.openai.toolResponseMetadata`

### UX Consideration:
Show a loading state initially since data takes a few seconds to arrive. Don't show misleading defaults like "0 credits".
