# Letter IRL Home

**Last Updated:** October 4, 2026
**Status:** In Progress; host acceptance pending
**Purpose:** The first read-only Plugin Extensions home and its rollout checks

## Scope

`open_letter_home` accepts {} on `mail:read` and returns the signed-in account's 20 newest active drafts and 20 newest retained letters or postcards. Recent recipients are deduplicated from that mail by name, city and state; this is not an address book. Bounds are stated in the tool and home. Gift drafts and mail are marked.

A single SQL statement reads both lists. Pending drafts must be unexpired and not redacted; mail must not be redacted. Neither list contains street addresses, body text, images, signatures, payments or prices. Errors refuse the read rather than implying an empty history. Existing authenticated account preparation and erased-account checks remain in effect. Summaries reach the connected app and its model, like `list_orders`.

The home uses the initial result and refreshes only when the person presses Refresh. It does not send, cancel, edit, purchase, or poll. Draft links open the existing website confirmation page, where the person signs in, reviews, and sends. Scheduled mail shows its original arrival aim and planned mail date. Delivered mail reads **Delivery estimated**. Certified mail reuses `certifiedOrderNote`, including status-specific tracking and electronic receipt wording. Refresh failures retain a visible stale-data warning.

## Configuration and compatibility

`LETTER_IRL_HOME_ENABLED` is off unless explicitly enabled. While off, the tool is absent from `tools/list` and /manifest.json, its resource is unlisted and unreadable, and cached calls refuse without reading home data. Manifest generation disables it for the checked-in production snapshot. No migration or dependency is added.

While enabled, LetterHomeCard.html@v67 is an MCP App resource. The tool declares _meta.ui.resourceUri and _meta["openai/ui"].entrypoints: [{type: "global"}]. Other clients can call it as a read-only tool. The host uses its default navigation icon: SDK 1.29's high-level `registerTool` does not emit top-level `icons`. This change does not modify SDK internals.

Source: [official Plugin Extensions documentation](https://developers.openai.com/plugins/build/extensions). Declaring an entrypoint does not establish that it appears in the owner's development connection. HOME-01 requires the owner's eyes before that is reported as working.

The published privacy policy covers recipient names, addresses and connected AI interfaces. This slice adds no collection, street-address disclosure or retention schedule. Review this scope against the website's published policy before enabling it live. This PR neither changes policy wording nor enables the flag anywhere.

## Remaining slices

- Scheduled cancellation through the existing confirmed cancellation tool.
- Model-App Context for selecting a draft, then home deep links.
- Rich-form pickers with capability detection and fallback. OpenAI-registered servers require multi-round-trip requests (`MRTR`); preserve existing tools until supported.
- Conversation panel after home/context host acceptance, as the plan requires.
- Custom entrypoint icon when the SDK exposes it.

## See Also

- [Tool APIs](tool-apis.md)
- [UI Widgets](ui-widgets.md)
- [Manual tests](manual-tests.md), HOME-01
- [Privacy policy](privacy-policy.md)
- [Letter creator vision](letter-creator-vision.md)
