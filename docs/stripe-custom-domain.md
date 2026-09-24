# Stripe Custom Checkout Domain

**Last Updated:** September 23, 2026
**Purpose:** Serving Stripe-hosted Checkout on `pay.letterirl.com`, and the order to set it up in (#373)
**Status:** Code ready; to be set up in production at launch. Live mode only.

The app guidelines ask for purchases to complete on our own domain. Stripe can serve its hosted Checkout page on a subdomain of ours. That is a paid Stripe feature, USD 10 a month, billed only for months it is on for the whole month.

## How it fits

A card never links to Stripe directly. It opens our start page, `https://api.letterirl.com/purchase/start`, which forwards to the Checkout Session's URL (#372). With the custom domain active, Stripe returns that URL on `pay.letterirl.com`.

The start page forwards only to hosts it knows (`src/config/checkoutDomain.ts`). `STRIPE_CHECKOUT_DOMAIN` adds ours beside `checkout.stripe.com`, which always stays, because:
- sandboxes cannot use a custom domain, so development stays on `checkout.stripe.com`;
- a session opened before the switch keeps its old URL.

The same setting adds `https://pay.letterirl.com` to the widgets' redirect list. A malformed value refuses to boot production (`stripe.checkout_domain_invalid`).

**Order matters.** The API must accept the new host before Stripe starts using it. Otherwise the start page refuses every new checkout, and customers stop on our own page.

## Setup, at launch

1. **Code.** The production API includes #373 (check `/readyz` reports a commit at or after it).
2. **Setting.** On Railway, set `STRIPE_CHECKOUT_DOMAIN=pay.letterirl.com` on production's `letter-irl-api`. Wait for the redeploy, then confirm:
   - `/readyz` answers 200;
   - the boot log has no `stripe.checkout_domain_invalid`.
3. **CAA check.** Run `nslookup -querytype=CAA letterirl.com`.
   - If any CAA record exists, add one allowing `letsencrypt.org` (flags `0`, tag `issue`), because Stripe's certificates come from Let's Encrypt.
   - No CAA record at all needs nothing.
4. **Stripe.** In the Dashboard, in live mode, open [Custom domains](https://dashboard.stripe.com/settings/custom-domains) and choose **Add your domain**.
   - Enter `pay.letterirl.com`.
   - Leave **Switch to this domain once added** ticked. Step 2 already made the switch safe.
   - Stripe then shows the two DNS records.
5. **DNS at DreamHost**, which hosts letterirl.com's DNS. Add:

   | Type | Name | Value | TTL |
   |------|------|-------|-----|
   | CNAME | `pay` | `hosted-checkout.stripecdn.com` | 300 |
   | TXT | `_acme-challenge.pay` | the value from Stripe's **View instructions** | 300 |

   `pay` must not already be a DreamHost site or have other records.
6. **Verify DNS.** Both of these should answer within about ten minutes:
   - `nslookup -querytype=CNAME pay.letterirl.com` gives `hosted-checkout.stripecdn.com`;
   - `nslookup -querytype=TXT _acme-challenge.pay.letterirl.com` gives the value.

   Stripe then issues the certificate. It emails, and the Dashboard shows the domain as active.
7. **Check.** In production ChatGPT, open a letter pack checkout from the card.
   - The start page should forward to `https://pay.letterirl.com/c/pay/...` with Stripe's page on it.
   - Cancel without paying.
   - The API log's `purchase.start` line shows the forward.

## Removing it

1. Remove the domain on the same Stripe settings page; new sessions return to `checkout.stripe.com`.
2. Delete the two DNS records.
3. The setting can stay, because the start page keeps accepting `checkout.stripe.com`.

Source: [Stripe: Use your custom domain](https://docs.stripe.com/payments/checkout/custom-domains?payment-ui=stripe-hosted).
