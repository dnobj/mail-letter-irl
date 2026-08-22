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
registration, and all direct tests. `OPENAI_API_KEY` is no longer read by any runtime
server code path (the app-registration script `scripts/create-app.sh` still
uses it for the unrelated OpenAI Apps API).

Kept deliberately:
- **`imageGenerationLimitService` and the entitlement plumbing** (commerce
  grants, admin endpoints, maintenance reconciliation, DB columns) — paid
  entitlements are a data-model concern beyond this change; follow-up issue
  filed for a separate decision.
- **Temp-image store + `/api/temp-image/` endpoint** — nothing writes to it
  anymore; kept for unexpired tokens and as a candidate for the same follow-up
  (its bucket
  configuration feeds the #158 production preflight: deploymentConfig still
  hard-errors production boot without the four TEMP_IMAGE_* vars, two of them
  secrets, for a store whose only writer is now gone. Removing it would
  simplify the cutover; that removal deserves its own review, hence the
  follow-up issue rather than riding along here).
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

## Post-removal addendum: the act-don't-explain ceiling (r5, Aug 21)

After removal, a native-app conversation OPENED with '@(DEV) Letter IRL
generate an image of X' sometimes produced a first-turn narration ('the app
doesn't expose an image-generation tool, so I can't...') instead of falling
through to image_gen; a one-line user nudge always produced the image.
Instructions r5 scripted the fallthrough explicitly ('generate immediately...
never pause to explain'). The mcp.client_request logs prove the device
received r5 (tools/list, steeringRev 5, 20:00:22Z) and the very next
first-turn @-mention ask still narrated (bear test, 20:01Z).

**Conclusion: server-instruction copy cannot override the native app's
first-turn treatment of an @-mention-addressed generate request.** This is
host/model behavior. Scope is narrow: it affects only the first turn of a
conversation opened by @-mentioning the app AND asking it to generate; plain
requests, desktop chip attachment, later turns, and the natural
generate-first flow all reach image_gen without friction. Accepted as a known
papercut; r5's directive is kept (harmless, may help other tiers), and the
clean repro + logs are available if this is ever escalated to OpenAI as
model-behavior feedback.

## Addendum 2: the intent trampoline (r6, Aug 21)

Rather than accept the first-turn narration, the owner asked for "a tool that
responds with instructions instead of just failing." `generate_image_for_mail`
does exactly that: it MATCHES generate-intent by name (exploiting the same
@-mention routing pull that motivated the removal), costs nothing (no OpenAI
call, no quota, no widget, read-only and PII-free so no consent dialog), and
returns a suggestedNextStep directing the model to generate with image_gen in
the same turn and then offer the mail flow. The redirect rides the tool-output
channel - empirically the strongest steering surface (the old tool's
"IMPORTANT: now call quote_and_preview_postcard" chained near-perfectly).

This does not reopen the removal: nothing generates server-side, and the
"no server-side generator" regression pin stands (narrowed to exclude the
router by name).

### Addendum 2 result (on-device, Aug 21)

The trampoline works as designed - 6s consent-free call, and the model ACTS on
the redirect ('Letter IRL handed this off to ChatGPT's built-in image
generation'), ending the capability narration. It then exposed the true
bottom: **the native app cannot chain an app tool call into image_gen within
the same turn.** Every same-turn attempt across every steering variant
reported image_gen 'unavailable'; every cross-turn attempt succeeded. One
natural nudge ('try again') completes the flow, every time. Web never routes
to the trampoline for plain requests (native gen fires directly), so the tool
only activates where it helps. Accepted end state: accurate attempt +
one-nudge recovery on native first turns; the only conceivable further step
is a widget on the router that fires sendFollowUpMessage as an auto-nudge -
deliberately NOT built (adds a visible synthetic turn, render weight, and a
flaky-API dependency for a papercut this small).

### Mechanism correction (owner-hypothesized, on-device confirmed, Aug 21)

The earlier 'same-turn tool-chaining restriction' framing was wrong in detail.
Discriminating test: in a conversation where image_gen had just succeeded
(fox, turn 2, no mention), a fresh @-mentioned generate request on turn 3
failed again - the model saying 'the built-in image generator isn't available
to me in this turn'. The failure follows the MENTION, not the turn number and
not a preceding tool call (the rocket case failed with a mention and no tool
call at all).

**Confirmed mechanism: on the native ChatGPT app, an @-mentioned message
scopes that turn's toolset to the app - image_gen is genuinely absent from
mention turns.** The web chip does not scope this way (native gen fired in
chip-attached turns). Every 'unavailable' claim was the model accurately
reporting its per-turn toolset, not hallucinating. Consequences: no
server-side design can make generation happen inside a mention turn (the tool
is not there); the trampoline's value is converting that turn into an
accurate, actionable handoff; the following unmentioned turn always succeeds.

## Addendum 3: the hybrid (r7, Aug 21) - generation returns, entitlement-gated

Owner decision after the trampoline experiments: `generate_image_for_mail`
becomes a HYBRID. When the user has Letter IRL image credits it generates
in-turn (the only way an image can appear inside a mention-scoped turn);
otherwise it returns a redirect card with a copy-ready prompt. This is a
principled partial reversal of the #239 removal: generation exists only as an
entitlement-gated, explicitly-addressed feature - never a generic tool the
router can waste.

Cost containment, in layers:
- **Credits are the gate**: pack purchases (existing `packImageGrant`), JIT
  orders (`IMAGE_ENTITLEMENTS_PER_JIT_ORDER`, default raised 1 -> 2), and a
  one-time starter allowance (`LETTER_IRL_IMAGE_STARTER_CREDITS`, default 3,
  granted lazily on first use, idempotent via the entitlement table's
  source uniqueness). Rationale for free starter credits: the rational abuser
  does not exist - generated images are free in ChatGPT by simply not
  mentioning Letter IRL; only vandalism remains, and it is capped.
- **Global daily ceiling** (`LETTER_IRL_IMAGE_DAILY_CEILING`, default 200
  =~ $10/day worst case at gpt-image-1.5 medium): past it, everyone degrades
  to the redirect card. `0` is a kill switch (blocks all generation). The
  check is advisory (read-before-reserve, so N concurrent requests can
  overshoot by ~N) and the day boundary is the DB server's timezone (UTC on
  hosted Postgres) - both acceptable for a soft spend cap.
- **Atomic reservations** (pre-existing): no concurrent overspend; ambiguous
  provider outcomes preserved for maintenance reconciliation.
- Model/quality remain env-tunable (`OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_QUALITY`;
  ~3.4-5.0 cents per medium generation as of Aug 2026).

Failure philosophy: the tool NEVER hard-fails the model. No prompt, no key,
no credits, ceiling reached, or provider failure all land on the redirect
card, because built-in generation always exists one unmentioned message away.
The redirect card's affordance is a **copy-to-clipboard prompt field** - the
sendFollowUpMessage auto-nudge was dropped after the on-device experiment
showed it RESOLVES without ever posting the message (false positive).

Infra consequences: `imageGenerationService` and its OPENAI_API_KEY return
(key absence degrades gracefully to redirect, never boot-fails); the
temp-image store has a writer again, so #240 resolves as "keep" and the four
TEMP_IMAGE_* vars remain on the #158 cutover checklist.

### Addendum 3 follow-up: the mode flag (Aug 21, evening)

The owner's original intent for the redirect card was the ONLY behavior (copy
field regurgitating the request; no server-side generation) - the hybrid
shipped both. Resolution: keep both, switchable without deploys via
`LETTER_IRL_IMAGE_GEN_MODE` (`on` | `off` | `mobile_only`, default `on`).
Desktop web WAS verified to spend credits when the tool is invoked there
(mention or explicit ask; log-proven `mobile: false` call consuming a credit),
which is why `mobile_only` exists: the `_meta["openai/userAgent"]` channel is
log-verified to distinguish surfaces (native app reports `mobile: true`), and
unknown surfaces fail closed to the free redirect path. The generated card
also now carries an attribution note ("Created by Letter IRL... ask again
without @Letter IRL and ChatGPT will generate free") so users learn the free
path even when credits flow.

### Surface-aware redirects (Aug 21, late)

The owner's target config is `LETTER_IRL_IMAGE_GEN_MODE=off` with per-surface
redirect behavior, so `redirectOutput` now branches on the log-verified
`isMobile` signal for EVERY redirect status (mode gate, no_credits, ceiling,
unconfigured, failures): confirmed desktop (`isMobile === false`) returns
`redirectStyle: "handoff"` - suggestedNextStep instructs the model to run
built-in generation NOW in the same turn (valid because desktop mentions do
not scope the toolset; the trampoline experiments showed in-turn native
generation works wherever image_gen is present), and the card renders as a
quiet fallback ("ChatGPT is generating this image") with the prompt+Copy row
retained for non-compliance. Mobile (`true`) and unknown (`undefined`)
surfaces return `redirectStyle: "resend"` with the original copy-field card,
the only path that works inside mention-scoped turns. no_prompt has no
style (nothing to hand off). Widget template v8. The tool cannot be hidden
per-surface at all: ChatGPT ingests tools/list once per connector at Refresh,
so per-surface behavior can only live in the response.

### On-device verification of surface-aware `off` (Aug 21, 9:22-9:29 PM, S25 Ultra)

With `LETTER_IRL_IMAGE_GEN_MODE=off` on the Railway dev API service and the
connector Refreshed (required after the v8 template bump - before the
Refresh the card rendered as a blank box because the platform still
requested the retired @v7 URI):

1. Fresh native-app conversation, "@Letter IRL draw a hedgehog sipping tea"
   -> tool redirected in ~8s, no credit spent, no reservation taken.
2. The v8 resend card rendered fully: "Generate this with ChatGPT" title,
   explanation, prompt field carrying the model's enriched prompt, Copy
   button, tip line, "routing t8" footer.
3. Copy button -> "Copied!" state AND Android's own "Copied." toast
   (OS-level clipboard write confirmed).
4. Prompt pasted into an unmentioned message (KEYCODE_PASTE) -> ChatGPT's
   built-in image_gen generated the hedgehog free. The known finished-
   generation display-stall occurred and recovered on conversation
   re-entry, as documented.

The Refresh action moved in the ChatGPT "Plugins" UI generation: Settings
-> Plugins -> connector -> scroll the detail panel to the Information
section's Refresh button. The "..." menus offer only Reconnect (still
re-auth only).

### Desktop handoff test falsified the scoping assumption (Aug 21, otter)

Desktop web, fresh chat, typed "@Letter IRL draw an otter juggling acorns"
with mode=off: the handoff card rendered perfectly (t8), no credit spent -
but the model reported built-in generation was NOT available in that turn.
**A typed @-mention scopes the toolset on desktop web too**; the earlier
"desktop doesn't scope" conclusion was specific to chip attach. The
recovery was one unmentioned reply ("ok go ahead and generate it") - the
model reused the prompt from context and image_gen produced the otter free,
no copy/paste needed.

Consequence (this revision, widget t9): handoff copy is hedged. The model
instruction is conditional (generate NOW if image_gen is present, otherwise
say a "go ahead" reply completes it); the card says "ChatGPT will generate
this free" with the reply-go-ahead fallback before the copy-field one.
Handoff remains the right desktop style - its one-word recovery still beats
the resend card - and executes in-turn on unmentioned invocations.

### Streamlining the double narration (t10, Aug 22)

The badger test showed card + narration saying the same thing twice (both
explained free routing and the "go ahead" recovery). Contract now: the CARD
is the single source of guidance; suggestedNextStep instructs the model to
add at most ONE short sentence (and to say nothing about routing at all when
it generates in-turn), never restating the card. The card itself lost its
redundant fallback hint row and both explains were tightened to one
sentence plus the postcard chain hint.

