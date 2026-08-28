import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { BetaAccessDeniedError, BETA_ACCESS_MESSAGE } from '../../../src/auth/betaAccess.js';

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

import { validateJWTToken } from '../../../src/auth/tokenValidator.js';
import {
  authenticateRestRequest,
  restAuthErrorLabel
} from '../../../src/api/middleware/restAuth.js';

const request = (headers: Record<string, string> = {}) =>
  ({ headers }) as unknown as IncomingMessage;

describe('restAuth failure statuses', () => {
  beforeEach(() => {
    vi.mocked(validateJWTToken).mockReset();
  });

  it('maps a beta refusal to 403, not 401', async () => {
    vi.mocked(validateJWTToken).mockRejectedValue(new BetaAccessDeniedError());

    const outcome = await authenticateRestRequest(request({ authorization: 'Bearer t' }));

    expect(outcome).toMatchObject({ ok: false, reason: 'forbidden', status: 403 });
    expect(outcome.ok ? '' : outcome.message).toBe(BETA_ACCESS_MESSAGE);
  });

  it('maps an unconfigured server to 503, which used to be flattened to 401', async () => {
    vi.mocked(validateJWTToken).mockRejectedValue(new Error('OAuth validation not configured'));

    expect(await authenticateRestRequest(request({ authorization: 'Bearer t' }))).toMatchObject({
      ok: false,
      reason: 'not_configured',
      status: 503
    });
  });

  it('keeps a rejected token and a missing header at 401', async () => {
    vi.mocked(validateJWTToken).mockRejectedValue(new Error('signature verification failed'));

    expect(await authenticateRestRequest(request({ authorization: 'Bearer t' }))).toMatchObject({
      ok: false,
      reason: 'rejected',
      status: 401
    });
    expect(await authenticateRestRequest(request())).toMatchObject({
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

    expect(await authenticateRestRequest(request({ authorization: 'Bearer t' }))).toMatchObject({
      reason: 'forbidden',
      status: 403
    });
  });

  it('labels each status honestly', () => {
    expect(restAuthErrorLabel(401)).toBe('Unauthorized');
    expect(restAuthErrorLabel(403)).toBe('Forbidden');
    expect(restAuthErrorLabel(503)).toBe('Service Unavailable');
  });
});
