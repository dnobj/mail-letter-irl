# Secondary units and PostGrid address verification (issue #200)

**Date:** August 22, 2026 · **Probe:** `scripts/probe-suite-verification.ts` against the live addver API (dev verification key).

## The bug

A recipient at `350 5th Ave, New York, NY 10118` was refused in every form:
`Suite 8701` → "Incorrect Value: Suite identifier", `STE 8701` → same, no
suite → "Missing Value: Suite identifier". No accepted input existed. The
code treated every PostGrid `status: "failed"` as a hard block before any
draft.

## What the live probe established

| Case | PostGrid status | DPV indicator | Errors |
|---|---|---|---|
| ESB + `Suite 8701` (line2) | `failed` | **S** | `{line1: ["Incorrect Value: Suite identifier"]}` |
| ESB + `STE 8701` (line2) | `failed` | **S** | same |
| ESB + suite folded into line1 | `failed` | **S** | same — PostGrid parses all three placements identically (`suiteID: "8701"`, `suiteKey: "STE"`) |
| ESB, no suite | `failed` | **D** | `{line1: ["Missing Value: Suite identifier"]}` |
| 285 Fulton St `Suite 8500` | `corrected` | **Y** | `{generic: ["Alternate: Delivery Information"]}` |
| **129 W 81st St `Apt 5A` (residential)** | `failed` | **S** | `{line1: ["Incorrect Value: Suite identifier"]}` |
| 123 Fake Street | `failed` | (none; `details` empty) | `{generic: ["Missing Value: Complete Street Information"]}` |

Key facts:

1. **The USPS DPV confirmation indicator** (`details.usMailingsDpvConfirmationIndicator`)
   is the reliable discriminator: `Y` = fully confirmed; `S` = building
   confirmed deliverable, the given unit is not in USPS's unit list; `D` =
   building confirmed, unit required but missing; absent = the street never
   resolved.
2. **Ordinary residential apartments land in class S.** USPS does not
   enumerate every unit in every building; carriers deliver such mail
   routinely. Blocking S refuses real, reachable recipients — including the
   harness's own long-standing "valid" fixture `145 Mulberry St`, which
   live-fails with class D.
3. **Error field keys cannot discriminate** — suite errors are keyed under
   `line1`. Classification must use the DPV indicator (with a message-text
   fallback on "Suite identifier").
4. **Failed responses still carry PostGrid's standardized address**
   (`"350 5th Ave Ste 8701"`, ZIP+4) — but PostGrid also **echoes the input
   back as `line1` when nothing resolved**, so a standardized "suggestion"
   is only real when `details.streetName` is present.
5. Suite placement in `line1` vs `line2` doesn't matter to PostGrid, but the
   served schema now tells the model to use `addressLine2` anyway (cleaner
   data downstream).

## The policy (owner decision, Aug 22)

Implemented in `src/services/addressVerificationPolicy.ts`, used by all four
preview tools (the postcard tool now calls the shared
`validateAddressesWithProvider`) and by return-address saving:

- **Class S/D (`secondary_unit`)** → proceed; draft is created; the output
  carries `addressWarnings` (surfaced in the tool summary) and the
  validation status reads `unverified`.
- **Transport/API failures (`service_error`)** → proceed with a "couldn't
  verify right now" warning; a verification outage never masquerades as an
  invalid address (matches the documented non-blocking intent).
- **Everything else (`address_failed`)** → still blocks, now with actionable
  copy and the standardized closest match when the street resolved.
