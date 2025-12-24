# Out-of-Scope and Future Enhancements

## Credit Purchase and Top-Up
- Future tool: `top_up_balance` integrating with payment providers (e.g., Stripe) or identity-linked funding flows (e.g., Worldcoin/WLD).
- Not exposed in v1 to simplify Apps SDK review and avoid payment compliance hurdles.

## Proof-of-Origin and Authenticity
- Roadmap feature to embed a QR code or code snippet in printed letters for verification of print time, integrity, and optional sender verification.
- Requires storing a `letterHash` or similar value per order; plan data model accordingly.

## Bulk and Campaign Mailing
- Multi-recipient or automated campaigns remain out-of-scope due to spam risk and heightened review scrutiny.
- Future support would need stronger abuse controls and rate limiting.

## Return Mail Handling
- Handling undeliverable mail, return-to-sender workflows, or mailbox services are deferred.
- Prototype assumes undeliverable items are unmanaged at this stage.

## Just-In-Time Billing (Saved Payment Methods)
- Allow users to save billing information (credit card via Stripe) or use Stripe Link for seamless checkout.
- Enables sending letters without pre-purchasing letter packs - charge at time of send.
- User flow: "Send now, pay now" instead of "Buy letter pack, then send."
- **Recommended approach: Stripe Link**
  - Universal wallet managed by Stripe (we never store payment info)
  - One-click checkout for returning users (SMS verification)
  - Already works with Stripe Checkout (may just need dashboard toggle)
  - No additional PCI compliance burden
- Implementation phases:
  1. **Quick win**: Enable Stripe Link in Stripe Dashboard for faster repeat checkout
  2. **JIT billing**: Add "Pay & Send" option that skips letter pack purchase
  3. **Optional**: Store Stripe Customer ID for true one-click (charge saved method directly)
- Considerations:
  - Failed payment handling (letter queued but payment fails)
  - Price transparency at preview time
  - Refund handling for failed deliveries
- **OpenAI compliance note**: Current letter-pack model is likely compliant (prepaid physical goods, not virtual currency). JIT billing is primarily a UX improvement.
- Related: See "Credit Purchase and Top-Up" above for pre-purchase flow.
- Tracking: GitHub issue #69
