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
