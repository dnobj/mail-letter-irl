# Letter Status Labels Reference

**Last Updated:** December 29, 2025
**Purpose:** Single source of truth for all letter status values across database, API, dashboard, and widgets.

---

## Overview

Letter status flows through multiple layers, each with its own vocabulary:

```
PostGrid API → Provider Layer → Database → MCP API → Dashboard/Widget
```

This document defines the canonical status values and mappings between layers.

---

## Status Lifecycle

```
┌─────────┐     ┌─────────┐     ┌────────────┐     ┌──────────┐
│  draft  │ ──► │ queued  │ ──► │ processing │ ──► │ accepted │
└─────────┘     └─────────┘     └────────────┘     └──────────┘
                                                         │
                     ┌───────────────────────────────────┤
                     │                                   │
                     ▼                                   ▼
              ┌──────────┐                        ┌──────────┐
              │ printing │  ───────────────────►  │ in_transit│
              └──────────┘                        └──────────┘
                                                       │
                     ┌─────────────────────────────────┤
                     │                                 │
                     ▼                                 ▼
              ┌───────────┐                     ┌───────────┐
              │ delivered │                     │ returned  │
              └───────────┘                     └───────────┘

Error path:  Any non-terminal status ──► failed
Cancel path: Any non-terminal status ──► cancelled
```

---

## Database Status Values

The `letters.status` column is the source of truth.

| Status | Meaning | When Set | Terminal? | Currently Used? |
|--------|---------|----------|-----------|-----------------|
| `draft` | Order created, not yet queued | sendLetter creates record | No | Yes (brief) |
| `queued` | Job queued for background worker | createLetterJob() | No | Yes (brief) |
| `processing` | Worker is rendering/sending | Worker picks up job | No | Yes (brief) |
| `accepted` | PostGrid accepted the order | Worker success | No | **Yes - current final success state** |
| `sent` | **LEGACY** - same as `accepted` | Old records only | No | Yes (legacy data) |
| `printing` | PostGrid is printing | Future: webhook/sync | No | Reserved for future |
| `in_transit` | Handed to USPS | Future: webhook/sync | No | Reserved for future |
| `delivered` | Delivered to recipient | Future: webhook/sync | **Yes** | Reserved for future |
| `returned` | Returned to sender | Future: webhook/sync | **Yes** | Reserved for future |
| `failed` | Processing failed | Worker error | **Yes** | Yes |
| `cancelled` | Order cancelled | User/admin action | **Yes** | Yes |

### Current Reality

Today, successful letters end at `accepted` status. We do NOT currently receive updates from PostGrid after initial acceptance. Future webhook integration will enable the full lifecycle.

### Legacy Compatibility

The `sent` status exists in old database records. Code should treat `sent` identically to `accepted`:
- Both mean "PostGrid has accepted the order"
- Both display as "Sent" to users
- New records use `accepted`; old records may have `sent`

---

## MCP Status Values (User-Facing API)

The `LetterStatus` type in `src/contracts/types.ts` defines what the MCP API returns.

| MCP Status | Meaning | Maps From DB |
|------------|---------|--------------|
| `pending` | Processing your order | `draft`, `queued`, `processing` |
| `accepted` | Accepted by print facility | `accepted`, `sent` (legacy) |
| `printing` | Being printed | `printing` |
| `in_transit` | In the mail | `in_transit` |
| `delivered` | Delivered | `delivered` |
| `returned` | Returned to sender | `returned` |
| `failed` | Failed | `failed` |
| `cancelled` | Cancelled | `cancelled` |

### Mapping Function

See `src/store/fileAccountStore.ts` → `mapStatus()` for the implementation.

---

## Dashboard Display Labels

The Dashboard shows status badges in the Letters section.

| DB Status | Display Label | Badge Color | Notes |
|-----------|---------------|-------------|-------|
| `draft` | "Draft" | Gray | Rarely seen |
| `queued` | "Queued" | Yellow | Rarely seen (brief) |
| `processing` | "Processing" | Yellow | Rarely seen (brief) |
| `accepted` | "Accepted" | Blue | PostGrid accepted order |
| `sent` | "Sent" | Green | Legacy, same as accepted |
| `printing` | "Printing" | Blue | Future (with webhooks) |
| `in_transit` | "In Transit" | Blue | In postal system |
| `delivered` | "Est. Delivered" | Green | **Estimated** - not confirmed (see US-MCP-10) |
| `returned` | "Returned" | Orange | Returned to sender |
| `failed` | "Failed" | Red | |
| `cancelled` | "Cancelled" | Gray | |

### Implementation

See `letter-irl-website/app/(dashboard)/dashboard/page.tsx` → `StatusBadge` component.

---

## Widget Display

The send widgets (LetterPreviewCard, PostcardPreviewCard) show **action states**, not order status:

| Widget State | Meaning | When Shown |
|--------------|---------|------------|
| "Loading..." | Fetching quote | During API call |
| "Ready to send" | Quote received, can send | canSendNow = true |
| "Cannot send" | Insufficient credits, etc. | canSendNow = false |
| "Sent!" | Send successful | After send_letter succeeds |
| "Send failed" | Send error | After send_letter fails |

The widget does NOT display ongoing order status (accepted, printing, in_transit, etc.). Users ask ChatGPT "what's the status of my letter?" to check order status.

---

## PostGrid Status Mapping

PostGrid has its own status lifecycle. This mapping is used by `statusSyncService` when syncing status updates.

### PostGrid Lifecycle

```
ready → rendered → processed → printed → mailed → in_transit → delivered
                                                              → returned
                                       → canceled
```

### PostGrid → Database Mapping

| PostGrid Status | Our DB Status | Meaning |
|-----------------|---------------|---------|
| `ready` | `accepted` | Order accepted, awaiting print |
| `rendered` | `accepted` | PDF generated |
| `processed` | `printing` | Sent to printer |
| `printed` | `printing` | Printed, awaiting mail |
| `mailed` | `in_transit` | Handed to USPS |
| `in_transit` | `in_transit` | In postal system |
| `delivered` | `delivered` | Delivered (estimated) |
| `returned` | `returned` | Returned to sender |
| `canceled` | `cancelled` | Cancelled by PostGrid |

### Implementation

See `src/services/providers/PostGridProvider.ts` → `mapStatus()`.

---

## Provider Interface Status

The abstract provider interface (`src/services/providers/types.ts`) uses this status set:

```typescript
status: 'queued' | 'accepted' | 'processing' | 'in_transit' | 'delivered' | 'failed' | 'returned';
```

This intermediate layer aligns with database statuses and is used by `statusSyncService` when syncing from providers.

---

## Timeline Text

When displaying status timeline to users:

| Event | Timeline Text |
|-------|---------------|
| Order created | "Order placed" |
| PostGrid accepts | "Accepted by print facility" |
| Printing starts | "Being printed" |
| In mail | "In transit via USPS" |
| Delivered | "Est. delivered (based on mail timing)" |
| Returned | "Returned to sender" |
| Failed | "Processing failed" |
| Cancelled | "Cancelled" |

### Delivery Status Disclaimer

**Important:** PostGrid's "delivered" status is **estimated** based on typical USPS mail timing, NOT confirmed delivery. We do not have:
- Real-time carrier tracking
- USPS tracking numbers
- Confirmed delivery scans

The MCP API returns `trackingSupport: "estimated_only"` in `send_letter`, `send_postcard`, and `get_order_status` responses to communicate this to AI models. See US-MCP-10 for details.

---

## Terminal vs Non-Terminal Status

**Terminal statuses** (no further updates expected):
- `delivered`
- `returned`
- `failed`
- `cancelled`

**Non-terminal statuses** (may receive updates):
- `draft`
- `queued`
- `processing`
- `accepted` / `sent`
- `printing`
- `in_transit`

The `statusSyncService` only checks letters in non-terminal status.

---

## Future Enhancements

### Not Yet Implemented

1. **PostGrid Webhooks** - Receive real-time status updates via `letter.updated` events
2. **IMB Tracking** - Parse Intelligent Mail Barcode data for USPS scan events
3. **Delivery Confirmation** - Paid tracking option for confirmed delivery
4. **Email Notifications** - Notify users when status changes

### Reserved Statuses

These statuses are defined but not currently reached in production:
- `printing` - Will be set when PostGrid webhook reports printing
- `in_transit` - Will be set when PostGrid webhook reports mailed
- `delivered` - Will be set when PostGrid webhook reports completed
- `returned` - Will be set when PostGrid webhook reports returned

---

## Code Locations

| Component | File | Function/Component |
|-----------|------|-------------------|
| DB → MCP mapping | `src/store/fileAccountStore.ts` | `mapStatus()` |
| MCP type definition | `src/contracts/types.ts` | `LetterStatus` type |
| Provider interface | `src/services/providers/types.ts` | `LetterStatus` interface |
| PostGrid mapping | `src/services/providers/PostGridProvider.ts` | `mapStatus()` |
| Status sync | `src/services/statusSyncService.ts` | `syncLetterStatuses()` |
| Worker status write | `src/workers/letterWorker.ts` | Line ~165 |
| Dashboard badge | `letter-irl-website/.../dashboard/page.tsx` | `StatusBadge` |
| Dashboard letters | `letter-irl-website/.../letters/page.tsx` | `StatusBadge` |

---

## Consistency Checklist

When adding or modifying statuses, update:

- [ ] Database migration (if new column value)
- [ ] `src/contracts/types.ts` - MCP LetterStatus type
- [ ] `src/store/fileAccountStore.ts` - mapStatus() function
- [ ] `src/services/providers/types.ts` - Provider LetterStatus interface
- [ ] `src/services/providers/PostGridProvider.ts` - mapStatus()
- [ ] `src/schemas.ts` - Schema enum values
- [ ] `letter-irl-website/.../dashboard/page.tsx` - StatusBadge
- [ ] `letter-irl-website/.../letters/page.tsx` - StatusBadge
- [ ] `docs/user-stories.md` - Status tables
- [ ] This document (`docs/status-labels.md`)

---

## Summary

| Layer | Source of Truth | Key File |
|-------|-----------------|----------|
| Database | `letters.status` | Schema |
| MCP API | `LetterStatus` type | `src/contracts/types.ts` |
| Dashboard | `StatusBadge` component | `dashboard/page.tsx` |
| PostGrid | PostGrid API docs | `PostGridProvider.ts` |
