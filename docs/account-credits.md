# Account and Credits Model

## User Account Record
- Maintain a per-user record containing at minimum:
  - `userId`: stable identifier derived from the Apps SDK session or auth token.
  - `creditsRemaining`: numeric field supporting integers or fractional credits.
  - `orders`: collection or foreign-key reference to stored letter orders.
- Development mode can stub a single user, but the data model must support multi-user tenancy.

## Credits Semantics
- Each letter costs 2 Letter IRL credits (current flat rate).
- All letters are limited to one page maximum (~1,800 characters).
- Credits are decremented only when `send_letter` succeeds; previews are read-only.
- Credit purchase flows available through Stripe checkout and OpenAI Agentic Commerce.

## Validation Rules
- `quote_and_preview_letter` returns `requiredCredits: 2` (flat rate) and determines `canSendNow` by comparing against the authenticated user's balance.
- `send_letter` validates:
  - User has at least 2 credits
  - Letter content does not exceed one page (~1,800 characters)
  - Re-validates balance before deduction to prevent race conditions
- Insufficient credit attempts return errors with `insufficientCredits: true` and current balance details for UI messaging.
- Over-length letters return errors prompting user to shorten content.

## Standard Cost Heuristics
- **Current Model:** Flat 2 credits per letter (one page maximum).
- **Future Plans:** May introduce tiered pricing:
  - Basic letters: 1 credit (plain text, standard delivery)
  - Premium letters: 2 credits (current offering)
  - Super premium: 3+ credits (multi-page, color, expedited)
