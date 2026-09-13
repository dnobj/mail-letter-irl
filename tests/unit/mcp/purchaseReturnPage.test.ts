/**
 * The Stripe return trip: the start page the card opens, and the return page
 * the customer lands on. Both must offer only what they can back up.
 *
 * Until 2026-09-13 the return page said "Return to ChatGPT" with no link. The
 * Android run that day showed the site root opens the web app rather than
 * the ChatGPT app when the phone has the app's link handling switched off,
 * and that the app hands the root back to the browser even when forced;
 * only a conversation link opens in-app. Apple devices get text only until
 * a link is proven on a device: the owner's rule is a working Apple link or
 * none.
 *
 * The conversation link comes from ChatGPT (#372): for an allowlisted
 * redirect domain it appends `redirectUrl` to what openExternal opens. The
 * start page keeps it in a same-site cookie and forwards to Stripe.
 */

import { describe, expect, it } from 'vitest';
import {
  CHATGPT_WEB_URL,
  IOS_RETURN_LINK_VERIFIED,
  RETURN_COOKIE_NAME,
  androidIntentLink,
  chatgptReturnAction,
  chatgptReturnLink,
  decidePurchaseStart,
  isApplePhoneOrTablet,
  parseChatgptReturnUrl,
  parseCheckoutTarget,
  readReturnCookie,
  renderPurchaseReturnPage,
  returnCookieHeader
} from '../../../src/mcp/purchaseReturnPage.js';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 16; SM-S948U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const MAC_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';

const CONVERSATION = 'https://chatgpt.com/c/6aa6ac84-013c-83ea-b6f7-e149f0883fe3';
const CHECKOUT = 'https://checkout.stripe.com/c/pay/cs_test_abc#fid';

describe('parseChatgptReturnUrl', () => {
  it('keeps https links into ChatGPT itself', () => {
    expect(parseChatgptReturnUrl(CONVERSATION)).toBe(CONVERSATION);
    expect(parseChatgptReturnUrl('https://chat.openai.com/c/x')).toBe('https://chat.openai.com/c/x');
    expect(parseChatgptReturnUrl('https://www.chatgpt.com/')).toBe('https://www.chatgpt.com/');
  });

  it('drops anything else, because the value becomes a button destination', () => {
    // An attacker who learns the start URL must not be able to plant a link.
    expect(parseChatgptReturnUrl('http://chatgpt.com/c/x')).toBeNull();
    expect(parseChatgptReturnUrl('https://chatgpt.com.evil.example/c/x')).toBeNull();
    expect(parseChatgptReturnUrl('https://evil.example/?u=https://chatgpt.com')).toBeNull();
    expect(parseChatgptReturnUrl('javascript:alert(1)')).toBeNull();
    expect(parseChatgptReturnUrl('https://user:pw@chatgpt.com/c/x')).toBeNull();
    expect(parseChatgptReturnUrl('')).toBeNull();
    expect(parseChatgptReturnUrl(null)).toBeNull();
    expect(parseChatgptReturnUrl('not a url')).toBeNull();
  });
});

describe('parseCheckoutTarget', () => {
  it('forwards only to Stripe-hosted checkout', () => {
    expect(parseCheckoutTarget(CHECKOUT)).toBe(CHECKOUT);
    expect(parseCheckoutTarget('https://evil.example/pay')).toBeNull();
    expect(parseCheckoutTarget('http://checkout.stripe.com/c/pay/x')).toBeNull();
    expect(parseCheckoutTarget(null)).toBeNull();
  });
});

describe('decidePurchaseStart', () => {
  it('forwards to the checkout and keeps a valid return link in a same-site cookie', () => {
    const decision = decidePurchaseStart({ to: CHECKOUT, redirectUrl: CONVERSATION });

    expect(decision.status).toBe(302);
    if (decision.status !== 302) throw new Error('unreachable');
    expect(decision.location).toBe(CHECKOUT);
    expect(decision.cookie).toContain(`${RETURN_COOKIE_NAME}=${encodeURIComponent(CONVERSATION)}`);
    // Lax, not Strict: the customer comes back from Stripe by a top-level
    // navigation, and Strict cookies are withheld on exactly that.
    expect(decision.cookie).toMatch(/SameSite=Lax/);
    expect(decision.cookie).toMatch(/HttpOnly/);
    expect(decision.cookie).toMatch(/Secure/);
    expect(decision.cookie).toMatch(/Path=\/purchase/);
  });

  it('forwards without a cookie when no acceptable return link was appended', () => {
    const decision = decidePurchaseStart({ to: CHECKOUT, redirectUrl: 'https://evil.example/' });

    expect(decision.status).toBe(302);
    if (decision.status !== 302) throw new Error('unreachable');
    expect(decision.cookie).toBeNull();
  });

  it('refuses a destination that is not Stripe checkout', () => {
    const decision = decidePurchaseStart({ to: 'https://evil.example/', redirectUrl: CONVERSATION });

    expect(decision.status).toBe(400);
    if (decision.status !== 400) throw new Error('unreachable');
    expect(decision.body).toMatch(/not valid/i);
  });
});

describe('readReturnCookie', () => {
  it('reads the link back out of the cookie header', () => {
    const header = `other=1; ${returnCookieHeader(CONVERSATION).split(';')[0]}; more=2`;
    expect(readReturnCookie(header)).toBe(CONVERSATION);
  });

  it('applies the same allowlist on the way back', () => {
    expect(readReturnCookie(`${RETURN_COOKIE_NAME}=${encodeURIComponent('https://evil.example/')}`)).toBeNull();
    expect(readReturnCookie(`${RETURN_COOKIE_NAME}=%E0%A4%A`)).toBeNull();
    expect(readReturnCookie(undefined)).toBeNull();
  });
});

describe('androidIntentLink', () => {
  it('names the package and keeps the web link as the fallback', () => {
    const link = androidIntentLink(CONVERSATION);

    expect(link.startsWith('intent://chatgpt.com/c/6aa6ac84-013c-83ea-b6f7-e149f0883fe3#Intent;')).toBe(true);
    expect(link).toContain('scheme=https;');
    expect(link).toContain('package=com.openai.chatgpt;');
    expect(link).toContain(`S.browser_fallback_url=${encodeURIComponent(CONVERSATION)};end`);
  });
});

describe('chatgptReturnAction', () => {
  it('offers no link on iPhone and iPad until a device has proven one', () => {
    expect(IOS_RETURN_LINK_VERIFIED).toBe(false);
    expect(isApplePhoneOrTablet(IPHONE_UA)).toBe(true);
    expect(chatgptReturnAction(IPHONE_UA, null)).toBeNull();
    expect(chatgptReturnAction(IPAD_UA, CONVERSATION)).toBeNull();
    expect(chatgptReturnLink(IPHONE_UA)).toBeNull();
  });

  it('sends Android into the app by package when the conversation is known', () => {
    const action = chatgptReturnAction(ANDROID_UA, CONVERSATION);
    expect(action?.label).toBe('Back to your conversation');
    expect(action?.href).toBe(androidIntentLink(CONVERSATION));
  });

  it('falls back to the plain origin on Android without a conversation', () => {
    // Opens the app where the phone keeps the app's link handling on, and
    // the web app where the owner turned it off; never the App Store.
    expect(chatgptReturnAction(ANDROID_UA, null)).toEqual({ href: CHATGPT_WEB_URL, label: 'Back to ChatGPT' });
  });

  it('gives desktop browsers, a Mac included, the conversation or the web app', () => {
    expect(chatgptReturnAction(DESKTOP_UA, CONVERSATION)).toEqual({
      href: CONVERSATION,
      label: 'Back to your conversation'
    });
    expect(chatgptReturnAction(MAC_SAFARI_UA, null)).toEqual({ href: CHATGPT_WEB_URL, label: 'Back to ChatGPT' });
    expect(chatgptReturnLink(undefined)).toBe(CHATGPT_WEB_URL);
  });
});

describe('renderPurchaseReturnPage', () => {
  it('offers Back to your conversation on Android in intent form, in the same tab', () => {
    const html = renderPurchaseReturnPage({ cancelled: false, userAgent: ANDROID_UA, conversationUrl: CONVERSATION });

    expect(html).toContain('<h1>Payment received</h1>');
    expect(html).toContain('>Back to your conversation</a>');
    expect(html).toContain('href="intent://chatgpt.com/c/');
    expect(html).not.toContain('target=');
  });

  it('offers Back to ChatGPT on Android when no conversation is known', () => {
    const html = renderPurchaseReturnPage({ cancelled: false, userAgent: ANDROID_UA });

    expect(html).toContain('>Back to ChatGPT</a>');
    expect(html).toContain(`href="${CHATGPT_WEB_URL}"`);
  });

  it('tells an iPhone to close the page instead of offering a link, conversation or not', () => {
    for (const conversationUrl of [null, CONVERSATION]) {
      const html = renderPurchaseReturnPage({ cancelled: false, userAgent: IPHONE_UA, conversationUrl });
      expect(html).not.toContain('<a ');
      expect(html).toMatch(/close this page and return to the ChatGPT app/i);
    }
  });

  it('says nothing was charged when the checkout was cancelled', () => {
    const html = renderPurchaseReturnPage({ cancelled: true, userAgent: DESKTOP_UA });

    expect(html).toContain('<h1>Checkout cancelled</h1>');
    expect(html).toMatch(/nothing was charged/i);
    expect(html).toContain(`href="${CHATGPT_WEB_URL}"`);
  });

  it('carries no order, session or amount detail', () => {
    // Authenticated status lives behind get_purchase_status only; this page
    // is reachable by anyone with the URL.
    for (const userAgent of [ANDROID_UA, IPHONE_UA, DESKTOP_UA]) {
      const html = renderPurchaseReturnPage({ cancelled: false, userAgent, conversationUrl: CONVERSATION });
      // Word-bounded: the inline CSS says "border-radius".
      expect(html).not.toMatch(/\border\b|\bsession\b|\bcs_[a-z]|\bUSD\b|\$\d/i);
    }
  });
});
