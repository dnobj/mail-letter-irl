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
 * Off unless explicitly enabled, so a deploy changes nothing until the
 * confirmation page is live and the ChatGPT regression pass has run with the
 * rule on. It is meant to be on in production before launch.
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
 * Where the person buys letter packs when the app they are in takes no
 * purchases (#484). The dashboard signs them in first and then opens this page.
 */
export function letterPacksPageUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${websiteBaseUrl(env)}/dashboard/letter-packs`;
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
