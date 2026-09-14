import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'http';
import { BetaAccessDeniedError, BETA_ACCESS_MESSAGE } from '../../../src/auth/betaAccess.js';
import { InsufficientScopeError } from '../../../src/auth/oauthChallenge.js';

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
  });

  it('maps a beta refusal to 403, not 401', async () => {
    vi.mocked(validateJWTToken).mockRejectedValue(new BetaAccessDeniedError());

    const outcome = await authenticateRestRequest(request({ authorization: 'Bearer t' }), READ);

    expect(outcome).toMatchObject({ ok: false, reason: 'forbidden', status: 403 });
    expect(outcome.ok ? '' : outcome.message).toBe(BETA_ACCESS_MESSAGE);
  });

  it('maps an unconfigured server to 503, which used to be flattened to 401', async () => {
    vi.mocked(validateJWTToken).mockRejectedValue(new Error('OAuth validation not configured'));

    expect(await authenticateRestRequest(request({ authorization: 'Bearer t' }), READ)).toMatchObject({
      ok: false,
      reason: 'not_configured',
      status: 503
    });
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
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const outcome = await authenticateRestRequest(request({ authorization: 'Bearer t' }), ['mail:send']);

    expect(outcome).toMatchObject({ ok: false, reason: 'insufficient_scope', status: 403 });
    expect(outcome.ok ? '' : outcome.challenge).toContain('error="insufficient_scope"');
  });

  it('checks the scopes the caller passed', async () => {
    vi.mocked(validateJWTToken).mockResolvedValue(validUser);

    await authenticateRestRequest(request({ authorization: 'Bearer t' }), ['mail:draft']);

    expect(requireScopes).toHaveBeenCalledWith(validUser, ['mail:draft']);
  });

  it('labels each status honestly', () => {
    expect(restAuthErrorLabel(401)).toBe('Unauthorized');
    expect(restAuthErrorLabel(403)).toBe('Forbidden');
    expect(restAuthErrorLabel(503)).toBe('Service Unavailable');
  });
});
