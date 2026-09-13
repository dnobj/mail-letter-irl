/**
 * The Stripe return page: where a customer lands after paying or cancelling
 * a Checkout Session that a ChatGPT card opened.
 *
 * It shows no order details on purpose; authenticated status is available
 * only through get_purchase_status, and the checkout card polls it.
 *
 * Until 2026-09-13 the page said "Return to ChatGPT" and linked nowhere. On
 * a phone the checkout opens in a browser tab over the ChatGPT app, so the
 * customer had to press Back through the whole checkout history.
 *
 * What the button can honestly promise, per platform:
 *
 * - Android and desktop get a link to chatgpt.com. The ChatGPT Android app is
 *   the verified handler for chatgpt.com links, so on phones that keep that
 *   handling on it opens the app; where the owner has turned it off (as on
 *   the device used for the 2026-09-13 run) it opens the web app instead.
 *   The site root is not an in-app destination even when forced, so a jump
 *   into the exact conversation needs a conversation link, which is #372.
 * - iPhone and iPad get text only. The iOS app claims `/open-app` as a
 *   universal link, but that has not been verified on a device, and the
 *   owner's rule is that Apple devices get a proven link or none. The
 *   conversation link from #372 is the intended answer there too.
 *
 * Neither platform accepts a script-driven redirect for these links, so this
 * is a button, never an automatic return.
 */

export const CHATGPT_WEB_URL = 'https://chatgpt.com/';

export function isApplePhoneOrTablet(userAgent: string | undefined): boolean {
  return /\b(iPhone|iPad|iPod)\b/i.test(userAgent ?? '');
}

/** The link the page may offer, or null when the platform gets text only. */
export function chatgptReturnLink(userAgent: string | undefined): string | null {
  return isApplePhoneOrTablet(userAgent) ? null : CHATGPT_WEB_URL;
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
  const action = href
    ? // Same tab, no target: on a phone this hands the tab to the app.
      `<a href="${href}" rel="noopener" style="display:inline-block;margin-top:1.5rem;padding:.75rem 1.25rem;border-radius:.75rem;background:#2563eb;color:#fff;text-decoration:none;font-weight:600">Back to ChatGPT</a>`
    : '<p style="margin-top:1.5rem;font-weight:600">You can close this page and return to the ChatGPT app.</p>';
  return (
    '<!doctype html><html><head>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Letter IRL</title></head>' +
    '<body style="font-family:system-ui;max-width:36rem;margin:4rem auto;padding:1rem">' +
    `<h1>${heading}</h1>` +
    `<p>${body}</p>` +
    action +
    '</body></html>'
  );
}
