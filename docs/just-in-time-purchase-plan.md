# Just-in-Time Purchase Implementation Plan

**Last Updated:** July 18, 2026
**Purpose:** Define the product and technical plan for paying for and sending one specific letter or postcard without first buying a letter pack
**Status:** Shipped. Phases 1-4 have landed; Pay & Send is live in both environments. Kept as the design record; tracked by GitHub issue #69

---

## Overview

Letter IRL currently requires a user to buy a prepaid letter pack before sending mail. Add a second purchase path named **Pay & Send** that charges for one immutable letter or postcard draft and fulfills that exact physical item after Stripe confirms payment.

This is not a one-credit purchase. It is a purchase of a clearly described physical good. Letter packs remain available as the discounted prepaid option, while Pay & Send removes the up-front commitment for occasional users.

The first implementation should use Stripe-hosted Checkout opened from the ChatGPT widget. OpenAI's external-checkout flow is generally available, while ChatGPT in-app payment collection and Stripe Instant Checkout remain limited-access options. Keep payment-provider and app-platform boundaries thin so those options can be added later without changing mail fulfillment.

## Product Decisions

1. **Sell the physical item, not an internal credit.** The checkout line item must identify the exact letter or postcard and its price. Internal credits remain an implementation detail of letter packs and must not be marketed as tokens, stored value, or digital goods.
2. **Payment is the send confirmation.** The button and checkout copy must say **Pay & Send**. A successful payment authorizes Letter IRL to send the immutable draft automatically; the user must not need to return to ChatGPT and confirm a second time.
3. **Keep letter packs.** A user with sufficient prepaid balance keeps the existing `send_letter` or `send_postcard` flow. A user without sufficient balance sees Pay & Send and Buy a Letter Pack as alternatives.
4. **Start with Stripe-hosted Checkout.** Enable eligible Stripe payment methods, including Link and wallets, through Stripe configuration rather than hard-coding cards only. Do not collect or store card data in Letter IRL.
5. **Fulfill from webhooks.** The return page may refresh status, but only a verified Stripe event with a paid payment state can mark an order paid. Fulfillment must also handle delayed payment methods through `checkout.session.async_payment_succeeded`.
6. **Gate Letter IRL-funded image generation.** Initially, users without a prior qualifying purchase cannot use Letter IRL's OpenAI image-generation budget. They can still use text-only mail, upload an image, or reuse an image generated elsewhere. A completed JIT order may grant a configurable future image-generation entitlement. A one-time verified-user trial can be tested later behind a disabled-by-default feature flag and a global spend cap.
7. **Refund money when paid fulfillment cannot proceed.** A JIT order that cannot be fulfilled after bounded recovery receives an idempotent Stripe refund. It must not silently become general-purpose credit.

## Goals

- Let a user pay for and send one previewed physical letter or postcard.
- Preserve the existing prepaid-balance send path without behavior changes.
- Guarantee at most one charge, one Letter IRL order, one provider order, and one fulfillment for a JIT checkout.
- Keep checkout amounts, product descriptions, user ownership, and fulfillment state server-controlled.
- Support desktop and mobile ChatGPT widget flows, including returning after external checkout.
- Make image-generation cost exposure explicit, configurable, and auditable.
- Preserve development and production isolation for Stripe, Railway, Neon, Auth0, and PostGrid.

## Non-Goals

- Charging a saved payment method without the user entering an explicit checkout flow.
- Joining the private-beta OpenAI Instant Checkout program in the first release.
- Replacing letter packs or migrating existing balances.
- Selling stand-alone image-generation credits or other digital goods through the app.
- Supporting subscriptions, recurring billing, non-US mail, or bulk campaigns.
- Guaranteeing a refund for normal carrier delivery outcomes after a provider has accepted the physical-mail order.

## Current-State Findings

### Payments

- `stripeService.ts` creates hosted Checkout sessions only for the three letter-pack products.
- The checkout endpoint is a dashboard REST endpoint rather than an MCP tool available to widgets.
- Checkout currently hard-codes `payment_method_types: ["card"]`, which prevents Stripe from dynamically presenting some eligible payment methods.
- Pack fulfillment writes directly to `credit_ledger`. The current check-then-insert webhook path is not protected by a unique database constraint and must be made concurrency-safe before adding another payment flow.
- The existing `orders` table was intended for purchase orders but is not the authoritative record for current Stripe pack purchases. Admin revenue data and reconciliation therefore do not share one complete order model.

### Mail Fulfillment

- Letter and postcard previews create immutable, expiring `letter_drafts` records.
- Preview widgets expose `canSendNow`; when false, their send controls are disabled and no JIT option is offered.
- `mailSendService.ts` already locks a draft and atomically consumes prepaid balance, creates the `letters` row, consumes the draft, and inserts the durable `letter_jobs` outbox record.
- JIT fulfillment should reuse that transaction and outbox while selecting a different funding source that does not debit `credit_ledger`.

### Image Generation

- Image generation is reserved atomically, which is good, but the allowance is derived from lifetime `users.credits_purchased` rather than explicit entitlements.
- The current formula grants five generations per purchased letter. At current OpenAI image pricing, that allowance should be reviewed against product margin before launch.
- A first-time JIT user needs an image before paying for the final draft. The safe initial policy is therefore to require an existing entitlement for Letter IRL-funded generation while continuing to accept uploaded, conversation-generated, or hosted images.

## Target User Flows

### Prepaid Balance

1. The user previews a letter or postcard.
2. The preview reports sufficient balance.
3. The existing Send action calls `send_letter` or `send_postcard` with `confirm: true`.
4. The existing credit-funded transaction and outbox flow continues unchanged.

### Pay & Send

1. The user previews a letter or postcard and receives a `draftId`, exact product description, amount, currency, and available purchase choices.
2. The user selects **Pay & Send** in the widget or asks ChatGPT to use the JIT option.
3. `create_mail_checkout` authenticates the user, locks the draft, validates ownership and expiry, and creates or reuses one pending JIT order for that draft.
4. The server creates a Stripe Checkout Session from server-side price configuration and returns its URL and expiry.
5. The widget opens the URL with `window.openai.openExternal`.
6. Stripe confirms payment to the webhook. The handler verifies the event signature and requires `payment_status=paid`; a completed-but-unpaid asynchronous session remains pending.
7. In one database transaction, Letter IRL records the payment, consumes the draft using JIT funding, creates the letter and outbox job, and marks the order fulfillment-pending.
8. The normal outbox submits the order to PostGrid using its stable idempotency key.
9. A return/status view calls `get_purchase_status` and reports paid, processing, sent, refund-pending, or refunded without depending on webhook timing.

### Checkout Abandonment or Failure

1. An abandoned or expired Checkout Session leaves the draft unsent.
2. An active JIT checkout prevents the same draft from being sent with balance or attached to another checkout.
3. A failed or expired payment unlocks the draft if the draft itself remains valid.
4. A late successful payment that cannot consume the draft creates a refund-pending order and is refunded idempotently.

## Target Architecture

### 1. Authoritative Commerce Orders

Evolve the existing `orders` table into the source of truth for both letter-pack and JIT purchases. Add or normalize:

- `order_type`: `letter_pack` or `jit_mail`
- `user_id`
- `draft_id` for JIT orders
- `letter_id` after fulfillment
- `product_code` and a human-readable product snapshot
- optional `credits` for pack orders
- `amount_cents` and `currency`
- `payment_provider`
- unique `stripe_checkout_session_id`
- unique `stripe_payment_intent_id`
- unique application `idempotency_key`
- `status`: `checkout_pending`, `paid`, `fulfillment_pending`, `fulfilled`, `payment_failed`, `refund_pending`, `refunded`, or `cancelled`
- payment, fulfillment, expiry, refund, and error timestamps/metadata

Add a partial unique index allowing only one active JIT order per draft. Migrate existing completed pack purchases from authoritative ledger metadata where possible, and make all new pack purchases write an order before Checkout creation.

Add a small webhook-event table keyed by the Stripe event ID. Event insertion and state transition occur in the same database transaction. This replaces check-then-act webhook deduplication with a unique-constraint-backed claim.

### 2. Draft Checkout Lock

Extend draft state with `checkout_pending`, or add an equivalent explicit active-order lock enforced by a database constraint. All prepaid and JIT send transactions must lock the draft row and reject conflicting active checkout or consumed states.

Align the Checkout Session expiry with the draft expiry. Never create a session that can complete after its draft expires without entering the documented refund path.

### 3. Commerce Service and Provider Adapter

Introduce a platform-neutral commerce service with operations such as:

- `createJitCheckout(userId, draftId)`
- `recordPaymentEvent(providerEvent)`
- `fulfillPaidOrder(orderId)`
- `getPurchaseStatus(userId, orderId)`
- `requestRefund(orderId, reason)`

Keep Stripe-specific Checkout, webhook signature verification, event mapping, and refunds behind a Stripe adapter. This lets a future ChatGPT Instant Checkout/SPT adapter fund the same commerce order and call the same fulfillment transaction.

### 4. Funding-Aware Mail Transaction

Refactor the current send transaction around an explicit funding union:

```ts
type MailFunding =
  | { type: "prepaid_balance"; requiredCredits: number }
  | { type: "jit_order"; orderId: string };
```

For prepaid funding, preserve FIFO ledger consumption. For JIT funding, require a locked, paid order owned by the same user and bound to the same draft; do not read or mutate prepaid balance. Both paths create exactly one `letters` row and exactly one `letter_jobs` row in the same transaction.

### 5. Refund and Recovery Worker

Extend the one-shot maintenance command to:

- retry paid orders whose fulfillment transaction did not complete;
- reconcile Checkout Sessions and PaymentIntents that missed a webhook;
- expire abandoned active checkouts and unlock eligible drafts;
- issue idempotent refunds for terminal pre-provider failures;
- reconcile refund status from Stripe;
- alert on orders stuck beyond configured service-level thresholds.

Do not refund automatically after PostGrid has accepted an order unless the documented customer-support policy calls for it.

### 6. Explicit Image Entitlements

Replace the allowance formula with an append-only image entitlement/grant model. Each grant records source type, source order, quantity, consumed quantity, and timestamps. Enforce unique source references so webhook retries cannot grant twice.

Recommended initial grants:

- Preserve allowances already earned by existing pack customers during migration.
- Grant a configurable number per newly purchased physical-mail entitlement.
- Default JIT grant: one future generation after successful payment.
- Default unaffiliated free trial: disabled.
- Optional trial: one generation for a verified user, guarded by per-user atomic reservation, rate limits, a global daily budget, and a kill switch.

This policy means a first-time JIT user can upload or reuse an image but cannot spend Letter IRL's image budget before making a qualifying purchase. Product copy must make that distinction clear.

## MCP and Widget Interfaces

### New Tools

- `create_mail_checkout`: Creates or reuses the checkout for an owned, pending draft. Returns `orderId`, checkout URL, amount, currency, product description, and expiry. This tool does not itself charge or send.
- `get_purchase_status`: Returns sanitized payment and fulfillment state for an order owned by the authenticated user. It never returns card or sensitive Stripe data.

### Existing Tools

- Preserve all existing names and input schemas.
- Preserve `canSendNow` temporarily for compatibility, but add a structured `sendEligibility` result containing prepaid eligibility, JIT availability, exact JIT price, and unavailability reason.
- `send_letter` and `send_postcard` remain the prepaid-balance confirmation tools. Paid JIT fulfillment is webhook-driven rather than invoked by the model after checkout.

### Widgets

- Add **Pay & Send** and **Buy a Letter Pack** actions when balance is insufficient.
- Keep the existing Send action when balance is sufficient; optionally show Pay & Send as a secondary choice only if product testing supports it.
- Show exact amount, currency, physical item, recipient summary, and the fact that payment submits the item for mailing before opening Checkout.
- Use `window.openai.openExternal` for hosted Checkout and declare only the required redirect/connect domains in widget CSP.
- On return, refresh order state through `get_purchase_status`. Handle webhook delay with a bounded processing state rather than assuming failure.
- Test first-render behavior on Android as well as conversation-switch and reconnect scenarios already documented in the manual suite.

## Security and Compliance Requirements

- Derive prices and product types only from server configuration; never accept amount, currency, or Stripe Price ID from the model or widget.
- Verify Stripe webhook signatures against the raw request body before parsing or writing data.
- Authenticate every checkout/status tool and validate that the user owns the referenced draft or order.
- Store no payment-card details. Store only Stripe object identifiers and sanitized metadata required for reconciliation.
- Put no address, letter content, image data, or other unnecessary PII in Stripe metadata or logs.
- Use distinct Stripe keys, webhook secrets, Price IDs, databases, domains, and PostGrid environments for dev and production.
- Apply rate limits to checkout creation, status polling, and image generation.
- Use database uniqueness and row locks as the final concurrency boundary; do not rely on process-local locks.
- Record security-relevant order transitions and redact secrets from logs and admin views.
- Keep app commerce limited to physical goods and present complete pricing and fulfillment terms before checkout.

## Implementation Phases

### Phase 1: Data Integrity Foundation

- Migrate `orders` into the authoritative commerce-order model.
- Add unique Stripe object and webhook-event constraints.
- Route current pack checkout and webhook fulfillment through orders.
- Fix pack webhook concurrency and reconciliation tests before enabling JIT.

### Phase 2: Funding-Aware Fulfillment

- Add the draft checkout lock/state.
- Refactor mail creation to accept prepaid or paid-order funding.
- Prove both paths use the same transactional outbox and provider idempotency behavior.
- Add refund-pending handling for paid drafts that cannot be consumed.

### Phase 3: Hosted JIT Checkout

- Add JIT products and server-side price configuration for letters and postcards.
- Implement the Stripe adapter, `create_mail_checkout`, verified webhooks, and `get_purchase_status`.
- Handle synchronous and asynchronous successful payments, expiration, failure, and refunds.
- Add maintenance reconciliation and operational alerts.

### Phase 4: Preview and Widget UX

- Add structured send eligibility to preview results.
- Add Pay & Send and letter-pack choices to letter and postcard widgets.
- Implement external checkout return/status behavior for desktop and mobile.
- Add clear image-entitlement messaging where Letter IRL generation is unavailable.

### Phase 5: Image Entitlements

- Migrate existing earned allowance without reducing customer access.
- Route pack and JIT grants through the new entitlement ledger.
- Add rate, budget, and feature-flag controls.
- Keep the unaffiliated free trial disabled until an explicit acquisition experiment is approved.

### Phase 6: Rollout and Documentation

- Deploy database-compatible code with `JIT_PURCHASE_ENABLED=false` first.
- Exercise the full flow in Stripe test mode and the development Railway/Neon environment.
- Enable for internal test accounts, then a small production cohort, then all eligible users.
- Update user flows, tool APIs, widgets, database schema, security policy, deployment variables, manual tests, pricing, and app-submission documentation.
- Archive or rewrite stale ACP documents that describe unavailable five-endpoint or Instant Checkout behavior.

## Configuration

Add environment-specific settings without committing values:

- `JIT_PURCHASE_ENABLED`
- `STRIPE_JIT_LETTER_PRICE_ID`
- `STRIPE_JIT_POSTCARD_PRICE_ID`
- `JIT_CHECKOUT_EXPIRY_MINUTES`
- `JIT_REFUND_RETRY_LIMIT`
- `JIT_REFUND_RETRY_DELAY_SECONDS`
- `IMAGE_ENTITLEMENTS_PER_JIT_ORDER`
- `IMAGE_TRIAL_ENABLED`
- `IMAGE_TRIAL_DAILY_BUDGET_CENTS`

Price IDs and webhook secrets must use Railway environment variables and must never be shared between development and production.

The implemented database and provider transaction boundaries are documented in
[`security-and-policy.md`](security-and-policy.md#pay--send-acid-and-distributed-transaction-boundaries).
PostgreSQL provides ACID guarantees for local state. Stripe and mail/image
provider calls use durable intent, idempotency, outbox work, and compensation;
they are not part of a database transaction.

## Verification and Acceptance Criteria

### Automated

- Duplicate and concurrently delivered Stripe events create one state transition and one pack grant or JIT fulfillment.
- Repeated checkout creation for one draft returns the active order and does not create multiple payable sessions.
- A JIT checkout cannot be created for another user's, consumed, cancelled, or expired draft.
- A pending JIT checkout and prepaid send cannot both consume the same draft.
- A paid JIT order creates one letter and one outbox job without changing prepaid balance.
- A prepaid send remains atomically charged once and otherwise behaves exactly as before.
- Webhook timeout, process restart, 429/5xx, delayed payment, and maintenance reconciliation recover safely.
- Terminal pre-provider failure issues at most one refund.
- Image grants and reservations remain atomic under concurrency and cannot be replayed from a payment event.
- No response or log exposes Stripe secrets, payment details, addresses, or letter content unnecessarily.

### Manual

- Desktop and Android: preview with zero balance, choose Pay & Send, complete Stripe test checkout, return, observe processing, and retrieve sent status.
- Desktop and Android: abandon checkout and verify the draft remains unsent and becomes usable after checkout expiry.
- Buy a simulated letter pack and verify the existing balance-funded send flow still works.
- Complete a JIT letter and postcard purchase with duplicate webhook delivery simulated.
- Verify zero-entitlement users can upload/reuse images but cannot invoke Letter IRL-funded generation.
- Verify a qualifying completed purchase grants exactly the configured future image entitlement.
- Verify dev uses Stripe test mode, dummy/test mail behavior, the dev database, and dev URLs; verify production configuration separately without placing a live order.

### Rollout Gates

- No known duplicate-charge, duplicate-send, cross-user, or lost-payment paths.
- All automated tests, type checks, lint checks, and documented manual ChatGPT tests pass.
- Reconciliation identifies every paid-but-unfulfilled test order.
- Pricing covers Stripe fees, PostGrid cost, expected image cost, refunds/support allowance, and target margin.
- External checkout and return behavior are acceptable on desktop and Android.

## Recommended Launch Defaults

- Keep letter packs as the best-value option.
- Price JIT at a convenience premium; validate the exact amount from current PostGrid, Stripe, tax, support, and image-cost inputs before creating production Price IDs.
- Enable Stripe Link and eligible wallets in hosted Checkout when supported by the account and customer device.
- Do not save payment methods explicitly in v1; Stripe Link can provide repeat-user convenience without Letter IRL charging off-session.
- Keep `IMAGE_TRIAL_ENABLED=false` and grant one future generation per completed JIT physical-mail order until measured economics justify a different allowance.

## Open Decisions for Implementation Kickoff

These are launch configuration decisions, not architecture blockers:

- Exact JIT price for a letter and postcard.
- Whether sufficient-balance users should also see Pay & Send.
- The final number of image entitlements granted by each pack and JIT order.
- The retry duration before a pre-provider failure becomes refund-pending.
- Whether to run a capped one-time image trial after the paid flow is stable.

## References

- [OpenAI Apps SDK monetization](https://developers.openai.com/apps-sdk/build/monetization)
- [OpenAI app submission guidelines](https://developers.openai.com/apps-sdk/app-guidelines)
- [OpenAI ChatGPT UI APIs](https://developers.openai.com/apps-sdk/build/chatgpt-ui)
- [OpenAI product checkout conversion specification](https://developers.openai.com/apps-sdk/guides/product-checkout-conversion-spec)
- [Stripe agentic commerce apps](https://docs.stripe.com/agentic-commerce/apps)
- [Stripe-hosted checkout for apps](https://docs.stripe.com/agentic-commerce/apps/accept-payment?platform=web&ui=stripe-hosted)
- [Stripe Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment)
- [Stripe saved payment methods](https://docs.stripe.com/payments/checkout/save-during-payment)
