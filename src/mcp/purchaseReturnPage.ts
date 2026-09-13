/**
 * The Stripe return trip: the start page a ChatGPT card opens, and the page
 * a customer lands on after paying or cancelling a Checkout Session.
 *
 * Neither page shows order details; authenticated status is available only
 * through get_purchase_status, and the checkout card polls it.
 *
 * Until 2026-09-13 the return page said "Return to ChatGPT" and linked
 * nowhere. On a phone the checkout opens in a browser tab over the ChatGPT
 * app, so the customer had to press Back through the whole checkout history.
 *
 * What a link can honestly promise, per platform (Android run, 2026-09-13):
 *
 * - A link to the site root is not an in-app destination for the ChatGPT
 *   Android app: with the app's link handling switched off on the owner's
 *   phone the root opened the web app in Chrome, and an explicit intent to
 *   the app with the root URL was handed back to the browser. A conversation
 *   link (/c/<id>) sent as an explicit intent opened the app on that
 *   conversation. So Android gets a conversation link in intent form when
 *   one is known, and the plain root otherwise.
 * - iPhone and iPad get text only. chatgpt.com's site association file
 *   claims /c/* and /open-app as universal links, but neither has been
 *   verified on a device, and the rule is that Apple devices get a proven
 *   link or none. Flip IOS_RETURN_LINK_VERIFIED after a device check.
 * - Desktop browsers get the conversation link, or the web app.
 *
 * Where the conversation link comes from (#372): the card opens the START
 * page through window.openai.openExternal. For an allowlisted redirect
 * domain, ChatGPT appends a `redirectUrl` query parameter to that link. The
 * start page keeps it in a same-site cookie on this origin and forwards to
 * Stripe; the return page reads the cookie back. Stateless, and nothing is
 * stored against the order.
 */

export const CHATGPT_WEB_URL = 'https://chatgpt.com/';
export const CHATGPT_ANDROID_PACKAGE = 'com.openai.chatgpt';
export const RETURN_COOKIE_NAME = 'lirl_return';
export const RETURN_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;

/** Set to true only after a tap on a real iPhone has opened the app. */
export const IOS_RETURN_LINK_VERIFIED = false;

const CHATGPT_HOSTS = new Set(['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com']);
const CHECKOUT_HOSTS = new Set(['checkout.stripe.com']);

export function isApplePhoneOrTablet(userAgent: string | undefined): boolean {
  return /\b(iPhone|iPad|iPod)\b/i.test(userAgent ?? '');
}

export function isAndroid(userAgent: string | undefined): boolean {
  return /\bAndroid\b/i.test(userAgent ?? '');
}

function httpsUrlOnHosts(value: string | null | undefined, hosts: Set<string>): string | null {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !hosts.has(parsed.hostname)) return null;
  if (parsed.username || parsed.password) return null;
  return parsed.toString();
}

/**
 * The link ChatGPT appended, kept only when it is an https link back into
 * ChatGPT itself. Anything else is dropped: this value is later rendered as
 * the destination of a button, so it must never be an open redirect.
 */
export function parseChatgptReturnUrl(value: string | null | undefined): string | null {
  return httpsUrlOnHosts(value, CHATGPT_HOSTS);
}

/** The checkout the start page may forward to: Stripe's hosted page only. */
export function parseCheckoutTarget(value: string | null | undefined): string | null {
  return httpsUrlOnHosts(value, CHECKOUT_HOSTS);
}

export function returnCookieHeader(chatgptUrl: string): string {
  // Lax, not Strict: the customer comes back from checkout.stripe.com by a
  // top-level navigation, and Strict cookies are withheld on exactly that.
  return `${RETURN_COOKIE_NAME}=${encodeURIComponent(chatgptUrl)}; Max-Age=${RETURN_COOKIE_MAX_AGE_SECONDS}; Path=/purchase; Secure; HttpOnly; SameSite=Lax`;
}

export function readReturnCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== RETURN_COOKIE_NAME) continue;
    try {
      return parseChatgptReturnUrl(decodeURIComponent(rest.join('=')));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The start page's decision for one request. A pure function so the route
 * can be tested without booting the server.
 */
export function decidePurchaseStart(params: {
  to: string | null;
  redirectUrl: string | null;
}): { status: 302; location: string; cookie: string | null } | { status: 400; body: string } {
  const target = parseCheckoutTarget(params.to);
  if (!target) {
    return { status: 400, body: 'This checkout link is not valid. Ask for a new checkout in ChatGPT.' };
  }
  const back = parseChatgptReturnUrl(params.redirectUrl);
  return { status: 302, location: target, cookie: back ? returnCookieHeader(back) : null };
}

/**
 * Chrome resolves an intent: link by package, which ignores the phone's
 * per-app "open supported links" setting; the fallback URL keeps the plain
 * web link for phones without the app.
 */
export function androidIntentLink(httpsUrl: string): string {
  const parsed = new URL(httpsUrl);
  return (
    `intent://${parsed.host}${parsed.pathname}${parsed.search}` +
    `#Intent;scheme=https;package=${CHATGPT_ANDROID_PACKAGE};` +
    `S.browser_fallback_url=${encodeURIComponent(httpsUrl)};end`
  );
}

export interface ReturnAction {
  href: string;
  label: string;
}

/** The link the page may offer, or null when the platform gets text only. */
export function chatgptReturnAction(
  userAgent: string | undefined,
  conversationUrl: string | null
): ReturnAction | null {
  if (isApplePhoneOrTablet(userAgent)) {
    return conversationUrl && IOS_RETURN_LINK_VERIFIED
      ? { href: conversationUrl, label: 'Back to your conversation' }
      : null;
  }
  if (conversationUrl) {
    return {
      href: isAndroid(userAgent) ? androidIntentLink(conversationUrl) : conversationUrl,
      label: 'Back to your conversation'
    };
  }
  return { href: CHATGPT_WEB_URL, label: 'Back to ChatGPT' };
}

/** Kept for callers that only need the plain target. */
export function chatgptReturnLink(userAgent: string | undefined): string | null {
  return chatgptReturnAction(userAgent, null)?.href ?? null;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function renderPurchaseReturnPage(params: {
  cancelled: boolean;
  userAgent: string | undefined;
  conversationUrl?: string | null;
}): string {
  const { cancelled } = params;
  const action = chatgptReturnAction(params.userAgent, params.conversationUrl ?? null);
  const heading = cancelled ? 'Checkout cancelled' : 'Payment received';
  const body = cancelled
    ? 'Nothing was charged and your draft was not sent. Go back to ChatGPT to try again or choose a letter pack.'
    : 'Letter IRL updates the purchase status in ChatGPT as soon as Stripe confirms the payment.';
  const control = action
    ? // Same tab, no target: on a phone this hands the tab to the app.
      `<a href="${escapeAttribute(action.href)}" rel="noopener" style="display:inline-block;margin-top:1.5rem;padding:.75rem 1.25rem;border-radius:.75rem;background:#2563eb;color:#fff;text-decoration:none;font-weight:600">${action.label}</a>`
    : '<p style="margin-top:1.5rem;font-weight:600">You can close this page and return to the ChatGPT app.</p>';
  return (
    '<!doctype html><html><head>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Letter IRL</title></head>' +
    '<body style="font-family:system-ui;max-width:36rem;margin:4rem auto;padding:1rem">' +
    `<h1>${heading}</h1>` +
    `<p>${body}</p>` +
    control +
    '</body></html>'
  );
}

export type PurchaseStartDecision = ReturnType<typeof decidePurchaseStart>;

/** The broad client class a request came from; nothing that identifies a person. */
export function clientClass(userAgent: string | undefined): 'android' | 'apple' | 'other' {
  if (isAndroid(userAgent)) return 'android';
  if (isApplePhoneOrTablet(userAgent)) return 'apple';
  return 'other';
}

/** The hostname of a URL and nothing else, or a fixed word when there is none. */
export function hostOnly(value: string | null | undefined): string {
  if (!value) return 'none';
  try {
    const host = new URL(value).hostname;
    return host ? host.slice(0, 80) : 'empty';
  } catch {
    return 'unparseable';
  }
}

const UNSAFE_TOKEN_CHARS = /[^A-Za-z0-9_.-]/g;

/**
 * What the start page writes to the log (#372): whether ChatGPT appended a
 * return link, which host it named, and whether the cookie was set. Names
 * and hosts only. The return link carries a conversation id and the target
 * is a live checkout session, so no query value and no cookie value is
 * logged.
 */
export function purchaseStartDiagnostics(params: {
  query: URLSearchParams;
  referer: string | undefined;
  userAgent: string | undefined;
  decision: PurchaseStartDecision;
}): Record<string, string | boolean> {
  const keys = [...new Set(params.query.keys())].sort();
  return {
    queryKeys: keys.map(key => key.replace(UNSAFE_TOKEN_CHARS, '?')).join(',').slice(0, 200),
    hasRedirectUrl: params.query.has('redirectUrl'),
    redirectHost: hostOnly(params.query.get('redirectUrl')),
    targetOk: params.decision.status === 302,
    returnKept: params.decision.status === 302 && params.decision.cookie !== null,
    refererHost: hostOnly(params.referer),
    client: clientClass(params.userAgent)
  };
}

/**
 * What the return page writes to the log: whether the cookie came back and
 * which kind of link the page offered. Never the link itself.
 */
export function purchaseReturnDiagnostics(params: {
  cookieHeader: string | undefined;
  cancelled: boolean;
  userAgent: string | undefined;
  conversationUrl: string | null;
}): Record<string, string | boolean> {
  const action = chatgptReturnAction(params.userAgent, params.conversationUrl);
  return {
    outcome: params.cancelled ? 'cancelled' : 'success',
    cookiePresent: new RegExp(`(^|;\\s*)${RETURN_COOKIE_NAME}=`).test(params.cookieHeader ?? ''),
    conversationKept: params.conversationUrl !== null,
    linkOffered: action === null ? 'none' : action.href === CHATGPT_WEB_URL ? 'chatgpt' : 'conversation',
    client: clientClass(params.userAgent)
  };
}
