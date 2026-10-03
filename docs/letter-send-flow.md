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
  - Its link text says nothing is sent until the person presses Send. For a preview with an arrival date (#535), it also says when, once sent, the mail goes to the printer and aims to arrive, and the answer carries the preview's `schedule`. A preview whose mail date has passed (by the send's own rule: today until noon New York time on a business day) is refused with `SCHEDULE_PASSED` instead of a link the page would refuse.
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
grants is a change to the send rule. The `GET` names what the page shows: the
preview, the addresses, the cost and the balance; a letter's `stationery`
(#563); and a postcard's `postcard`, its `size` in PostGrid's naming (`6x4` is
the 4x6) and its front (`layout`, with its `caption` or `place`) as the print
reads them: only for a postcard drawn as `pdf-3`, the photo alone otherwise
(#594). For a front the print cannot read, `postcard` is left out, size and
all. The `POST`:
- runs the same service as the tools, below, so every check applies;
- rewords the service's refusals for the page.

**Mail no pack pays for (#579)** is paid on the page with Pay & Send:
- `GET` marks it `packPays: false` and, while the draft is ready, gives its `payment`: the quote's Pay & Send (`available`, the amount and its display, or why not now), its price resolved first. For a letter of more than one page (#586) it also gives `pages`, which no pack pays for; the page keys on `packPays`, not on `lettersRequired`.
- `POST /api/sends/:draftId/checkout`, the website's alone like the rest and `mail:send` like `create_mail_checkout`, opens the Stripe checkout (`createJitCheckout`). It returns to the page: `?paid=1` when paid, `?paid=0` when turned back. The order records those addresses, so a retry from the page reuses the page's own sessionless order, and a sessionless one an app began is replaced. An order with a Stripe session already open is reused as it is, wherever that session returns: one session, one charge, and the paid webhook sends the mail either way.
- Paying sends the mail, as everywhere else; the route itself sends nothing. Its refusals are worded for the page (`checkoutRefusalFor`), and `{ sendAnotherCopy: true }` buys another copy, as the send's body does.

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
5. locks and deducts prepaid sends from the user's ledger, or, for a draft previewed as a gift send, uses one gift letter under the same account lock and decides its card ([Gift Letters](gift-letters.md)). Neither pays for mail other than a one-page letter or a 6x9 postcard: such a draft is refused with `PACK_CANNOT_PAY` before any value moves, and is paid per send with Pay & Send (#579, [Pricing](pricing-and-credits.md));
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
  - **Every preview's output** carries `arrivalWindow` (`earliestArrival`, `latestArrival`) while the flag is on, with a date or without, so a card can offer the dates before one is chosen (`previewArrivalWindow`). They are the dates a held preview is checked against. The field is left out while the flag is off, and when no date can be scheduled.
- **`set_arrival_date` moves them** (`src/tools/setArrivalDate.ts`), listed only while the flag is on: it sets, moves or clears a draft's dates without previewing again.
  - **The date is checked first**, as the previews check theirs, and refused in the same words. Left out, or empty, it clears the dates, and the mail goes to the printer as soon as it is sent.
  - **One transaction** (`setDraftSchedule`, `src/services/draftService.ts`) locks the draft row first, as the send and the Pay & Send checkout lock it before they read its dates. So they run one after the other: a send or checkout that goes first leaves the change refused, and one that goes second reads the new dates.
  - **It changes only** a draft that is the caller's, pending, unexpired and not emptied by an erasure, with no live Pay & Send order (any status in `ACTIVE_JIT_STATUSES`, but a checkout whose window has passed). Payment sends the mail with the dates the draft has, so they do not move under it.
  - **Its refusals** say what to do next: the preview was not found, has already been sent (`list_orders` shows it), has expired (the preview tools take `arriveBy` themselves), or is tied to a Pay & Send payment.
  - **Annotations:** not read-only, not destructive (a draft sends nothing and expires on its own), and idempotent.
  - **The cards may call it** (`openai/widgetAccessible`, MCP Apps' `ui.widgetAccessible`), and so may the model. `cancel_scheduled_mail` is the same. A result a card gets this way is the card's alone: the model does not see it ([ui-widgets.md](ui-widgets.md)).
  - **The cards' Arrives row** calls it with the draft, and **Cancel** on mail sent with a date calls `cancel_scheduled_mail` ([ui-widgets.md](ui-widgets.md)).
- **The hold:** the send copies both dates to the letter and creates its job with `next_attempt_at` at 09:00 New York time on the mail date. `scheduled_at` records the same moment, written as a timestamp without a zone in the database session's zone. Value moves at the send, as for any letter: sends, a gift letter or a paid order.
  - The claim takes a job only once `next_attempt_at` has passed. So neither the inline dispatch right after the send nor the hourly run touches it before then, and the first hourly run after 09:00 sends it to PostGrid as an ordinary order. No PostGrid `sendDate` is used.
  - **What the send and the order status say** (`src/tools/heldSend.ts`, `src/store/fileAccountStore.ts`): the send's answer carries `schedule` and `cancellable`, and while the mail waits its status is `scheduled`, with "Scheduled: Goes to the printer Tue, Oct 6, and aims to arrive by Fri, Oct 16. It can be cancelled free until then." in place of "Queued for the print provider". `get_order_status` and `list_orders` say the same, from the letter's `arrive_by`, `mail_on`, `status` and `funding_type`; Pay & Send held mail is `scheduled` but not `cancellable` ([status-labels.md](status-labels.md)).
- **Cancelling held mail** (`src/services/scheduledMailService.ts`): free until it goes to the printer. It is reached through `cancel_scheduled_mail { orderId, confirm: true }`, listed only while the flag is on, and through `POST /api/letters/:letterId/cancel` for the website, whatever the flag (scope `mail:draft`).
  - **What can be cancelled:** the caller's letter with a mail date, still `queued`, whose job is `pending` and `not_dispatched`. That includes a letter past 09:00 on its mail date that the hourly run has not yet taken. Nothing outside Letter IRL is involved, since PostGrid has never seen it.
  - **One transaction, in the outbox's lock order:**
    - the letter (`FOR UPDATE`, which waits: its other holders are short, and a second cancel then finds it cancelled);
    - its job (`FOR UPDATE NOWAIT`: the one holder of a job without its letter is the claim taking it to the printer, so a conflict answers "going to the printer right now");
    - the account last, inside the return.
  - **It writes:** the job and the letter `cancelled` (the job's `last_error` `cancelled_by_customer`), and a `letter_status_history` row with source `customer`.
  - **What goes back:**
    - a prepaid letter's credits, through `returnConsumedCreditsForLetter`, on lots that keep their expiry. The answer counts them in letters (two credits each), never credits, and only those still usable. Credits whose lot ran out while the mail was held go back on record as `expired`, so they are never returned twice. They are left out of the cached balance and the account's history, which the ledger would not spend, and the answer says so; whether a cancel should give them new life, as a gift gets, is the owner's call;
    - a gift letter, through `returnGiftLetterForFailedSendWithClient`, its printed code voided as `send_cancelled`.
    - Both use the failed send's exactly-once records (reason or source `send_failed`), so a replay returns nothing and the operator's retry guard (`isLetterAlreadyCompensated`) counts a cancel. `failure_code` and the descriptions say it was cancelled.
  - **Refused**, where it is checked first so each answer is true of it (a letter a refund cancelled is already cancelled; printed mail is too late, whatever paid for it):
    - someone else's or a missing letter, as not found;
    - mail with no date;
    - mail the outbox has taken, or that failed;
    - Pay & Send, whose refunds a person decides (support@letterirl.com).
  - **A repeat** answers as already cancelled, and nothing more goes back.
  - **Cancelled letters free the duplicate guard**, so the same mail can be sent again.
  - **The outbox never brings a cancelled job back.** Its failure-before-dispatch path skips a job cancelled meanwhile, so a claimant that stalled past its lock cannot return it to pending.
- **What the website sees** (`src/api/letterApiHandler.ts`, `src/api/sendConfirmationApiHandler.ts`):
  - `GET /api/letters` and `GET /api/letters/:letterId` give each letter:
    - `arriveBy` and `mailOn`, null without dates (dates it cannot read are left out);
    - `scheduled`: still `queued`, waiting for its mail date;
    - `cancellable`: scheduled, and not Pay & Send;
    - `mailService`: `standard`, `certified` or `certified_return_receipt` (#625);
    - `carrierTrackingNumber` and `carrierTrackingUrl`: USPS's number for certified mail and the USPS page that shows it, null until the status sync has stored the number. `trackingNumber` stays the printer's id for the letter, not a carrier number.

    The list's `status` filter takes every letter status, and `scheduled` for that waiting mail. It used to refuse `accepted`, `in_transit`, `delivered`, `returned` and `held`.
  - `POST /api/letters/:letterId/cancel` answers `letterId`, as the letters routes do. A refusal carries its reason as `code`, which the website's API client reads, and as `error`.
  - The confirmation page's API:
    - `GET /api/sends/:draftId` gives the draft's `schedule` (null without dates);
    - and its `stationery` (#563): a themed draft's theme, date line, initials and headline, read as the print reads them (`stationeryOf`), or null for Classic, a legacy preview, or a theme the print would refuse;
    - and a postcard's `postcard` (#594): its `size` in PostGrid's naming (`6x4` is the 4x6, `6x11` the 11x6) and its front as the print reads it, left out for a letter or for a front the print cannot read;
    - its `POST` answers a dated send with `schedule`, `scheduled` and `cancellable`, as the send tools do. `scheduled` is true while its job is held past now. A hand-off that throws does not change that, since such a job cannot have been taken.
- **Sending held mail early:** the admin panel's **Send held mail now** (`job.dispatch_now`, `releaseHeldLetterJobAsAdmin` in `src/services/letterJobService.ts`) makes a held letter's job due at once, so the next hourly run sends it ([Admin Panel](admin-panel-guide.md)).
  - **Only mail still held:** the job `pending`, `not_dispatched`, never attempted, carrying `metadata.heldUntil` and not yet due by the database's clock; the letter `queued`; a Pay & Send letter's order still `fulfillment_pending`. It locks the order, the letter and the job, in the outbox's order.
  - **What moves:** `next_attempt_at` and `scheduled_at`, to now. `heldUntil` keeps the original time, because the admin's operator role cannot write the job's metadata. The stuck-order condition also reads the job's next attempt and attempts, so a released Pay & Send order that has not gone is called stuck 90 minutes after its release, or as soon as a first attempt fails.
  - **The record:** a `commerce_operator_audit_events` row, `mail_job_release` (migration 042), with the hold that ended and the operator's reason hashed. A replay with the same key returns the first outcome.
  - The customer can still cancel the letter until the run takes it.
- **A passed mail date:** today counts as a mail date until noon New York time on a business day, so a draft previewed before the cutoff and sent after it has missed its date.
  - A prepaid or gift send is then refused with `SCHEDULE_PASSED`, before anything is written: "The day this letter was to go to the printer has passed…". The person previews again with a new date.
  - A Pay & Send checkout refuses such a draft before the charge. A paid order whose date passes before fulfilment mails as soon as it can instead, logging `send.schedule_missed`, because refusing after the charge would strand the money.
- **An account erasure** cancels prepaid and gift mail still waiting for its mail date, with nothing returned, once nothing else holds the account back ([Account Erasure](account-erasure.md)). Held mail that is due, and held Pay & Send mail, hold the erasure back until they mail.
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
- with `pdf-1`, as our own PDF from `src/render`, uploaded as a multipart form with a 30-second budget;
- with `pdf-2`, the same, in the stationery the preview was drawn in (`letters.content.stationery`, #563). A `pdf-2` letter whose stored stationery this build cannot read is refused (`render`), never printed as Classic.
- a letter of more than one page (#586) also carries its page count, from the draft (migration 047): `letters.content.pages`, written only when above one.

A `pdf-1` gift send prints its card as the PDF's second page, drawn by the renderer with the code the send minted (`letters.content.giftCard`). When our renderer refuses a letter before any request, it is held like any other failure that is not an explicit rejection, with the class `render_refused`. That happens for a version this build cannot print, an unreadable image, a letter that no longer fits its page or pages, a gift card it cannot lay out, or stationery it cannot read or fit. Every version the database admits must be in `PRINTABLE_RENDERER_VERSIONS`, which a test checks, so a new renderer never strands letters waiting under an older one. Resolving such a hold is in [deployment.md](deployment.md).

**A letter of two or three pages (#586)** prints from our renderer only, on both sides of the paper. Its page count is copied into `letters.content.pages` at send, from the draft (migration 047), and only when above one.
- The print lays it out as a preview does, on up to three pages, and holds it unless it takes exactly its page count. So it reproduces the preview by construction, a last line of invisible characters included. A letter that fits one page is laid out as ever. The Dummy and DIY providers, in development only, ignore the page count.
- `doubleSided` follows the letter's own pages, never the PDF's. A gift letter is one page, and its card keeps a sheet of its own.
- Before any request, the print refuses (`render_refused`, reason `pages`):
  - a count outside 1 to 3;
  - more than one page on the legacy HTML or beside a gift card.

  A letter that now lays out on more or fewer pages than it was previewed on, or past three, is an `overflow`: its layout changed since the preview.
- PostGrid's `pageCount` counts sides (probe P13). The cost estimate adds about 10c per page past the first, or 20c in colour, to the 10c for double-sided.

**How a postcard goes to PostGrid (#534 Phase 4).** A postcard carries the same `rendererVersion` from its draft.
- With `pdf-1`, it prints as our own two-page PDF, front then back, at its size with a 0.125 in bleed (#594): 9.25 x 6.25 in for a 6x9, 6.25 x 4.25 in for a 4x6 and 11.25 x 6.25 in for an 11x6. It is uploaded to `/postcards` as a multipart form with a 30-second budget.
  - The front image covers the whole page.
  - The message fills the left part of the back:
    - a 6x9: its left half, 16 lines of 14 pt Tinos;
    - a 4x6: its left 3.25 in, above USPS's barcode clear zone, 11 lines of 12 pt;
    - an 11x6: its left 6 in, 16 lines of 14 pt.
  - The rest stays empty for PostGrid's addresses and postage: content there cancels the postcard (probes P9 and P14, [postgrid-pdf-rendering.md](learnings/postgrid-pdf-rendering.md)).
- With `pdf-3` (#594, migration 048), it prints as the same two-page PDF, its front drawn as the preview drew it from `letters.content.postcardFront`, which the send copies from the draft's `postcard_front`:
  - a border: the photo cut to a box inside a white border, its caption below in Caveat;
  - a greeting: the photo covering the page, "Greetings from" over it, and the place in capitals.

  A front the print cannot read (`postcardFrontOf`) is refused (`render`), never printed full bleed. A caption or place that no longer fits is refused as an `overflow`.
- A gift send's card prints in a strip 1.75 in tall at the foot of the message, drawn by the renderer with the code the send minted (`letters.content.giftCard`). The message keeps the 11 lines above it. A gift postcard is a 6x9 (#579), with any front.
- Refusals hold the postcard as `render_refused`, as for letters. The postcard is held for:
  - a version this build cannot print;
  - an unreadable image;
  - a message past its room on the back;
  - a gift card whose words run past its strip;
  - a gift card on any size but 6x9;
  - a size no writer stores, on either path;
  - a `pdf-3` front the print cannot read, or one whose caption or place no longer fits (#594).
- With the flag, a postcard preview records `pdf-1` (below), or `pdf-3` with a front. The print's overflow refusal is then a backstop: the preview measured the same back and the same front. A 4x6 or 11x6 with no renderer version prints on the legacy HTML, as before.
- **The 4x6 and 11x6 are offered only while `LETTER_IRL_POSTCARD_SIZES_ENABLED`, `LETTER_IRL_PRINT_RENDERER=pdf` and Pay & Send are all on (#594).** The legacy back is a 9 x 6 in page whatever the card, so the tool never previews either on it, and none it makes reaches the legacy print.
  - The preview crops the front to the size, measures the back at its size, and stamps the addresses where PostGrid prints them on it. The draft keeps the size.
  - A 4x6 or 11x6 is paid with Pay & Send at its own price (`jit-postcard-4x6`, `jit-postcard-11x6`), never from a pack or as a gift letter (#579).
  - Off, the tool's `size` is served as before, the 6x9 alone. A size from a schema cached while it was on is refused by validation, and the preview itself refuses any other size.
- **Postcard collages are offered only while `LETTER_IRL_POSTCARD_COLLAGES_ENABLED` is on (#616, `isPostcardCollagesOffered`).** The preview takes `images` or `imageUrls`, two to four photos (`src/tools/collageSources.ts`), and draws them as one JPEG at the postcard's size (`downloadAndProcessCollageWithPreview`).
  - The draft stores that picture in `front_image_data` as a single photo's crop is, with no source address (`front_image_url` null), and records the front as any postcard's: with our renderer, full bleed (`pdf-1`) or a border or greeting over the collage (`pdf-3`); on the legacy HTML path, no version. Nothing in the send or the print knows it was a collage, so either print path prints it and a collage costs what a postcard costs.
  - A collage keeps the size it was made at: `set_postcard_style` refuses another (`COLLAGE_SIZE`), since the photos are not kept and cropping the composite again would cut them. Its front can still change.
  - Off, the two arguments are not served and one sent anyway is refused. A collage already previewed still prints: the send and the print read the draft's own picture, never the flag.
- **The postcard layouts are offered only while `LETTER_IRL_POSTCARD_LAYOUTS_ENABLED` and `LETTER_IRL_PRINT_RENDERER=pdf` are both on (#594, `isPostcardLayoutsOffered`).** The legacy HTML draws the photo alone, so the tool never previews a front on it.
  - The preview takes `layout` (`full_bleed`, the default, `border` or `greetings`), a `caption` for a border and a `place` for a greeting (`src/tools/postcardFrontInput.ts`). Each layout takes only its own line, and a greeting needs its place.
  - It measures the line at the postcard's size with the print's own layout, and refuses one too long, saying about how many of its characters fit. Its characters are checked as the message's are, in the face the line prints in: the caption in Caveat, the place in Tinos capitals.
  - The draft records the front in `postcard_front` with `pdf-3`, and full bleed records none with `pdf-1`: migration 048's checks keep the two together. The send copies the front into `letters.content.postcardFront`, and the print draws it (above).
  - A gift postcard keeps its front, with its card on the back as ever. A layout does not change the price.
  - Off, the three are not served, and the postcard is served open to unknown keys. So a front from a schema cached while they were on reaches the preview, which refuses it rather than printing the photo alone.
- **`set_postcard_style` changes a postcard preview's size and front in place** (#594, `src/tools/setPostcardStyle.ts`). It is listed while the sizes or the layouts are offered, and the postcard maker on the card calls it.
  - It checks a size and a front as the preview does, at the postcard's size. A kept front is measured again at a new size, and a message a smaller back cannot hold is refused. A gift postcard stays a 6x9.
  - At the same size it draws the front again and keeps the back as it was, a gift card's strip with it.
  - At a new size it crops the picture again and lays the back out at that size. The crop comes from the picture's source while that still opens. Otherwise it comes from the stored copy, which was cropped to the old size.
  - `setDraftPostcardStyle` writes the size, the front, its version (`pdf-3` with a front, `pdf-1` without), the page and any picture cropped again. It does so in one `UPDATE`, under the lock a send and a Pay & Send checkout take. A preview that changed since it was read, under another restyle, refuses the write as `DRAFT_CHANGED`.
  - It prices the postcard again: a 4x6 or 11x6 is paid with Pay & Send, and a 6x9 by a pack, as a preview prices it.

**How a preview is drawn (#534).** With `LETTER_IRL_PRINT_RENDERER=pdf`, the three letter previews are drawn by `src/render`, from the layout the PDF prints from:
- the page is laid out with the image that prints, and a letter that runs past it is refused with the count: "Letter is 2 lines too long for one page: it takes 28 lines and the page holds 26." A page holds 26 lines of text only, 16 under a full 2-inch header image, and 13 above a full 3-inch enclosed image;
- the legacy character and line estimates, calibrated for Open Sans, give way to a cap of 10,000 characters for each page the letter may take (30,000 while room to write is offered, #586), which only bounds the work;
- the text is checked against Tinos, the font it prints in, which draws more than Open Sans (the non-breaking hyphen, for one). A letter carrying more than four marks is refused, and so are controls, line and paragraph separators, private-use characters and any space Tinos would draw as a box, since the font maps some of them to a visible box. The addresses are still checked against Open Sans, which PostGrid stamps them in;
- `preview_html` holds the page as SVG in a minimal HTML document, which the website's confirm page and the letter card show. The page carries the addresses where PostGrid stamps them, at 9pt in upper case, as sent. It asks for Open Sans, which no card or confirm page loads, so a viewer sees a sans-serif fallback, slightly narrower than the print. The PDF leaves the addresses to PostGrid;
- the draft records `renderer_version = 'pdf-1'`, so the letter prints as it was previewed.

**Pages after the first (#586, room to write).** `layoutLetter` can lay a letter out over up to three pages (`maxPages`).
- A letter that fits one page is laid out exactly as before, whatever the limit; a golden test pins every layout and theme.
- A longer one flows on. Pages 2 and 3 start 1 in from the top and hold 33 lines of Classic.
- The theme's corner, date and headline, and a header image, stay on the first page. Handwritten rules every page.
- An enclosed image follows the last line where it fits, or starts a page of its own; it is never split.
- `pageFit` says how full the letter is, for the card's fit meter.
- The previews lay letters out on more than one page only while room to write is offered (below).

**A signature on a letter (#608).** `layoutLetter` takes the person's saved signature (`LetterContent.signature`: the picture, and the paragraph of the text that holds the sign-off's first line).
- It draws the picture in a band three lines tall (`SIGNATURE_LINES`, 0.8 in) right after that line, left with the text, at most 2.5 in wide and never past CSS pixel size, with 3 pt of air above it and at least 3 pt below. "Sincerely,\nPat Example" prints the closing, the signature, then the name; a one-line sign-off gets it below.
- The band counts as three lines, so the page fit, room to write and a letter's overflow all see it.
- A page break never parts the band from the closing above it: when it would, the closing and the band start the next page (of a closing that wraps, its last line). A continuation page never drops the band as blank lines.
- Handwritten's rules skip the band, as they skip an enclosed image.
- Without a signature the page is exactly the page without one.
- The letter previews pass the saved signature while signatures are offered: their `signature` argument, or the account's choice ([tool-apis.md](tool-apis.md#letter-drafts-and-sending)). `signatureParagraph` finds the closing's paragraph, past any blank line the sign-off begins with; the preview and the print both ask it.
- The draft keeps its own copy (`letter_drafts.signature_image`, migration 051) and records renderer `pdf-4`, with or without a theme. The send copies it into `letters.content.signatureImage`.
- The print draws a `pdf-4` letter with that copy. One whose content lost it, or holds one that cannot be read, is held as a render refusal, never printed unsigned; a `pdf-1` or `pdf-2` letter prints no signature whatever its content holds. A postcard recording `pdf-4` is refused.

**Certified mail (#625, in progress).** The draft records how the letter travels (`letter_drafts.mail_service`, migration 052): `standard` (first-class mail), `certified` (USPS Certified Mail) or `certified_return_receipt` (with an electronic return receipt). Only a letter that is not a gift send is ever certified, and it is paid per send (#579): `draftMailOption` reads the service beside the pages, so the checkout, the confirmation page and the send price and refuse it by what the draft holds.
- **The draft records it, and the previews set it (below).** `createDraft` stores the service (refusing a gift send or an unknown value first, `DRAFT_MAIL_SERVICE_INVALID`), `setDraftMailService` changes it under the draft lock a schedule change takes (so a live Pay & Send order holds the price), the checkout peek reads it, and the confirmation API names it when it is not standard.
- **The send copies it to the letter.** `createMailOrderFromDraft` writes `letters.mail_service` (migration 053) from the draft, for a letter only: a postcard is standard, and the checks of 052 and 053 hold any writer to that. A pack or a gift letter never pays for it (`PACK_CANNOT_PAY`), and a Pay & Send order pays only for the product of the service the draft asks for (`JIT_PRODUCT_MISMATCH` otherwise), so a letter is never paid for as certified and mailed as standard.
- **The dispatch hands it to the provider, and refuses what the provider cannot send.** `letterParams` passes `extraService` (one of the two PostGrid sells; standard passes none). A provider says it sells extra services with `supportsExtraServices` (PostGrid and the dummy do; manual fulfilment does not). Before anything is submitted, `extraServiceRefusal` turns a letter away when its service is text this code does not know, when the provider does not say it can sell services, or when it is a postcard.
  - The refusal is a definite rejection, by the road every other one takes: the job and the letter fail, a Pay & Send order goes to `refund_pending` and a pack's credits come back. The operator's record is the data-free class `extra_service_refused` (in `letter_jobs.last_error`, `orders.last_error` and the `provider.terminal_failure` event, where a provider's own answer reads `provider_rejected http_<status>`); the cause is the log line `outbox.extra_service_refused` with a fixed `reason` (`unknown_service`, `provider_cannot_sell` or `postcard`).
  - The providers refuse too, as a second line: PostGrid any service it does not sell (`provider.postgrid.extra_service_refused`), manual fulfilment any service at all. None of them reads `null`, the empty string or `standard` as a service.
- **Rollout.** A build from before the send does not read `letters.mail_service` and would print a certified letter as ordinary mail: turn the flag on only once the api and the maintenance service both run the send, and pause the outbox (`LETTER_IRL_OUTBOX_DISPATCH_ENABLED=false`) before rolling either back below it while certified letters wait ([deployment.md](deployment.md)). The admin panel's status sync runs as the operator role, whose letters UPDATE list gains `carrier_tracking_number`: re-run `npm run admin:provision-access` after migration 053.
- **The status sync stores the carrier's number.** `getStatus` carries PostGrid's `trackingNumber` when it is shaped like one (`LetterStatus.carrierTrackingNumber`), and `syncLetterStatuses` writes it to `letters.carrier_tracking_number` on its own, since it usually arrives without a change of status. It writes only to a letter that travelled certified, and only when the number differs. A certified letter that was delivered before it had a number is still asked about (inside the same window) until it has one, for its number alone: its status stays delivered, whatever the provider now answers.
- **Orders show the service and the number.** `FileAccountStore.fetchOrders` reads `letters.mail_service` and `carrier_tracking_number` (`certifiedFactsOf` in `src/config/certifiedMail.ts`: nothing for an ordinary letter, the number only beside a certified service) into `OrderRecord.certified`. `get_order_status` and `list_orders` pass them on as `mailService`, `carrierTrackingNumber` and `carrierTrackingUrl` (USPS's page for the number, with spaces and hyphens taken out), and `get_order_status` adds `certifiedNote` (`certifiedOrderNote`): the service, the number and link or that it is not here yet, and for the return receipt that it is USPS's record, which Letter IRL does not receive. Its `trackingSupport` is `carrier_tracking` only once the number is stored. `GET /api/letters` gives `mailService` (`standard` for an ordinary letter), `carrierTrackingNumber` and `carrierTrackingUrl` (null until the number is stored). They are shown whatever the flag says: a sent letter is a fact, and the output schemas declare them either way.
- **Every reader of a draft that prices it must read the service.** `tests/unit/services/draftOptionColumns.test.ts` reads the source and fails if a query that selects `pages` from `letter_drafts` by name does not select `mail_service` too. It sees column lists only: a join, a list built in code, a CTE or a schema-qualified name would escape it, so a new reader of a draft is reviewed for this by hand. The readers above the SQL (below) price from the row by `draftMailOption` or `letterOption`.
- **So do the tools that restyle or read a ready letter.**
  - `letterOption(layout, service)` is the letter's option: its pages and the draft's own service, read as the rest of the code reads a row's (`mailServiceOf`). `set_stationery`, `set_letter_words` and `set_letter_signature` price what they return by it, so a restyled certified letter is still certified-priced, `canSendNow` false, and the reason cannot be sent from the balance is "Certified mail is paid with Pay & Send."
  - A change of pages moves nothing about who pays for a certified letter (one price whatever the pages), so their message says "The price is the same." and never that a pack or Pay & Send pays for the page (`pageChangeSentence`, shared by the three).
  - `get_draft_status` keeps a ready certified letter's terms (`canSendNow`, the reason, `sendEligibility`) whether or not room to write is offered, since the letter was previewed while certified mail was. Like the other terms, only for a letter our renderer drew.
  - No gift letter pays for certified mail: `earlyGiftChoice` takes the service and decides at once, refusing `sendAsGift: true` (`GIFT_NOT_FOR_CERTIFIED`) and choosing no gift when it is left out; `set_letter_words` never suggests a gift letter for a certified letter that shrinks to one page. The three previews pass the service (the next bullet). Whatever else sets it (`set_mail_service`, a card) must gate on `isCertifiedMailOffered()`: `setDraftMailService` does not check the flag. The copy that gives a certified letter the one-page pack rule is certified-aware where a person or a model reads it: `sendLinkText` and `howToSendText` in `registerTools.ts` (through `packRuleText`; the send-by-link answer to a refused pack send is built from `request_send`'s result, which now carries `mailService`). Still to do in the part with the cards: the letter card's `PAY_PAGE_NOTE`.
- **The three letter previews take it.** While certified mail is offered (`isCertifiedMailOffered()`: the flag, and Pay & Send), `quote_and_preview_letter`, `quote_and_preview_letter_with_header_image` and `quote_and_preview_letter_with_image` accept `mailService`: `certified` or `certified_return_receipt`; `standard`, `null` and the empty string (the served schema reads both as none, as it does for the stationery, for a client that fills every field) and leaving it out are an ordinary letter.
  - `chooseMailService` reads it right after the arrival date, before the sender, the picture, the address check, the gift choice and the draft, so a refusal creates nothing. While certified mail is not offered, anything else is `MAIL_SERVICE_NOT_OFFERED` whatever it says (a person is never told to use a value that is then refused, and a call's own text never reaches the log: it logs `certified`, `certified_return_receipt` or `unrecognized`). While it is offered, any other text is refused: by the schema's enum (the SDK's validation error, which lists the valid values) and again by `MAIL_SERVICE_INVALID`, never read as standard mail, which would send it as an ordinary letter at the ordinary price.
  - The draft is created with the service and priced by `letterOption(layout, service)`; the preview returns `mailService` for certified mail only, and its narration says it goes by USPS Certified Mail once sent.
  - `withheldInputKeys` leaves the argument out of `tools/list` and `/manifest.json` while certified mail is not offered. The output field is declared whatever the flag: the output schemas are closed, and a letter can outlive the flag. Mention it when the Apps SDK submission is next touched.
  - `request_send` carries `mailService` for a certified draft, so the link's words say Pay & Send pays for it, never a letter pack or a gift letter; the how-to-send words do the same from the preview's output (`previewPayment().certified`); `paidPerSend`'s description says packs and gift letters never pay for certified mail. Steering rev 38.
  - The preview's description says to pass it only when the person asks, that it costs more and that a new preview of a certified letter must pass it again (`set_mail_service` will change a preview without one). Its narration says the letter "goes by USPS Certified Mail" once sent, never that it was sent.
  - **Turn the flag on only when the whole path is in:** the previews' words promise a tracking number, and the orders show it from part 5 (`get_order_status`, `list_orders`, `GET /api/letters`); the letter card's pay note is certified-aware in part 6. Until then nothing shows the number, and the card's note still gives a certified letter the one-page pack rule.

**Room to write on a preview (#586).** While `LETTER_IRL_ROOM_TO_WRITE_ENABLED` is on, the previews are drawn by `src/render` and Pay & Send is on (`isRoomToWriteOffered`), the three letter previews lay the letter out on up to three pages (`letterPageLimit`):
- **Recorded and priced.** The draft records the pages (`letter_drafts.pages`, migration 047), counted before any gift page. A letter of two or three pages is Pay & Send at its own price: no pack pays for it, so `canSendNow` is false and the eligibility is priced as `jit-letter-2-pages` or `jit-letter-3-pages`. The output gives `pages`, and the narration opens "Preview ready: paid with Pay & Send." and adds "A two-page letter, printed on both sides of one sheet." A letter that fits one page is as before.
- **Refused only past three pages:** "Letter is 6 lines too long for three pages: three pages is the longest letter we print. Please shorten your message to fit on three pages." The theme ways out are offered as on one page, at three pages. The character cap names three pages.
- **The gift waits for the pages.** Without room to write the gift is decided first, so the printable check sees its card. With it, the gift is decided after the layout (`earlyGiftChoice`, `giftForLayout`): a gift letter pays for one page only (#579), so a longer letter is never a gift send. `sendAsGift: true` on one is refused, and none is chosen when it is left out. A gift chosen for a one-page letter then has its card's name checked (`validateGiftCardPrints`), after the image is fetched where there is one.
- **`set_stationery` lays the letter out again on its pages,** on up to the limit, and a gift letter on one page. A theme whose face runs a gift letter past one page is refused as too long, as before.
  - It draws every page again, finding the picture's small copy on whichever page showed it, and keeps a gift letter's card page.
  - It stores the pages with the stationery, under the same lock, so an open Pay & Send checkout still refuses it.
  - A restyle can change the price: a wider face can run a one-page letter on to a second page, which Pay & Send pays for, and Classic can bring it back to one, which a pack pays for. So it returns what the letter costs now: `pages` above one, `canSendNow`, `reasonCannotSend` and `sendEligibility`. Its message says when the pages changed.
  - With room to write off, a restyle is laid out on one page, so a longer draft is refused as too long.
- **`set_letter_words` changes the words in place** (`src/tools/setLetterWords.ts`), listed only while room to write is offered, and called by the card's Words tab.
  - It checks them as a preview does: the character cap, what prints (`validatePrintableLetter`, in the draft's stationery), and the page.
  - It lays them out in the draft's own stationery on up to three pages, and draws the page again as `set_stationery` does (`redrawLetterPreview`, shared by both).
  - A gift letter is held to one page: words that run it past are refused in a gift's words, even past three pages, never priced again (`GIFT_LETTER_ONE_PAGE`). A letter brought back to one page that its balance cannot pay keeps its payment as it was; the message adds that a new preview can use the account's gift letter, when it has one, as only a preview decides a gift.
  - **Which words it replaces.** The card and the chat can each change the words, and neither sees the other's call (#366). So the previews, `set_letter_words` and `get_draft_status` give the words' version (`wordsVersionOf`, a hash of the words, nothing stored), and a change names the version it replaces. One that names none, or one the words no longer have, is refused (`WORDS_CHANGED`) with the words as they are now and their version: the model's read of words changed on the card. `setDraftWords` checks the words again under the lock.
  - `setDraftWords` writes the words, the page and the pages in one `UPDATE` under the same lock as a restyle, so an open Pay & Send checkout still refuses it. It returns what the letter costs now, as a restyle does, and its message says when the pages changed.
  - **Two edits, one draft.** A restyle draws the words it read; new words are drawn in the stationery they read. Each writes what the other draws from, so whichever committed second would store a page drawn from what the first replaced. Each write reads what it was drawn from again under the lock (`drawnFromChanged`), and a change of words the words it replaces too, and is refused if one changed (`DRAFT_CHANGED`: "The letter changed while its page was being drawn again. Try ... again.").
- **The checkout's price is the one its caps checked.** `createJitCheckout` checks the daily caps at the price the peek reads, before the transaction. New words or a restyle can change the pages, and so the price, before the lock, so `prepareJitOrder` refuses an order whose locked price is not the one the caps were checked at (`DRAFT_CHANGED`), before any order or session. Trying again checks the caps at the price it charges. A session-bearing checkout made before the letter's product changed (its window passed, so the lock allowed the change) is not reused: it is refused (`PREVIOUS_CHECKOUT_CLOSING`) until Stripe's webhook or the sweep cancels it, since only Stripe's word cancels an order with a session.
- **`get_draft_status`** gives a ready letter's `pages` when above one, as a restyle may have changed them. While room to write is offered, it also gives what the letter costs now: `canSendNow`, `reasonCannotSend` and `sendEligibility`, the preview's own terms (`letterPayment`). A card shown its preview's first answer again then draws the price the draft has.
- **The fit line (#586).** While room to write is offered, the previews, `set_stationery` and `set_letter_words` give the card `_meta.pageFit`, which never reaches the model. It holds the pages, the sheets, double-sided, each page's lines, and the room left on the last page in lines and about how many characters. The letter card:
  - says on the studio's Words tab how full the letter is: "Fits on one page, with room for about 1,940 more characters.", "Runs on to the back of the page: printed on both sides of one sheet." or "Three pages, on two sheets: the longest letter we print.";
  - names a longer letter's pages in the studio's summary and the layout row: "2 pages, both sides";
  - shows its Pay & Send price as the cost;
  - after a restyle, or a status answer, draws the price and pages the server gave, laid over the preview's. A status answer lays nothing out, so the fit line keeps the preview's count while the draft's page is still the preview's, and says nothing of room once the chat has changed it.
- **The Words tab's editor.** Where the Style row shows, while room to write is offered and the draft is still a draft, the studio's Words tab offers **Change the words**: the letter and its sign-off in two boxes, a line that counts the room as they are written ("About 1,925 characters left on this page.", "About 60 characters past this page: Update the page to see how it runs on."), and **Update the page**, which calls `set_letter_words` with the version of the words it started from. The page, the price and the words it gave are the card's from then on. If the chat changed the words since the card showed them, the server refuses the change (the version check), and the card says in its own words, never the refusal written for the model, that its copy is out of date, keeping what was typed: the person asks in the chat, or makes the preview again. The card fetches nothing to catch up (#593 review round 3). A status answer's words are the Words tab's too. One change to the draft at a time: the Style row and the editor share one wait, and neither runs while the card sends or pays.
- **Descriptions.** The three previews' descriptions add one sentence while it is offered (steering r32), and `set_letter_words` is listed (steering r33). The manifest pins the flag off.

**Stationery on a preview (#563).** While `LETTER_IRL_STATIONERY_ENABLED` is on and the previews are
drawn by `src/render`, the three letter previews take `stationery`, `monogram` and `headline`
(`src/tools/stationeryInput.ts`):
- **Served only then.** The served schemas and `/manifest.json` include them only then
  (`withheldInputKeys`, read at each registration). Otherwise the three previews pass unknown fields
  through, as for `arriveBy`, so a theme, initials or a headline from a cached schema is refused
  ("Stationery is not available yet…") rather than printed on a plain page. Classic is always
  accepted.
- **Checked** after the sender is known and before the page is laid out:
  - the theme is one of the six;
  - initials go only with Monogram, a headline only with Celebration;
  - asked-for initials are one to three letters; otherwise the return address's name gives them, without
    the titles before it or the suffixes after it ("Md. Rafiqul Islam" keeps its M);
  - a headline is one line, shrinking to 18pt and refused past it, saying how much fits, and at most
    `STATIONERY_SLOT_MAX_LENGTH` characters as stored, so what is stored reads back;
  - the initials and the headline are checked against Tinos; the text and sign-off against the face
    the theme sets them in (`drawsGraphemeIn`), so a theme with its own refuses what it cannot draw,
    naming itself and suggesting another stationery;
  - a headline takes three lines of the page, and a letter it pushes past the page is refused with
    the counts, "…on the celebration stationery with a headline…", and the ways out.
- **The date line** is the day of the preview on the New York calendar, written out ("October 1, 2026").
  It prints as previewed, like a letter dated the day it was written.
- **Recorded:**
  - a theme other than Classic draws the preview in it;
  - the draft records `renderer_version = 'pdf-2'` and `stationery`, each slot as it prints;
  - the preview's document names `pdf-2`;
  - Classic records `pdf-1` and no stationery: the page as before.
- **Said:** the output's `stationery` names the theme and what it prints, and `source`: `asked`,
  `remembered` or `default`. The narration names a theme, and a remembered one as such.
- **Remembered** (migration 045, `users.stationery_theme`):
  - a preview that asks for no theme is drawn in the account's last choice, or Classic with none;
  - a theme a preview asks for, Classic included, is remembered once its draft exists, so a refused
    preview chooses nothing;
  - only the theme is remembered, not the initials or a headline;
  - nothing is read or written while stationery is not offered;
  - erasure clears it, and both writers skip an erased account (`AND erased_at IS NULL`), so a
    remember that waited on the erasure writes nothing ([account-erasure.md](account-erasure.md)).

A gift send in a theme prints its themed page, then today's card page.

**Typewriter and Handwritten** (#563 PR 8, migration 046) set the whole letter in a face of their own:
- on Classic's line pitch, so a page holds as many lines (`bodyFace`):
  - Typewriter in Cousine at 11pt, 70 characters to a line, so it fits fewer words than Classic;
  - Handwritten in Caveat at 15pt, with a faint 0.5pt `#aaaaaa` rule under each of the page's lines,
    left out where an enclosed image sits;
- each prints its date line in its face, and neither takes initials or a headline;
- the text and sign-off are checked against that face, which draws less than Tinos:
  - Caveat has no Greek or Hebrew, almost no precomposed Vietnamese, no horn letters (Ơ, Ư), few of
    the caron letters beyond Latin Extended-A's (no Ǎ, Ǧ or ǰ), few historic Cyrillic letters, no
    arrows, few mathematical signs, and none of the symbols Tinos draws (♥, ♪, ☺, ●, ■) or its box
    and shape characters. Many of its letters cannot carry an accent written apart from them (an
    "i" followed by U+0301, as some systems store "í"): such a letter is refused in Handwritten,
    and the same letter written as one character (U+00ED) prints;
  - Cousine lacks superscript and subscript digits, most letterlike symbols, and the ﬃ and ﬄ
    ligatures;
  - neither has the non-breaking hyphen, the narrow no-break space or the other fixed-width spaces,
    which ChatGPT's text often holds; each face draws them as the nearest dash or space it has
    (`inFace`), so it takes what Classic takes of them. Lines still break as the text was written:
    a non-breaking hyphen drawn as a hyphen keeps its word whole;
- a refusal names the theme ("…which the handwritten stationery prints in its own typeface"), and
  suggests another stationery when Classic would print what it cannot; a letter its face pushes past
  the page is told so: "…too long for one page on the typewriter stationery…", with Classic offered
  only when the letter fits it. A theme the call did not name, the account's remembered one, says so
  first ("The account's remembered stationery is handwritten."), as does a remembered Celebration
  whose headline pushes the letter past the page.

The fonts are Google Fonts' files, each beside its licence in `assets/fonts`.

**`set_stationery` restyles a preview** (#563, `src/tools/setStationery.ts`), listed only while
stationery is offered:
- **Checked as a preview's are:** the theme, initials and headline (`previewStationery`), the slots
  against Tinos, the text in the theme's typeface, and the page laid out again in the theme, so a
  headline or a wider typeface that pushes the letter past its page is refused.
- **Drawn again from the draft:** its text, addresses and image. The page keeps the small copy of its
  picture that the preview showed, and a gift letter's card page is kept as it was drawn
  (`rendererDocumentPages`). Drawn back to Classic, the page is byte for byte the first preview's.
- **One transaction** (`setDraftStationery`) locks the draft as `setDraftSchedule` does, with the same
  refusals: not the caller's, sent, expired (or emptied by an erasure), or a live Pay & Send order.
  So a send or a checkout runs before or after it, never between. It writes the stationery,
  `renderer_version` (`pdf-2` for a theme, `pdf-1` for Classic) and `preview_html`, and
  remembers the theme.
- A postcard, or a preview the legacy HTML drew, is refused: make a new preview.

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

**Held mail in the hourly run (#535):**
- **Missed mail day.** A letter with a mail date that is not at the printer at 18:00 New York time that day raises one `schedule_missed_mail_day` alert (warning, migration 041), once per letter, and logs `schedule.missed_mail_day`. "Not at the printer" means still `queued`, taken and not accepted, or `failed`; a letter `held` after an ambiguous dispatch has its own critical alert. A partial unique index keeps it to one per letter even if two runs overlap. The cause may be a pause, the provider being down, or retries running out. It runs right after the outbox, so mail the run has just sent is not counted, and it never throws. It is shown on the admin panel's alerts page, linked to the account. No code posts it to `LETTER_IRL_OPERATOR_ALERT_URL` yet: doing that is a follow-up, and needs the variable set on the maintenance service as well as the API.
- **Stuck Pay & Send orders.** A held letter's order stays `fulfillment_pending` until the letter is accepted. It is not counted as stuck (`commerce.stuck_orders_detected`, and the admin panel's health, which share `src/services/stuckOrders.ts`) until 90 minutes after its job falls due, and only until the run first tries it. The job falls due when its hold ends (`metadata.heldUntil`), or earlier when an operator sends it now, which moves `next_attempt_at` (and `scheduled_at`) but not `heldUntil`; both are read.
- **The pause count.** While the outbox is paused, a held job not yet due is not counted as waiting behind the pause, so held mail alone does not withhold the heartbeat. Only a held job is pending, never attempted and not yet due.
- **Status sync and stuck letters** count from `sent_at`, when the provider took the letter, not `created_at`. So mail held for weeks is still followed for 30 days after it mails, and is not called stuck for the time it waited.

**A cancel by the provider (#566).** PostGrid cancels a piece only while it is `ready`, before printing, and answers `cancelled`. The status sync hands that to `failProviderCancelledLetter` (`letterJobService.ts`) instead of writing the status itself. In one transaction, under the outbox's lock order (the funding order, the letter, its jobs), and only while the letter has not already ended:
- the letter becomes `failed`, with a history row from the sync;
- a prepaid send's credits come back, or a gift letter comes back with the code it printed voided. This happens exactly once, through the same returns as a definite rejection, and only while our record says `accepted`. A cancel after the sync saw the letter printing (`processing`) or mailed (`in_transit`) contradicts PostGrid's own lifecycle, so nothing comes back by itself and a person decides;
- a Pay & Send order, already `fulfilled` when PostGrid accepted the letter, is not moved: a person decides its refund;
- one `provider_cancelled_mail` alert per letter (migration 043) says what happened, with the status our record held before. It is a warning when what paid came back, and critical when a refund waits for a person.

A held letter cancelled after its mail day may also raise `schedule_missed_mail_day`.

**Paused outbox (#444).** With `LETTER_IRL_OUTBOX_DISPATCH_ENABLED=false` on the API and the maintenance service, neither claims a job, so nothing reaches the provider. A send still commits and queues its job, and the tool answers `currentStatus: pending`, "Queued for the print provider" (mail sent with an arrival date answers `scheduled` while its mail date is ahead, as it would unpaused). Every waiting job keeps its attempts and backoff and goes out on the first maintenance run after the switch is back on. The crash sweeps still run; how a pause shows and how to rehearse it is in [operational-acceptance.md](operational-acceptance.md).

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
