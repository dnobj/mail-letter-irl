# Decision Record: Remove the `generate_image` / `generate_image_fallback` tool

**Date:** August 21, 2026
**Decision:** Remove Letter IRL's own image-generation tool entirely. ChatGPT's
built-in image generation (`image_gen`) is the only generation path.
**Owner:** David Nicholl. Investigation and evidence: issues #227, #235;
PRs #231–#238 and the removal PR referencing this record.

## History: why the tool existed

`generate_image` was built because the ChatGPT **mobile app** could not hand a
natively-generated image to MCP tools — the model passed unusable strings
(`chat_upload://image_0`, bare file ids) instead of file params, so a postcard
built from a generated image was impossible on mobile. The tool called the
OpenAI Images API server-side, stored the result in the temp-image store, and
returned a `temp-image` URL the preview tools could chain.

The owner's standing position (Aug 2026): *"I'd really like to just strip this
part of the app if I can, but leave it in place if it is needed to deliver a
good intent experience."*

## What changed: the #227 investigation

1. **The handoff was fixable on our side.** The served file-param schemas did
   not conform to the Apps SDK contract (three schema layers; the served layer
   used `z.any()` → `{}`). PRs #231–#233 fixed the contract; the connector's
   **Refresh** action (not Reconnect) re-ingests it.
2. **After the fix, direct handoff of natively-generated images works on every
   surface** — verified with real drafts: desktop web (lighthouse), mobile web
   (cabin), native Android app (jet — owner's device; cabin postcard draft
   `ada398c5`). The model passes an `/mnt/data/...` string; the platform
   transform delivers the real file on the wire.
3. **The tool was winning routing it should not win.** With the app selected,
   generic requests ("generate an image of a cute bunny / monkey playing
   chess") routed to our tool instead of `image_gen`. Three rounds of
   description steering (r1 PR #236, r2 PR #237, r3 PR #238) fixed this on
   desktop web (both Instant and Medium tiers verified) but **not** on the
   native app, where attachment is an @-mention: server logs (the
   `mcp.client_request` instrumentation, PR #238) proved the phone fetched
   `tools/list` with `steeringRev: 3` at 18:32Z and still routed
   "@Letter IRL generate an image of a penguin…" to the tool at 18:34Z.
   **Copy cannot override mobile @-mention routing — proven, not assumed.**

## The decision tests and results (all on the owner's Galaxy S25 Ultra, Android 16, plus web)

| Question | Test | Result |
|---|---|---|
| Does native `image_gen` work inside app conversations on the native app? | Steered request in an @-mention conversation (penguin) | ✅ Generated in 34s (a native-app **display stall** made it look hung; re-entering the conversation showed the finished image) |
| Does it work even when the model claims it can't? | Rocket test: model said "the image-generation tool is currently unavailable" | ✅ Hallucinated constraint — one "try it anyway" nudge produced the image. Server instructions now state built-in generation is always available |
| Will generated images reach postcards without our tool? | fileParams handoff per surface | ✅ Desktop, mobile web, native app (see #227 evidence trail) |
| Is the Library picker (`selectFiles`) a fallback on every surface? | ImageUploadCard render per surface | Desktop ✅ (lists generated images), mobile web ✅, **native app ❌** — `window.openai.selectFiles` is absent; only local upload ("Select Photo") exists there |
| Does steering copy fix mobile routing? | r3 deployed + log-verified fresh metadata + penguin test | ❌ Tool still grabbed the @-mention request |

## Decision rationale

- Every current image path works without the tool, on every surface.
- Keeping it defeats the goal: mobile @-mention image requests keep routing to
  it (r3-proven), burning our OpenAI quota for a worse-model result.
- Removal is the only deterministic routing fix.
- Residual risk: if the platform's fileParams handoff regresses on the native
  app again, recovery there is save-to-phone → local upload (the Library
  picker does not exist on native). Accepted: the regression is hypothetical,
  the workaround functional, and the tool is one revert away
  (`git log` for the removal PR; the tool, widget, service, schemas, and tests
  are all in history).

## What was removed / kept

Removed: `src/tools/generateImage.ts`, `widgets/GenerateImageCard.html`,
`src/services/imageGenerationService.ts` (OpenAI Images API caller, sole
consumer was the tool), the three schema-layer entries, scope mapping, widget
registration, and all direct tests. `OPENAI_API_KEY` is no longer read by any
code path.

Kept deliberately:
- **`imageGenerationLimitService` and the entitlement plumbing** (commerce
  grants, admin endpoints, maintenance reconciliation, DB columns) — paid
  entitlements are a data-model concern beyond this change; follow-up issue
  filed for a separate decision.
- **Temp-image store + `/api/temp-image/` endpoint** — nothing writes to it
  anymore; kept for unexpired tokens and as a candidate for the same follow-up
  (its bucket configuration feeds the #158 production preflight, so removing
  it simplifies the cutover and deserves its own review).
- `STEERING_COPY_REV` (now r4) and the `mcp.client_request` logging — the
  observability outlives the tool it was built to debug.

## Regression pins

- `manifest.test.ts` asserts no `generate_image*` tool is advertised.
- `widgetResources.test.ts` asserts `GenerateImageCard` is not defined and
  re-homes the widget CSP pins from the deleted bridge test.
- Server instructions carry the anti-hallucination line ("built-in image
  generation … is always available for image requests").
- Manual tests (CIMD-04) now check the two things that must stay true: generic
  and @-mention image requests route to NATIVE generation, and the upload
  widget remains the image-recovery path.
