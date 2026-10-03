# MCP Tool API Specifications

**Last Updated:** October 3, 2026  
**Purpose:** Practical reference for the MCP tools exposed by Letter IRL

The runtime MCP registry is the source of truth. The checked-in `manifest.json` is generated from that registry with `npm run manifest:generate`, and submission-facing tests verify that the manifest, widget list, and runtime tool registry stay aligned.

Letter IRL currently exposes **24 tools** and **6 widgets**. Four more are listed only while their switch is on: `request_send` while the send rule is on, `upload_photo_chunk` while card upload is on, and `set_arrival_date` and `cancel_scheduled_mail` while arrival dates are on. So are `request_address`, `get_address_request` and `cancel_address_request`, while address requests are on (#604). The tools are:

## Onboarding

- `get_started`: Show a short getting-started guide with setup steps and example prompts. Read-only. Uses `ui://widgets/GetStartedCard.html@v<N>`.

## Letter Drafts and Sending

All four preview tools accept an optional `sendAsGift` ([gift-letters.md](gift-letters.md)): `true`
sends the draft as the account's gift letter, free and with a printed card for the recipient;
omitted, a gift letter is used only when the balance cannot pay. A gift preview returns `giftCard`
(`state`: `funded` or `unfunded`, and a `description`), and any preview returns
`giftLettersAvailable` when the account has some and a gift letter could pay for the mail. Both are absent while gift letters are off.

While room to write is offered (`LETTER_IRL_ROOM_TO_WRITE_ENABLED` on, with our renderer and Pay & Send, #586),
the three letter previews lay a letter out on up to three pages. A longer letter returns `pages` (2 or 3),
is paid with Pay & Send (`canSendNow` false, its eligibility priced for its pages), and is never a gift
letter: `sendAsGift: true` on it is refused. Only a letter longer than three pages is refused, "too long for
three pages: three pages is the longest letter we print", without line counts. Otherwise every preview is one
page, as before. They also return `wordsVersion`, the version of the letter's words, which `set_letter_words` names. The card also gets `_meta.pageFit`, which never reaches the model: how full the letter's pages are
(pages, sheets, double-sided, each page's lines, and the room left on the last page in lines and about how many
characters), counted before any gift page, for its fit line.

While `LETTER_IRL_ARRIVE_BY_ENABLED` is on, all four preview tools also accept an optional
`arriveBy` (YYYY-MM-DD, #535): the date the mail should arrive by. The preview works back to the
day it goes to the printer, holds the draft to it, and returns `schedule` (`arriveBy`, `mailOn`,
`releasesAt`, `earliestArrival`, `latestArrival`), with `deliveryEstimate` saying when it goes to
the printer. A date too soon, too late or not a date is refused with the dates on offer; an empty
`arriveBy` counts as none. While the flag is off, `arriveBy` is not served, nor in `/manifest.json`;
an app that cached it and passes it anyway is refused, since those four tools then pass unknown
fields through to the preview rather than drop them
([letter-send-flow.md](letter-send-flow.md#confirmed-send-transaction)). Every preview also returns
`arrivalWindow` (`earliestArrival`, `latestArrival`) while the flag is on, with a date or without:
the dates that can be chosen now, for a card's date picker, not when this mail arrives. It is left out
while the flag is off, and when no date can be scheduled.

While certified mail is offered (`LETTER_IRL_CERTIFIED_MAIL_ENABLED` and Pay & Send both on, #625), the three letter previews
also accept `mailService`: `certified` (USPS Certified Mail, which gives a tracking number) or `certified_return_receipt`
(with an electronic return receipt). `standard`, `null`, the empty string and leaving it out are an ordinary letter. While certified mail is offered, any other text is refused (by
the schema's enum, and again as `MAIL_SERVICE_INVALID`) rather than read as one; while it is not offered, anything but those is
refused as `MAIL_SERVICE_NOT_OFFERED`, whatever it says. Both come before anything is created. Certified mail is Pay & Send only: no letter pack, balance or gift letter
pays for it, so the preview's terms are Pay & Send's. The preview returns `mailService` for certified mail only. While certified mail is
not offered the argument is not served, nor in `/manifest.json`; the output field is declared either way, since output schemas are closed.

While stationery is offered (`LETTER_IRL_STATIONERY_ENABLED` on, and `LETTER_IRL_PRINT_RENDERER=pdf`,
#563), the three letter previews also accept:
- `stationery`: `classic` (a plain page), `monogram`, `botanical`, `celebration`, `typewriter` or `handwritten`, in any case.
  Typewriter and Handwritten set the whole letter in a typeface of their own (Cousine, Caveat). Left
  out, the account's last choice is used, or Classic with none: the model leaves it out unless the user asks
  for a style or for a plain page, so an ordinary letter never resets the account's choice. Every theme but Classic prints the preview's date, written out, at the top right.
- `monogram`: for `monogram` only, asked for or remembered. One to three letters, as written; spaces and full stops are dropped.
  Left out, the initials of the return address's name are used, in capitals, skipping titles at its start and suffixes at its end
  ("Dr. Pat Rivera Jr." is PR).
- `headline`: for `celebration` only, asked for or remembered. One line above the letter, which takes three of the page's lines.

A preview that asks for no theme is drawn in the account's remembered one: the theme it last chose,
in a preview's `stationery`, `set_stationery` or the letter card. With nothing remembered, it is
Classic. A theme a preview asks for, Classic included, is remembered once its draft exists. Only the
theme is remembered; initials and a headline belong to one letter.

Each preview then returns `stationery`: its `theme`, the `dateLine`, `monogram` and `headline` it
prints, and `source`, which is `asked`, `remembered` or `default` (Classic, nothing chosen). The
preview's narration names a theme, and says when it was the account's last choice. The refusals say
what to change:
- an unknown theme;
- initials or a headline with a theme that does not print them;
- initials that are not one to three letters;
- a headline too long for its line, with how much of it fits;
- characters the font cannot draw: the text is checked in the typeface its theme sets it in, so
  Handwritten refuses Greek or Hebrew that Classic prints, naming the theme, and suggests another
  stationery when Classic would print the characters. A theme the call did not name, the account's
  remembered one, says so first;
- a letter the headline or the theme's typeface pushes past its page, with the line counts, and the
  ways out that would fit; while room to write is offered, past three pages, without the counts.

While stationery is not offered, the three fields are not served, nor in `/manifest.json`, and
the output has no `stationery`. An app that cached them and passes a theme, initials or a headline
anyway is refused rather than printed on a plain page. Classic is always accepted. Postcards take
none of them.

While signatures are offered (`LETTER_IRL_SIGNATURES_ENABLED` on, and `LETTER_IRL_PRINT_RENDERER=pdf`,
#608), the three letter previews also accept `signature`: whether the letter prints the person's saved
signature ([Signatures](#signatures)) under the sign-off's first line.
- Left out, the account's choice: on once a signature is saved, then as the person last chose in a
  preview. A preview that names it, `true` or `false`, is remembered once its draft exists.
- `true` with none saved is refused (`SIGNATURE_NOT_SAVED`), saying `set_signature` saves one.
- The letter is laid out with it. Its band takes three lines, so a letter that fits only without it is
  refused as too long, and the refusal says it fits with `signature: false`. So does a gift letter's
  refusal, while room to write is offered, when the band is what runs it past one page, and
  `set_letter_words`' refusal of a gift letter's new words.
- Each preview then returns `signature`: `printed`, whether the letter prints it, and `source`: `asked`
  (the call named it), `remembered` (the account's choice) or `none_saved` (the account has none, whatever the call asked). The narration says when the
  account's choice signed the letter, or left it unsigned, and that `set_letter_signature` changes it in
  place, so a model without the card can tell the person.
- The draft keeps its own copy, as the letter was previewed with it, and records renderer `pdf-4`
  whatever its theme. The send copies it into the letter, so replacing or removing the saved signature
  never changes a letter already previewed. `set_stationery` and `set_letter_words` draw the letter
  again with the draft's copy.

While signatures are not offered, `signature` is not served, nor in `/manifest.json`, and the output
has no `signature`. An app that cached it and passes `true` anyway is refused (`SIGNATURES_OFF`) rather
than printed unsigned.
Postcards take no signature.

- `quote_and_preview_letter`: Create a free draft preview for a text-only physical letter. Requires a real U.S. recipient address, `bodyText`, and `signOff`; sender is optional when a saved return address exists. Creates a draft, so it is not read-only. Uses `ui://widgets/LetterPreviewCard.html@v<N>`.
- `quote_and_preview_letter_with_header_image`: Create a free draft preview for a letter with a header image at the top. Accepts an attached image or `imageUrl`. Creates a draft and uses `ui://widgets/LetterHeaderImagePreviewCard.html@v<N>`, which serves the letter card under its own name so the card knows which preview to repeat (#411).
- `quote_and_preview_letter_with_image`: Create a free draft preview for a letter with an enclosed image after the signature. Accepts an attached image or `imageUrl`. Creates a draft and uses `ui://widgets/LetterInlineImagePreviewCard.html@v<N>`, the letter card under its own name for the same reason.
- `send_letter`: Send a letter from a prior draft. Requires `draftId` and `confirm: true`. Idempotent retries with the same draft return the existing order rather than charging twice. The same letter sent, paid for or awaiting payment from the account in the last 24 hours refuses the call unless `sendAnotherCopy: true` is passed, which the model does only after the user asks for another copy ([letter-send-flow.md](letter-send-flow.md#the-same-mail-twice)). Sent with an arrival date (#535), the answer carries `schedule` (`arriveBy`, `mailOn`) and `cancellable`, and while the mail waits for its mail date its status is `scheduled`, with a line saying when it goes to the printer and that it can be cancelled free until then.
- `request_send`: Listed only while the send rule is on ([letter-send-flow.md](letter-send-flow.md)). Returns the letterirl.com page where the person checks a previewed draft and sends it themselves. Sends nothing, and is read-only. For a preview with an arrival date, it carries `schedule` (`arriveBy`, `mailOn`), and its link text says when, once sent, the mail goes to the printer (#535). For a certified draft it carries `mailService` (#625), and its link text says Pay & Send pays for it, never a letter pack or a gift letter.
- `set_stationery`: Listed only while stationery is offered (#563). Changes a letter preview's stationery without previewing again, and the account remembers the theme for its next preview. Takes `draftId` and `stationery` (`classic`, `monogram`, `botanical`, `celebration`, `typewriter` or `handwritten`), and `monogram` and `headline` as the letter previews take them. They are checked in the same words, the text is checked in the theme's typeface, and the letter is laid out again in the theme, so a headline or a wider typeface that pushes it past the pages it may take is refused. The page is drawn again from the draft's own content, with the small copy of its picture and a gift letter's card page as they were, and the draft records it, `pdf-2` for a theme and `pdf-1` for Classic; a letter drawn with a signature keeps `pdf-4`, and its own copy of the signature is drawn again (#608). Returns `stationery`, a `message` that says nothing has been sent, and the page for the card in `_meta`, with `_meta.pageFit` while room to write is offered. It also returns what the letter costs now, since a restyle can change its pages (#586): `pages` above one, `canSendNow`, `reasonCannotSend` and `sendEligibility`; the message says when the pages changed. While room to write is offered, a letter is laid out again on up to three pages and a gift letter on one; otherwise on one. Refused, as `set_arrival_date` is, for a draft that is not the caller's, already sent, expired, or with a live Pay & Send order, and for a postcard or a preview the legacy HTML drew; and when the letter's words, or its signature (#608), changed while its page was drawn (`DRAFT_CHANGED`, #586: try again). Sends nothing. Not read-only, not destructive and idempotent. The cards may call it too (`openai/widgetAccessible`).
- `set_letter_words`: Listed only while room to write is offered (#586). Changes a letter preview's words without previewing again. Takes `draftId`, `bodyText` and `signOff` in full, which replace the preview's, and `wordsVersion`, the version of the words being replaced, from the preview or the last change. The letter card can change the words too, and neither the card nor the model sees the other's call (#366), so a change that names no version, or a version the words no longer have, is refused (`WORDS_CHANGED`), and the refusal gives the words as they are now with their version. A version copied with spaces or quotes round it is taken as it is, and words the draft has already go through whatever version is named, as when a call is retried after its answer was lost; the answer then says the letter already has them. They are checked as the letter previews check theirs (the character cap, what prints, and the page), and laid out again in the draft's own stationery on up to three pages; a gift letter is held to one page, and words that run it past, even past three pages, are refused in a gift's words (`GIFT_LETTER_ONE_PAGE`). The page is drawn again with the small copy of its picture and a gift letter's card page as they were, and the draft records the words, the page and the pages. Returns what the letter costs now: `pages` above one, `canSendNow`, `reasonCannotSend` and `sendEligibility`; the new words' `wordsVersion`; and a `message` that says when the pages changed and that nothing has been sent. A letter brought back to one page that its balance cannot pay adds that a new preview can use the account's gift letter, when it has one, since only a preview decides a gift. The page and `pageFit` go to the card in `_meta`. Refused, as `set_stationery` is, for a draft that is not the caller's, already sent, expired, or with a live Pay & Send order, for a postcard or a preview the legacy HTML drew, and when the stationery, the words or the signature (#608) changed while the page was drawn (`DRAFT_CHANGED`: try again). Sends nothing. Not read-only, not destructive (a draft expires on its own) and idempotent. The letter card's Words tab calls it too (`openai/widgetAccessible`).
- `set_arrival_date`: Listed only while `LETTER_IRL_ARRIVE_BY_ENABLED` is on (#535). Sets, moves or clears a preview's arrival date without previewing again. Takes `draftId`, and `arriveBy` (YYYY-MM-DD), which is checked as the previews check theirs and refused in the same words; left out, the date is cleared and the mail goes to the printer as soon as it is sent. Returns `schedule` (absent once cleared), `deliveryEstimate` and a `message` that says nothing has been sent. Refused for a draft that is not the caller's, already sent, expired, or with a live Pay & Send order, whose payment sends the mail with the dates it has ([letter-send-flow.md](letter-send-flow.md#confirmed-send-transaction)). Sends nothing. Not read-only, not destructive (a draft expires on its own) and idempotent. The cards may call it too (`openai/widgetAccessible`).
- `cancel_scheduled_mail`: Listed only while `LETTER_IRL_ARRIVE_BY_ENABLED` is on (#535). Cancels a letter or postcard sent with an arrival date while it waits for its mail date, free until it goes to the printer. Takes `orderId` and `confirm: true`; without `confirm: true` nothing happens. Returns `status: "cancelled"`, `alreadyCancelled`, `returned` (`kind` `letters` or `gift_letter`, and `count`: whole letters of two credits each, or the gift letter) and a `message`. The message also says when part or none of it came back usable: refunded with its pack, or expired while the mail was held. A repeat answers as already cancelled and returns nothing more. Refused, with a sentence saying what to do, for an order that is not found, has no arrival date, has gone to the printer, is going right now, or is Pay & Send (support email). Destructive, since a cancelled order must be sent again, and idempotent. The cards may call it too (`openai/widgetAccessible`). The website cancels through `POST /api/letters/:letterId/cancel` ([letter-send-flow.md](letter-send-flow.md#confirmed-send-transaction)).
- `get_draft_status`: Card-only: hidden from the model (`ui.visibility: ["app"]`, `openai/visibility: "private"`) and asked by the preview cards in a host that keeps no state for them ([ui-widgets.md](ui-widgets.md)). Says whether a preview's draft is `ready`, `sent` (with its `orderId`), `expired` or `not_found` (#535 for the rest). A ready draft comes with its arrival dates when it has them (`schedule`: `arriveBy`, `mailOn`) and its `deliveryEstimate` with those dates. A sent one says where its order stands, read from the letter, never the draft: `orderStatus` `scheduled` while it waits for its mail date, `cancelled`, or `sent` once the outbox has taken it; its `schedule`; and `cancellable`, which is false for Pay & Send. A letter it cannot read leaves those out. Dates it cannot read are left out rather than refused. Read-only; a draft that is not the caller's reads as `not_found`. While stationery is offered, a ready letter drawn by our renderer also carries its `stationery` now (Classic for a page without a theme), with its page in `_meta.previewHtml`, so a card shown its preview's first answer again draws the style the draft has (#563). A ready letter of more than one page also carries its `pages` now (#586), as a restyle may have changed them. While signatures are offered, a ready letter drawn by our renderer also carries `signature`, whether it prints the saved signature now, with its page in `_meta.previewHtml`, as `set_letter_signature` may have changed both (#608); never the picture. While room to write is offered, a ready letter drawn by our renderer also carries what it costs now (`canSendNow`, `reasonCannotSend` and `sendEligibility`) and its words now (`bodyText`, `signOff` and `wordsVersion`), which the chat may have changed since the card's preview. A ready postcard our renderer drew, while its sizes or layouts are offered, also carries its `size`, its `layout` with its `caption` or `place`, its page in `_meta.previewHtml`, and what it costs now (#594), as set_postcard_style may have changed them.

## Buying Letters and Pay & Send

- `list_letter_packs`: List the packs available to buy, with how many letters each adds and what it costs. Read-only. Packs whose Stripe Price has not resolved are omitted rather than offered, because buying one would fail.
- `create_pack_checkout`: Create a Stripe-hosted checkout for one pack size (`starter`, `regular`, `power`). Payment adds letters to the balance; it does not send anything, so the customer still chooses and sends afterward. Uses `ui://widgets/PackCheckoutCard.html@v<N>`.
- `create_mail_checkout`: Create a Stripe-hosted Pay & Send checkout for one previewed letter or postcard draft. Paying sends that exact item; see [Pay & Send Details](#pay--send-details).
- `get_purchase_status`: Read the status of a pack or Pay & Send purchase by `orderId`. Read-only. Has no widget of its own; `PackCheckoutCard` and the preview cards poll it through `callTool`.
- `redeem_promo_code`: Redeem a promo code, or a gift code printed on a letter, to add letters. A gift code or seed campaign reports `giftLetters`. Returns `redeemed: false` with the reason for an invalid, expired or spent code - an ordinary answer rather than an error.

## Postcards

- `quote_and_preview_postcard`: Create a free draft preview for a physical postcard (a 6x9; a 4x6 or 11x6 too while those are offered) with a front image and back message. Accepts an attached image or `imageUrl`; sender is optional when a saved return address exists. Creates a draft and uses `ui://widgets/PostcardPreviewCard.html@v<N>`.
  - **`size` (#594).** While the 4x6 and 11x6 are offered (`LETTER_IRL_POSTCARD_SIZES_ENABLED`, with `LETTER_IRL_PRINT_RENDERER=pdf` and Pay & Send on), `size` takes `6x9` (the default), `6x4` (a 4 x 6 in postcard) or `6x11` (an 11 x 6 in one).
    - Each is drawn by our renderer at its size, and its back is measured at its size: 16 lines on a 6x9 or an 11x6, 11 on a 4x6.
    - A 4x6 or 11x6 is paid with Pay & Send at its own price, never from a pack or as a gift letter (#579).
    - While they are not offered, `size` is served as before, the 6x9 alone, and the preview refuses any other.
  - **`layout`, `caption` and `place` (#594).** While the layouts are offered (`LETTER_IRL_POSTCARD_LAYOUTS_ENABLED`, with `LETTER_IRL_PRINT_RENDERER=pdf`), `layout` takes `full_bleed` (the default: the photo across the whole front, as before), `border` (the photo in a white border, with an optional handwritten `caption` under it) or `greetings` ("Greetings from" over the photo, with the `place` it needs, printed in capitals).
    - Each layout takes only its own line. A caption without a border, a place without a greeting, and a greeting without a place are refused, each saying what to change.
    - The line is measured at the postcard's size as it prints. One too long is refused, saying about how many of its characters fit; a caption longer than 60 characters, or a place longer than 30, is refused before it is measured. Its characters are checked as the message's are, in the face the line prints in.
    - The draft records the front with `pdf-3`, and the postcard prints with it ([letter-send-flow.md](letter-send-flow.md)). A layout does not change the price, and a gift postcard keeps its front.
    - While they are not offered, the three are not served, and a layout other than `full_bleed`, a caption or a place is refused rather than printed as the photo alone.
  - **`images` and `imageUrls`, a collage (#616).** While collages are offered (`LETTER_IRL_POSTCARD_COLLAGES_ENABLED`), the front can be two to four photos: `images` (attachments in the conversation, a file parameter beside `image`) or `imageUrls` (links), in the order they should appear. Never both lists, and never beside `image` or `imageUrl`.
    - The arrangement follows the count: two side by side; three, one large on the left with two stacked beside it; four, two by two, with white margins and gutters ([image-support.md](image-support.md#1-postcard-images)).
    - The photos are drawn as one picture at the postcard's size, so a collage is stored and printed as a single photo's crop is, costs what a postcard costs, and takes `layout`, `caption` and `place` as a photo does. A collage keeps the size it was made at: its photos are not kept, so `set_postcard_style` refuses another size for it (`COLLAGE_SIZE`), saying to preview again with the same photos, while its front (`layout`, `caption`, `place`) can still change.
    - The count, the two lists and an attachment the host did not resolve are checked before anything is downloaded, each refusal saying what to send instead. A photo that cannot be used is named by its place ("The second photo: ...").
    - A list left empty or holding only blanks, or a blank string where a list belongs (a host sends "" for an argument left unset, and may send the others), is no collage: the preview carries on as a single photo's, with `image`, `imageUrl` or the account's recent upload. A blank photo beside a real one inside `images` is one the host did not resolve, and is refused by its place. An account makes one collage at a time (two run at once across accounts): a second preview while one is running is refused with the busy sentence, "You have other images still processing. Please wait for them to finish and try again."
    - While collages are not offered, `images` and `imageUrls` are not served (and `images` is not a file parameter), and one sent anyway is refused rather than printed as one photo.
  - **The answer names the size and front (#594),** each while it is offered: `size`, and `layout` with its `caption` or `place`. A collage also names `collagePhotos`, how many photos the front draws. The postcard maker on the card reads them to offer its choices, and `set_postcard_style` changes them; for a collage the maker names the photos and offers no other size.
- `send_postcard`: Send a postcard from a prior draft. Requires `draftId` and `confirm: true`. Idempotent retries with the same draft return the existing order rather than charging twice. Refuses the same postcard sent recently unless `sendAnotherCopy: true` is passed, as `send_letter` does. Sent with an arrival date, it answers as `send_letter` does.
- `set_postcard_style`: Listed only while the postcard sizes or layouts are offered (#594). Changes a postcard preview's size or front without previewing again; the postcard maker on the card calls it too (`openai/widgetAccessible`).
  - **Takes** `draftId`, with `size` while the sizes are offered and `layout`, `caption` and `place` while the layouts are, as the postcard preview takes them. A size or layout left out stays as it is; a layout given replaces the front, so a caption is kept only when given again.
  - **Checks** each as the preview does, at the postcard's size. A front kept at a new size is measured again there, and a message the new size's back cannot hold is refused (`MESSAGE_TOO_LONG`). A gift postcard stays a 6x9 (`GIFT_POSTCARD_SIZE`).
  - **Draws** the front again. At the same size the back is kept as it was, a gift card's strip with it. At a new size the picture is cropped again, from its source while that still opens and otherwise from the copy the draft prints from, and the back is laid out at the size. A collage has no source and is not cropped again: it keeps its size.
  - **Records** the size, the front and the version that goes with it (`pdf-3` with a front, `pdf-1` without), under the lock a send and a Pay & Send checkout take.
  - **Returns** `size`, and `layout` with its `caption` or `place`. It also returns what the postcard costs now (`canSendNow`, `reasonCannotSend`, `sendEligibility`; a 4x6 or 11x6 is paid with Pay & Send), and a `message` that says nothing has been sent. The postcard drawn again goes to the card in `_meta`. The same style again changes nothing, and says so.
  - **Refused**, as `set_stationery` is, for a draft that is not the caller's, already sent, expired, or with a live Pay & Send order. Also for a letter (`DRAFT_NOT_A_POSTCARD`), a preview the legacy HTML drew, and a draft another change redrew meanwhile (`DRAFT_CHANGED`: try again). Sends nothing. Not read-only, not destructive, and idempotent.
  - **Its own refusals:**
    - neither the sizes nor the layouts offered (`POSTCARD_STYLES_DISABLED`);
    - a call naming nothing to change (`STYLE_MISSING`);
    - a size not offered (`SIZE_NOT_OFFERED`);
    - a gift postcard asked off 6x9 (`GIFT_POSTCARD_SIZE`);
    - a collage asked for another size (`COLLAGE_SIZE`, #616): its photos were read once and are not kept, so it cannot be arranged again. A collage is the draft with a picture and no source address, as every single photo's draft records its link;
    - a message too long for the new back (`MESSAGE_TOO_LONG`);
    - a picture that cannot be cropped again (`PICTURE_UNAVAILABLE`), or the image service busy, which says so rather than cropping the smaller stored copy;
    - a stored picture or front the print cannot read (`DRAFT_NOT_DRAWN`).

    A front is refused as the preview refuses it. A front the postcard keeps, too long for a new size's line, says it is the postcard's own, and to give a shorter one with the size.
  - **Its description** names only what is offered: the size, the front, or both.

## Address Requests

Listed only while `LETTER_IRL_ADDRESS_REQUESTS_ENABLED` is on (#604, concept 10 in [letter-creator-vision.md](letter-creator-vision.md)), and each refuses while it is off (`ADDRESS_REQUESTS_OFF`). The table is `address_requests` ([database-schema.md](database-schema.md#address_requests)). The recipient's page is the website's `/address#<token>` (website #55); its public routes are below.

- `request_address`: Makes a private link asking someone for their U.S. mailing address, when the person wants to send them mail and does not know it. Letter IRL never contacts the recipient: the person shares the link themselves.
  - **Takes** `recipientName` (what the person calls them, up to 100 characters; the envelope's name unless the recipient gives another; never shown on the page) and `senderFirstName`.
  - **The first name** is one or two words of letters, joined by a space or a hyphen, up to 40 characters, with apostrophes inside a word and a full stop only at its end ("J.") or in initials ("J.R."). The page shows it to someone the sender chose, so nothing may read as a link, and little as a message.
  - Without `senderFirstName`, the first word of the saved return address's name is used, unless it is a title or "The" ("Dr.", "Mrs", "The Smiths"). With neither, it is refused (`SENDER_NAME_REQUIRED`).
  - **Returns** `requestId`, `status: "waiting"`, `url` (`<website>/address#<token>`), `recipientName`, `senderFirstName`, `expiresAt` and a `message` with the link and when it stops working ("October 9 at 10:00 AM EDT").
  - **The link** is given only here: the server keeps the SHA-256 of its 144-bit token. The token is in the fragment, which a browser never sends, so it stays out of HTTP access logs; the page posts it to the API itself.
  - **It works** once and for `LETTER_IRL_ADDRESS_REQUEST_LINK_DAYS` days (default 7).
  - **Caps per account:** 10 waiting (`TOO_MANY_WAITING`) and 20 in 24 hours (`TOO_MANY_TODAY`), set by `LETTER_IRL_ADDRESS_REQUEST_WAITING_CAP` and `LETTER_IRL_ADDRESS_REQUEST_DAILY_CAP`. The description says each call makes a new link counted against them.
  - **An account erased** while the call waited for its lock is refused as any closed account is.
  - Not read-only (it records a request), not destructive, not idempotent: each call makes a new link.
- `get_address_request`: What became of a request, by `requestId`, for the account's own requests only (`REQUEST_NOT_FOUND`).
  - `status` is `waiting`, `answered`, `declined`, `cancelled` or `expired` (a waiting request past `expiresAt`).
  - Once answered, `recipient` is the address given, in the shape a preview tool's `recipient` takes, and the text gives it on one line too.
  - Read-only. On `mail:draft`, not `mail:read`, as its answer is a third party's address.
- `cancel_address_request`: Closes a waiting request by `requestId`, so its link stops working. One already answered, declined, cancelled or expired is left as it is (`alreadyClosed: true`). Destructive, since the link cannot be restored, and idempotent.

The server instructions add, while these are listed, that `request_address` is the way when the person does not know the recipient's address, and never to guess one (steering r35).

**The page's public routes** (`src/api/addressRequestApi.ts`, #604). They need no sign-in, and each takes the token in a JSON body, never in the path or the query. The page reads the token from the link's fragment.
- `POST /api/public/address-requests/page` with `{ token }` answers `{ state, senderFirstName, expiresAt }`, nothing else.
- `POST /api/public/address-requests/answer` with `{ token, address: { name?, addressLine1, addressLine2?, city, state, postalCode } }`:
  - **The link is checked first,** so a used or expired one costs no verification.
  - **The fields** are trimmed and bounded (name, lines 100 characters, city 60), with no hidden characters and nothing Open Sans cannot print. `state` is a USPS state, territory or freely associated state code (FM, MH, PW), or a military post office's. `postalCode` is a ZIP or ZIP+4; nine digits without the hyphen are taken as ZIP+4. A wrong field answers 400 `{ reason: "invalid", fields }`.
  - **PostGrid's verification** then runs under the preview's policy: a corrected address is kept corrected; one USPS cannot reach answers 422 `{ reason: "undeliverable", message }`; one the service cannot check goes ahead as given.
  - **A link may spend 10 verifications a day** (in memory, per process). An unreachable address leaves the link waiting, so without the budget one link could drive paid checks at the routes' global rate. Past it, 429 `{ reason: "too_many_tries" }` with `Retry-After` (the seconds until the link may spend one again), before PostGrid is asked.
  - An absent name or line 2 is left out. The envelope then carries the name the sender gave.
- `POST /api/public/address-requests/decline` with `{ token }`.
- **Outcomes:** 200 `{ ok: true }` when done. 409 `{ reason }` for a link already answered, declined, cancelled or expired. 404 `{ reason: "not_found" }` for an unknown link, and for everything while the feature is off.
- **Limits:** a 4 KB body (413), read within 30 seconds (408), and the `address_public` rate limits (20 a minute per IP, 200 in all). Answers are `no-store` and `no-referrer`.
- **Logs** carry an outcome and an error class only: never the token, a name or an address.

## Signatures

Listed only while signatures are offered (#608, concept 3 in [letter-creator-vision.md](letter-creator-vision.md)): `LETTER_IRL_SIGNATURES_ENABLED` is on and `LETTER_IRL_PRINT_RENDERER=pdf`, since only our renderer can draw one. Each refuses otherwise (`SIGNATURES_OFF`). The table is `user_signatures` ([database-schema.md](database-schema.md#user_signatures)). Letters print the saved signature under the closing (#608, parts 2 to 4), and the flag is on in development only until the owner's word.

- `set_signature`: Saves a picture of the person's handwritten signature for their account, in place of any saved before.
  - **Takes** `image` (a file attached in ChatGPT, through `openai/fileParams`) or `imageUrl` (a link, or `letterirl-upload:latest` for the account's own upload through the card), the file first. Neither is refused (`SIGNATURE_PICTURE_REQUIRED`), and a file the server cannot open is refused as such (`SIGNATURE_PICTURE_UNREADABLE`).
  - **The picture** is fetched as a letter image is (at most 5 MB), then cleaned (`src/services/signatureImage.ts`):
    - turned upright by its EXIF orientation, transparency flattened onto white, and looked at no larger than 1600 px;
    - each pixel divided by the paper's light at that point, estimated by a grey-level closing (a maximum then a minimum filter over a window a twentieth of the longest edge, wider than a pen stroke). A grey sheet, a gradient, a hard shadow or a desk at the edges goes white, edges included, and the ink stays dark. The window is the trade-off: a straight stroke as wide as it (about 5 mm) is taken for paper, and a dark band narrower than it next to the signature (a pen's shadow, a printed rule) for ink. Paper darker than a quarter of white, such as a phone beside the sheet, holds no ink. Light ink on a dark sheet is not refused as such ([#611](https://github.com/dnobj/mail-letter-irl/issues/611)): the closing takes light strokes for paper, so the dark sheet between their bends reads as ink. Such a picture may be refused by the checks below, or saved as those shapes (at a phone's size, usually a blob under 600 px wide), which the person sees in the letter's preview before it prints;
    - the ink's connected pieces found: the largest and those near it are kept, and a stray mark is whitened and left out of the crop;
    - cropped to what was kept, and fitted inside 1200 x 400 px, as a grayscale PNG. A 16-megapixel photograph takes about half a second, most of it the closing, on the event loop.
  - **Refusals**, in words the person can act on:
    - `NO_SIGNATURE_FOUND`: under 300 px of ink as looked at, as blank paper gives;
    - `NOT_A_SIGNATURE`: ink filling more than a third of its own box, as a photograph's detail does;
    - `SIGNATURE_TOO_SMALL`: a picture under 150 x 50 px, or ink under 60 px wide.
  - **Returns** `saved: true`, `replaced`, and the cleaned `width` and `height`, and a `message`, which says when the signature came out under 600 px wide and so prints softly. The cleaned picture goes to a card in `_meta.signatureImage`, never to the model.
  - Saving one turns it on for the account's next previews (`use_by_default`), which print it unless they say `signature: false` (above). Destructive (the signature before cannot be brought back), not idempotent.
- `get_signature`: Whether a signature is saved: `saved`, and when one is, its `width`, `height` and `savedAt`; the picture in `_meta.signatureImage`. Read-only, on `mail:read`.
- `clear_signature`: Removes the saved signature, with `confirm: true` (`CONFIRM_REQUIRED` without it). Returns `removed`, false when none was saved. Letters already previewed keep their own copy. Destructive and idempotent.
- `set_letter_signature`: Signs or unsigns a letter preview without previewing it again (#608 part 4).
  - **Takes** `draftId` and `signature`: `true` prints the saved signature under the closing, `false` takes it off.
  - **Lays the letter out again** with or without the signature's three lines, in its own stationery, on up to the pages a preview may take (a gift letter on one). A signature with no room is refused (`SIGNATURE_NO_ROOM`), and `true` with none saved is refused (`SIGNATURE_NOT_SAVED`).
  - **The draft** keeps a copy of the signature as it is saved now, or none. It records `pdf-4` with one, or `pdf-2` or `pdf-1` by its stationery without, and the account remembers the choice for its next letter preview.
  - **Returns** `signature` (`printed`, and `source: asked`), what the letter costs now (`pages` above one, `canSendNow`, `reasonCannotSend` and `sendEligibility`) and a `message` that says when the pages changed and that nothing has been sent. The page and `pageFit` go to the card in `_meta`.
  - **Refused**, as `set_stationery` is, for a draft that is not the caller's, already sent, expired, or with a live Pay & Send order; for a postcard or a preview the legacy HTML drew; and when its words, stationery or signature changed while its page was drawn (`DRAFT_CHANGED`: try again).
  - Sends nothing. Not read-only, not destructive, and idempotent, on `mail:draft`. The letter card may call it (`openai/widgetAccessible`).

**The website's routes** (`src/api/signatureApiHandler.ts`), the same service and scopes as the tools, and 404 while signatures are not offered:
- `GET /api/signature` (`mail:read`): `{ saved: false }`, or `{ saved: true, width, height, savedAt, image }` with the picture as a PNG data URI. `no-store`.
- `POST /api/signature` (`mail:draft`) with `{ image: <PNG, JPEG or WebP data URI> }`, a body of at most `LETTER_IRL_SIGNATURE_BODY_LIMIT_BYTES` (4 MB): cleans and saves it, and answers as GET does with `replaced`. 400 for a body that is not a picture; 422 `{ reason, message }` for a cleaning refusal or a picture that cannot be opened; 413 too large; 408 too slow; 503 when the image service is busy.
- `DELETE /api/signature` (`mail:draft`): `{ removed }`.

## Account, Orders, and Return Address

- `get_profile`: The profile ChatGPT records for a connected account - a stable account id and the confirmed email address. Marked `_meta["openai/profile"]`, which is how ChatGPT finds it; called by ChatGPT with the connection's credentials when it links an account; the model can call it too; the narration carries only the address, while the id travels in `structuredContent` (#424). Read-only.
- `get_account_balance`: Check remaining pre-paid letter sends plus image-generation quota metadata, and `giftLettersRemaining` when the account holds gift letters (not counted in `lettersRemaining`). Read-only.
- `list_orders`: List recent mailed letters and postcards (recipient, delivery status; ids for `get_order_status`) and letter pack purchases (payment status, letters, amount; ids for `get_purchase_status`). Mail sent with an arrival date also carries `arriveBy`, `mailOn` and `cancellable`, and reads as `scheduled` while it waits for its mail date (#535, [status-labels.md](status-labels.md)). An order sent as USPS Certified Mail also carries `mailService` and, once the status sync has stored USPS's number, `carrierTrackingNumber` and `carrierTrackingUrl` (#625). Read-only.
- `get_order_status`: Retrieve the latest timeline for a specific order, or the most recent order when `orderId` is omitted. Mail sent with an arrival date also carries `arriveBy`, `mailOn` and `cancellable`, reads as `scheduled` while it waits, and its timeline says when it goes to the printer. An order sent as USPS Certified Mail also carries `mailService`, `certifiedNote` (worded by where the order stands: the service, the USPS tracking number and link or that it is not here yet, or that none is coming for a letter that did not go out, and for a return receipt that it is USPS's record, which Letter IRL does not send), the number as `carrierTrackingNumber` and `carrierTrackingUrl`, and `trackingSupport: carrier_tracking` once it has the number (#625). These are shown whatever the flag says: a sent letter is a fact. Read-only.
- `set_return_address`: Validate and save the user's default return address for future letters and postcards.
- `get_return_address`: Retrieve the saved return address. Read-only.
- `clear_return_address`: Clear the saved return address. Requires `confirm: true` and is marked destructive, as are `send_letter`, `send_postcard`, `set_return_address`, `create_mail_checkout` and `create_pack_checkout` (irreversible outcomes: mail that cannot be recalled, an overwritten address, a payment; see [learnings/tool-annotation-decision.md](learnings/tool-annotation-decision.md)).

## Images

- `generate_image_for_mail`: Uses `ui://widgets/ImageRoutingCard.html@v<N>`. Hybrid image tool for requests addressed to Letter IRL. With Letter IRL image generations remaining (pack/JIT grants plus a one-time starter allowance) it generates in-turn via the OpenAI Images API and returns an imageUrl for previews; with none left, or past the global daily ceiling, it returns a redirect card with a copy-ready prompt for free built-in generation. Never hard-fails. See docs/learnings/generate-image-removal-decision.md Addendum 3.
- `upload_image`: Open the image upload widget as a fallback when direct attachment or `imageUrl` handoff does not work. Uses `ui://widgets/ImageUploadCard.html@v<N>`. Its `cardUploadAvailable` tells the card whether it may send the photo itself in an app with no file store (#474), which is true only while `LETTER_IRL_CARD_UPLOAD_ENABLED` is on. Its `context` is what the photo is for: `postcard`, `header_image` or `inline_image`. A model may describe it in its own words instead (in CLIENT-01 step 14 Claude sent a whole sentence), so the server reads such a description as one of the three, or as none (`src/utils/uploadContext.ts`), before the card or the recent upload sees it.
- `confirm_uploaded_image`: Internal widget relay that confirms an uploaded image and returns the `imageUrl` plus next-step guidance. Its `context` is read the same way, so a context in other words no longer keeps the recent upload from matching its preview.
- `upload_photo_chunk` (#474, phase 3): the upload card's way to send a photo in an app with no file store, such as Claude.
  - **Who sees it:** listed and callable only while `LETTER_IRL_CARD_UPLOAD_ENABLED` is on. Off, it is not registered, so a call gets the MCP SDK's "not found" error, and a card drawn before the switch went off says upload is not available. Card-only, like `get_draft_status`: hidden from the model, and called by the card with no prompt. It needs the drafting scope (`mail:draft`), and the photo is always the caller's own.
  - **Input:** `uploadId` (a UUID the card makes), `index`, `total` (at most 24), `data` (base64, at most 512 Ki characters, a multiple of 4), and optionally `context` (`postcard`, `header_image` or `inline_image`).
  - **Order:** chunks go in order. The first chunk of a new upload replaces any the account left unfinished. A chunk sent again is answered as before and starts nothing. That holds for the chunk just received, and for any chunk of an upload being finished or just finished, which waits for that upload's answer. While the account's last photo is still being saved, a new upload is refused with "Your last photo is still being saved. Please try again in a moment.", so the last upload started is the photo held. The card waits for each answer, so it meets this only when an answer was lost and the person starts another photo while the last is still being saved; the sentence tells them what to do. A chunk out of order drops the upload with "That upload was interrupted. Choose the photo again."
  - **Answer:** `{uploadId, received, total, done}`, plus the photo's `width` and `height` once `done`.
  - **The photo:** on the last chunk the server checks the photo by its own bytes (an image of a kind it takes, big enough to print, within the decode limits). It then stores it privately, as the account's **only** uploaded photo, replacing the one before. It records `letterirl-upload:latest` as the account's recent upload, so the next preview with no image uses the photo. The image service resolves that reference only to the photo of the account the preview is for. It is never served at an address, and it is kept 15 minutes.
  - **Limits per account:** one upload in progress or being saved; at most 8 MiB of photo; ten minutes to send it; `LETTER_IRL_PHOTO_UPLOADS_PER_DAY` uploads started in a rolling 24 hours (default 20; a chunk sent again does not count). Across the process, at most 64 MiB of chunks and photos being kept are held at once ("Photo uploads are busy right now. Please try again in a minute."). The chunks are held in the API process's memory, so a restart mid-upload means choosing the photo again.
  - **Errors:** every refusal is a sentence the card shows as it is. So is the image service's, for a photo it will not take. Any other failure, such as the image store being down, is logged by its class and answered "The photo could not be kept just now. Please try again."

## Feedback

- `submit_feature_request`: Capture unsupported formats, workflows, integrations, or product-improvement requests.

## Pay & Send Details

### `create_mail_checkout`

Input: `{ draftId: string, sendAnotherCopy?: boolean }`.

Creates or reuses the one active hosted checkout for an authenticated user's
pending letter or postcard draft. The tool never accepts a price, currency,
Stripe Price ID, recipient, or mail content. It returns the commerce `orderId`,
hosted `checkoutUrl`, exact server-configured amount/currency, product
description, expiry, and current order status. Payment is authorization to mail
the immutable draft; the model must not call `send_letter` or `send_postcard`
after payment. A new checkout for mail sent, paid for or awaiting payment in the
last 24 hours is refused unless `sendAnotherCopy` is true
([letter-send-flow.md](letter-send-flow.md#the-same-mail-twice)). A draft whose pages,
and so its price, changed while the checkout was being made is refused before any
order (`DRAFT_CHANGED`, #586), so trying again charges the price it has now. And an earlier checkout,
whose window passed before new words or a restyle changed the letter's product, is not reused: it is
refused (`PREVIOUS_CHECKOUT_CLOSING`) until Stripe's webhook cancels it, usually within minutes, or the
hourly sweep does when the webhook is missed.

While the send rule is on, the tool is card-only like the send tools (#475):
the preview card's **Pay & Send** button calls it, and no app shows it to its
model. It is listed only for an app that takes purchases (ChatGPT today). As
a guard for a future app, a call from one that takes no purchases, shows no
card, or can't keep card-only tools from its model answers with the
confirmation link instead ([letter-send-flow.md](letter-send-flow.md#who-can-send-the-send-rule-470)).

### `get_purchase_status`

Input: `{ orderId: string }`.

Returns sanitized, owner-scoped purchase state: `pending_payment`, `processing`,
`submitted`, `payment_failed`, `refund_pending`, `refunded`, `on_hold`, or
`cancelled`. It exposes no card, billing, address, content, or raw Stripe data.

For a letter-pack order it also returns the pack's figures, absent (never
null) on Pay & Send orders: `letters` in the pack, `lettersRemaining` still on
the account (active and unexpired), `lettersRefunded` returned as cash so far,
`perLetterCents` (the pack price divided by its letter count, rounded down),
`refundableAmountCents` (what a proportional refund of the remaining letters
would come to, `0` unless the pack is fulfilled and untouched by an earlier
proportional refund), and `amountRefundedCents`. These are the numbers an
operator reads before touching a refund in Stripe (#323). The pack message
never says a refund will be issued; refund requests go to
`support@letterirl.com` with the order id, and a person decides.

### Preview eligibility

Preview tools retain `canSendNow` for compatibility and now also return
`sendEligibility`, containing prepaid eligibility, Pay & Send availability and
exact price, and the configured letter-pack destination.

## Schema Notes

- Three files define tool schemas, and they reach different places:
  - `src/zodSchemas.ts` holds the Zod input and output shapes that `src/mcp/registerTools.ts` passes to `mcpServer.registerTool`. The SDK turns them into the JSON Schema returned by MCP `tools/list`, which is what ChatGPT reads, and validates calls against them. **A contract change that ChatGPT must see goes here.** `src/contracts/outputConformance.ts` proves at compile time that each tool's output type matches its served output schema.
  - `src/schemas.ts` holds the JSON schemas on each tool module's definition object. `/manifest.json` and the checked-in `manifest.json` are generated from these, not from the Zod shapes, so the two must be changed together.
  - `src/mcp/toolSchemas.ts` holds Zod input schemas that type the registration maps and back `tests/unit/mcp/schemaConsistency.test.ts`. Nothing serves them.
- Registration iterates the tool list in `src/server.ts` and **silently skips** any tool missing from the Zod input or output map in `registerTools.ts`.
- Adding a tool therefore touches: `src/tools/<tool>.ts`; its export in `src/tools/index.ts`; the `tools` array in `src/server.ts` (order matters, see [learnings/openai-app-sdk-notes.md](learnings/openai-app-sdk-notes.md)); `src/zodSchemas.ts` and both maps in `src/mcp/registerTools.ts`; `src/schemas.ts`; `src/mcp/toolSchemas.ts`; then `npm run manifest:generate` and `npm run test:submission`.
- Tool responses split data intentionally:
  - `structuredContent`: compact model-facing fields validated by the runtime output schema.
  - `content`: short model narration.
  - `_meta`: widget-only fields such as preview HTML and compressed letter-image previews.
- Preview tools create database draft records, so they are write tools even though they do not send mail or charge the user.
- Send tools require a draft and explicit confirmation. The assistant must not claim mail was sent unless the corresponding send tool succeeds.

## Verification

Run these after tool, schema, or widget changes:

```bash
npm run manifest:generate
npm run test:submission
```
