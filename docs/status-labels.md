# Letter Status Labels Reference

**Last Updated:** October 1, 2026
**Purpose:** Single source of truth for letter status values across database, API, dashboard, and widgets.

---

## Overview

Letter status flows through multiple layers, each with its own vocabulary:

```
PostGrid API → Provider Layer → Database → MCP API → Dashboard/Widget
```

This document defines the canonical values and the mappings between layers. Where it names a mapping
function, that function is authoritative; update this page when the code changes.

---

## Status Lifecycle

```
   send transaction              dispatch               status sync (every 6 hours)
┌───────┐   ┌────────┐      ┌────────────┐   ┌──────────┐   ┌────────────┐   ┌────────────┐
│ draft │ ► │ queued │ ───► │ processing │ ► │ accepted │ ► │ processing │ ► │ in_transit │
└───────┘   └────────┘      └────────────┘   └──────────┘   └────────────┘   └────────────┘
                 ▲                │                          (at printer)          │
                 │ retryable      │ ambiguous                            ┌─────────┴──────┐
                 └────────────────┤                                      ▼                ▼
                                  ▼                               ┌───────────┐   ┌──────────┐
                             ┌────────┐                           │ delivered │   │ returned │
                             │  held  │ ── operator decides ──►   └───────────┘   └──────────┘
                             └────────┘   accepted / queued / failed

Failure path:  a definite rejection or exhausted retries ──► failed
Cancel path:   a Pay & Send payment refunded or disputed before dispatch ──► cancelled
```

The confirmed-send transaction inserts the letter as `draft` and moves it to `queued` when it inserts
the `letter_jobs` outbox row, so `draft` is never visible after commit. The same request then claims
the job, which sets `processing`, and submits it to the provider. Success sets `accepted`; a retryable
pre-dispatch failure returns it to `queued`; a definite rejection sets `failed`. An outcome that does
not prove what happened (a timeout, a `5xx`, lost transport) sets `held`, and only an operator moves it
on (`src/services/letterJobService.ts`). After acceptance, the six-hourly status sync
(`src/services/statusSyncService.ts`) applies PostGrid's lifecycle, which reuses `processing` for the
printer stage. PostGrid's own statuses are `ready`, `printing`, `processed_for_delivery`, `completed` and
`cancelled` (#566). It cancels a piece only while it is `ready`, before printing, so a `cancelled` piece
fails here (`failProviderCancelledLetter`). What paid for it comes back by itself for prepaid and gift mail our
record still held as `accepted`; a Pay & Send letter, or one our record had seen printing or mailed, is left to a
person, with a critical alert.

---

## Database Status Values

The `letters.status` column is the source of truth. Its CHECK constraint (`valid_letter_status`,
migration `023_jit_recovery_state_machines.sql`) allows exactly the values below.

| Status | Meaning | Set by | Terminal? |
|--------|---------|--------|-----------|
| `draft` | Letter row inserted; replaced by `queued` in the same transaction | the confirmed-send transaction | No |
| `queued` | Committed with its outbox row, awaiting submission | job creation; a retryable failure; an operator retry | No |
| `processing` | Being submitted to the provider, **or** at the printer (PostGrid `printing`, or the older `processed`/`printed`) | the outbox when it claims the job; status sync | No |
| `held` | Provider outcome unknown; an operator must reconcile it | the outbox on an ambiguous dispatch | No |
| `accepted` | PostGrid accepted the order | the outbox on provider success; an operator decision; status sync | No |
| `sent` | **Legacy** - same as `accepted` | old records only | No |
| `in_transit` | Handed to USPS | status sync | No |
| `delivered` | Delivered (estimated in live mode) | status sync | **Yes** |
| `returned` | Returned to sender | status sync | **Yes** |
| `failed` | Terminal failure: a definite provider rejection, exhausted retries, an operator's rejected decision, or a PostGrid cancellation (`cancelled`, before printing: an alert is raised, and what paid comes back by itself unless a person must decide, #566) | the outbox; an operator decision; status sync | **Yes** |
| `cancelled` | Stopped before dispatch: the Pay & Send payment that funded it was refunded or disputed, the customer cancelled mail held to a date (#535), or the account was erased | commerce (`stopFundedMailBeforeFinancialReversal`); `cancel_scheduled_mail` and its REST route; account erasure | **Yes** |

`printing` is **not** a database value; the constraint rejects it. It exists only in the MCP
vocabulary below.

Status sync skips terminal letters and letters without a `tracking_id`, and stores the provider's status
message ("Letter was canceled before sending", not PostGrid's raw `cancelled`) in `provider_raw_status`. Every transition is recorded in `letter_status_history`.

### Legacy compatibility

The `sent` status exists in old records. Code treats `sent` identically to `accepted`:
- both mean "PostGrid has accepted the order";
- new records use `accepted`.

### The outbox job

`letter_jobs.status` is a separate state machine: `pending`, `processing`, `held`, `completed`,
`failed`, `cancelled`, paired with `provider_outcome` (`not_dispatched`, `dispatching`, `ambiguous`,
`accepted`). See [letter-send-flow.md](letter-send-flow.md) and
[database-schema.md](database-schema.md).

---

## MCP Status Values (User-Facing API)

The `LetterStatus` type in `src/contracts/types.ts` defines what `get_order_status` and `list_orders`
return. The mapping is `mapStatus()` in `src/store/fileAccountStore.ts`.

| MCP Status | Meaning | Maps From DB |
|------------|---------|--------------|
| `pending` | Processing your order | `draft`, `queued`, `held`, and any unrecognized value |
| `accepted` | Accepted by print facility | `accepted`, `sent` (legacy) |
| `printing` | Being printed | `processing` (so a letter mid-submission also reads as `printing`) |
| `in_transit` | In the mail | `in_transit` |
| `delivered` | Delivered | `delivered` |
| `returned` | Returned to sender | `returned` |
| `failed` | Failed | `failed` |
| `cancelled` | Cancelled | `cancelled` |
| `scheduled` | Sent with an arrival date, waiting for its mail date (#535) | `queued` with `arrive_by` and `mail_on` |

A `held` letter reads as `pending` to the customer on purpose: whether it was mailed is not yet known.

Mail sent with an arrival date (#535) waits in the outbox, `queued`, until 09:00 New York time on its mail date. Until the outbox takes it, `get_order_status`, `list_orders` and the preview card's `get_draft_status` call it `scheduled`, with `arriveBy`, `mailOn` and `cancellable` (false for Pay & Send, whose refund a person decides). The send's answer calls it `scheduled` only while its mail date is ahead: sent after 09:00 New York on that day, it is due at once and reads as any send. Its timeline carries a line saying when it goes to the printer. Once taken, it reads as any other letter, keeping its dates.

---

## Dashboard Display Labels

The dashboard shows status badges in the Letters section. The badge component lives in the
`letter-irl-website` repository (`StatusBadge` in `app/(dashboard)/dashboard/page.tsx` when this was
last checked); treat that file as authoritative and update this table when it changes.

| DB Status | Display Label | Badge Color | Notes |
|-----------|---------------|-------------|-------|
| `draft` | "Draft" | Gray | Rarely seen |
| `queued` | "Queued" | Yellow | Usually brief |
| `processing` | "Processing" | Yellow | At the printer |
| `held` | - | - | Not listed in the website table when last checked; verify there |
| `accepted` | "Accepted" | Blue | PostGrid accepted order |
| `sent` | "Sent" | Green | Legacy, same as accepted |
| `in_transit` | "In Transit" | Blue | In postal system |
| `delivered` | "Est. Delivered" | Green | **Estimated** - not confirmed (see US-MCP-10) |
| `returned` | "Returned" | Orange | Returned to sender |
| `failed` | "Failed" | Red | |
| `cancelled` | "Cancelled" | Gray | |

---

## Widget Display

The send widgets (LetterPreviewCard, PostcardPreviewCard) show **action states**, not order status:

| Widget State | Meaning | When Shown |
|--------------|---------|------------|
| "Loading..." | Fetching quote | During API call |
| "Ready to send" | Quote received, can send | `canSendNow` = true |
| "Cannot send" | Insufficient letters, etc. | `canSendNow` = false; Pay & Send and Buy a Letter Pack are offered instead |
| "Sent!" | Send successful | After `send_letter` / `send_postcard` succeeds |
| "Send failed" | Send error | After the send tool fails |

After a Pay & Send checkout the preview cards show purchase status from `get_purchase_status`. The
widgets do not display ongoing mail status (accepted, in_transit, and so on); users ask ChatGPT for
it, which calls `get_order_status`.

---

## PostGrid Status Mapping

PostGrid has its own lifecycle. `mapStatus()` in `src/services/providers/PostGridProvider.ts`
converts it, and status sync writes the result to `letters.status`.

### PostGrid Lifecycle

```
Live mode:  ready → rendered → processed → printed → mailed → in_transit → delivered
                                                                          → returned
                                                   → canceled

Test mode:  ready → rendered → processed → printed → processed_for_delivery → completed
                                                   → canceled
```

### Test Mode vs Live Mode

PostGrid uses different terminal statuses depending on environment:
- **Live mode**: `delivered` - estimated delivery based on USPS mail timing
- **Test mode**: `completed` - simulated delivery (no real mail sent)

Both are mapped to our `delivered` status.

### PostGrid → Database Mapping

| PostGrid Status | Our DB Status | Meaning |
|-----------------|---------------|---------|
| `ready` | `accepted` | Order accepted, awaiting print |
| `rendered` | `accepted` | PDF generated |
| `processed` | `processing` | Sent to printer |
| `printed` | `processing` | Printed, awaiting mail |
| `mailed` | `in_transit` | Handed to USPS |
| `in_transit` | `in_transit` | In postal system |
| `processed_for_delivery` | `in_transit` | In transit - test mode |
| `delivered` | `delivered` | Delivered (estimated) - live mode |
| `completed` | `delivered` | Delivered (simulated) - test mode |
| `returned` | `returned` | Returned to sender |
| `canceled` | `failed` | Cancelled by PostGrid before mailing |

PostGrid's `canceled` becomes `failed`, not `cancelled`: in our vocabulary `cancelled` is a decision
made on our side, while a provider cancellation is a failure to mail.

---

## Related Documentation

- [letter-send-flow.md](letter-send-flow.md) - outbox, holds, and terminal failures
- [database-schema.md](database-schema.md) - `letters`, `letter_jobs`, `letter_status_history`
- [user-stories.md](user-stories.md) - US-MCP-10 (estimated delivery)
