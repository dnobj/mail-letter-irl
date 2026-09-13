/**
 * The Stripe return page: where a customer lands after paying or cancelling
 * a Checkout Session that a ChatGPT card opened.
 *
 * It shows no order details on purpose; authenticated status is available
 * only through get_purchase_status, and the checkout card polls it.
 *
 * Until 2026-09-13 the page said "Return to ChatGPT" and linked nowhere. On
 * a phone the checkout opens in a browser tab over the ChatGPT app, so the
 * customer had to press Back through the whole checkout history. The link
 * below opens the app directly:
 *
 * - The ChatGPT Android app is the verified handler for every chatgpt.com
 *   URL (assetlinks.json grants handle_all_urls), so the plain origin opens
 *   the app, and the web app when it is not installed.
 * - The iOS app claims universal links only for listed paths. The root is
 *   not one of them; `/open-app` is, and chatgpt.com describes it as
 *   "redirects to the App Store as a fallback".
 * - Desktop browsers get the web app.
 *
 * Neither platform accepts a script-driven redirect for these links, and
 * ChatGPT gives the card no conversation id, so this is a button that
 * opens the app rather than a jump back into the exact conversation.
 */

export const CHATGPT_WEB_URL = 'https://chatgpt.com/';
export const CHATGPT_IOS_OPEN_APP_URL = 'https://chatgpt.com/open-app';

export function chatgptReturnLink(userAgent: string | undefined): string {
  return /\b(iPhone|iPad|iPod)\b/i.test(userAgent ?? '') ? CHATGPT_IOS_OPEN_APP_URL : CHATGPT_WEB_URL;
}

export function renderPurchaseReturnPage(params: {
  cancelled: boolean;
  userAgent: string | undefined;
}): string {
  const { cancelled } = params;
  const href = chatgptReturnLink(params.userAgent);
  const heading = cancelled ? 'Checkout cancelled' : 'Payment received';
  const body = cancelled
    ? 'Nothing was charged and your draft was not sent. Go back to ChatGPT to try again or choose a letter pack.'
    : 'Letter IRL updates the purchase status in ChatGPT as soon as Stripe confirms the payment.';
  return (
    '<!doctype html><html><head>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Letter IRL</title></head>' +
    '<body style="font-family:system-ui;max-width:36rem;margin:4rem auto;padding:1rem">' +
    `<h1>${heading}</h1>` +
    `<p>${body}</p>` +
    // Same tab, no target: on a phone this hands the tab to the app.
    `<a href="${href}" rel="noopener" style="display:inline-block;margin-top:1.5rem;padding:.75rem 1.25rem;border-radius:.75rem;background:#2563eb;color:#fff;text-decoration:none;font-weight:600">Back to ChatGPT</a>` +
    '</body></html>'
  );
}
