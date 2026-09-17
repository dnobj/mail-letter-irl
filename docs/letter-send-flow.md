# Letter and Postcard Send Flow

**Last Updated:** September 17, 2026
**Purpose:** Draft, payment, outbox, and provider workflow for letters and postcards

This document describes the current draft, payment, outbox, and provider workflow for letters and postcards.

## Preview

Preview tools validate the user's input, render the appropriate widget, and create a 24-hour database draft. Previewing does not deduct a letter send and does not create a provider order.

| Tool | Layout | Text limit |
| --- | --- | --- |
| `quote_and_preview_letter` | text only | 1,600 characters / 24 lines |
| `quote_and_preview_letter_with_header_image` | image at top | 1,100 characters / 17 lines |
| `quote_and_preview_letter_with_image` | image after signature | 800 characters / 12 lines |
| `quote_and_preview_postcard` | image front, message back | postcard-specific message limit |

The preview response includes a `draftId`. Sending is a separate, explicit tool call requiring `confirm: true`.

## Confirmed Send Transaction

`send_letter` and `send_postcard` call the same atomic service. Inside one PostgreSQL transaction the service:

1. selects the draft `FOR UPDATE`;
2. validates ownership, mail type, state, and expiry;
3. returns the existing order if the draft was already consumed;
4. inserts the Letter IRL order;
5. locks and deducts prepaid sends from the user's ledger;
6. checks the daily caps, then refuses the same mail sent recently (below), unless the caller asked for another copy;
7. marks the draft consumed and links it to the order;
8. inserts one `letter_jobs` outbox row;
9. commits.

Any error rolls back every effect. An insufficient balance therefore creates no order, consumes no draft, inserts no job, and deducts no sends.

Database constraints enforce one outbox row and one stable idempotency key per letter. Concurrent calls serialize on the draft lock, so the second call returns the first order.

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
    - An order handed back for the same draft is not checked again, because nothing new is bought: it is the same order at the same price. That covers an order with a Stripe session, and a sessionless one still at today's price, which gets a fresh session for the same order. It also covers an order past checkout: paid, being refunded, disputed or held.
    - A sessionless order being replaced is checked. That happens when it is too near expiry for Stripe or was priced before a price change. A refusal also rolls back that order's cancellation.
    - This check is a best-effort net. Checkouts for two identical drafts lock different rows, so two made at the same moment can both pass.
  - Pay & Send fulfilment, which runs after the customer has paid, is never checked.
- **The refusal.** It is an MCP error result whose text starts with `Possible duplicate:`. The text tells the model what went out, when, and to ask the user before repeating the call with `sendAnotherCopy: true`. `_meta["letterirl/duplicateMail"]` carries `{kind, mailType, recipientName, ageMinutes}` for the preview cards, which say what went out and turn the button into **Send another copy** or **Pay for another copy**.

## Immediate Provider Submission

After the transaction commits, the send tool claims its outbox row and submits it immediately.

A **Pay & Send** order takes a different route to the same outbox: the verified payment webhook
consumes the draft and inserts the letter and its outbox row in one transaction, and nothing submits
it in that request. The next hourly maintenance run does, so a paid item can wait up to an hour for
provider acceptance. The PostGrid request uses the Letter IRL `letter_id` as `Idempotency-Key`.

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

## Hourly Recovery

Railway runs `npm run maintenance` once per hour. Outbox recovery atomically claims due rows with `FOR UPDATE SKIP LOCKED`, allowing safe concurrency. A job left in processing with a lock older than 15 minutes is treated as stale and can be reclaimed.

The same stable provider idempotency key is reused after timeout or process restart. This protects against a provider order succeeding while the application loses the response.

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
