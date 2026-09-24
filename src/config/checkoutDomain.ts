/**
 * Stripe's custom domain for Checkout (#373).
 *
 * With a custom domain active, Stripe returns Checkout Session URLs on it,
 * such as https://pay.letterirl.com/c/pay/cs_live_..., instead of on
 * checkout.stripe.com. Two things here forward only to hosts they know: the
 * start page (/purchase/start, #372), which refuses any other target, and the
 * widgets' redirect list. STRIPE_CHECKOUT_DOMAIN names the custom host for
 * both, beside checkout.stripe.com, which always stays: a session opened
 * before the switch keeps its URL. The domain is added once, in live mode,
 * but Stripe's docs suggest test-mode sessions of the same account may use it
 * too, so development sets the variable as well.
 *
 * Set it BEFORE adding the domain in Stripe. The domain activates by itself
 * once its DNS records verify, and every session created after that carries
 * it; without the setting the start page would refuse every one of them.
 */

export const STRIPE_CHECKOUT_HOST = "checkout.stripe.com";

const HOST_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The configured custom checkout host, or null when it is unset or not a bare host name. */
export function stripeCheckoutDomain(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.STRIPE_CHECKOUT_DOMAIN ?? "").trim().toLowerCase();
  if (!raw || !HOST_NAME.test(raw) || raw === STRIPE_CHECKOUT_HOST) return null;
  return raw;
}

/** True when STRIPE_CHECKOUT_DOMAIN is set to something that is not a bare host name. */
export function stripeCheckoutDomainInvalid(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.STRIPE_CHECKOUT_DOMAIN ?? "").trim();
  return raw !== "" && raw.toLowerCase() !== STRIPE_CHECKOUT_HOST && stripeCheckoutDomain(env) === null;
}

/** Every host a Checkout Session URL may be on. */
export function checkoutHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const custom = stripeCheckoutDomain(env);
  return new Set(custom ? [STRIPE_CHECKOUT_HOST, custom] : [STRIPE_CHECKOUT_HOST]);
}

/**
 * The widgets' redirect list: every checkout host, then the packs page and
 * the API, which serves the start page the cards open (#372).
 */
export function widgetRedirectOrigins(
  packsOrigin: string,
  apiOrigin: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return Array.from(
    new Set([...Array.from(checkoutHosts(env), (host) => `https://${host}`), packsOrigin, apiOrigin]),
  );
}
