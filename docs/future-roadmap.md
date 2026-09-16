# Out-of-Scope and Future Enhancements

**Last Updated:** September 16, 2026
**Purpose:** Features deliberately left out, and the plans for them

## Shipped Since v1

- **Letter packs in the conversation:** `list_letter_packs` and `create_pack_checkout`, through
  Stripe-hosted Checkout.
- **Just-in-Time Pay & Send:** `create_mail_checkout` buys and sends one exact letter or postcard.
  Design and acceptance criteria: [just-in-time-purchase-plan.md](just-in-time-purchase-plan.md);
  tracking: [GitHub issue #69](https://github.com/dnobj/mail-letter-irl/issues/69).

## In-ChatGPT Checkout (Agentic Commerce Protocol)
- Complete purchases inside ChatGPT through ACP once OpenAI makes it available to apps like Letter
  IRL. Today in-ChatGPT checkout is limited-access, so both purchase paths use external Stripe
  Checkout.
- OpenAI's app guidelines, when last checked (2026-09-13), allowed commerce only for physical goods,
  so Pay & Send is the likelier first ACP product.
- Plan: [acp-implementation-guide.md](acp-implementation-guide.md),
  [acp-quickstart.md](acp-quickstart.md), [acp-stripe-integration.md](acp-stripe-integration.md).

## Identity-Linked Funding
- Identity-linked funding flows (e.g., Worldcoin/WLD) remain an idea, not a plan.

## Proof-of-Origin and Authenticity
- Roadmap feature to embed a QR code or code snippet in printed letters for verification of print time, integrity, and optional sender verification.
- Requires storing a `letterHash` or similar value per order; plan data model accordingly.

## Bulk and Campaign Mailing
- Multi-recipient or automated campaigns remain out-of-scope due to spam risk and heightened review scrutiny.
- Future support would need stronger abuse controls and rate limiting.

## Return Mail Handling
- Handling undeliverable mail, return-to-sender workflows, or mailbox services are deferred.
- Prototype assumes undeliverable items are unmanaged at this stage.

