# Letter and Postcard Send Flow

Last updated: July 16, 2026

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
6. marks the draft consumed and links it to the order;
7. inserts one `letter_jobs` outbox row;
8. commits.

Any error rolls back every effect. An insufficient balance therefore creates no order, consumes no draft, inserts no job, and deducts no sends.

Database constraints enforce one outbox row and one stable idempotency key per letter. Concurrent calls serialize on the draft lock, so the second call returns the first order.

## Immediate Provider Submission

After the transaction commits, the send tool claims its outbox row and submits it immediately. The PostGrid request uses the Letter IRL `letter_id` as `Idempotency-Key`.

Transient `429`, `5xx`, network, and timeout failures receive a small bounded retry with exponential delay and jitter. A successful response records the provider order ID and marks the job completed. A retryable failure returns a pending status and schedules `next_attempt_at`. A non-retryable or exhausted failure becomes terminal.

The tool response reports one of:

- `accepted`: provider submission completed;
- `pending`: the transaction committed and recovery is scheduled;
- `failed`: provider submission reached a terminal failure.

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
- insufficient balance rolls back all effects;
- `429`, `503`, timeout, and network failures schedule/retry correctly;
- a process restart after provider submission does not create a second provider order;
- hourly maintenance recovers due and stale rows;
- generated images remain available after API restart for 15 minutes;
- documented ChatGPT preview, purchase, send, and status flows pass in development.

See [manual-tests.md](manual-tests.md) and [idle-cost-operations.md](idle-cost-operations.md).
