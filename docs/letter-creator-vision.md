# Letter Creator Vision

**Last Updated:** October 3, 2026
**Status:** Draft
**Purpose:** Where letter and postcard creation goes next: the goal, the principles, every concept, the interactive demos, and the order we build in

---

## Overview

Letter IRL creates mail through conversation. Today the result is deliberately narrow:
- three one-page letter layouts;
- one 6x9 postcard layout;
- a read-only preview card;
- a printed page that does not match its preview.

This document sets the goal for what creation becomes: a **mail studio**. The conversation writes the words; the person, or an agent acting for them, shapes the paper, the date and the delivery; and what they preview is exactly what prints.

It came out of a research and design session on 2026-09-30, which drew on:
- a map of how letters are generated in the codebase (origin/dev 472454a);
- the OpenAI DevDay announcements of 2026-09-29;
- a survey of about 25 comparable card and mail products;
- PostGrid's full print and mail API.

**Interactive demos and concept boards:** [Letter IRL Concepts canvas](https://claude.ai/artifact/D5ex9zY2whS8oDLxqgJjzB). It is private to the owner until shared from its Share menu. Its two pages are listed in [The Demos](#the-demos).

**Being built before launch:**

| Issue | What | Why first |
|-------|------|-----------|
| [#534](https://github.com/dnobj/mail-letter-irl/issues/534) | Our own print renderer: the paper matches the preview | Fixes #526 and is the foundation for every visual concept |
| [#535](https://github.com/dnobj/mail-letter-irl/issues/535) | Arrive-by: schedule mail to arrive by a date, cancel free until it mails | The most story for the least risk; built on the existing outbox |
| [website #47](https://github.com/dnobj/mail-letter-irl-website/issues/47) | The website half of arrive-by | The confirm page and dashboard must show and cancel scheduled mail |

---

## The Goal

> **Anyone, or any agent, can get a beautiful, personal piece of paper into a U.S. mailbox by the day it matters, and it looks exactly like what they approved.**

Three themes carry it:

| Theme | Question it answers | Concepts |
|-------|--------------------|----------|
| **Make it beautiful** | What lands in the mailbox? | 1-5 |
| **Make it playful** | Can I shape it without re-prompting? | 6-8 |
| **Make it effortless** | Can you take the hard parts of mailing away? | 9-13 |

---

## Principles

These rules apply to every concept below. A design that breaks one needs an explicit decision.

1. **The preview is the print.** One layout drives both the PDF sent to the printer and the preview the person sees ([#534](https://github.com/dnobj/mail-letter-irl/issues/534)). No second template kept alike by hand.
2. **Every card control is a tool argument first.**
   - The card is a shortcut, never the only way.
   - Stationery, ink, signature, arrival date, postcard size, layout and caption are arguments on the preview tools, and the card calls the same tools.
   - An agent with no card, such as Claude Code, Codex or a personal access token, can do everything a person can do on the card. See [Every Client and Agent](#every-client-and-agent).
3. **The confirm page is the card for card-less clients.** Where no card shows, the person sends from `letterirl.com/confirm/<draftId>`, so that page shows the same rendered preview, date and cost.
4. **The server remembers the person's choices.** Changes made on a card don't always reach the model (#366), so the most recent stationery, ink and signature become defaults for the next preview. A rewrite never silently resets the style.
5. **Honest delivery language.** USPS does not guarantee First-Class dates. We say "aims to arrive by", show the mail date, and let the person cancel free until the letter mails.
6. **Agent-legible, never agent-persuasive.**
   - Tool text says when to use a tool, when not to, what it costs, how long it takes and what it returns.
   - It never tries to win selection over other tools, which OpenAI's plugin guidelines forbid. See [Agents](#agents).
7. **The send rule holds, for now.**
   - Mail is sent by the person: the card's Send button, or the confirmation link (#470).
   - Standing permissions for agents are the planned evolution. See [Agents](#agents).
8. **Gifts work everywhere.** Every concept states how a gift send (a free gift letter that prints a QR card) behaves. See [Gift Sends](#gift-sends).

---

## Where We Are

State at origin/dev 472454a (2026-09-30):

| Area | Today |
|------|-------|
| Letter layouts | `text_only`, `header_image`, `inline_image`. One page only; a gift adds page 2 |
| Letter limits | 1,600 / 1,100 / 800 characters; hard limits of 26 / 17 / 14 lines (soft 24 / 17 / 12); estimated at 65 characters a line (`src/services/previewService.ts:21-58`) |
| Postcards | 6x9 only, one full-bleed layout, and the message uses the left half of the back. The 4x6 and 11x6 sizes have code paths (`'6x4'` and `'6x11'` in `PostcardSize`; PostGrid's `6x4` and `11x6`), but the schema enum admits only `6x9` |
| Typeface | PostGrid prints all mail in **Open Sans**; the preview is serif (#526). Emoji and several scripts are refused at preview (#528, #533) |
| Print vs preview | Two separate templates: print HTML in `src/services/providers/PostGridProvider.ts:526-684`, preview HTML in `src/services/previewService.ts:280-452` |
| Preview card | Read-only. It shows a mockup rebuilt from `previewHtml`, and every edit goes back through the chat |
| Delivery | "Mailed in 1-2 business days; usually arrives in 1-2 weeks" (`src/content/delivery.ts`). No scheduling and no cancel |
| PostGrid options unused | `sendDate`, `pdf`, `perforatedPage`, `returnEnvelope`, mail classes (certified, express), `mergeVariables`/templates, premium paper, self-mailers. `doubleSided` is sent: `true` exactly when a letter runs past one page (#586) |
| Unused design work | `example_layouts/` holds static prototypes (standard, modern, formal, personal, header-image and postcard variants) that `src` never references |

---

## The Demos

The [Letter IRL Concepts canvas](https://claude.ai/artifact/D5ex9zY2whS8oDLxqgJjzB) has two pages.

### Interactive demos (press Play on each)

| Demo | What you can do | Concepts |
|------|-----------------|----------|
| **Demo 1: letter studio card** | The inline card, end to end. **Style tab:** switch between five stationery themes, three inks and a signature. **Words tab:** edit the letter, and a fit meter grows it onto the back instead of refusing. **Delivery tab:** "arrive by Ruth's birthday" and certified mail. **Send:** the letter folds into its envelope, then a timeline with "Cancel: free until it prints" | 1, 2, 3, 6, 8, 9 |
| **Demo 2: side-panel editor** | Chat on the left, the letter in a panel on the right. Tap a paragraph for Warmer, Shorter, Funnier, Original or Move to P.S. Each change is echoed in the chat, and Undo works. **Envelope tab:** what the recipient sees through the windows. **When tab:** an October calendar that computes the mail date | 7, 9 |
| **Demo 3: postcard maker** | Three sizes drawn to scale and five layouts. Edit the caption, the "Greetings from" place and the message, with a per-size character count. A 3D flip to the back, and a premium gloss option | 4 |
| **Demo 4: address request** | The chat card and the recipient's phone side by side. Text the link, the recipient fills in her address, and the letter becomes ready, or she taps "No thanks" | 10 |

### Concept boards

| Board | Shows |
|-------|-------|
| Concept map | All 13 concepts with Now, Next or Later, and the DevDay signals |
| 1-3 · Stationery collection | Six themes on real 8.5x11 proportions, with the envelope window marked: Classic, Monogram, Botanical, Typewriter, Celebration, Handwritten |
| 4 · Postcard layouts and sizes | Full bleed, border and caption, collages of three and four, "Greetings from", an 11x6 panorama, today's back versus a reimagined back |
| 5 · Keepsake formats | Tear-off keepsake, reply kit, folded card, important (certified) letter, holiday batch |
| 6 · Studio card | An earlier static-plus-interactive version of Demo 1 |
| 7 · Side-panel editor | A static version of Demo 2 |
| 9-13 · Effortless flows | Phone screens: address request, arrive-by card, delivery moments, sign together |

---

## The Concepts

Each concept lists what PostGrid supports and how it reaches clients without cards. "Pre-launch", "Next" and "Later" are the build order in [Roadmap](#roadmap).

### Make it beautiful

#### 1. Stationery collection
- **What:** themes that restyle the whole letter.
  - Classic (serif, black and white, the default), Monogram (initials in the top corner), Botanical (line-drawn sprigs), Typewriter (monospace on a warm tint), Celebration (an occasion headline and confetti), Handwritten (a handwriting face on faint rules).
  - Each theme has a date line, greeting, sign-off and signature slot.
  - The unused top-right corner beside the envelope window holds the date and monogram.
- **Why:** it is the first thing people see and the easiest delight. It borrows from Letterbird, Paperless Post and Minted.
- **PostGrid:** only layout and fonts, which need #534. Colour themes print with `color: true` (about 35¢ more).
- **Card-less clients:** a `stationery` argument on the preview tools, as an enum whose descriptions say when to use each theme.
- **Settled by probe P12 (2026-10-01):** the top-right corner, 4.0-8.0 in across and 0.35-2.85 in down, stays clear of PostGrid's address stamp. Lines of 0.5 pt and up, and greys from #222 to #aaa, survive its flattening. See `learnings/postgrid-pdf-rendering.md`.
- **Stage:** Next, as #563. Classic, Monogram, Botanical and Celebration are drawn by the renderer in Tinos, in black and greys; Typewriter and Handwritten set the letter in Cousine and Caveat (#563 PR 8).

#### 2. Room to write
- **What:** letters of two or three pages, printed double-sided.
- **Why:** the one-page cap causes most refusals and retries today.
- **PostGrid:** extra pages cost about $0.10 (black and white) or $0.20 (colour) each, and `doubleSided` exists. Six or more pages switch to a flat envelope at about $5.50 extra postage.
- **Card-less clients:** no argument needed. Length decides the page count, and the result reports it.
- **Open:** pricing per extra page (see [Open Decisions](#open-decisions)).
- **Stage:** Next.

#### 3. Your signature, your hand
- **What:** photograph your signature once and reuse it; optionally a handwriting typeface for the body.
- **Why:** it makes the letter feel personal. It borrows from Hallmark Sign & Send, Ink Cards and Thankster.
- **PostGrid:** an image in the layout.
- **Card-less clients:** a `signature` argument that uses the saved one. Capture needs an upload, which is weak outside ChatGPT (the MCP Apps standard has no upload).
- **Stage:** Later, built as #608 behind `LETTER_IRL_SIGNATURES_ENABLED`, on in development: saving (`set_signature`), the renderer's band, previews and prints (`pdf-4`), `set_letter_signature` and the card's Signature switch, and the website's Settings page to draw or upload one, for apps without an upload. The handwriting face is #563's Handwritten stationery. Still open: refusing light ink on a dark sheet (#611), a smaller copy for the card's page (#614), and the privacy wording, which is the owner's before production.

#### 4. Postcard layouts and sizes
- **What:**
  - Layouts: full bleed, white border with a caption, a collage of three, a grid of four, "Greetings from" lettering, and a roomier back with a handwriting face.
  - Sizes as tiers: **4x6 quick note** (PostGrid about $0.90), **6x9 postcard** (today, about $1.02) and **11x6 big postcard** (about $1.29).
- **Why:** postcards are the fastest thing to send. It borrows from Touchnote, Postagram and Alpic's "Send Postcard" ChatGPT app.
- **PostGrid:** all three sizes. 120lb gloss, UV and satin stock need PostGrid to enable premium paper, which the Starter tier doesn't include.
- **Card-less clients:** `size`, `layout` and `caption` arguments, and an image-link array for collages.
- **Stage:** Next for sizes and single-photo layouts. Collages are built as #616 behind `LETTER_IRL_POSTCARD_COLLAGES_ENABLED`: the compositor draws two to four photos as one front, and the postcard preview takes them as `images` or `imageUrls`. Whether ChatGPT hands over several attachments at once is still to be probed on development.

#### 5. Keepsake formats
- **What:**
  - **Tear-off keepsake:** a photo or "one free hug" coupon perforated off page 1 (`perforatedPage: 1`, the bottom 3.6in).
  - **Reply kit:** a pre-addressed return envelope for grandparents and pen pals (`returnEnvelope`; the envelopes are ordered ahead).
  - **Folded card:** an 8.5x11 bifold self-mailer, enabled by PostGrid on request.
  - **Important letter:** certified, optionally with a return receipt (about $6.94 or $9.85).
  - **Holiday batch:** one letter to a list with a personal line each (templates and `mergeVariables`).
  - **Scan-to-hear:** a printed QR code that plays a voice note. This needs media hosting and a retention policy.
- **Not in PostGrid:** folded 5x7 greeting cards in envelopes, robot-pen ink, real stamps, gift cards, foil. These would need a second vendor, such as Thanks.io notecards or Handwrytten, both of which have APIs.
- **Stage:** Later.

### Make it playful

#### 6. Studio card
- **What:** the preview card becomes where the paper is shaped. Tabs for Style, Words and Delivery; a fit meter instead of refusals; Send becomes Schedule when a date is set; an envelope animation; a timeline with Cancel after sending.
- **Why:** today every change costs a round trip through the model.
- **How:**
  - Controls call the preview tools, or a small `update_draft` tool, through the MCP Apps bridge, which works in ChatGPT, Claude and VS Code.
  - Choices reach the model with `ui/update-model-context` where the host supports it, and through server-side defaults everywhere (Principle 4).
  - Tabs keep the card short, which matters wherever a host limits a card's height; measure Claude's limit before designing them.
- **Stage:** its Delivery tab ships with #535 (Pre-launch); the Style tab follows #534 (Next); the Words tab is Next.

#### 7. Side-panel editor
- **What:** the letter lives in a panel beside the chat.
  - Tap a paragraph for Warmer, Shorter, Funnier, Original or Move to P.S.
  - Tabs for the letter, the envelope and the date.
- **Why:** the conversation handles intent; the panel handles precision.
- **Platform:** DevDay 2026's **Plugin Extensions** (thread side panels). ChatGPT only; web availability for Free and Go users is "coming soon". Other hosts fall back to the inline studio card.
- **Stage:** Later. Nothing depends on it.

#### 8. Envelope reveal
- **What:** preview and confirmation open like real mail. The envelope with its windows, then the letter slides out, and it folds in on send.
- **Why:** Paperless Post's best moment; it makes the send feel physical.
- **Stage:** Next. It is card and website CSS only.

### Make it effortless

#### 9. Arrive-by dates
- **What:** "Get this there by Mom's birthday."
  - We work back to a mail date and hold the letter in our outbox until then.
  - It can be cancelled free until it mails, and the letter returns to the balance.
- **Design:** [#535](https://github.com/dnobj/mail-letter-irl/issues/535). It is held in `letter_jobs`, **not** PostGrid's `sendDate`, for the four reasons given there.
- **Card-less clients:** an `arriveBy` argument, plus the `set_arrival_date` and `cancel_scheduled_mail` tools. Agents gain the most.
- **Stage:** **Pre-launch.**

#### 10. Address request link
- **What:** "I don't have Ruth's new address." Letter IRL makes a private link; the sender shares it however they reach Ruth; she types her address or taps "No thanks". The letter waits.
- **Rules:**
  - Letter IRL never texts or emails the recipient itself.
  - The link works once and expires.
  - The page shows only the sender's first name.
  - Retention wording is an owner decision.
- **Why:** finding the address is the hardest part of sending from a chat. It borrows from Postable and Sendoso.
- **Card-less clients:** a `request_address` tool that returns the link. An agent can obtain an address this way without ever holding one it wasn't given.
- **Stage:** Next.

#### 11. Delivery moments
- **What:** "Your letter to Ruth is out for delivery in Tucson today," back in the conversation, with an offer to send a follow-up.
- **Platform:** PostGrid webhooks (`letter.updated`) and USPS barcode events, which arrive 5-7 days after handoff, relayed through DevDay 2026's **MCP Events**. That needs MCP protocol 2026-07-28 (#477), and signed webhooks, not yet filed as an issue (#178 researches delivery-status promises).
- **Stage:** Later.

#### 12. Letter IRL home
- **What:** a sidebar home (Plugin Extensions `global` entrypoint) with drafts, the people you write to, their dates and your orders.
- **Stage:** Later.

#### 13. Sign together, send to many
- **What:** a group letter that others sign by link, with no account (GroupGreeting, Kudoboard), and a holiday batch.
- **Note:** bulk mail was out of scope for spam reasons ([future-roadmap.md](future-roadmap.md)). A batch needs the abuse controls described there.
- **Stage:** Later.

---

## Every Client and Agent

| Client | Cards | Where the person sends | Notes |
|--------|-------|------------------------|-------|
| ChatGPT (web, mobile, desktop) | Yes, plus panels (concept 7) when available | The card's Send button | `widgetState` restores a reopened card (#389) |
| Claude web | Yes, through the MCP Apps bridge (#474) | The card | Cards get `_meta`; app-only tools are hidden from the model and callable by the card. No `widgetState` |
| VS Code | Yes, inline | The confirmation page, opened from the card: VS Code isn't yet trusted with card-only tools (`TRUSTS_NOTHING` in `src/auth/clientProfiles.ts`) | `ui/message` should fill the input without sending; unverified, since the VS Code card step (CLIENT-03) hasn't run |
| Claude Code, Codex, other agents, personal access tokens | No | The confirmation link (`request_send`) | The model reads `structuredContent`; everything goes through tool arguments and results |

What keeps them equal: Principles 2-4. The renderer (#534) is server-side, so every client benefits from it equally. Uploads (signature capture, collages) are the one area where clients without ChatGPT's file APIs stay weaker. Image links are the portable path.

---

## Gift Sends

A gift send (`sendAsGift`) is funded by a free gift letter (each pack grants one) and prints a QR gift card: page 2 of a letter, or a strip on a postcard's back, which cuts the message to 350 characters on the legacy print and to 11 lines on our renderer (#534). Pay & Send is refused for gifts. See [gift-letters.md](gift-letters.md). Gift letters are on in development and off in production; open gift launch blockers are #432, #433, #435 and #487.

| Concept | Gift behaviour |
|---------|----------------|
| Renderer (#534) | The gift page and strip move into the same renderer: the letter's typeface, and a vector QR code |
| Stationery | Works with every theme and letter layout. The gift card keeps Letter IRL's design in the theme's typeface and ink |
| Arrive-by (#535) | Supported. Cancelling returns the gift letter; the gift code's 90-day expiry counts from the mail date |
| Postcard sizes | Gift postcards are 6x9 or 11x6 only: the strip does not fit a 4x6 back |
| Paid extras | Proposed: colour is included; extra pages are charged from the balance (refused clearly if it can't pay); no certified mail on gifts |
| Double-sided letters | The gift card may print on the back of the last page ("turn over for your gift"). Decide with concept 2 |

---

## Agents

The owner expects agents to be Letter IRL's largest users. DevDay 2026 introduced **dots**: always-on ChatGPT agents that run scheduled tasks and call plugins. Business agents (CRMs, property managers) are the volume.

### Copy for agents
- **Where the model reads it** (tool names, descriptions, schemas, server instructions): state the job ("Use this when a letter must physically reach a U.S. address by a date"), when not to use it, the cost, delivery time, limits and side effects.
- **What OpenAI's plugin guidelines forbid:**
  - text that attempts "to influence the model to select them over another plugin's tools";
  - "overly broad triggering";
  - promotional names such as `best` or `official`.
- **Where agents research** (the website, `llms.txt`, a machine-readable pricing and capabilities page): factual comparison is welcome.
- **For people** (ads, the directory listing): "give your agent a mailbox".
- **Measure it** with the submission's positive and negative test cases, plus agent-phrased prompts.

### From "the person presses Send" to "the person authorizes"
The send rule (#470) is right for launch. Its evolution is **standing permissions**, set by the person on letterirl.com:
- **who:** the address book, or an approved list;
- **how much:** a monthly cap and a daily limit;
- **what:** templates only, or free text;
- **a cancel window:** agent sends are held and announced, and can be cancelled free (the #535 machinery);
- **per connection:** an audit log and revoke.

The `mail:send` scope already exists. OAuth clients (ChatGPT, Claude, the website) are granted it, and it gates the send and checkout tools (`src/auth/toolScopes.ts`). Personal access tokens never carry it today (migration 037, #470). Standing permissions would let a person grant sending to an agent's token within these limits.

---

## Roadmap

| Stage | Items |
|-------|-------|
| **Pre-launch** | #534 renderer (probe prints first); #535 arrive-by; website #47; studio card Delivery tab (part of #535) |
| **Next** (after launch) | Stationery collection (1) and studio card Style tab (6); room to write (2) and the Words tab; postcard sizes and single-photo layouts (4); envelope reveal (8); address request (10); server-remembered choices (Principle 4) |
| **Later** | Signature capture (3; built as #608, on in development); collages (4); keepsake formats (5); side panel (7); delivery moments via MCP Events (11); home (12); group letters and batch (13); standing agent permissions; a second vendor for folded cards or robot-pen ink |

---

## Open Decisions

| # | Decision | Recommendation | Where |
|---|----------|----------------|-------|
| 1 | Print typeface | Tinos (metric-compatible with Times New Roman) | #534 |
| 2 | Scripts at launch | What the chosen font covers; emoji and CJK later | #534 |
| 3 | Postcards on the new renderer before launch? | If time allows; otherwise flag the back's Open Sans | #534 |
| 4 | Scheduling horizon | 60 days | #535 |
| 5 | Lead time | 7 business days, calibrated from production data | #535 |
| 6 | Cancelling a scheduled Pay & Send letter | Support email for launch (refunds are decided by a person) | #535 |
| 7 | Can the model cancel scheduled mail? | Yes, with `confirm: true` | #535 |
| 8 | Scheduled mail when an account is erased | Erasure cancels it | #535 |
| 9 | Price of extra pages, big postcards, gloss, certified | Owner's pricing call; touches the pack model (#308) | Concepts 2, 4, 5 |
| 10 | Address-request retention wording | Owner's call, with the privacy policy's upper-limit rule | Concept 10 |
| 11 | PostGrid enablement: premium paper, self-mailers | Ask PostGrid sales | Concepts 4, 5 |

---

## Research Notes

### DevDay 2026 (2026-09-29)

| Announcement | Relevance |
|--------------|-----------|
| Plugin Extensions: sidebar home, thread side panels, file viewers, plugin settings | Concepts 7 and 12 |
| Rich forms: native image pickers and address forms in elicitation | Could simplify `upload_image` and address entry |
| MCP Events: signed webhooks into the conversation (protocol 2026-07-28) | Concept 11 |
| Dots: always-on agents calling plugins | The [Agents](#agents) section |
| Commerce unchanged: in-chat checkout for select marketplaces only; guidelines forbid selling "credits" and linking straight to checkout | A submission risk for the pack model: #476, #308 |
| Apps renamed to plugins (July 2026); a new submission flow | #476, #407 |

### Comparable products worth borrowing from
- **Postable:** a recipient-filled address book.
- **Punkpost:** priced add-ons, scheduled up to a year ahead.
- **Touchnote:** collages and captions.
- **Hallmark Sign & Send:** scanning your own handwriting.
- **Paperless Post:** the envelope opening.
- **Thanks.io and Handwrytten:** APIs, and MCP servers, for folded cards and robot-pen ink.
- **Alpic's "Send Postcard":** a ChatGPT app where you refine the postcard region by region, the closest competitor.

### PostGrid capability summary

| Capability | PostGrid | Used today |
|------------|----------|------------|
| HTML, PDF or template content | Yes | HTML only |
| Colour, double-sided | Yes | Colour for image letters only; never double-sided |
| `sendDate` scheduling, cancel while `ready` | Yes | No (#535 holds in our outbox instead) |
| Perforated page 1, return envelope | Yes | No |
| Certified, registered, express | Yes | No |
| Postcards 4x6, 6x9, 11x6 | Yes | 6x9 only |
| Premium paper, self-mailers | On request | No |
| Folded greeting cards, photo prints, robot pen | No | Would need another vendor |

---

## See Also

- [future-roadmap.md](future-roadmap.md) - out-of-scope features and plans
- [letter-send-flow.md](letter-send-flow.md) - how drafts, credits and jobs work today, and the send rule
- [gift-letters.md](gift-letters.md) - gift letter design
- [image-support.md](image-support.md) - today's layouts and image handling
- [ui-widgets.md](ui-widgets.md) - the preview cards
- [learnings/layout-options-research.md](learnings/layout-options-research.md) - earlier layout research
- [business-overview.md](business-overview.md) - users, model, goals

## Changelog

| Date | Change |
|------|--------|
| 2026-09-30 | Initial version from the concept and demo session; #534, #535 and website #47 filed |
| 2026-10-01 | Stationery: probe P12 settles the top-right corner; #563 filed |
| 2026-10-03 | Signature: #608 saved, printed, switched on the card and set on the website; #611 and #614 filed |
