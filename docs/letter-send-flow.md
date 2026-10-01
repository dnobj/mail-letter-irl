# Letter and Postcard Send Flow

**Last Updated:** October 1, 2026
**Purpose:** Draft, payment, outbox, and provider workflow for letters and postcards

This document describes the current draft, payment, outbox, and provider workflow for letters and postcards.

## Preview

Preview tools validate the user's input, render the appropriate widget, and create a 24-hour database draft. Previewing does not deduct a letter send and does not create a provider order.

| Tool | Layout | Text limit |
| --- | --- | --- |
| `quote_and_preview_letter` | text only | 1,600 characters / 24 lines |
| `quote_and_preview_letter_with_header_image` | image at top | 1,100 characters / 15 lines (the legacy HTML takes 17) |
| `quote_and_preview_letter_with_image` | image after signature | 800 characters / 12 lines |
| `quote_and_preview_postcard` | image front, message back | postcard-specific message limit |

Every preview tool also refuses characters the print can't show (#526). PostGrid prints all our mail
in Open Sans, whatever font the HTML names, and prints a character the font lacks as an empty box.
So the text and both addresses may hold:
- Latin letters with the accents of European languages and Vietnamese;
- modern Greek, Cyrillic and Hebrew letters;
- common punctuation, € and ™;
- the signs ₪ ₫ № ℓ ℮ ℅ ℠ and ◊, the maths signs − ∂ ∆ ∏ ∑ √ ∞ ∫ ≈ ≠ ≤ ≥, the fractions ⅛ ⅜ ⅝ ⅞,
  the ligatures ﬀ to ﬄ, and superscript and subscript digits.

Emoji, every other script, and anything that neither a test print nor the shipped font's glyph
list shows are refused. Examples are arrows, stars, check marks, the hyphen and non-breaking hyphen,
and polytonic Greek's breathings, circumflex and iota subscript. The glyph list is
`sources/OpenSans-glyphset.txt` in googlefonts/opensans, which its build subsets every shipped font
to, not the larger design master.

A character the font lacks still prints when its canonical decomposition is made of characters that
print. The renderer draws the parts, so pinyin tone letters and the letters with a dot above or
below are allowed. The narrow no-break space prints as a space. The coverage probe of 2026-09-30
showed both (#526). `src/services/printableText.ts` holds the ranges. Widen them only on that
evidence.

The refusal names each character and where it is. Invisible characters get a name and code point,
and a character that may look like one that prints gets its code point. It comes before PostGrid
checks the addresses, before any picture is downloaded, and before a draft is made.

The preview response includes a `draftId`. Sending is a separate, explicit tool call requiring `confirm: true`.

## Who Can Send: the Send Rule (#470)

With `LETTER_IRL_SEND_CONFIRMATION_ENABLED` on, only the person can finish a
send. The model can't, in any app. There are three ways to send:

- **The card's Send button.** `send_letter` and `send_postcard` are card-only:
  - They carry `_meta.ui.visibility: ["app"]` and `openai/visibility: "private"`, so an app that honours them keeps the tools away from its model.
  - They also carry `anthropic/requiresUserInteraction: true`. Claude Code's MCP documentation describes this as prompting before every call. It is a hint only: Claude Code is protected by its profile, which gets the link.
  - They stay callable by the card, which sends when the person presses Send.
- **A confirmation link.** `request_send` returns `<website>/confirm/<draftId>`:
  - There the person, signed in, sees the preview and the cost, and presses Send.
  - Nothing is sent by the tool. It is read-only and needs only `mail:draft`.
  - Its link text says nothing is sent until the person presses Send.
- **The card's Pay & Send button, in ChatGPT only.** `create_mail_checkout` is card-only too (#475): the person sees the card, and the mail is sent when they pay. It was model-callable in ChatGPT until launch. But Codex also reaches Letter IRL through ChatGPT's own connection, where the server sees ChatGPT and no card shows the preview, and the server cannot tell the two apart. It is listed only for an app that takes purchases (the profile's `inAppPurchases`, ChatGPT today), where the card is its only caller. The server also answers it with the link, not a checkout, from any app that takes no purchases, shows no card, or can't keep card-only tools from its model. No app reaches that answer today: it guards a future profile.

**Where the rule is enforced.** Hiding a tool is the app's side of the rule. The
server enforces its own side by the calling app's profile
(`src/auth/clientProfiles.ts`, #473):
- **Apps that honour card-only tools** (ChatGPT, and Claude since CLIENT-01
  step 11 showed its model does not have them, #474): a send tool call sends as
  before.
- **Every other caller:** a personal access token, an app with no card, or an
  app we do not know. A send tool call, and a Pay & Send call from an app that
  may not take a purchase:
  - sends nothing;
  - is authorized as `request_send` is, so a read-and-draft token gets the link
    and not a scope error;
  - answers with an error result carrying the link. A preview card that gets
    this answer to its own Send offers the page in place of Send
    ([ui-widgets.md](ui-widgets.md)).

**Model-facing text.** While the rule is on:
- every preview's text ends with how the person sends it, including the draft
  id. Where our card shows, it points to the card's Send button, or in ChatGPT
  to its Pay & Send button when the card offers that instead (the balance
  can't pay and Pay & Send is on); elsewhere, to `request_send`;
- the four preview tools' descriptions end the same way, without the draft id:
  the card's Send where our card shows, `request_send`'s link elsewhere. They no
  longer name `send_letter` or `send_postcard`. Claude Code's model sees
  neither: it hides card-only tools, and the server still registers both and
  answers a call with the link. That model reads the descriptions but not the
  preview's text (#516);
- where a send tool call answers with the link (every app without
  `honorsCardOnlyTools`), `send_letter`'s and `send_postcard`'s own
  descriptions say a call sends nothing and name `request_send`. ChatGPT and
  Claude keep these tools from the model, and their text is unchanged (#516,
  steering r20);
- the server instructions say the model cannot send, and that the card or the
  page offers another copy of mail sent recently. They name no checkout to
  repeat, since the model cannot start Pay & Send;
- `create_pack_checkout`'s description points to the card's Pay & Send for
  paying for one draft. Buying a pack sends nothing, so the model may still
  start one.

**The confirmation page's API** is `GET` and `POST` `/api/sends/:draftId`
(`src/api/sendConfirmationApiHandler.ts`). It accepts only a token issued to the
website's own Auth0 application (`LETTER_IRL_WEBSITE_CLIENT_ID`). REST accepts
the MCP audience, so without that check a local agent could read its own token
and press Send itself. The check holds only while the website's application
can get tokens by nothing but a person signing in: it must stay a confidential
client with the `authorization_code` and `refresh_token` grants alone (see
[auth0-tenant-configuration.md](auth0-tenant-configuration.md)). A change to its
grants is a change to the send rule. The `POST`:
- runs the same service as the tools, below, so every check applies;
- rewords the service's refusals for the page.

**Rollout.** The rule is off by default. It is turned on once:
- the website's confirmation page is live (website #39);
- the ChatGPT DEV regression pass has run with it on. It includes asking the model to send a preview: it must point to the card's Send button, or give the link, and never reach `send_letter` itself. Since #475 it also includes asking it to pay for one: it must point to the card's Pay & Send, and never reach `create_mail_checkout`, while the card's button still opens a checkout;
- the development log shows ChatGPT's tokens resolving to the `chatgpt` profile.

**Where it stands.**
- **Development:** on since 2026-09-25, with all three conditions met. SEND-01 passed there ([manual-tests.md](manual-tests.md)).
- **Production:** off. It goes on with the promotion that carries #479, #480, #481 and website #41, and needs:
  - `LETTER_IRL_WEBSITE_CLIENT_ID`, the production website's client id;
  - the production connector refreshed;
  - a production send from the card and from the page.

A Pay & Send checkout opened before the switch still mails when the person
pays, for as long as the checkout lasts: at most the draft's 24 hours. The
person's own payment for that exact mail is the trigger, so this is expected,
not a gap.

## Confirmed Send Transaction

`send_letter` and `send_postcard` call the same atomic service. Inside one PostgreSQL transaction the service:

1. selects the draft `FOR UPDATE`;
2. validates ownership, mail type, state, and expiry, and for a draft with an arrival date that its mail date has not passed (below);
3. returns the existing order if the draft was already consumed;
4. inserts the Letter IRL order;
5. locks and deducts prepaid sends from the user's ledger, or, for a draft previewed as a gift send, uses one gift letter under the same account lock and decides its card ([Gift Letters](gift-letters.md));
6. checks the daily caps (and, for a gift send, the daily gift budget), then refuses the same mail sent recently (below), unless the caller asked for another copy;
7. marks the draft consumed and links it to the order;
8. inserts one `letter_jobs` outbox row, due at once, or for held mail at 09:00 New York time on its mail date;
9. commits.

Any error rolls back every effect. An insufficient balance therefore creates no order, consumes no draft, inserts no job, and deducts no sends.

Database constraints enforce one outbox row and one stable idempotency key per letter. Concurrent calls serialize on the draft lock, so the second call returns the first order.

**Held mail (#535).** A draft can carry the date its mail should arrive by and the date it goes to the printer (`arrive_by` and `mail_on`, migration 040). The mail date is worked back from the arrival date by a lead time of business days, by `src/services/deliverySchedule.ts`.
- **The preview sets them**, from the four preview tools' optional `arriveBy` (YYYY-MM-DD, `src/tools/arriveByInput.ts`).
  - **Only while `LETTER_IRL_ARRIVE_BY_ENABLED` is on:** the served schemas, and `/manifest.json`, include `arriveBy` only then (`getServedInputSchema`, read at each registration).
    - While the flag is off, the four previews are served as objects that pass unknown fields through, not the SDK's default strip. So an app that cached the field and passes it anyway reaches the preview, which refuses it ("Arrival dates are not available yet…") instead of mailing at once.
    - An empty `arriveBy` counts as none.
  - **Checked first**, before any picture is fetched or address validated, against the lead time (`LETTER_IRL_SCHEDULE_LEAD_DAYS`, default 7 business days; development may set 0, production refuses less than 3) and the horizon (`LETTER_IRL_SCHEDULE_HORIZON_DAYS`, default 60 days).
  - **A date it cannot meet** is refused with the dates on offer: "The earliest this can arrive is Tue, Oct 13 (2026-10-13)…", "The latest arrival date on offer is…", "arriveBy must be a date written YYYY-MM-DD…", or "Arrival dates cannot be scheduled right now…".
  - **A held preview's output** carries `schedule` (`arriveBy`, `mailOn`, `releasesAt`, `earliestArrival`, `latestArrival`). Its `deliveryEstimate`, which the cards show, reads "Goes to the printer Tue, Oct 6, and aims to arrive by Fri, Oct 16." The narration says it is held until then and that USPS does not guarantee First-Class dates.
- **`set_arrival_date` moves them** (`src/tools/setArrivalDate.ts`), listed only while the flag is on: it sets, moves or clears a draft's dates without previewing again.
  - **The date is checked first**, as the previews check theirs, and refused in the same words. Left out, or empty, it clears the dates, and the mail goes to the printer as soon as it is sent.
  - **One transaction** (`setDraftSchedule`, `src/services/draftService.ts`) locks the draft row first, as the send and the Pay & Send checkout lock it before they read its dates. So they run one after the other: a send or checkout that goes first leaves the change refused, and one that goes second reads the new dates.
  - **It changes only** a draft that is the caller's, pending and unexpired, with no live Pay & Send order (any status in `ACTIVE_JIT_STATUSES`, but a checkout whose window has passed). Payment sends the mail with the dates the draft has, so they do not move under it.
  - **Its refusals** say what to do next: the preview was not found, has already been sent (`list_orders` shows it), has expired (the preview tools take `arriveBy` themselves), or is tied to a Pay & Send payment.
  - **Annotations:** not read-only, not destructive (a draft sends nothing and expires on its own), and idempotent.
- **The hold:** the send copies both dates to the letter and creates its job with `next_attempt_at` at 09:00 New York time on the mail date. `scheduled_at` records the same moment, written as a timestamp without a zone in the database session's zone. Value moves at the send, as for any letter: sends, a gift letter or a paid order.
  - The claim takes a job only once `next_attempt_at` has passed. So neither the inline dispatch right after the send nor the hourly run touches it before then, and the first hourly run after 09:00 sends it to PostGrid as an ordinary order. No PostGrid `sendDate` is used.
- **A passed mail date:** today counts as a mail date until noon New York time on a business day, so a draft previewed before the cutoff and sent after it has missed its date.
  - A prepaid or gift send is then refused with `SCHEDULE_PASSED`, before anything is written: "The day this letter was to go to the printer has passed…". The person previews again with a new date.
  - A Pay & Send checkout refuses such a draft before the charge. A paid order whose date passes before fulfilment mails as soon as it can instead, logging `send.schedule_missed`, because refusing after the charge would strand the money.
- **A held gift letter** decides its card as of the moment it goes to the printer. A seed campaign that will have ended by then does not print its code, and a chain code's 90 days count from then ([Gift Letters](gift-letters.md)).
- **DATE columns** are read as 'YYYY-MM-DD' strings (`src/db/dateParser.ts`). A draft whose dates are anything else is refused rather than read as some day.

## The Same Mail Twice

Each draft is sent at most once, but two drafts can hold the same mail. On ChatGPT web a preview call approved with "Allow once" can finish late, after the preview card has made its own draft (#411). If the person sends one draft from the card and confirms the other in the chat, two identical letters are mailed and paid for (#412).

So a send from balance, and a new Pay & Send checkout, is refused when the account has the same mail from the last 24 hours (a draft's whole lifetime), unless the call passes `sendAnotherCopy: true`. The check lives in `src/services/duplicateMailService.ts`.

- **The same mail.** Every one of these matches, ignoring capitalization and runs of whitespace:
  - the kind (letter or postcard), and the letter's layout or the postcard's size;
  - the recipient's name and full address, and the return address;
  - the body and sign-off, or the postcard message;
  - the printed image, compared by the MD5 of the processed image data rather than by its link, because the two drafts can reach one picture through different links.
- **Already out.** Any of these counts:
  - mail created from the account, unless it failed or was cancelled;
  - a Pay & Send order that is paid but not yet mail;
  - a Pay & Send checkout that is still open.
- **Where it runs.**
  - For a send from balance, the check runs after the deduction, beside the daily caps. The account row is already locked there, so two sends from one account cannot both pass. A refusal rolls the send back.
  - For Pay & Send, it runs in `prepareJitOrder` as the last step before a new order is inserted, before any Stripe session exists.
    - An order handed back for the same draft is not checked again, because nothing new is bought: it is the same order at the same price. That covers an order with a Stripe session, and a sessionless one whose retry would send Stripe the same request, which gets a fresh session for the same order. It also covers an order past checkout: paid, being refunded, disputed or held.
    - A sessionless order being replaced is checked. That happens when it is too near expiry for Stripe, when it was priced before a price change (a different amount, or a different Stripe Price at the same amount), or when its return URLs have moved with their configuration (#279). A refusal also rolls back that order's cancellation.
    - This check is a best-effort net. Checkouts for two identical drafts lock different rows, so two made at the same moment can both pass.
  - Pay & Send fulfilment, which runs after the customer has paid, is never checked.
- **The refusal.** It is an MCP error result whose text starts with `Possible duplicate:`. The text tells the model what went out, when, and to ask the user before repeating the call with `sendAnotherCopy: true`. `_meta["letterirl/duplicateMail"]` carries `{kind, mailType, recipientName, ageMinutes}` for the preview cards, which say what went out and turn the button into **Send another copy** or **Pay for another copy**. On ChatGPT web a refused call reaches the card without `_meta`, so the cards recognise the refusal by its text and show a shorter notice ([ui-widgets.md](ui-widgets.md)).

## Immediate Provider Submission

After the transaction commits, the send tool claims its outbox row and submits it immediately.

A **Pay & Send** order takes a different route to the same outbox: the verified payment webhook
consumes the draft and inserts the letter and its outbox row in one transaction, and nothing submits
it in that request. The next hourly maintenance run does, so a paid item can wait up to an hour for
provider acceptance. The PostGrid request uses the Letter IRL `letter_id` as `Idempotency-Key`.

**How a letter goes to PostGrid (#534).** A letter prints with the renderer its preview was drawn with, recorded on the draft (`renderer_version`, migration 039) and copied into `letters.content.rendererVersion` at send:
- without a version, as today's HTML;
- with `pdf-1`, as our own PDF from `src/render`, uploaded as a multipart form with a 30-second budget.

A `pdf-1` gift send prints its card as the PDF's second page, drawn by the renderer with the code the send minted (`letters.content.giftCard`). When our renderer refuses a letter before any request, it is held like any other failure that is not an explicit rejection, with the class `render_refused`. That happens for a version this build cannot print, an unreadable image, a letter that no longer fits its page, or a gift card it cannot lay out. Every version the database admits must be in `PRINTABLE_RENDERER_VERSIONS`, which a test checks, so a new renderer never strands letters waiting under an older one. Resolving such a hold is in [deployment.md](deployment.md).

**How a postcard goes to PostGrid (#534 Phase 4).** A postcard carries the same `rendererVersion` from its draft.
- With `pdf-1`, it prints as our own two-page PDF, front then back, each 9.25 x 6.25 in with its bleed. It is uploaded to `/postcards` as a multipart form with a 30-second budget.
  - The front image covers the whole page.
  - The message fills the left half of the back, 16 lines of 14 pt Tinos.
  - The right half stays empty for PostGrid's addresses and postage: content there cancels the postcard (probe P9, [postgrid-pdf-rendering.md](learnings/postgrid-pdf-rendering.md)).
- A gift send's card prints in a strip 1.75 in tall at the foot of the message, drawn by the renderer with the code the send minted (`letters.content.giftCard`). The message keeps the 11 lines above it.
- Refusals hold the postcard as `render_refused`, as for letters: a version this build cannot print, an unreadable image, a message past its half of the back, a gift card whose words run past its strip, or a size other than 6x9.
- With the flag, a postcard preview records `pdf-1` (below). The print's overflow refusal is then a backstop: the preview measured the same back.

**How a preview is drawn (#534).** With `LETTER_IRL_PRINT_RENDERER=pdf`, the three letter previews are drawn by `src/render`, from the layout the PDF prints from:
- the page is laid out with the image that prints, and a letter that runs past it is refused with the count: "Letter is 2 lines too long for one page: it takes 28 lines and the page holds 26." A page holds 26 lines of text only, 16 under a full 2-inch header image, and 13 above a full 3-inch enclosed image;
- the legacy character and line estimates, calibrated for Open Sans, give way to a cap of 10,000 characters, which only bounds the work;
- the text is checked against Tinos, the font it prints in, which draws more than Open Sans (the non-breaking hyphen, for one). A letter carrying more than four marks is refused, and so are controls, line and paragraph separators, private-use characters and any space Tinos would draw as a box, since the font maps some of them to a visible box. The addresses are still checked against Open Sans, which PostGrid stamps them in;
- `preview_html` holds the page as SVG in a minimal HTML document, which the website's confirm page and the letter card show. The page carries the addresses where PostGrid stamps them, at 9pt in upper case, as sent. It asks for Open Sans, which no card or confirm page loads, so a viewer sees a sans-serif fallback, slightly narrower than the print. The PDF leaves the addresses to PostGrid;
- the draft records `renderer_version = 'pdf-1'`, so the letter prints as it was previewed.

A gift send is previewed like any other letter, with its card as the second page (#534 PR 5). Whether a preview is a gift send is decided before the checks, because the card prints the sender's name in Tinos: a name Tinos cannot draw is refused "in the sender's name, which the gift card prints", though PostGrid could stamp it in the return address. So is a name long enough to push the card past the page's bottom margin, about a thousand characters: "The sender's name is too long to print on the gift card." Without the flag, previews are the legacy HTML. The flag is read only when a letter is previewed, so changing it never changes a letter already previewed or queued.

**How a postcard preview is drawn (#534 Phase 4).** With the same flag, a postcard preview is drawn by `src/render` too:
- Before the picture is fetched, the message is measured on the back as it prints. A message that runs past 16 lines is refused with the count: "Postcard message is 1 line too long for the back: it takes 17 lines and the back holds 16." The legacy 500-character limit gives way to a cap of 1,000 characters, which only bounds the work.
- The message is checked against Tinos, the addresses against Open Sans, as for letters.
- The draft records `renderer_version = 'pdf-1'`. Its `preview_html` holds the front and the back as SVG: the front laid out with the full image's box and drawn with the small copy, the back with the addresses where PostGrid stamps them ("RETURN TO:" and the return address, then the recipient, probes P9 and P11). The addresses are the ones sent, after any correction; P11 showed PostGrid upper-casing them and nothing more, and its own standardisation at stamp time is not probed. The website's confirm page shows both, where it showed only the front before.
- The tool's output carries the same document as `previewHtml`, which goes to the card's `_meta`, and the postcard card shows its two pages (#534 Phase 4b).
- A gift postcard is drawn with its card in the strip at the foot of the message (#534 PR 8), so its message has 11 lines: "it takes 12 lines and the back holds 11 above the gift card." The legacy 350-character limit gives way as the 500 does.
- Its sender's name is checked against Tinos, as on a gift letter, whichever card the preview shows: the send decides the card, and may print a funded one where the preview showed the plain one. The name must also fit the strip, for this card and for the longest card the send could print instead (`longestSendCard`: funded, with the longest date and a seed campaign's wording). A name of about a hundred characters is refused: "The sender's name is too long to print on the gift card." A seed campaign's long code takes room from the name, and one that does not fit even without a name (only the widest codes, 49 or 50 W's) is refused whatever the name: "This gift letter's card does not fit on a postcard. Send it as a letter, or set sendAsGift to false to pay from the balance." Only a seed code the preview never saw can still overflow the strip, and that print is held.
- Any size but 6x9, and every postcard without the flag, keeps the legacy HTML, and a gift postcard there its 350-character limit.
- The legacy front preview is landscape at every size (it drew a 6x9 card in portrait, cropping the picture on the confirm page).

A claimed job is submitted to the provider exactly once. A successful response records the provider order ID and marks the job completed. Any outcome that does not prove what happened — `5xx`, timeout, transport loss, an unreadable body — may mean the piece was accepted and physically mailed, so it is never resubmitted: the job is held with `provider_outcome = 'ambiguous'` for operator reconciliation. Only an explicit provider rejection, which proves no mail exists, is terminal.

The tool response reports one of:

- `accepted`: provider submission completed;
- `pending`: the transaction committed and recovery is scheduled;
- `failed`: provider submission reached a terminal failure.

## Terminal Failure and the Letter Pack

A confirmed send consumes the Letter Pack before the provider is called, so a terminal failure owes the customer compensation. A pay-per-send order moves to `refund_pending` and Stripe settles it. A prepaid send has its pack returned to the credit ledger.

The return posts new compensating lots rather than reversing the original ones. It mirrors the original per-lot split recorded in `credit_consumption`, and each returned lot inherits its source lot's expiry, because credits are consumed FIFO by `expires_at` and collapsing them would silently move credits between expiry windows. It stores a stable failure code, never provider text.

Three paths reach it, and all three are guarded by the same exactly-once check, so replayed failure handling, an operator retry that fails again, and two concurrent handlers all return one pack:

- an explicit provider rejection during dispatch;
- a terminal failure *before* dispatch, where the job never left `provider_outcome = 'not_dispatched'` and no mail can exist;
- an operator resolving an ambiguous hold as a confirmed rejection.

Once a pack has been returned, an operator retry of that job is refused. Nothing re-deducts on the way back through the outbox, so resending would give the customer the pack and the letter; selling them a new send is a deliberate decision rather than a side effect of a retry.

An ambiguous outcome returns nothing. The piece may physically exist, and an unnecessary hold is recoverable while refunding posted mail is not.

A gift letter (`funding_type = 'gift_letter'`) consumed no credits, so its compensation is a gift: the same three paths void the code printed on it and grant a replacement gift letter with the same budget, once, keyed by the letter. Nothing is returned if the code was already redeemed, which proves the letter arrived, or if the purchase that granted the gift has been refunded or disputed. Either counts as compensation for the retry guard.

## Hourly Recovery

Railway runs `npm run maintenance` once per hour. Outbox recovery atomically claims due rows with `FOR UPDATE SKIP LOCKED`, allowing safe concurrency. Held mail (#535) is due from 09:00 New York time on its mail date. A job left in processing with a lock older than 15 minutes is treated as stale and can be reclaimed.

The same stable provider idempotency key is reused after timeout or process restart. This protects against a provider order succeeding while the application loses the response.

**Paused outbox (#444).** With `LETTER_IRL_OUTBOX_DISPATCH_ENABLED=false` on the API and the maintenance service, neither claims a job, so nothing reaches the provider. A send still commits and queues its job, and the tool answers `currentStatus: pending`, "Queued for the print provider". Every waiting job keeps its attempts and backoff and goes out on the first maintenance run after the switch is back on. The crash sweeps still run; how a pause shows and how to rehearse it is in [operational-acceptance.md](operational-acceptance.md).

Maintenance also performs image cleanup and conditionally runs six-hour provider status synchronization and daily credit/draft/payment maintenance. It closes all database and bucket clients before exit.

## Status Retrieval

`get_order_status` and `list_orders` read Letter IRL's persisted order state. Provider status synchronization updates accepted orders on its six-hour cadence. A user can retrieve the order immediately even while provider recovery is pending.

## Image Handling

Generated images receive a capability URL backed by a private Railway bucket. The URL is valid for 15 minutes and remains usable across API restarts. Once a preview consumes an image, the draft/order contains the data needed for provider submission; maintenance removes expired temporary bucket objects.

## Required Tests

- duplicate and concurrent send calls create one order and one deduction;
- a second draft of the same mail is refused within 24 hours, from balance and at a new Pay & Send checkout, and goes through only with `sendAnotherCopy: true` (`tests/integration/duplicateMail.postgres.test.ts`);
- insufficient balance rolls back all effects;
- `429`, `503`, timeout, and network failures are held as ambiguous rather than resubmitted;
- a terminal failure returns the customer's Letter Pack exactly once, and an ambiguous one never does;
- a process restart after provider submission does not create a second provider order;
- hourly maintenance recovers due and stale rows;
- generated images remain available after API restart for 15 minutes;
- documented ChatGPT preview, purchase, send, and status flows pass in development.

See [manual-tests.md](manual-tests.md) and [idle-cost-operations.md](idle-cost-operations.md).
