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
