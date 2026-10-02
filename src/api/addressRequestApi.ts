/**
 * The address request page's API (#604): public and signed out, for the
 * person a sender shared a link with. The website's page reads the token from
 * the link's fragment and posts it here in the body, never in the path or the
 * query, so it stays out of every access log.
 *
 *   POST /api/public/address-requests/page     { token }                    -> { state, senderFirstName, expiresAt }
 *   POST /api/public/address-requests/answer   { token, address: { name?, addressLine1, addressLine2?, city, state, postalCode } }
 *   POST /api/public/address-requests/decline  { token }
 *
 * Each route is rate-limited per IP and in all, answers only the sender's
 * first name and the request's state, and logs nothing of the token, the names
 * or the address: an outcome and an error class at most. While address
 * requests are off, or for a token it does not know, each answers 404 alike.
 *
 * The address is checked as a preview checks one: U.S. only, its fields
 * bounded and printable in the font PostGrid stamps them in, then PostGrid's
 * verification under the preview's policy (addressVerificationPolicy.ts). An
 * address the recipient gives reaches the sender's model context through
 * get_address_request, so nothing here stores more than the fields a preview
 * takes, each trimmed and bounded, and an absent line is left out, never null.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { isAddressRequestsEnabled } from '../config/addressRequests.js';
import {
  answerAddressRequest,
  declineAddressRequest,
  readAddressRequestPage,
  type GivenAddress
} from '../services/addressRequestService.js';
import { assessValidation } from '../services/addressVerificationPolicy.js';
import { getLetterProvider } from '../services/providers/index.js';
import { unprintableCharacters } from '../services/printableText.js';
import { rateLimitMiddlewareWithGlobal } from './middleware/rateLimit.js';
import { readRequestBody, RequestBodyTooLargeError } from '../utils/requestBody.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';

export const ADDRESS_REQUEST_API_PREFIX = '/api/public/address-requests/';

/** A page's whole body: a token and an address, so a few kilobytes at most. */
const BODY_LIMIT_BYTES = 4 * 1024;

/**
 * The state and territory codes USPS delivers to, with DC and the military
 * post offices: the page offers these and nothing else.
 */
export const US_STATE_CODES: readonly string[] = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'AS', 'GU', 'MP', 'PR', 'VI', 'AA', 'AE', 'AP'
];

/** The longest each field may be, in characters as a reader counts them. */
export const ADDRESS_FIELD_LIMITS = { name: 100, addressLine1: 100, addressLine2: 100, city: 60 } as const;

const ZIP_CODE = /^\d{5}(?:-\d{4})?$/;

/**
 * Characters no address field needs: controls, invisible format marks,
 * separators, private or unassigned code points (as the tools' names refuse).
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/u;

type Json = Record<string, unknown>;

function sendJson(res: ServerResponse, status: number, body: Json): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

const NOT_FOUND = { reason: 'not_found' } as const;

/**
 * Reads the body as JSON. Null once the request has been answered: a body too
 * large, not JSON, or not an object.
 */
async function readBody(req: IncomingMessage, res: ServerResponse): Promise<Json | null> {
  let raw: string;
  try {
    raw = await readRequestBody(req, { limitBytes: BODY_LIMIT_BYTES });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(res, 413, { reason: 'too_large' });
      return null;
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Json;
  } catch {
    // Answered below as invalid.
  }
  sendJson(res, 400, { reason: 'invalid' });
  return null;
}

function tidy(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : undefined;
}

function fits(value: string, limit: number): boolean {
  return [...value].length <= limit && !HIDDEN.test(value) && unprintableCharacters(value).length === 0;
}

export type AddressFieldProblem = 'name' | 'addressLine1' | 'addressLine2' | 'city' | 'state' | 'postalCode';

/**
 * The address a page sent, trimmed and bounded, or the fields it got wrong.
 * An absent or empty line 2 or name is left out.
 */
export function givenAddressOf(raw: unknown): { ok: true; address: GivenAddress } | { ok: false; fields: AddressFieldProblem[] } {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Json) : {};
  const name = tidy(body.name);
  const line1 = tidy(body.addressLine1);
  const line2 = tidy(body.addressLine2);
  const city = tidy(body.city);
  const state = tidy(body.state)?.toUpperCase();
  const postalCode = tidy(body.postalCode);
  const fields: AddressFieldProblem[] = [];
  if (body.name !== undefined && body.name !== null && (name === undefined || !fits(name, ADDRESS_FIELD_LIMITS.name))) fields.push('name');
  if (!line1 || !fits(line1, ADDRESS_FIELD_LIMITS.addressLine1)) fields.push('addressLine1');
  if (body.addressLine2 !== undefined && body.addressLine2 !== null && (line2 === undefined || !fits(line2, ADDRESS_FIELD_LIMITS.addressLine2))) {
    fields.push('addressLine2');
  }
  if (!city || !fits(city, ADDRESS_FIELD_LIMITS.city)) fields.push('city');
  if (!state || !US_STATE_CODES.includes(state)) fields.push('state');
  if (!postalCode || !ZIP_CODE.test(postalCode)) fields.push('postalCode');
  if (fields.length > 0) return { ok: false, fields };
  return {
    ok: true,
    address: {
      ...(name ? { name } : {}),
      addressLine1: line1!,
      ...(line2 ? { addressLine2: line2 } : {}),
      city: city!,
      state: state!,
      postalCode: postalCode!,
      country: 'US'
    }
  };
}

/**
 * PostGrid's verification under the preview's policy: an address it corrects
 * is kept corrected, one it cannot reach is refused with the reason, and one
 * it cannot check (the service down, a unit it cannot confirm) goes ahead as
 * given, as a preview's does.
 */
async function verified(address: GivenAddress): Promise<{ ok: true; address: GivenAddress } | { ok: false; message: string }> {
  const provider = getLetterProvider();
  if (!provider.validateAddress) return { ok: true, address };
  const validation = await provider.validateAddress({
    line1: address.addressLine1,
    line2: address.addressLine2,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: 'US'
  });
  const assessment = assessValidation('Your', validation);
  if (assessment.outcome === 'blocked') return { ok: false, message: assessment.blockText ?? 'This address could not be delivered to.' };
  if (validation.status === 'corrected' && validation.verifiedAddress) {
    const fixed = validation.verifiedAddress;
    return {
      ok: true,
      address: {
        ...(address.name ? { name: address.name } : {}),
        addressLine1: fixed.line1,
        ...(fixed.line2 ? { addressLine2: fixed.line2 } : {}),
        city: fixed.city,
        state: fixed.state,
        postalCode: fixed.postalCode,
        country: 'US'
      }
    };
  }
  return { ok: true, address };
}

/** A request the route did not change: gone or never known, or closed. */
function refused(res: ServerResponse, refusal: string): void {
  if (refusal === 'not_found') sendJson(res, 404, NOT_FOUND);
  else sendJson(res, 409, { reason: refusal });
}

/**
 * Answers a request under ADDRESS_REQUEST_API_PREFIX. False for any other
 * path, which the server then routes on. OPTIONS is the server's own
 * preflight; `corsOrigin` is the origin it allows for this request.
 */
export async function handleAddressRequestApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  corsOrigin: string
): Promise<boolean> {
  if (!pathname.startsWith(ADDRESS_REQUEST_API_PREFIX)) return false;
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Referrer-Policy', 'no-referrer');
  const route = pathname.slice(ADDRESS_REQUEST_API_PREFIX.length);
  if (req.method !== 'POST' || !['page', 'answer', 'decline'].includes(route)) {
    sendJson(res, 404, NOT_FOUND);
    return true;
  }
  if (rateLimitMiddlewareWithGlobal(req, res, 'address_public')) return true;
  if (!isAddressRequestsEnabled()) {
    sendJson(res, 404, NOT_FOUND);
    return true;
  }

  const body = await readBody(req, res);
  if (!body) return true;
  const token = body.token;

  try {
    if (route === 'page') {
      const page = await readAddressRequestPage(token);
      if (!page) sendJson(res, 404, NOT_FOUND);
      else sendJson(res, 200, { state: page.state, senderFirstName: page.senderFirstName, expiresAt: page.expiresAt });
      return true;
    }

    if (route === 'decline') {
      const result = await declineAddressRequest(token);
      if (result.ok) sendJson(res, 200, { ok: true });
      else refused(res, result.refusal);
      writeDiagnostic('info', 'address_request.decline', { outcome: result.ok ? 'declined' : result.refusal });
      return true;
    }

    // An answer: the link first, so a used or expired one costs no verification.
    const page = await readAddressRequestPage(token);
    if (!page) {
      sendJson(res, 404, NOT_FOUND);
      return true;
    }
    if (page.state !== 'waiting') {
      refused(res, page.state);
      return true;
    }
    const given = givenAddressOf(body.address);
    if (!given.ok) {
      sendJson(res, 400, { reason: 'invalid', fields: given.fields });
      return true;
    }
    const checked = await verified(given.address);
    if (!checked.ok) {
      sendJson(res, 422, { reason: 'undeliverable', message: checked.message });
      writeDiagnostic('info', 'address_request.answer', { outcome: 'undeliverable' });
      return true;
    }
    const result = await answerAddressRequest(token, checked.address);
    if (result.ok) sendJson(res, 200, { ok: true });
    else refused(res, result.refusal);
    writeDiagnostic('info', 'address_request.answer', { outcome: result.ok ? 'answered' : result.refusal });
    return true;
  } catch (error) {
    // The class only: never the token, a name or an address.
    writeDiagnostic('error', 'address_request.public_failed', {
      route,
      errorClass: classifyDiagnosticError(error, 'unknown_error')
    });
    if (!res.headersSent) sendJson(res, 500, { reason: 'unavailable' });
    return true;
  }
}
