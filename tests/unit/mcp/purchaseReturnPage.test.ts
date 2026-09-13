/**
 * The Stripe return page must give the customer a way back into ChatGPT.
 *
 * Until 2026-09-13 it said "Return to ChatGPT" with no link, and on a phone
 * the only way back was the browser's Back button through the checkout
 * history. The link target depends on the platform: the ChatGPT Android app
 * handles every chatgpt.com URL, the iOS app only claims listed paths (the
 * root is not one, /open-app is), and desktop browsers get the web app.
 */

import { describe, expect, it } from 'vitest';
import {
  CHATGPT_IOS_OPEN_APP_URL,
  CHATGPT_WEB_URL,
  chatgptReturnLink,
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

describe('chatgptReturnLink', () => {
  it('sends iPhone and iPad to the universal-link path the iOS app claims', () => {
    // The root of chatgpt.com is not in the app's universal-link list, so a
    // plain origin would open Safari, not the app.
    expect(chatgptReturnLink(IPHONE_UA)).toBe(CHATGPT_IOS_OPEN_APP_URL);
    expect(chatgptReturnLink(IPAD_UA)).toBe(CHATGPT_IOS_OPEN_APP_URL);
  });

  it('sends Android to the plain origin, which the app handles as a verified app link', () => {
    // Not /open-app: without the app installed that path falls back to
    // Apple's store, and the plain origin degrades to the web app instead.
    expect(chatgptReturnLink(ANDROID_UA)).toBe(CHATGPT_WEB_URL);
  });

  it('sends desktop and unknown agents to the web app', () => {
    expect(chatgptReturnLink(DESKTOP_UA)).toBe(CHATGPT_WEB_URL);
    expect(chatgptReturnLink(undefined)).toBe(CHATGPT_WEB_URL);
    expect(chatgptReturnLink('')).toBe(CHATGPT_WEB_URL);
  });
});

describe('renderPurchaseReturnPage', () => {
  it('offers a Back to ChatGPT link in the same tab, with the platform target', () => {
    const html = renderPurchaseReturnPage({ cancelled: false, userAgent: IPHONE_UA });

    expect(html).toContain('<h1>Payment received</h1>');
    expect(html).toContain('>Back to ChatGPT</a>');
    expect(html).toContain(`href="${CHATGPT_IOS_OPEN_APP_URL}"`);
    // A new tab would leave the checkout tab behind; the app takes this one.
    expect(html).not.toContain('target=');
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
    const html = renderPurchaseReturnPage({ cancelled: false, userAgent: ANDROID_UA });
    // Word-bounded: the inline CSS says "border-radius".
    expect(html).not.toMatch(/\border\b|\bsession\b|\bcs_[a-z]|\bUSD\b|\$\d/i);
  });
});
