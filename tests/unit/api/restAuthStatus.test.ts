import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'http';
import { BetaAccessDeniedError, BETA_ACCESS_MESSAGE } from '../../../src/auth/betaAccess.js';
import { InsufficientScopeError } from '../../../src/auth/oauthChallenge.js';
import {
  VerifiedEmailRequiredError,
  VERIFIED_EMAIL_MESSAGE
} from '../../../src/auth/verifiedEmail.js';
import {
  EmailAlreadyLinkedError,
  EMAIL_ALREADY_LINKED_MESSAGE
} from '../../../src/services/userService.js';
import { AccountErasedError, ACCOUNT_ERASED_MESSAGE } from '../../../src/auth/accountErased.js';

/**
 * Where the HTTP status comes from (#179).
 *
 * All three REST handlers answered a hardcoded 401 for every authentication
 * outcome. Two problems:
 *
 *   - `not_configured` means the SERVER cannot validate anything. restAuth's
 *     own docblock says distinguishing that from a rejected token is why it
 *     exists, and the sibling middleware already answered 503 - but the REST
 *     handlers flattened it back to 401, telling the caller their credentials
 *     were bad when the server was misconfigured.
 *   - A beta refusal must be 403. At 401 the client re-authenticates, succeeds,
 *     and is refused again.
 *
 * A missing scope (audit A-03) is 403 for the same reason as a beta refusal.
 *
 * The failure variant now carries a required `status`, so the compiler finds
 * every caller. It cannot force a caller to USE it - that is pinned separately,
 * in restHandlerStatus.test.ts.
 */

vi.mock('../../../src/auth/tokenValidator.js', () => ({
  validateJWTToken: vi.fn(),
  validateAuthorizationHeader: vi.fn(),
  parseTokenScopes: vi.fn(() => []),
  requireScopes: vi.fn()
}));

// Opening the account row is the one step here that would reach PostgreSQL.
// This file is about which status each outcome gets, so it is a seam.
vi.mock('../../../src/auth/identity.js', () => ({
  prepareAuthenticatedUser: vi.fn(async () => 'user@example.invalid')
}));

import { prepareAuthenticatedUser } from '../../../src/auth/identity.js';
import { requireScopes, validateJWTToken } from '../../../src/auth/tokenValidator.js';
import {
  authenticateRestRequest,
  restAuthErrorLabel
} from '../../../src/api/middleware/restAuth.js';

const READ = ['mail:read'] as const;

const request = (headers: Record<string, string> = {}) =>
  ({ headers }) as unknown as IncomingMessage;

const validUser = {
  userId: 'auth0|user-1',
  claims: {},
  token: 't',
  authType: 'jwt' as const,
  scopes: ['mail:read']
};

describe('restAuth failure statuses', () => {
  beforeEach(() => {
    vi.mocked(validateJWTToken).mockReset();
    vi.mocked(requireScopes).mockReset();
    vi.mocked(prepareAuthenticatedUser).mockReset();
    vi.mocked(prepareAuthenticatedUser).mockResolvedValue('user@example.invalid');
  });

  it('maps a beta refusal to 403, not 401', async () => {
    vi.mocked(validateJWTToken).mockRejectedValue(new BetaAccessDeniedError());

    const outcome = await authenticateRestRequest(request({ authorization: 'Bearer t' }), READ);

    expect(outcome).toMatchObject({ ok: false, reason: 'forbidden', status: 403 });
    expect(outcome.ok ? '' : outcome.message).toBe(BETA_ACCESS_MESSAGE);
  });

  it('maps an unconfigured server to 503, which used to be flattened to 401', async () => {
    vi.mocked(validateJWTToken).mockRejectedValue(new Error('OAuth validation not configured'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await authenticateRestRequest(request({ authorization: 'Bearer t' }), READ)).toMatchObject({
      ok: false,
      reason: 'not_configured',
      status: 503
    });
    // Logged here: the validator throws before its own log in this case.
    // Exactly one line, with no fields, so a dropped call or an added
    // request-derived value fails this.
    expect(
      error.mock.calls
        .map(([line]) => String(line))
        .filter(line => line.includes('"event":"auth.validation_not_configured"'))
        .map(line => JSON.parse(line))
    ).toEqual([{ event: 'auth.validation_not_configured', msg: 'auth.validation_not_configured' }]);
    error.mockRestore();
  });

  it('keeps a rejected token and a missing header at 401', async () => {
    vi.mocked(validateJWTToken).mockRejectedValue(new Error('signature verification failed'));

    expect(await authenticateRestRequest(request({ authorization: 'Bearer t' }), READ)).toMatchObject({
      ok: false,
      reason: 'rejected',
      status: 401
    });
    expect(await authenticateRestRequest(request(), READ)).toMatchObject({
      ok: false,
      reason: 'no_credentials',
      status: 401
    });
  });

  it('checks the refusal BEFORE the message comparison', async () => {
    // A BetaAccessDeniedError whose message happened to match the
    // not-configured string would otherwise be reported as a server fault.
    const error = new BetaAccessDeniedError();
    Object.defineProperty(error, 'message', { value: 'OAuth validation not configured' });
    vi.mocked(validateJWTToken).mockRejectedValue(error);

    expect(await authenticateRestRequest(request({ authorization: 'Bearer t' }), READ)).toMatchObject({
      reason: 'forbidden',
      status: 403
    });
  });

  it('maps a valid token without the scope to 403 with a challenge, not 401', async () => {
    vi.mocked(validateJWTToken).mockResolvedValue(validUser);
    vi.mocked(requireScopes).mockImplementation(() => {
      throw new InsufficientScopeError(['mail:send']);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const outcome = await authenticateRestRequest(request({ authorization: 'Bearer t' }), ['mail:send']);

    expect(outcome).toMatchObject({ ok: false, reason: 'insufficient_scope', status: 403 });
    expect(outcome.ok ? '' : outcome.challenge).toContain('error="insufficient_scope"');
    // Logged with the missing scope names and nothing else: no subject, no
    // token. Exact equality, so an added field fails this too.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({
      missing: 'mail:send',
      event: 'auth.rest_insufficient_scope',
      msg: 'auth.rest_insufficient_scope'
    });
    warn.mockRestore();
  });

  it('checks the scopes the caller passed', async () => {
    vi.mocked(validateJWTToken).mockResolvedValue(validUser);

    await authenticateRestRequest(request({ authorization: 'Bearer t' }), ['mail:draft']);

    expect(requireScopes).toHaveBeenCalledWith(validUser, ['mail:draft']);
  });

  it('maps a caller with no confirmed address to 403, with the sentence to act on', async () => {
    // 403 for the same reason a beta refusal is: the credentials are fine and
    // authorizing again would produce the same token and the same answer.
    vi.mocked(validateJWTToken).mockResolvedValue(validUser);
    vi.mocked(prepareAuthenticatedUser).mockRejectedValue(new VerifiedEmailRequiredError());

    const outcome = await authenticateRestRequest(request({ authorization: 'Bearer t' }), READ);

    expect(outcome).toMatchObject({ ok: false, reason: 'no_account', status: 403 });
    expect(outcome.ok ? '' : outcome.message).toBe(VERIFIED_EMAIL_MESSAGE);
  });

  it('maps one address held by another sign-in method to 409', async () => {
    // Not 403: nothing is refused about this caller, two accounts want one
    // address, and only they can say which sign-in method is theirs.
    vi.mocked(validateJWTToken).mockResolvedValue(validUser);
    vi.mocked(prepareAuthenticatedUser).mockRejectedValue(new EmailAlreadyLinkedError());

    const outcome = await authenticateRestRequest(request({ authorization: 'Bearer t' }), READ);

    expect(outcome).toMatchObject({ ok: false, reason: 'account_conflict', status: 409 });
    expect(outcome.ok ? '' : outcome.message).toBe(EMAIL_ALREADY_LINKED_MESSAGE);
  });

  it('maps an erased account to 403, with the sentence that points at support (#289)', async () => {
    // A token issued before the erasure is still valid for up to a day; the
    // dashboard shows this sentence instead of reading the tombstone.
    vi.mocked(validateJWTToken).mockResolvedValue(validUser);
    vi.mocked(prepareAuthenticatedUser).mockRejectedValue(new AccountErasedError());
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const outcome = await authenticateRestRequest(request({ authorization: 'Bearer t' }), READ);

    // A refusal decided and logged where it happened, not a database fault.
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
    expect(outcome).toMatchObject({ ok: false, reason: 'account_erased', status: 403 });
    expect(outcome.ok ? '' : outcome.message).toBe(ACCOUNT_ERASED_MESSAGE);
  });

  it('maps a database that will not answer to 503, not a rethrow', async () => {
    // Every REST handler calls authenticateRestRequest OUTSIDE its own try, so
    // an error escaping here is answered by the request boundary as text/plain
    // where the dashboard has always been given JSON.
    vi.mocked(validateJWTToken).mockResolvedValue(validUser);
    vi.mocked(prepareAuthenticatedUser).mockRejectedValue(new Error('connection terminated'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const outcome = await authenticateRestRequest(request({ authorization: 'Bearer t' }), READ);

    error.mockRestore();
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable', status: 503 });
  });

  it('reports the address the account was opened with', async () => {
    // It used to read the standard `email` claim, which Auth0 does not put on
    // an access token minted for a custom API: every route saw undefined.
    vi.mocked(validateJWTToken).mockResolvedValue(validUser);

    const outcome = await authenticateRestRequest(request({ authorization: 'Bearer t' }), READ);

    expect(outcome).toMatchObject({ ok: true, user: { email: 'user@example.invalid' } });
  });

  it('reports the application the token was issued to (#470)', async () => {
    // The send confirmation routes accept only the website's own application.
    vi.mocked(validateJWTToken).mockResolvedValue({ ...validUser, claims: { azp: 'WebsiteClient01' } });
    const withClient = await authenticateRestRequest(request({ authorization: 'Bearer t' }), READ);
    expect(withClient).toMatchObject({ ok: true, user: { clientId: 'WebsiteClient01' } });

    vi.mocked(validateJWTToken).mockResolvedValue(validUser);
    const withoutClient = await authenticateRestRequest(request({ authorization: 'Bearer t' }), READ);
    expect(withoutClient.ok && withoutClient.user.clientId).toBeUndefined();
  });

  it('labels each status honestly', () => {
    expect(restAuthErrorLabel(401)).toBe('Unauthorized');
    expect(restAuthErrorLabel(403)).toBe('Forbidden');
    expect(restAuthErrorLabel(409)).toBe('Conflict');
    expect(restAuthErrorLabel(503)).toBe('Service Unavailable');
  });
});
