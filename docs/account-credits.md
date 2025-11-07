# Account and Credits Model

## User Account Record
- Maintain a per-user record containing at minimum:
  - `userId`: stable identifier derived from the Apps SDK session or auth token.
  - `creditsRemaining`: numeric field supporting integers or fractional credits.
  - `orders`: collection or foreign-key reference to stored letter orders.
- Development mode can stub a single user, but the data model must support multi-user tenancy.

## Credits Semantics
- Each Letter IRL credit covers one standard, single-page First Class mailing.
- Pricing for longer letters is calculated server-side and returned as `requiredCredits` in preview responses.
- Credits are decremented only when `send_letter` succeeds; previews are read-only.
- Credit purchase flows are intentionally excluded from v1 but should be easy to bolt on later.

## Validation Rules
- `quote_and_preview_letter` computes `requiredCredits` and determines `canSendNow` by comparing against the authenticated user’s balance.
- `send_letter` re-validates balance before deduction to prevent race conditions.
- Insufficient credit attempts return errors with `insufficientCredits: true` and current balance details for UI messaging.

## Standard Cost Heuristics
- Default cost: 1.0 Letter IRL credit for content that fits on a single page.
- Multi-page detection can rely on simple character-count thresholds in v1; convert to smarter pagination once print pipeline is integrated.
- Costs should round up in 0.5-credit increments to preserve future pricing flexibility.
