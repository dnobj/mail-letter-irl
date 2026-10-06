# Plugin Extensions Plan

**Last Updated:** October 5, 2026
**Status:** In progress: the home is built (behind its flag); host acceptance, the panel and rich forms wait; the card work alongside is built but for custom stationery
**Purpose:** What Letter IRL builds with ChatGPT Plugin Extensions, in what order, and what each slice waits for (#652, epic #537, concepts 7 and 12 of [the vision](letter-creator-vision.md))

---

## Where it stands

| Slice | State | Issue |
|---|---|---|
| Letter IRL home (sidebar app, `{ type: "global" }` entrypoint) | Built, behind `LETTER_IRL_HOME_ENABLED`; host acceptance (HOME-01) waits for the owner | #639, #640 |
| Selection shared with the conversation (Model-App Context) | Built: the home on a click; the letter card by itself (#650) | #641, #642, #650 |
| Cancel scheduled mail from the home, with confirmation | Built | #642 |
| Deep links to a draft or an order | Built | #643, #646 |
| Link checks and held mail's words | Built | #651 |
| Rich-form pickers (stationery, recipient, layout, date) | Waiting for MCP multi-round-trip requests (MRTR) in the SDK | #644 |
| Conversation panel (side-panel editor, `{ type: "thread" }`) | Waiting for the home and its context to be accepted on desktop | #645 |
| Plugin settings (return address, signature, default stationery) | Optional; duplicates the website's Settings page | none |

The design and the rollout of the home are in [letter-home.md](letter-home.md).

### Card work alongside

Not extensions, but the same epic (#537) and the same owner list of 2026-10-05:

| Change | State | Issue |
|---|---|---|
| Change a letter's words on the Words tab without room to write | Built, behind `LETTER_IRL_WORDS_EDITOR_ENABLED` (one page; words past it are refused) | #647, #655 |
| Choose how a letter travels on the Delivery tab | Built, shown while certified mail is offered, never for a gift letter | #648, #656 |
| Custom stationery designed with ChatGPT | Waiting for the owner's design decisions (what the model makes, print safety, storage, abuse) | #649 |

## What the specification says

Sources (read 2026-10-04): [the extensions guide](https://developers.openai.com/plugins/build/extensions) and the specification at `github.com/openai/mcp-extensions`, `docs/spec.md`.

- **Sidebar app (home):** a tool with `_meta.ui.resourceUri` and `_meta["openai/ui"].entrypoints: [{ type: "global" }]`. The server must accept `{}` as arguments. It opens fullscreen from ChatGPT's sidebar. The widget gets the tool's result and the host context (a deep link at `hostContext["openai/deepLink"]`); it may call `ui/update-model-context`, `ui/message` and `tools/call`.
- **Conversation panel:** the same with `{ type: "thread" }`. The person opens it beside a conversation; the server receives `{}`; each thread has its own instance and a title of its own.
- **Rich forms:** the host shows a form (`OpenAIForm`, JSON-schema-like, with `oneOf` options that can carry titles and thumbnails) and returns the answer to the tool.
- **Model-App Context:** `ui/update-model-context` replaces what the app last told the model (idempotent); a block can be marked for the assistant only.
- **Deep links:** `https://chatgpt.com/plugins/<plugin-id>/app/<tool-name>?path=<encoded>`.
- On the web, extensions are "coming soon" for Free and Go; composer mentions are desktop only.
- **Not documented:** how to test an extension, or whether a developer-mode connector shows one. The home's acceptance therefore needs the owner's eyes.

## Order and reasons

1. **The home** (done): read-only, useful on its own, and the smallest way to learn whether the host shows an entrypoint at all.
2. **Selection and deep links** (done): let "make it warmer" act on the right draft without naming it.
3. **Rich forms** next, once the SDK supports them: small, they work in any chat, and they replace options the model types. Keep today's behaviour where the host does not support forms.
4. **The conversation panel** last: it starts with `{}`, so it must find the latest preview itself, and its Warmer and Shorter buttons can only ask the model through `ui/message`, which is known to post nothing in the ChatGPT native app. Build it only after the home and its context are accepted on desktop.
5. **Plugin settings** only if the owner wants them in ChatGPT as well as on the website.

Skipped: file viewers and composer mentions (no flow of ours fits them yet).

## Rules every slice keeps

- Its own flag, off in production until the owner's word.
- Every sentence about a letter switches on the letter's status; a delivery is an estimate, never "confirmed".
- Every answer that carries a letter's terms carries how it travels (#638), so a card never mixes two answers.
- What reaches the model is the least it needs (an id, a recipient's name, city and state, dates), and the privacy policy is checked before a slice is enabled live.
- Two clean review rounds for money, sending or account paths; a mutation run with every mutant killed; the studio loop's merge gate.
- Anything only ChatGPT's sidebar can show is accepted by the owner, with a manual test written for them.

## See Also

- [Letter IRL Home](letter-home.md)
- [Letter Creator Vision](letter-creator-vision.md)
- [UI Widgets](ui-widgets.md)
- [Manual tests](manual-tests.md), HOME-01
