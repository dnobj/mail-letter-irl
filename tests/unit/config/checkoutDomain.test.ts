import { describe, expect, it } from 'vitest';
import {
  STRIPE_CHECKOUT_HOST,
  checkoutHosts,
  stripeCheckoutDomain,
  stripeCheckoutDomainInvalid,
  widgetRedirectOrigins
} from '../../../src/config/checkoutDomain.js';

/**
 * Stripe's custom domain for Checkout (#373): once it is active, Checkout URLs
 * are on it, and the start page and the widgets must accept it beside
 * checkout.stripe.com.
 */
describe('the custom checkout domain', () => {
  it('reads a bare host name, trimmed and lower-cased', () => {
    expect(stripeCheckoutDomain({ STRIPE_CHECKOUT_DOMAIN: 'pay.letterirl.com' })).toBe('pay.letterirl.com');
    expect(stripeCheckoutDomain({ STRIPE_CHECKOUT_DOMAIN: '  Pay.LetterIRL.com ' })).toBe('pay.letterirl.com');
  });

  it('refuses anything that is not a bare host name, and says so', () => {
    for (const value of [
      'https://pay.letterirl.com',
      'pay.letterirl.com/',
      'pay.letterirl.com:443',
      'pay.letterirl.com/c/pay',
      'pay',
      'pay..letterirl.com',
      '-pay.letterirl.com',
      'pay.letterirl.com.',
      'pay letterirl.com'
    ]) {
      expect(stripeCheckoutDomain({ STRIPE_CHECKOUT_DOMAIN: value }), value).toBeNull();
      expect(stripeCheckoutDomainInvalid({ STRIPE_CHECKOUT_DOMAIN: value }), value).toBe(true);
    }
  });

  it('is simply off when unset, blank, or Stripe\'s own host', () => {
    for (const env of [{}, { STRIPE_CHECKOUT_DOMAIN: '' }, { STRIPE_CHECKOUT_DOMAIN: '  ' }, { STRIPE_CHECKOUT_DOMAIN: STRIPE_CHECKOUT_HOST }]) {
      expect(stripeCheckoutDomain(env)).toBeNull();
      expect(stripeCheckoutDomainInvalid(env)).toBe(false);
      expect([...checkoutHosts(env)]).toEqual([STRIPE_CHECKOUT_HOST]);
    }
  });

  it("always keeps Stripe's own host beside the custom one", () => {
    expect([...checkoutHosts({ STRIPE_CHECKOUT_DOMAIN: 'pay.letterirl.com' })]).toEqual([
      'checkout.stripe.com',
      'pay.letterirl.com'
    ]);
  });

  it('leads the widgets\' redirect list with the checkout hosts', () => {
    expect(widgetRedirectOrigins('https://letterirl.com', 'https://api.letterirl.com', {})).toEqual([
      'https://checkout.stripe.com',
      'https://letterirl.com',
      'https://api.letterirl.com'
    ]);
    expect(
      widgetRedirectOrigins('https://letterirl.com', 'https://api.letterirl.com', { STRIPE_CHECKOUT_DOMAIN: 'pay.letterirl.com' })
    ).toEqual(['https://checkout.stripe.com', 'https://pay.letterirl.com', 'https://letterirl.com', 'https://api.letterirl.com']);
  });
});
