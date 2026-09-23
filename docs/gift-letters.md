# Gift Letters

**Last Updated:** 2026-09-17
**Purpose:** How gift letters work: the entitlement, the printed card, the codes, the cost bound, and how to run the programme
**Status:** Built behind `LETTER_IRL_GIFT_LETTERS_ENABLED` (off by default); not yet enabled in any environment

---

## Overview

A **gift letter** is a free send that prints a card for the recipient. On a letter the card is an extra page; on a postcard it is a strip across the foot of the message side.

While a gift letter has **budget** left, its card carries a code the recipient can use to send a letter of their own, which is itself a gift letter with one less budget. When the budget reaches zero the card only says the letter was sent with Letter IRL. That is the whole growth loop: the product's own artifact, arriving at a real address from someone the recipient knows, carries the invitation, and the only cost is the postage on the free letters.

Customers only ever see **letters** and **gift letters**, never credits (see [App Submission Checklist](app-submission/owner-checklist.md)).

## The entitlement

Gift letters live in `gift_letters`, not in the credit ledger. A ledger lot would join the FIFO spend order and could be spent on an ordinary letter, which is not what a gift is for, and `credit_source_type` cannot gain a value in a transactional migration ([db/README.md](../db/README.md)). They follow the `image_entitlements` precedent instead: a separate entitlement, granted idempotently per `(source, source_reference_id, grant_index)`, always under the account lock.

| Source | Granted by | Budget |
|--------|-----------|--------|
| `pack_purchase` | Every letter pack, while the programme is on | `giftGenerationsRemaining` in [products.ts](../src/config/products.ts) (1) |
| `chain_redemption` | Redeeming a chain code | The code's budget: the sender's less one |
| `seed_redemption` | Redeeming a seed campaign | The campaign's `gift_generations_remaining` |
| `operator` | The admin panel's `gift.grant` | Chosen by the operator (default 4) |
| `send_failed` | A gift send the provider refused | The same as the gift it replaces |

A pack bought while the programme is off grants none, and turning the programme on later does not backfill.

## The card

Every gift letter prints a card. Which one depends on the gift letter being sent:

| Condition | Card | Code |
|-----------|------|------|
| Bound by an operator to a live seed campaign | Funded | The campaign's own code, multi-use |
| Budget above zero | Funded | A new chain code, single-use, worth one gift letter with budget less one |
| Budget zero | Plain ("Sent with Letter IRL") | None |

The code is minted **inside the send transaction**, never at preview time, so abandoned drafts leave no redeemable codes behind. The preview draws a placeholder where the code will print.

The fine print follows the code. A chain code's card says "The code works once." ("One use." on a postcard). A seed code is shared on purpose, so its card says "Each person can use the code once, while it lasts." ("One use per person, while it lasts."). When the campaign is limited to new accounts, it adds "For new Letter IRL customers." On a postcard the strip says "New customers only. One use per person.", so its fine print stays at two lines. The redeem rule counts anyone with a purchase or spend on record as not new, however recent the account, so the card says customers, not accounts. The preview shows the same wording as the print.

### Chain codes

8 characters of Crockford base32 (no I, L, O or U), printed as `XXXX-XXXX`. When read back, `O` is taken as `0` and `I` and `L` as `1`. 32^8 is about 1.1e12, and the public lookup shares the promo rate limit, so guessing one is not practical. The code is also the redeem link: `https://letterirl.com/g/K7M2QX9A`.

**Branching factor 1.** `gift_codes.gift_id` and `gift_codes.letter_id` are both unique: each gift letter prints at most one code, and each code grants at most one gift letter. A chain is therefore a path, not a tree, and **the free letters descending from any grant are at most its budget**. This is the cost bound, and it holds whoever redeems each code.

A chain code is never minted if a promo campaign's code reads as it once normalised (`WELCOME5` reads as `WE1C0ME5`), because redemption tries chain codes first; the admin panel likewise refuses to create a campaign whose code reads as an existing chain code.

### Seed codes

A seed code is an ordinary promo campaign with `gift_generations_remaining` set. It is multi-use by design: a press or influencer letter is photographed and shared, and a single-use code would turn away everyone after the first reader. Its bound is the campaign's `max_total_redemptions`. An operator makes seeded letters print it by granting gift letters with the campaign code filled in.

### Print

- **Letters:** a page break, then the card in the upper half of the second sheet. PostGrid prints its integrity QR and sequence ids in the bottom-left corner of letter pages, and the card stays clear of it. The second page is an extra B&W page (about +$0.10); the letter stays single-sided and black and white.
- **Postcards:** a strip at the foot of the left (message) half; PostGrid owns the right half. The message limit drops from 500 to 350 characters on a gift postcard.
- **QR:** version 3 at error correction Q, 1.4in on letters and 0.95in on postcards, with a four-module quiet zone, drawn as inline SVG `<rect>` runs at render time from the code written into `letters.content.giftCard`. It is never stored as an image: `duplicateMailService` fingerprints mail by the MD5 of the image columns, and an image layout switches on colour printing.
- **Fallback:** `LETTER_IRL_GIFT_QR_FORMAT=png` embeds a PNG instead, if a test print shows PostGrid's renderer mishandling inline SVG.
- Print and preview draw the card with one renderer, [giftCardRenderer.ts](../src/services/giftCardRenderer.ts), so they cannot drift.
- The **DIY** provider prints nothing itself, so it prints no card.

## Sending a gift letter

The preview decides, because the preview has to show the page that will print.

- `sendAsGift: true` sends as a gift letter; it is refused if the account has none, or the programme is off.
- `sendAsGift` omitted uses a gift letter **only when the balance cannot pay**. Someone with letters is never switched to a gift without asking.

The draft records the decision (`letter_drafts.is_gift_send`) and `send_letter` / `send_postcard` honour it: inside the one send transaction the gift is consumed under the account lock, then the per-account and global mail caps, the daily gift budget and the #412 duplicate guard run, and a refusal rolls the gift back. Pay & Send refuses a gift draft before any charge (`DRAFT_IS_GIFT`). See [Letter Send Flow](letter-send-flow.md).

## Redeeming a code

One entry point, [codeRedemptionService.ts](../src/services/codeRedemptionService.ts), serves every surface:

| Surface | Route |
|---------|-------|
| The website's claim page and promo box | `POST /api/promo/redeem` |
| ChatGPT | `redeem_promo_code` |
| The claim page before sign-in | `GET /api/public/gift/:code`: validity, kind and redeem-by date only, never the sender |

Chain codes are tried first (one primary-key read); anything else goes to promo campaigns, which covers seed codes and ordinary codes. Nothing depends on ChatGPT: a person can claim on the website and the entitlement waits in the account. A web composer, if one is built, is a new route over the same send service.

The claim page is `letterirl.com/g/<code>` (the QR) or `letterirl.com/g` with the code typed in. It stores the code in a cookie across sign-in and redeems it on the first dashboard load, the same pattern as the preview gate's pending promo code.

## Rules

| Rule | Applies to | Why |
|------|-----------|-----|
| Budget decrements by one per hop; branching factor 1 | Chain codes | The cost bound |
| `max_total_redemptions`, `max_per_user`, `requires_new_user`, window | Seed codes | The existing campaign controls |
| One claim per normalised email (lower case, no `+tag`, no Gmail dots) | Seed codes | Multi-use codes are where one person with several accounts costs money |
| The sender cannot redeem their own code (same account or same mailbox) | Chain codes | Protects the recipient it was printed for |
| Daily gift budget, fails closed, 0 is a kill switch | Every gift send | The ceiling on what the programme can spend in a day |
| Programme flag, off unless explicitly on, off on a typo | Everything | It gives mail away |

**Rules considered and not applied.** The plan listed one redemption per email for life, a new-account gate and one code per destination address for chain codes as well. Because a chain code grants the same thing whoever redeems it, none of those changes what a chain costs, and each blocks a legitimate case: someone who receives gifts from two friends, or a paying customer who receives one. The destination rule would also have kept a hash of a recipient's address beyond the 90-day content retention. They can be added later if abuse appears that the budget does not already bound.

## Failure, refunds and disputes

- **Provider refuses the piece:** the code on it is voided (`send_failed`) and a replacement gift letter with the same budget is granted, once, keyed by the letter. The replacement lives at least a fresh `LETTER_IRL_GIFT_LETTER_TTL_DAYS`, so a gift used at the end of its life does not come back already expired. Nothing is returned if the code has already been redeemed (the letter evidently arrived) or the purchase that granted the gift was reversed. `isLetterAlreadyCompensated` counts either as compensation, so an operator retry cannot re-mail it.
- **Pack refund:** a whole-pack refund, or a proportional refund that takes every letter left, revokes the pack's unsent gift letters and marks sent ones `source_reversed_at`; printed codes stay valid, because the recipient did nothing wrong. A proportional refund that leaves letters behind leaves the gift with them.
- **Pack dispute:** as a refund, and unredeemed codes the pack's letters printed are also voided, which stops the chain at its first hop.
- **Known limitations:** a dispute later won restores the pack's credits but not its gift letters. Deleting the sender's account deletes their letters and so the codes printed on them; a recipient holding one is told it is not found.
- **Lock order:** `gift_letters.source_order_id` is deliberately not a foreign key. The failed-send return writes it while holding the account lock, and a foreign key would lock the order after the account, the reverse of the refund path (#288).

## Settings

| Variable | Default | Meaning |
|----------|---------|---------|
| `LETTER_IRL_GIFT_LETTERS_ENABLED` | off | The programme. Only an explicit `true`, `1`, `yes`, `on` or `enabled` turns it on |
| `LETTER_IRL_GIFT_DAILY_SEND_CAP` | 20 | Gift sends per UTC day, all accounts. 0 stops them |
| `LETTER_IRL_GIFT_CODE_TTL_DAYS` | 90 | How long a printed chain code stays redeemable |
| `LETTER_IRL_GIFT_LETTER_TTL_DAYS` | 180 | How long an unsent gift letter lasts |
| `LETTER_IRL_GIFT_OPERATOR_GENERATIONS` | 4 | The budget `gift.grant` uses when the operator names none |
| `LETTER_IRL_GIFT_LANDING_BASE_URL` | `https://letterirl.com` | The website the QR opens. Not `LETTER_IRL_PUBLIC_BASE_URL`, which is this API. Written into the letter at send time, so the maintenance service never reads it |
| `LETTER_IRL_GIFT_QR_FORMAT` | `svg` | `png` for the raster fallback |

## Cost

Provider cost is about $1.23 for a B&W first-class letter and $0.10 for the extra page, so a gift letter sent costs about $1.33. A claimed gift letter costs nothing until it is sent, and one never sent expires.

The most a single pack grant can cost is its own letter plus one child: about $2.66, against pack margins of $2.54, $3.85 and $28.50 ([Pricing](pricing-and-credits.md)). Read it as marketing spend rather than lost margin: each completed hop is a newly signed-in person. `LETTER_IRL_GIFT_DAILY_SEND_CAP` is what turns it into a budget; at the default of 20 the programme cannot spend more than about $27 a day.

## Running the programme

**Seeding a press or influencer letter** (admin panel):

1. Optionally create a seed campaign on **Promos**: credits 0, a budget in the seed field, a total cap, and "New accounts only". Activate it.
2. On the person's account page, **Grant gift letters**: a quantity, a budget, and the seed campaign's code if their letters should print it.
3. Their gift sends print the card. **Gifts** shows the totals and the newest codes; any issued code can be voided there.

## Platform policy

- Customer-facing copy says **gift letter**, never credits or tokens.
- The offer lives on letterirl.com. Inside ChatGPT the surface is functional: a preview says a gift letter adds a card, and `sendAsGift` is described as something to set only when the user asks. No tool description promotes anything ([Apps SDK Guidelines](apps-sdk-guidelines.md)), and `get_started` says nothing about gifts.
- A free grant is not commerce, so the physical-goods rule does not apply to it.

## Before switching it on

See **GIFT-01** in [Manual Tests](manual-tests.md). The test print is the gate: whether PostGrid's renderer keeps inline SVG, whether the QR scans on an iPhone and an Android phone, and whether the card clears PostGrid's own integrity QR can only be answered by a real page.

## Related

- [Letter Send Flow](letter-send-flow.md)
- [Database Schema](database-schema.md)
- [Account Credits](account-credits.md)
- [Admin Panel Guide](admin-panel-guide.md)
