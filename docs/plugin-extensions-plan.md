# Plugin Extensions Plan

**Last Updated:** October 6, 2026
**Status:** In progress
**Purpose:** What Letter IRL builds with ChatGPT Plugin Extensions, in what order, and what each slice waits for (#652, epic #537, concepts 7 and 12 of [the vision](letter-creator-vision.md))

---

## Overview

The home and the context it shares are built behind their flags and wait for the owner's acceptance in ChatGPT. Rich forms wait for the SDK, and the conversation panel waits for the home to be accepted. The card work from the owner's list of 2026-10-05 sits beside it: built, except custom stationery, which is being built (#649).

## Where it stands

Every slice below is off unless `LETTER_IRL_HOME_ENABLED` is on: the home is where they show.

| Slice | State | Issue |
|---|---|---|
| Letter IRL home (sidebar app, `{ type: "global" }` entrypoint) | Built, behind `LETTER_IRL_HOME_ENABLED` (on for development only); the owner's acceptance (HOME-01) waits | #639, #640 |
| Selection shared with the conversation (Model-App Context) | Built: the home on a click, the letter card by itself (#650), both only while the home is on; the owner's acceptance (HOME-02) waits | #641, #642, #650 |
| Cancel scheduled mail from the home, with confirmation | Built; also needs `LETTER_IRL_ARRIVE_BY_ENABLED` | #642 |
| Deep links to a draft or an order | Built; share links need `LETTER_IRL_CHATGPT_PLUGIN_ID`, unset until the plugin is installed, and the owner's acceptance (HOME-03) waits | #643, #646 |
| Link checks and held mail's words | Built; the privacy check before the home goes live is the owner's (item 4 of #651) | #651 |
| Entrypoint icon (20x20 monochrome SVG) | Waiting: the SDK does not expose it yet, so the home uses the default | none |
| Rich-form pickers (stationery, recipient, layout, date) | Waiting for MCP multi-round-trip requests (MRTR) in the SDK (1.32.0 still advertises 2025-11-25) | #644 |
| Conversation panel (side-panel editor, `{ type: "thread" }`) | Waiting for the home and its context to be accepted on desktop | #645 |
| Plugin settings (return address, signature, default stationery) | Optional; duplicates the website's Settings page | none |

The design and the rollout of the home are in [letter-home.md](letter-home.md). The manual tests are HOME-01, HOME-02 and HOME-03 in [manual-tests.md](manual-tests.md).

### Card work alongside

Not extensions, but the same epic (#537) and the same owner list of 2026-10-05:

| Change | State | Issue |
|---|---|---|
| Change a letter's words on the Words tab without room to write | Built, behind `LETTER_IRL_WORDS_EDITOR_ENABLED` with our renderer (`LETTER_IRL_PRINT_RENDERER=pdf`), or with room to write; one page, and words past it are refused | #647, #655 |
| Choose how a letter travels on the Delivery tab | Built: shown while certified mail is offered (off on development until the owner's Stripe test prices exist), more than one service is offered and the preview named a stationery; never for a gift letter | #648, #656 |
| Custom stationery designed with ChatGPT | Being built: parameters on the existing pieces (face, corner ornament, rules, grey), saved per account | #649 |
| Custom stationery with maximum flexibility (the model's own artwork, fonts, layouts) | Later | #657 |

## What the specification says

Sources (read 2026-10-04): [the extensions guide](https://developers.openai.com/plugins/build/extensions) and the specification at `github.com/openai/mcp-extensions`, `docs/spec.md`.

- **Sidebar app (home):** a tool with `_meta.ui.resourceUri` and `_meta["openai/ui"].entrypoints: [{ type: "global" }]`. The server must accept `{}` as arguments. It opens fullscreen from ChatGPT's sidebar. The widget gets the tool's result and the host context (a deep link at `hostContext["openai/deepLink"]`); it may call `ui/update-model-context`, `ui/message` and `tools/call`. The tool should have a title and a 20x20 monochrome SVG icon.
- **Conversation panel:** the same with `{ type: "thread" }`. The person opens it beside a conversation; the server receives `{}`; each thread has its own instance and a title of its own.
- **Rich forms:** the host shows a form (`OpenAIForm`, JSON-schema-like, with `oneOf` options that can carry titles and thumbnails) and returns the answer to the tool.
- **Model-App Context:** `ui/update-model-context` replaces what the app last told the model (idempotent); a block can be marked for the assistant only.
- **Deep links:** `https://chatgpt.com/plugins/<plugin-id>/app/<tool-name>?path=<encoded>`.
- On the web, extensions are "coming soon" for Free and Go; composer mentions are desktop only.
- **Not documented:** how to test an extension, or whether a developer-mode connector shows one. The home's acceptance therefore needs the owner's eyes.

## Order and reasons

The plan of 2026-10-04 put rich forms first, as the smallest slice that works in any chat, and the home second. Rich forms turned out to need MRTR, which the SDK does not support yet (#644), so the home went first. It is read-only and useful on its own, and it is the smallest way to learn whether the host shows an entrypoint at all.

1. **The home** (built): drafts, recent letters with their status, scheduled mail with Cancel, and the people written to.
2. **Selection and deep links** (built): let "make it warmer" act on the right draft without naming it.
3. **Rich forms** once the SDK supports them: they replace options the model types. Keep today's behaviour where the host does not support forms.
4. **The conversation panel** last. It starts with `{}`, so it must find the latest preview itself. Its Warmer and Shorter buttons can only ask the model through `ui/message`; in the ChatGPT native app a follow-up message from an app was seen to post nothing ([generate-image-removal-decision.md](learnings/generate-image-removal-decision.md), #645). Build it only after the home and its context are accepted on desktop.
5. **Plugin settings** only if the owner wants them in ChatGPT as well as on the website.

Skipped: file viewers and composer mentions (no flow of ours fits them yet).

## Rules every slice keeps

- Its own flag, off in production until the owner's word.
- Every sentence about a letter switches on the letter's status; a delivery is an estimate, never "confirmed".
- Every answer that carries a letter's terms carries how it travels (#638), so a card never mixes two answers.
- What reaches the model is the least it needs: ids, a recipient's name, city and state, dates, a letter's status and whether it can still be changed. The privacy policy is checked before a slice is enabled live.
- Every pull request has independent review rounds and a mutation run with every mutant killed. Money, sign-in, erasure, sending, fulfilment and migrations need two clean rounds.
- Anything only ChatGPT's sidebar can show is accepted by the owner, with a manual test written for them.

## See Also

- [Letter IRL Home](letter-home.md): the home's design, flags and rollout
- [Letter Creator Vision](letter-creator-vision.md): the epic's concepts, of which extensions are 7 and 12
- [UI Widgets](ui-widgets.md): the cards, including the letter card's Style, Words and Delivery tabs
- [Manual tests](manual-tests.md): HOME-01, HOME-02 and HOME-03
