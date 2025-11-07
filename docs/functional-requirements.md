# Functional Requirements

## Identity and Session Management
- The server must uniquely identify ChatGPT users; assume Apps SDK will deliver an auth token or user ID.
- In development, a hard-coded user or simple bearer token is acceptable, provided all state remains scoped per user.

## Credits Lifecycle
- Store each user's Letter IRL credit balance as an integer or decimal.
- Reject `send_letter` requests when available credits are less than `requiredCredits`.
- Return the computed `requiredCredits` from `quote_and_preview_letter` so the UI can surface cost prior to confirmation.

## Letter Composition and Formatting
- Generate printable output suitable for standard 8.5"×11" letter stock in black text.
- Collect complete sender and recipient address blocks (name, address lines, city, state, postal code, country) before proceeding.
- Persist a renderable HTML (and eventual PDF) snapshot linked to each order for downstream previews and auditing.

## Order Creation
- On successful `send_letter`, deduct the required credits and create an order record containing:
  - `orderId` (unique string or GUID)
  - Sender and recipient blocks
  - Immutable letter body and sign-off
  - `requiredCredits`
  - `statusTimeline` array with timestamped entries
  - `currentStatus`
- Initialize `statusTimeline` with a `queued_for_print` state.
- Return order details alongside updated credit balance in the tool response.

## Order Status Updates
- Support, at minimum, the states `queued_for_print`, `printing`, and `mailed`.
- `get_order_status` must return the full timeline (`timestampISO`, `statusText`) and a recipient summary.
- For development, status transitions can be simulated or mocked; integrate with the real print pipeline later.

## Safety and Confirmation Controls
- `send_letter` must validate `confirm === true`; otherwise return a failure with a clear error.
- Include recipient and sender summaries plus the first ~200 characters of the letter body in the confirmation payload for user reassurance.

## Audit and Traceability
- Log each order with full text, addresses, timestamps, and initiating user ID.
- Preserve immutable snapshots to support customer service inquiries and fraud investigations.

## Observability and Debugging
- Instrument every MCP tool handler with structured logs that capture tool name, correlation ID, user identifier (hashed/anonymized), request validation results, and high-level outcome (success, validation error, business rule failure) while redacting full PII payloads.
- Emit start/finish log entries for long-running operations (e.g., preview rendering, credit deduction, status transitions) with elapsed timing to aid SLA tracking.
- Centralize logging through a shared module so sinks (stdout, file, remote aggregator) can be swapped without touching business logic.
- Surface validation failures with explicit error codes/messages and include them in logs to simplify QA triage.
