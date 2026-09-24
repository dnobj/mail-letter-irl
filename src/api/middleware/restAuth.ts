/**
 * Bearer authentication for the REST API (letters, credits, return address).
 *
 * One implementation, delegating to the same validator the MCP layer trusts.
 * Issue #209: three copies of this check lived in three handlers, each reading
 * LETTER_IRL_OAUTH_AUDIENCE straight from the environment as a single value.
 * The MCP layer read the audience through getOAuthConfig(), which then merged
 * LETTER_IRL_OAUTH_LEGACY_AUDIENCES under the static-DCR compatibility flag
 * (since removed). The two layers therefore disagreed about which audiences
 * were valid, and only the MCP one won: the website's token, minted for the
 * legacy audience, was rejected by every dashboard call.
 *
 * Going through validateJWTToken closes that permanently. Whatever the config
 * layer accepts, REST accepts; there is no second source of truth to drift.
 *
 * It also fixes the message. The old check answered "Missing or invalid
 * Authorization header" for a header that was present and well-formed but
 * carried a token failing issuer or audience validation. That sent the #209
 * investigation to the website's proxy first. The outcomes are now distinct.
 *
 * Issue #179 added `status`, and made it REQUIRED. All three handlers used to
 * answer 401 for every failure, including "the server cannot validate
 * anything" - which this file's own docblock says it exists to distinguish,
 * and which the sibling middleware already answered 503. A beta refusal must
 * be 403, because 401 tells a client to authenticate again and it would
 * succeed and be refused again. Making the field required means the compiler
 * finds every caller rather than trusting three handlers to be updated
 * together.
 *
 * Scopes (audit A-03). The REST routes used to check only that a token was
 * valid. Once the website moved onto the MCP audience, every token issued to
 * an MCP client became valid here too, so each route now also requires the
 * scope its MCP twin requires (src/auth/restScopes.ts). `requiredScopes` is a
 * required parameter for the same reason `status` is a required field. A valid
 * token without the scope gets 403 with a WWW-Authenticate challenge naming
 * what is missing: at 401 the client would authenticate again, receive the
 * same token, and be refused again.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import {
  requireScopes,
  validateJWTToken,
  type AuthenticatedUser
} from '../../auth/tokenValidator.js';
import { buildWwwAuthenticateChallenge, InsufficientScopeError } from '../../auth/oauthChallenge.js';
import { OAUTH_NOT_CONFIGURED } from '../../auth/oauthErrors.js';
import { BetaAccessDeniedError, BETA_ACCESS_MESSAGE } from '../../auth/betaAccess.js';
import {
  VerifiedEmailRequiredError,
  VERIFIED_EMAIL_MESSAGE
} from '../../auth/verifiedEmail.js';
import { prepareAuthenticatedUser } from '../../auth/identity.js';
import {
  EmailAlreadyLinkedError,
  EMAIL_ALREADY_LINKED_MESSAGE
} from '../../services/userService.js';
import { AccountErasedError, ACCOUNT_ERASED_MESSAGE } from '../../auth/accountErased.js';
import type { ProductScope } from '../../auth/toolScopes.js';
import { classifyDiagnosticError, writeDiagnostic } from '../../utils/diagnosticLog.js';

export interface RestAuthInfo {
  userId: string;
  email?: string;
  /** Every scope the token carries. Empty when it carries none. */
  scopes: string[];
}

export type RestAuthFailureReason =
  | 'no_credentials'
  | 'not_configured'
  | 'rejected'
  | 'forbidden'
  | 'no_account'
  | 'account_conflict'
  | 'account_erased'
  | 'unavailable'
  | 'insufficient_scope';

export interface RestAuthFailure {
  ok: false;
  reason: RestAuthFailureReason;
  status: number;
  message: string;
  /**
   * The WWW-Authenticate value naming the missing scopes. Present only for
   * insufficient_scope, where it tells an OAuth client what to ask for.
   */
  challenge?: string;
}

export type RestAuthOutcome = { ok: true; user: RestAuthInfo } | RestAuthFailure;

const MESSAGES: Record<RestAuthFailureReason, string> = {
  no_credentials: 'Missing or invalid Authorization header',
  not_configured: 'Authentication is not configured on this server',
  rejected: 'The bearer token was rejected',
  forbidden: BETA_ACCESS_MESSAGE,
  no_account: VERIFIED_EMAIL_MESSAGE,
  account_conflict: EMAIL_ALREADY_LINKED_MESSAGE,
  account_erased: ACCOUNT_ERASED_MESSAGE,
  unavailable: 'The account could not be read. Please try again.',
  insufficient_scope: 'The bearer token does not grant this action'
};

/**
 * The status each outcome deserves, in one table rather than at three call
 * sites. 403 for `forbidden` is the load-bearing one: the caller authenticated
 * correctly and is simply not admitted, so telling them to authenticate again
 * would send them round a loop that cannot terminate. `insufficient_scope` is
 * 403 for the same reason.
 */
const STATUS: Record<RestAuthFailureReason, number> = {
  no_credentials: 401,
  not_configured: 503,
  rejected: 401,
  forbidden: 403,
  // Authenticated, admitted, and still has no account: 403 for the same reason
  // `forbidden` is. Authorizing again would produce the same token and the
  // same answer; what has to change is the address, at the provider.
  no_account: 403,
  // A database that will not answer. 503 rather than letting the error escape
  // this function: every REST handler calls it OUTSIDE its own try, so a throw
  // here leaves the request boundary to answer text/plain where the dashboard
  // has always been given JSON.
  unavailable: 503,
  // 409, because two accounts want one address and only the customer can say
  // which sign-in method is theirs.
  account_conflict: 409,
  // The account was erased at the customer's request (#289). Nothing a new
  // token could change.
  account_erased: 403,
  insufficient_scope: 403
};

/**
 * The JSON `error` label for a status. Exported so the handlers do not each
 * carry their own mapping - three copies of a small thing is exactly how the
 * audience check drifted in #209.
 */
export function restAuthErrorLabel(status: number): string {
  if (status === 403) return 'Forbidden';
  if (status === 409) return 'Conflict';
  if (status === 503) return 'Service Unavailable';
  return 'Unauthorized';
}

function fail(reason: RestAuthFailureReason): RestAuthFailure {
  return { ok: false, reason, status: STATUS[reason], message: MESSAGES[reason] };
}

/**
 * The failure for a token that authenticated but lacks a scope. Exported for
 * the routes that authenticate without authenticateRestRequest (token
 * management and checkout), so every REST scope refusal has one shape.
 */
export function insufficientScope(error: InsufficientScopeError): RestAuthFailure {
  // Scope names are fixed public values, never user data.
  writeDiagnostic('warn', 'auth.rest_insufficient_scope', {
    missing: error.missingScopes.join(' ')
  });
  return {
    ...fail('insufficient_scope'),
    challenge: buildWwwAuthenticateChallenge(error.message, undefined, error.missingScopes)
  };
}

/**
 * Writes a failure as the response. The one writer for the REST handlers, so
 * none of them can hardcode a status again (#179) or drop the challenge.
 */
export function sendRestAuthFailure(res: ServerResponse, failure: RestAuthFailure): void {
  res.statusCode = failure.status;
  res.setHeader('Content-Type', 'application/json');
  if (failure.challenge) {
    res.setHeader('WWW-Authenticate', failure.challenge);
  }
  res.end(JSON.stringify({ error: restAuthErrorLabel(failure.status), message: failure.message }));
}

function extractToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.substring(7).trim();
    if (token) return token;
  }
  // Bearer only. An access_token cookie used to be accepted here as a fallback
  // (audit A-11). Nothing sets that cookie, and reading it would have made
  // every cross-site form post to these routes carry credentials with no
  // CSRF check the day something did. A cookie is not a credential here.
  return null;
}

/**
 * @param requiredScopes - What the route requires, from requiredRestScopes.
 */
export async function authenticateRestRequest(
  req: IncomingMessage,
  requiredScopes: readonly ProductScope[]
): Promise<RestAuthOutcome> {
  const token = extractToken(req);
  if (!token) {
    return fail('no_credentials');
  }
  let user: AuthenticatedUser;
  try {
    user = await validateJWTToken(token);
  } catch (error) {
    // Checked before the message comparisons below: a beta refusal is not an
    // authentication failure, and must not be reported as one.
    if (error instanceof BetaAccessDeniedError) {
      return fail('forbidden');
    }
    // validateJWTToken logs a token it rejects. A server that cannot validate
    // anything throws before that log, so it is logged here. The two outcomes
    // stay distinct so an operator reading the response knows which side to
    // look at.
    const message = error instanceof Error ? error.message : '';
    if (message === OAUTH_NOT_CONFIGURED) {
      writeDiagnostic('error', 'auth.validation_not_configured');
      return fail('not_configured');
    }
    return fail('rejected');
  }
  // Checked here rather than passed to validateJWTToken, which would log a
  // valid token as rejected and leave this function answering 401.
  try {
    requireScopes(user, requiredScopes);
  } catch (error) {
    if (error instanceof InsufficientScopeError) {
      return insufficientScope(error);
    }
    throw error;
  }
  // The account row, opened here if this is the caller's first arrival.
  //
  // Until now only the MCP layer did this (registerTools), so a person whose
  // first visit was the dashboard or a gift claim reached routes that all
  // assume a users row and got three different failures instead of one
  // answer. It also settles `email`, which this function used to read from the
  // standard `email` claim alone - a claim Auth0 does not put on an access
  // token minted for a custom API, so it was undefined on every request.
  let email: string | undefined;
  try {
    email = (await prepareAuthenticatedUser(user)) ?? undefined;
  } catch (error) {
    if (error instanceof VerifiedEmailRequiredError) return fail('no_account');
    if (error instanceof EmailAlreadyLinkedError) return fail('account_conflict');
    if (error instanceof AccountErasedError) return fail('account_erased');
    writeDiagnostic('error', 'auth.account_preparation_failed', {
      errorClass: classifyDiagnosticError(error, 'database_error')
    });
    return fail('unavailable');
  }
  return { ok: true, user: { userId: user.userId, email, scopes: user.scopes } };
}
