import { offUnlessExplicitlyEnabled } from '../utils/envSettings.js';

/**
 * The send rule (#470): a letter or postcard goes out only when the person
 * sends it themselves.
 *
 * There are two ways, and the model can complete neither on its own:
 *
 * - **The card's Send button.** In an app that keeps card-only tools away from
 *   the model (a client profile with `honorsCardOnlyTools`, see
 *   src/auth/clientProfiles.ts), send_letter and send_postcard are card-only,
 *   so a call to one comes from the person pressing Send on our card.
 * - **A confirmation link.** Everywhere else - a personal access token, an app
 *   with no card, an app we do not know - a send tool answers with a link to
 *   letterirl.com, where the person, signed in, sees the preview and presses
 *   Send. request_send gives the same link when the model is asked to send.
 *
 * Off unless explicitly enabled, so development can run either way.
 * Production refuses to start with it off (send_confirmation.required in
 * src/config/deploymentConfig.ts, #730).
 */
export function isSendConfirmationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return offUnlessExplicitlyEnabled('LETTER_IRL_SEND_CONFIRMATION_ENABLED', env);
}

/**
 * The website, where the person confirms a send. Not LETTER_IRL_PUBLIC_BASE_URL,
 * which is this API's own origin. Falls back to the gift landing address, which
 * is the same website and is already set in every environment.
 */
export function websiteBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value =
    (env.LETTER_IRL_WEBSITE_BASE_URL ?? '').trim() ||
    (env.LETTER_IRL_GIFT_LANDING_BASE_URL ?? '').trim() ||
    'https://letterirl.com';
  return value.replace(/\/+$/, '');
}

/** Where the person checks a draft and sends it themselves. */
export function sendConfirmationUrl(draftId: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${websiteBaseUrl(env)}/confirm/${encodeURIComponent(draftId)}`;
}

/**
 * Where Stripe returns a person who paid for a draft with Pay & Send on its
 * confirmation page (#579), or turned back: the same page, which then shows
 * the mail going out.
 */
export function confirmationCheckoutReturnUrls(
  draftId: string,
  env: NodeJS.ProcessEnv = process.env
): { successUrl: string; cancelUrl: string } {
  const page = sendConfirmationUrl(draftId, env);
  return { successUrl: `${page}?paid=1`, cancelUrl: `${page}?paid=0` };
}

/**
 * Where the person buys letter packs when the app they are in takes no
 * purchases (#484). The dashboard signs them in first and then opens this page.
 */
export function letterPacksPageUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${websiteBaseUrl(env)}/dashboard/letter-packs`;
}

/**
 * A pack checkout's return address, if it is the website's letter packs page
 * (#683), as the URL parser reads it; else null. Stripe sends the person there
 * after paying or turning back, so a request that starts a purchase cannot
 * send them anywhere else: the website's origin (or its www twin) and the
 * page's path (letterPacksPageUrl), with any query. The parsed form is what
 * goes to Stripe, so Stripe and the browser read one address.
 */
export function letterPacksReturnUrl(value: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url: URL;
  let page: URL;
  try {
    url = new URL(value);
    page = new URL(letterPacksPageUrl(env));
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const twin = page.hostname.startsWith('www.') ? page.hostname.slice(4) : `www.${page.hostname}`;
  const ours =
    url.protocol === page.protocol &&
    url.port === page.port &&
    (url.hostname === page.hostname || url.hostname === twin) &&
    url.pathname === page.pathname;
  return ours ? url.href : null;
}

/**
 * The website's own Auth0 application. Only a token issued to it may confirm a
 * send: the REST routes accept the MCP audience, so a token held by any MCP
 * client is valid there too, and a local agent with a shell can read its own
 * token and call the API directly. Unset means no token may confirm.
 */
export function websiteClientId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = (env.LETTER_IRL_WEBSITE_CLIENT_ID ?? '').trim();
  return value || undefined;
}
