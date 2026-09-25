# Stripe Custom Checkout Domain

**Last Updated:** September 24, 2026
**Purpose:** Serving Stripe-hosted Checkout on `pay.letterirl.com`, and the order to set it up in (#373)
**Status:** Steps 4 to 7 done on 2026-09-24: `pay.letterirl.com` added in live mode with **Switch to this domain once added** unticked, DNS verified. Development has the setting (step 2). Left for launch: the production setting and connector refresh (steps 1 to 3), then switching to the domain in Stripe, then step 8.

The app guidelines ask for purchases to complete on our own domain. Stripe can serve its hosted Checkout page on a subdomain of ours. That is a paid Stripe feature: USD 10 a month, billed in the first week of the following month, and only for months it was on for the whole month ([Stripe's FAQ](https://support.stripe.com/questions/custom-domain-on-stripe-hosted-surfaces-faq)).

## How it fits

The letter pack card opens our start page, `https://api.letterirl.com/purchase/start`, which forwards to the Checkout Session's URL (#372). The Pay & Send buttons on the preview cards open the Checkout URL itself. With the custom domain active, Stripe returns that URL on `pay.letterirl.com` either way.

The start page forwards only to hosts it knows (`src/config/checkoutDomain.ts`). `STRIPE_CHECKOUT_DOMAIN` adds ours beside `checkout.stripe.com`, which always stays, because a session opened before the switch keeps its old URL.

The domain is added once, in live mode; a sandbox cannot add one. Stripe's docs suggest test-mode sessions of the same account may still use it. Development shares that account, so it sets the variable too. An extra allowed host costs nothing, and without it every development checkout would stop on our page.

The same setting adds `https://pay.letterirl.com` to the widgets' redirect list. That list matters for Pay & Send: its cards open the Checkout URL itself, while the pack card opens the start page. A malformed value refuses to boot production (`stripe.checkout_domain_invalid`).

**Order matters.** The API must accept the new host before Stripe starts using it. Otherwise the start page refuses every new checkout, and customers stop on our own page.

## Setup, at launch

1. **Code.** The production API includes #373 (check `/readyz` reports a commit at or after it).
2. **Setting.** On Railway, set `STRIPE_CHECKOUT_DOMAIN=pay.letterirl.com` on `letter-irl-api` in **both** environments. Wait for each redeploy, then confirm:
   - `/readyz` answers 200;
   - the boot log has no `stripe.checkout_domain_invalid`.
3. **Connector.** Refresh the production ChatGPT connector after that redeploy. The widgets' redirect list is cached with the connector. Confirm the panel's `csp.redirectDomains` lists `https://pay.letterirl.com`. The launch's own connector refresh can be this one if it comes after the setting.
4. **CAA check.** Look up the CAA records of `letterirl.com`, for example with `curl -s "https://dns.google/resolve?name=letterirl.com&type=CAA"`. Windows `nslookup` does not know the CAA type.
   - If any CAA record exists, add one allowing `letsencrypt.org` (flags `0`, tag `issue`), because Stripe's certificates come from Let's Encrypt.
   - No CAA record at all needs nothing. An empty `Answer` means none; that was the case on 2026-09-24.
5. **Stripe.** In the Dashboard, in live mode, open [Custom domains](https://dashboard.stripe.com/settings/custom-domains) and choose **Add your domain**.
   - Enter `pay.letterirl.com`, and choose **Add**. The dialog states the price and that the subscription renews.
   - Stripe then shows the two DNS records.
   - Behind that popup, on the domain's card, **Switch to this domain once added** is ticked by default. The Add dialog itself has no such box. Leave it ticked, because step 2 already made the switch safe.

   Steps 4 to 7 can run before launch, so the certificate is ready. Then **untick** the box on the domain's card before adding the DNS records, because production does not accept the new host until steps 1 to 3 are done. The untick is saved at once, and it survives a reload. After verification Stripe checks the records' stability for at least three hours, then emails. Switch to the domain on the same page afterwards.
6. **DNS at DreamHost**, which hosts letterirl.com's DNS. Add:

   | Type | Name | Value | TTL |
   |------|------|-------|-----|
   | CNAME | `pay` | `hosted-checkout.stripecdn.com` | 300 |
   | TXT | `_acme-challenge.pay` | the value from Stripe's **View instructions** | 300 |

   `pay` must not already be a DreamHost site or have other records. DreamHost's panel has no TTL field; its default is five minutes. It saves a record the moment you choose **Add Record**, and publishing takes a minute or two.
7. **Verify DNS.** Both of these should answer within about ten minutes:
   - `nslookup -querytype=CNAME pay.letterirl.com` gives `hosted-checkout.stripecdn.com`;
   - `nslookup -querytype=TXT _acme-challenge.pay.letterirl.com` gives the value.

   Stripe then issues the certificate. It emails, and the Dashboard shows the domain as active.
8. **Check.** In production ChatGPT, open a letter pack checkout from the card.
   - The start page should forward to `https://pay.letterirl.com/c/pay/...` with Stripe's page on it.
   - Cancel without paying.
   - The API log's `purchase.start` line shows the forward.
   - From a letter preview on an account with no letters, **Pay & Send** should open `pay.letterirl.com` without ChatGPT's safe-link warning. Cancel that too.
9. **Development.** Open a checkout on the (DEV) connector and note which host Stripe's test page is on, and record it here. Either way the start page forwards, since development allows both hosts.

## Removing it

1. Remove the domain on the same Stripe settings page; new sessions return to `checkout.stripe.com`.
2. Wait a day before the next step. Checkout Sessions stay open for up to 24 hours, and a session opened on `pay.letterirl.com` keeps that URL in its order and in the card. Once the domain's DNS is gone, those links stop working.
3. Delete the two DNS records.
4. The setting can stay, because the start page keeps accepting `checkout.stripe.com`.

Source: [Stripe: Use your custom domain](https://docs.stripe.com/payments/checkout/custom-domains?payment-ui=stripe-hosted).
