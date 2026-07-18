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

## Just-in-Time Pay & Send
- Add a hosted checkout that purchases and sends one exact physical letter or postcard without requiring a letter pack.
- Keep packs as the discounted prepaid option; do not expose internal credits as stand-alone digital goods.
- Treat successful payment as explicit send authorization, then fulfill from verified Stripe webhooks through the transactional outbox.
- Keep Letter IRL-funded image generation purchase-gated initially, with explicit entitlements and a disabled-by-default trial flag.
- Detailed design and acceptance criteria: [Just-in-Time Purchase Implementation Plan](just-in-time-purchase-plan.md)
- Tracking: [GitHub issue #69](https://github.com/dnobj/mail-letter-irl/issues/69)
