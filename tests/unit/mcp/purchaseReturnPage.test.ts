/**
 * The Stripe return page must give the customer an honest way back into
 * ChatGPT, and nothing it cannot back up.
 *
 * Until 2026-09-13 it said "Return to ChatGPT" with no link, and on a phone
 * the only way back was the browser's Back button through the checkout
 * history. The Android run that day showed the site root opens the web app
 * rather than the ChatGPT app when the owner has turned the app's link
 * handling off, and that the app itself hands the root back to the browser
 * even when forced; only a conversation link opens in-app (#372). Apple
 * devices get text only until a link is proven on a device: the owner's
 * rule is a working Apple link or none.
 */

import { describe, expect, it } from 'vitest';
import {
  CHATGPT_WEB_URL,
  chatgptReturnLink,
  isApplePhoneOrTablet,
  renderPurchaseReturnPage
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

describe('chatgptReturnLink', () => {
  it('offers no link at all on iPhone and iPad', () => {
    // A universal link exists in chatgpt.com's site association file, but it
    // has not been proven on a device, and an Android-shaped link must never
    // reach an Apple phone.
    expect(isApplePhoneOrTablet(IPHONE_UA)).toBe(true);
    expect(isApplePhoneOrTablet(IPAD_UA)).toBe(true);
    expect(chatgptReturnLink(IPHONE_UA)).toBeNull();
    expect(chatgptReturnLink(IPAD_UA)).toBeNull();
  });

  it('links Android to the plain origin', () => {
    // Opens the app where the phone keeps the app's link handling on, and
    // the web app where the owner turned it off; never the App Store.
    expect(chatgptReturnLink(ANDROID_UA)).toBe(CHATGPT_WEB_URL);
  });

  it('links desktop browsers, a Mac included, and unknown agents to the web app', () => {
    // Mac Safari's agent says "Macintosh", not iPhone or iPad, so it keeps
    // the button: there is no app to hand off to and the web app is right.
    expect(isApplePhoneOrTablet(MAC_SAFARI_UA)).toBe(false);
    expect(chatgptReturnLink(MAC_SAFARI_UA)).toBe(CHATGPT_WEB_URL);
    expect(chatgptReturnLink(DESKTOP_UA)).toBe(CHATGPT_WEB_URL);
    expect(chatgptReturnLink(undefined)).toBe(CHATGPT_WEB_URL);
    expect(chatgptReturnLink('')).toBe(CHATGPT_WEB_URL);
  });
});

describe('renderPurchaseReturnPage', () => {
  it('offers a Back to ChatGPT link in the same tab on Android', () => {
    const html = renderPurchaseReturnPage({ cancelled: false, userAgent: ANDROID_UA });

    expect(html).toContain('<h1>Payment received</h1>');
    expect(html).toContain('>Back to ChatGPT</a>');
    expect(html).toContain(`href="${CHATGPT_WEB_URL}"`);
    // A new tab would leave the checkout tab behind; the app takes this one.
    expect(html).not.toContain('target=');
  });

  it('tells an iPhone to close the page instead of offering a link', () => {
    const html = renderPurchaseReturnPage({ cancelled: false, userAgent: IPHONE_UA });

    expect(html).toContain('<h1>Payment received</h1>');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href=');
    expect(html).toMatch(/close this page and return to the ChatGPT app/i);
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
    for (const userAgent of [ANDROID_UA, IPHONE_UA]) {
      const html = renderPurchaseReturnPage({ cancelled: false, userAgent });
      // Word-bounded: the inline CSS says "border-radius".
      expect(html).not.toMatch(/\border\b|\bsession\b|\bcs_[a-z]|\bUSD\b|\$\d/i);
    }
  });
});
