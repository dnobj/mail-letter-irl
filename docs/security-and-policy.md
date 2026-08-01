# Security, Privacy, and Policy Requirements

## Consent and Confirmation

- Always display the complete letter preview and a recipient summary before mailing.
- Require `confirm: true` in the `send_letter` payload; reject requests lacking explicit confirmation.

## Personal Data Handling

- Treat sender and recipient addresses as sensitive personal data.
- Never expose address data to other users; responses must remain scoped to the authenticated user.
- After mailing, return masked address summaries (e.g., name + city/state) in confirmations and status widgets.

## Abuse Prevention

- Log body text and address blocks for moderation and audit purposes.
- Introduce an internal `holdForReview` flag on new orders (default true during the prototype) to allow manual vetting.
- Enforce rate limits, e.g., no more than three queued letters per user per hour, to mitigate spam and harassment risk.

## Auditability and Retention

- Persist immutable snapshots of letter content, sender/recipient addresses, and status timelines with timestamps.
- Ensure audit logs capture the initiating user ID for each state transition.

## Future Compliance Hooks

- Data model should anticipate future integrations such as automated content moderation, payment compliance, and authenticity hashes without blocking current development.

## 2026-05-31 Security Review Notes

- OpenAI image generation uses a server-side `OPENAI_API_KEY`; the key must remain only in Railway environment variables and must never be emitted in tool output, widget metadata, manifests, docs, or logs.
- Image-generation spend protection requires atomic quota reservation. The `generate_image` tool should reserve one generation in the database before calling OpenAI and release that reservation if generation or preview handoff fails.
- Remote image URLs are untrusted input. Image processing must require HTTPS, block localhost/private/link-local/reserved IP ranges, validate DNS results before fetch, limit redirects, apply request timeouts, and enforce download size caps even when `Content-Length` is missing.
- Dependency audits are part of the submission readiness checklist. `npm audit --omit=dev` should report zero vulnerabilities before OpenAI app submission and before production deploys that touch MCP/App SDK dependencies.
- Capability URLs for temporary generated images should remain short-lived and should not be logged in full. Prefer token suffixes, hashes, or correlation IDs in logs.

# Pay & Send security invariants

- Checkout products, Price IDs, amounts, and currency are server configured;
  model and widget inputs cannot override them.
- Draft and purchase ownership is checked on every checkout and status call.
- A database partial unique index and row locks prevent a pending JIT checkout
  from racing another checkout or prepaid draft consumption.
- Stripe signatures are verified from the raw body before any write. Event IDs
  are claimed transactionally with the associated state transition.
- Only a paid payment state can authorize fulfillment; delayed-payment success
  is handled separately.
- Stripe metadata contains order/product identifiers only, never addresses,
  letter text, images, or card data.
- Terminal failures before provider acceptance enter an idempotent monetary
  refund path. They do not create general-purpose credit.

## Pay & Send ACID and distributed transaction boundaries

PostgreSQL is the ACID boundary. Stripe and the mail/image providers are never
called inside a database transaction. Cross-system work uses durable intent,
stable idempotency keys, leases, transactional outbox rows, and reconciliation.

### Atomicity

- Checkout creation first commits an authoritative `orders` intent. Stripe is
  then called with the order's stable idempotency key, and a second transaction
  attaches the returned Session. A crash between those steps leaves a reusable
  order; retry asks Stripe for and reattaches the same Session. A racing webhook
  can bind the order from signed metadata, and maintenance reconciles attached
  paid Sessions whose webhook was missed.
- A paid webhook claims its event ID and locks the order in one transaction.
  Pack credit, its ledger audit, image entitlement, and final order state commit
  together. For JIT mail, the paid state, exact-draft consumption, letter,
  funding link, image entitlement, outbox job, and fulfillment state commit
  together. A savepoint converts a pre-provider fulfillment rejection into a
  durable `refund_pending` outcome without retaining partial mail state.
- A prepaid send locks the draft and user, deducts the credit ledger, creates
  the letter, consumes the draft, and inserts the outbox job in one transaction.
- A mail provider call occurs only after the outbox commit. Provider acceptance
  is persisted in a later transaction that updates the letter, job, JIT order,
  and order event together. If that persistence is ambiguous, the job is kept
  recoverable and replayed with the same letter idempotency key; it is not
  reclassified as a pre-provider failure.
- Refund work atomically acquires a database lease, calls Stripe outside the
  transaction, and then locks/finalizes the order, revocations, and audit event
  in one transaction. If Stripe succeeds before persistence crashes, retry
  discovers the existing refund by payment intent and order metadata.
- Image generation reserves and charges an exact entitlement in one transaction
  before the provider call. Provider success marks that durable reservation
  consumed; a known failure transactionally releases only that reservation.
- Stripe dispute delivery claims its event and creates a sanitized operational
  alert in one transaction. A failed alert insert rolls the claim back, so a
  Stripe retry cannot be acknowledged while its monitoring work is lost.

### Consistency

- Database checks prevent negative cached balances, negative or over-consumed
  ledger buckets, invalid order/funding/reservation states, non-positive grants,
  and entitlement consumption above its quantity.
- Unique constraints prevent duplicate Stripe Session, PaymentIntent, refund,
  application idempotency, webhook-event, grant-source, JIT-letter-funding, and
  active-JIT-draft records.
- Runtime transitions additionally require locked ownership and exact
  `user_id`/`draft_id`/paid-order binding. JIT funding cannot debit prepaid
  balance, and a letter funded by one order cannot satisfy another order.
- State changes use locked current rows and status predicates. Late payment
  failures, expirations, refunds, and provider outcomes cannot move an already
  terminal order backward.

### Isolation

- Draft, order, user/ledger, entitlement, reservation, and outbox candidate rows
  are locked before decisions that consume or transition them. `SKIP LOCKED`
  gives one worker a job; stale leases recover after process loss.
- Concurrent webhook deliveries compete on the unique event claim and order
  lock. Concurrent checkout/prepaid/JIT paths serialize on the same draft, and
  the partial unique index remains a final database guard.
- Refund workers use an atomic time-bounded lease. A separate order lock
  serializes the returned Stripe result with refund webhooks so grants are
  revoked at most once.
- Image reservations move through `reserved -> dispatched -> consumed/released`
  with `ambiguous` as a quarantine state. Stale pre-dispatch reservations are
  locked with `SKIP LOCKED` and released once; stale dispatches are quarantined
  without restoring quota. Concurrent reconcilers cannot resolve the same row.

### Durability and compensation

- Orders, webhook claims, event history, credit transactions, entitlements,
  reservations, letters, refund attempts, and outbox work are committed data;
  none depends on process memory or an in-process queue.
- Stable Stripe order/attempt keys and the letter ID used as the provider key
  make crash/redeploy replay deterministic. Maintenance reconciles paid
  Sessions, paid orders, stale mail jobs, and pending refunds.
- Only an explicit provider rejection is treated as proof that no mail was
  accepted and is eligible for automatic refund. Timeouts, thrown provider
  errors, and acceptance-persistence failures remain recoverable because their
  external outcome is ambiguous. This is the unavoidable compensation boundary
  where no distributed ACID transaction exists.
- Image generation uses the same compensation rule. Validation and a stale
  pre-dispatch lease are safe to release. Transport failures, HTTP timeouts and
  5xx responses after the durable dispatch boundary are ambiguous and keep the
  budget unit held. Provider-confirmed success consumes it; provider-confirmed
  failure or a deliberate customer-compensation decision releases the exact
  entitlement in a locked transaction. The small crash window after durable
  dispatch marking but before network I/O is also treated as ambiguous because
  the database cannot prove whether bytes reached the provider.
- Ambiguous outcomes are resolved only through the authenticated admin route.
  The request binds the reservation to its expected account, uses a durable
  idempotency key, and restricts decisions to evidence-compatible enums. The
  state/counter transition and durable operator audit row commit together;
  exact retries return the recorded result and changed reuses fail closed.
