> **HISTORICAL (Aug 2026):** the generate_image tool, GenerateImageCard widget,
> and generation service described below were REMOVED - see
> `docs/learnings/generate-image-removal-decision.md`. This plan is kept as the
> most detailed write-up of the _meta partitioning contract, which lives on in
> `partitionToolResult` for letter/postcard previews.

# Generated image result bridge repair

Status: implementation-ready

Tracking issue: https://github.com/dnobj/mail-letter-irl/issues/169

Target branch: dev

Last reviewed: 2026-07-31

## Objective

Make a successfully generated Letter IRL image render reliably in the ChatGPT widget and remain available to the model for the next postcard or letter tool call, without placing base64 image data in model context.

The selected contract is:

- `structuredContent.generatedImageUrl` is the small, model-visible, chainable capability URL.
- Tool-result `_meta.generatedImagePreview` is the widget-only base64 thumbnail.
- The widget prefers the thumbnail, falls back to the URL, and accepts both the current nested ChatGPT metadata envelope and the legacy flat compatibility shape.
- The widget's CSP explicitly permits images from the configured Letter IRL API origin.
- The runtime output schema describes only `structuredContent`; it must require the fields the adapter actually returns.

## Background and evidence

The DEV acceptance test for issue #160 proved that `generate_image` completed successfully and returned both a preview and a temporary URL. `GenerateImageCard` nevertheless rendered “No image was generated.”

The failure spans three layers:

1. `src/tools/generateImage.ts` returns `generatedImagePreview` and `generatedImageUrl`.
2. `src/mcp/registerTools.ts` currently removes both fields from `structuredContent` and moves them to response `_meta`.
3. `widgets/GenerateImageCard.html` expects `_meta` fields directly on `window.openai.toolResponseMetadata`, while the current ChatGPT bridge exposes an envelope containing `mcp_tool_result`, including the hidden MCP `_meta`.

The project history records two important constraints:

- Large full-resolution base64 values caused context and metadata-size failures. They must not return to `structuredContent`.
- Widget values can arrive after initial load, so the widget must keep its `openai:set_globals` listener and loading state.

Current OpenAI guidance says `window.openai.toolOutput` is `structuredContent`, that concise structured content is visible to both the model and component, and that `toolResponseMetadata` preserves the full MCP result envelope. It also recommends the portable `ui/notifications/tool-result` path for new UI. This repair keeps the existing compatibility bridge working and adds the portable notification path without rewriting unrelated widgets.

## Scope

### In scope

- Correct the `generate_image` response partitioning.
- Make the generated-image runtime output schema match the response.
- Resolve current nested, direct MCP-result, and legacy-flat widget metadata shapes.
- Listen for the standard `ui/notifications/tool-result` message in addition to the existing compatibility event.
- Permit the configured Letter IRL API origin in image/resource CSP.
- Add focused adapter, schema, widget-contract, and CSP tests.
- Update the relevant Apps SDK/image learnings and manual test case.
- Run the complete DEV generate → render → postcard-preview acceptance flow.

### Out of scope

- Redesigning `GenerateImageCard`.
- Restoring the removed “Use This Image” or “Generate Another” buttons.
- Changing image-generation models, quotas, storage lifetime, or billing.
- Migrating every widget to a new framework or bridge API.
- Production deployment; production promotion follows normal DEV acceptance.

## Implementation design

### 1. Partition tool results by purpose

Refactor the adapter partitioning into an exported, testable helper or equivalent focused unit:

- Remove `generatedImagePreview` from `structuredContent` and place it in `_meta`.
- Retain `generatedImageUrl` in `structuredContent`.
- Optionally duplicate the URL in `_meta` during the compatibility window, because it is small and existing widget versions may read it there.
- Continue removing preview HTML and all large letter/postcard base64 fields from model-facing output.
- Never log the preview payload, full image payload, or complete capability URL.

The result should be valid against the registered Zod output schema before it is returned by the MCP handler.

### 2. Align schemas

Update `generateImageOutputZ` so the registered `outputSchema` requires the chainable `generatedImageUrl` along with message, suggested next step, and remaining-generation count. Do not add `generatedImagePreview` to the runtime output schema because the schema describes `structuredContent`, not hidden `_meta`.

Reconcile `src/schemas.ts` documentation with this split. Its public tool-result documentation must distinguish model-visible output from widget-only metadata rather than claiming the base64 preview is a required structured field.

### 3. Normalize widget inputs

Add a small resolver inside `GenerateImageCard` that accepts:

- `window.openai.toolOutput` for `structuredContent`.
- `window.openai.toolResponseMetadata.mcp_tool_result._meta` for the current ChatGPT envelope.
- Direct MCP tool-result shapes containing `_meta`.
- The legacy flat `window.openai.toolResponseMetadata.generatedImagePreview` form.
- A cached standard `ui/notifications/tool-result` result.

Resolution order:

1. Use a valid base64 preview from hidden metadata.
2. Use the URL from `structuredContent`.
3. Use a compatibility URL from hidden or flat metadata.
4. Stay loading when no tool result has arrived.
5. Show the existing error only after a result arrives without usable image data.

Treat all bridge values as untrusted. Only accept non-empty strings, avoid rendering arbitrary HTML, and keep the image error handler.

### 4. Support the standard result notification

Keep `openai:set_globals` for compatibility. Also listen for `message` events from `window.parent`, require JSON-RPC 2.0, and process only `ui/notifications/tool-result`. Cache `message.params` and re-render.

This is deliberately limited to result receipt. Tool calls, follow-up messages, and broader widget modernization remain separate work.

### 5. Correct widget CSP

Build separate canonical and legacy CSP representations:

- Canonical `_meta.ui.csp` uses `connectDomains` and `resourceDomains`.
- Legacy `_meta["openai/widgetCSP"]` uses `connect_domains` and `resource_domains`.
- Both resource-domain lists include the configured Letter IRL API origin and the required OpenAI static asset origin.

Normalize the configured API value to an HTTPS origin before publishing it. Do not add wildcards for Railway or unrelated Letter IRL hosts.

## Automated tests

Add focused Vitest coverage under `tests/unit/mcp/`:

1. Adapter partition happy path:
   - URL remains in `structuredContent`.
   - base64 preview is absent from `structuredContent` and present in `_meta`.
   - unrelated lean fields remain model-visible.
2. Adapter partition failure/edge path:
   - absent optional heavy fields do not create undefined metadata keys.
   - letter/postcard base64 fields remain excluded.
3. Output schema:
   - accepts the actual structured result.
   - rejects a generated-image result without `generatedImageUrl`.
4. Widget contract:
   - source includes current nested metadata resolution, legacy fallback, `openai:set_globals`, and `ui/notifications/tool-result`.
   - error handling does not run while no result has arrived.
5. CSP:
   - canonical camelCase and legacy snake_case structures are both correct.
   - configured API origin is allowed as an image resource.

Retain existing tool-level image-generation tests for quota reservation, provider failures, preview creation, storage, and URL construction.

## Manual acceptance

Add or update a durable case in `docs/manual-tests.md`, then execute it against `(DEV) Letter IRL` after deployment:

1. Refresh or reconnect the DEV app so ChatGPT receives the deployed widget resource.
2. Ask Letter IRL—not native ChatGPT image generation—to create an image for a postcard.
3. Confirm `generate_image` succeeds and `GenerateImageCard` displays the preview.
4. Confirm the conversation can use the returned image URL in `quote_and_preview_postcard` without asking the user to copy it.
5. Confirm the postcard front renders the same generated image.
6. Repeat after reconnect to guard against cached widget resources.
7. Check a narrow mobile viewport and dark mode; confirm loading, image, URL, and error states remain readable and do not overflow.
8. Confirm server/browser logs contain no bearer tokens, full capability URLs, or base64 image bodies.

## Verification commands

- `npm run lint`
- `npm run test:submission`
- `npm run test:run`
- `npx tsc --noEmit`
- `npm run manifest:generate` followed by a clean diff check

Record any pre-existing failures separately; do not treat them as regressions or silently suppress them.

## Rollout

1. Merge the implementation into `dev` with issue #169 linked.
2. Let Railway deploy the DEV service.
3. Refresh the `(DEV) Letter IRL` app and run the manual acceptance case.
4. Observe at least one reconnect/retry and inspect non-sensitive logs.
5. Mark #169 complete only after the generated image renders and chains into a postcard preview.
6. Promote to production only with the next approved DEV-to-production release group.

## Rollback

If the change prevents image generation, widget rendering, or downstream preview:

1. Revert the implementation commit in `dev` and allow Railway to redeploy.
2. Refresh the DEV app's tool/widget metadata.
3. Confirm the prior textual `generate_image` result still completes.
4. Preserve redacted evidence of the failing result envelope and reopen #169.

No database migration or Auth0/OpenAI app-registration rollback is required.

## Acceptance criteria

Issue #169 is complete only when:

- The registered output schema matches actual `structuredContent`.
- `generatedImageUrl` reaches both the model and widget without exposing base64 data to the model.
- The widget renders from current ChatGPT metadata, the standard MCP Apps result notification, and legacy compatibility input.
- CSP permits the exact configured image origin without broad wildcards.
- Focused tests and the full automated suite pass without new failures.
- The DEV ChatGPT flow generates, displays, and carries the image into a postcard preview.
- Documentation records the final response split and the previously learned size/timing constraints.
- Production remains unchanged until normal promotion approval.

## Primary references

- OpenAI plugin UI guide: https://developers.openai.com/plugins/build/chatgpt-ui
- OpenAI plugin UI reference: https://developers.openai.com/plugins/reference
- MCP Apps specification: https://modelcontextprotocol.io/docs/extensions/apps
- Project widget learnings: `docs/learnings/widget-debugging-notes.md`
- Project Apps SDK notes: `docs/learnings/openai-app-sdk-notes.md`
