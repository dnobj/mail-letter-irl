# Letter IRL Home

**Last Updated:** October 7, 2026
**Status:** In Progress; host acceptance pending
**Purpose:** Plugin Extensions home, selection, cancellation and rollout checks

## Scope

`open_letter_home` accepts {} on `mail:read` and returns the signed-in account's 20 newest active drafts and 20 newest retained letters or postcards. Recent recipients are deduplicated from that mail by name, city and state; this is not an address book. Bounds are stated in the tool and home. Gift drafts and mail are marked.

A single SQL statement reads both lists. Pending drafts must be unexpired and not redacted; mail must not be redacted. Neither list contains street addresses, body text, images, signatures, payments or prices. Errors refuse the read rather than implying an empty history. Existing authenticated account preparation and erased-account checks remain in effect. Summaries reach the connected app and its model, like `list_orders`.

The home uses the initial result and refreshes only when the person presses Refresh. Draft links open the existing website confirmation page, only on the website origin the result names (`websiteOrigin`); a USPS link opens only as `https://tools.usps.com/go/TrackConfirmAction?tLabels=` with 8 to 40 letters and digits (#651). Held mail (held for an operator: a recovery hold, or a payment reversed or disputed while the letter was going out) reads as awaiting an update, as `get_order_status` says it. There the person signs in, reviews, and sends. Scheduled mail shows its original arrival aim and planned mail date. Delivered mail reads **Delivery estimated**, and the model is told the same: the order status's description, and the tool's text whenever an item is delivered, say a delivered status is the printer's estimate, not a carrier's confirmation. `get_order_status`, `list_orders` and a retried send say it too, and a selection shared with the conversation carries the card's own label (`statusLabel`). A Refresh that works says "Mail list refreshed." in the status line. Certified mail reuses `certifiedOrderNote`, including status-specific tracking and electronic receipt wording. Refresh failures retain a visible stale-data warning.

Scheduled prepaid and gift mail offer Cancel while arrive-by is enabled. A second press confirms cancellation through `cancel_scheduled_mail`; the existing transaction rechecks eligibility, account ownership and dispatch races, and restores funding at most once. Pay & Send never offers Cancel here. The UI displays the tool's actual balance-return message, including expired or refunded funding. A timeout or refusal leaves the status unchanged and asks for Refresh before retrying. The home read remains `mail:read`; cancellation separately requires the cancellation tool's scope.

The letter card, while the home flag and the host capability are on, shares the draft it shows by itself, with no button (#650): only a draft known to be ready (in Claude and VS Code, after `get_draft_status` says so), again with a later time whenever the person uses the card, and taken back once the card sends or pays for it or the draft is sent or expired. Several cards may share at once; the share carries `sharedAt`, and its instruction tells the model the latest is most likely the one the person means, to ask if unsure, and to recheck the draft status before editing. A use of the card means a click or a key on it. Selecting a draft or order in the home sends only its ID, recipient summary, status and dates through `ui/update-model-context`, replacing prior selection context. Clear selection replaces it with empty content. Calls are serialized so an older selection cannot arrive after a newer one. Unsupported or refused context is reported visibly.

Deep links accept only `/draft/<id>`, `/order/<id>` or `/`. Selection must exist in the current owner-scoped, bounded result; arbitrary routes never trigger a fetch. A missing or old selection asks for Refresh. Optional `LETTER_IRL_CHATGPT_PLUGIN_ID` enables share URLs for that installed plugin; leave it unset until the actual development plugin ID is known. No ID is invented. Links have the documented ChatGPT HTTPS format and an encoded `path` query.

## Configuration and compatibility

`LETTER_IRL_HOME_ENABLED` is off unless explicitly enabled. While off, the tool is absent from `tools/list` and /manifest.json, its resource is unlisted and unreadable, and cached calls refuse without reading home data. Manifest generation disables it for the checked-in production snapshot. No migration or dependency is added.

While enabled, LetterHomeCard.html@v72 is an MCP App resource. The tool declares _meta.ui.resourceUri and _meta["openai/ui"].entrypoints: [{type: "global"}]. Other clients can call it as a read-only tool. The host uses its default navigation icon: SDK 1.29's high-level `registerTool` does not emit top-level `icons`. This change does not modify SDK internals.

Source: [official Plugin Extensions documentation](https://developers.openai.com/plugins/build/extensions). Declaring an entrypoint does not establish that it appears in the owner's development connection. HOME-01 requires the owner's eyes before that is reported as working.

The published privacy policy covers recipient names, addresses and connected AI interfaces. This slice adds no collection, street-address disclosure or retention schedule. Review this scope against the website's published policy before enabling it live. This PR neither changes policy wording nor enables the flag anywhere.

## Remaining slices

- Rich-form pickers with capability detection and fallback. OpenAI-registered servers require multi-round-trip requests (`MRTR`); preserve existing tools until supported.
- Conversation panel after home/context host acceptance, as the plan requires.
- Custom entrypoint icon when the SDK exposes it.

## See Also

- [Tool APIs](tool-apis.md)
- [UI Widgets](ui-widgets.md)
- [Manual tests](manual-tests.md), HOME-01
- [Privacy policy](privacy-policy.md)
- [Letter creator vision](letter-creator-vision.md)
