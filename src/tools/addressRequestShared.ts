import { isAddressRequestsEnabled } from '../config/addressRequests.js';
import { websiteBaseUrl } from '../config/sendConfirmation.js';
import type { AddressRequest } from '../services/addressRequestService.js';

/**
 * What the three address request tools share (#604): their refusals, the
 * link, the names they take, and the sentence each state says.
 */

export type AddressRequestRefusalCode =
  | 'ADDRESS_REQUESTS_OFF'
  | 'RECIPIENT_NAME_INVALID'
  | 'SENDER_NAME_REQUIRED'
  | 'SENDER_NAME_INVALID'
  | 'TOO_MANY_WAITING'
  | 'TOO_MANY_TODAY'
  | 'REQUEST_NOT_FOUND';

/**
 * Refusals the model can act on. As request_send's, none repeats what was
 * asked, and the code doubles as the log's class.
 */
export class AddressRequestRefusedError extends Error {
  readonly diagnosticClass: string;

  constructor(readonly code: AddressRequestRefusalCode, message: string) {
    super(message);
    this.name = 'AddressRequestRefusedError';
    this.diagnosticClass = code;
  }
}

/**
 * The tools are listed only while address requests are on (src/server.ts),
 * and refuse while they are off: a tool list cached while they were on still
 * reaches them.
 */
export function requireAddressRequests(): void {
  if (!isAddressRequestsEnabled()) {
    throw new AddressRequestRefusedError(
      'ADDRESS_REQUESTS_OFF',
      "Address requests aren't available here. Ask the person for the recipient's mailing address instead."
    );
  }
}

/**
 * The page the person shares: the website's, with the link's token in the
 * fragment. A browser never sends a fragment, so the token stays out of every
 * HTTP access log; the page posts it to the API itself (#605 review round 1).
 */
export function addressRequestUrl(token: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${websiteBaseUrl(env)}/address#${token}`;
}

/**
 * Characters no name needs: controls, the invisible format marks and
 * direction overrides that can disguise what a name reads as, line and
 * paragraph separators, and private or unassigned code points (the classes
 * the renderer never draws, src/render/layout.ts).
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/u;

/**
 * A first name the page may show: one or two words joined by a space or a
 * hyphen ("Mary Ann", "Anne-Marie"). A word is letters and marks with
 * apostrophes inside and a full stop only at its end ("J."), or initials
 * ("J.R."). So nothing reads as a link, and little as a message, since the
 * page shows it to someone the sender chose: "evil.example" has a full stop
 * inside a word, and three words are refused (#605 review round 1).
 */
const FIRST_NAME = /^(?:(?:\p{L}\.){2,4}|\p{L}[\p{L}\p{M}'\u2019]*\.?)(?:[ -](?:(?:\p{L}\.){2,4}|\p{L}[\p{L}\p{M}'\u2019]*\.?))?$/u;

const RECIPIENT_NAME_MAX = 100;
const SENDER_FIRST_NAME_MAX = 40;

function tidy(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

/** What the person calls the recipient, as the request keeps it. */
export function recipientNameOf(raw: unknown): string {
  const name = typeof raw === 'string' ? tidy(raw) : '';
  if (!name || [...name].length > RECIPIENT_NAME_MAX || HIDDEN.test(name)) {
    throw new AddressRequestRefusedError(
      'RECIPIENT_NAME_INVALID',
      `Give the recipient's name as the person calls them, up to ${RECIPIENT_NAME_MAX} characters.`
    );
  }
  return name;
}

function isFirstName(name: string): boolean {
  return [...name].length <= SENDER_FIRST_NAME_MAX && FIRST_NAME.test(name) && !HIDDEN.test(name);
}

/**
 * The first name the model passed, or null when it passed none. One that the
 * page could not show as a name is refused.
 */
export function senderFirstNameOf(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const name = typeof raw === 'string' ? tidy(raw) : null;
  if (name === '') return null;
  if (name === null || !isFirstName(name)) {
    throw new AddressRequestRefusedError(
      'SENDER_NAME_INVALID',
      `Give the sender's first name alone, in one or two words of letters, up to ${SENDER_FIRST_NAME_MAX} characters: the page shows it as who is asking.`
    );
  }
  return name;
}

/**
 * Words a saved name can start with that are not a first name: a title or
 * "The" ("Dr. Pat Sender", "The Smiths"). With one, the tool asks for the
 * first name instead (#605 review round 1).
 */
const NOT_FIRST_NAMES = new Set(['mr', 'mrs', 'ms', 'mx', 'miss', 'dr', 'prof', 'rev', 'fr', 'sir', 'dame', 'lord', 'lady', 'the']);

/** The first word of the saved return address's name, when it reads as a first name. */
export function firstNameFromSaved(name: string | undefined | null): string | null {
  const first = typeof name === 'string' ? tidy(name).split(' ')[0] : '';
  if (!first || NOT_FIRST_NAMES.has(first.replace(/\.$/, '').toLowerCase())) return null;
  return isFirstName(first) ? first : null;
}

const LINK_EXPIRY = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/New_York',
  timeZoneName: 'short'
});

/**
 * When a link stops working, as a person says it: "October 9 at 10:00 AM
 * EDT". Built from its parts, so no narrow space ICU puts before AM reaches
 * the text.
 */
export function linkExpiry(iso: string): string {
  const part = Object.fromEntries(LINK_EXPIRY.formatToParts(new Date(iso)).map(({ type, value }) => [type, value]));
  return `${part.month} ${part.day} at ${part.hour}:${part.minute} ${part.dayPeriod} ${part.timeZoneName}`;
}

/** What a request's state means, in a sentence for the person. */
export function addressRequestMessage(request: AddressRequest): string {
  const who = request.recipientName;
  switch (request.state) {
    case 'waiting':
      return `${who} hasn't answered yet. The link works until ${linkExpiry(request.expiresAt)}.`;
    case 'answered':
      return `${who} gave their address, so the mail can be previewed with it now.`;
    case 'declined':
      return `${who} chose not to share an address.`;
    case 'cancelled':
      return 'This request was cancelled, so its link no longer works.';
    case 'expired':
      return `The link expired before ${who} answered. A new request makes a new link.`;
  }
}
