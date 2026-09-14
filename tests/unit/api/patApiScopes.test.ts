import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Scopes on personal access token management (audit A-02, A-03).
 *
 * A personal access token passes every scope check, so a token that can only
 * read must not be able to mint one: that would turn a read grant into a
 * standing credential that can spend. These drive the real handler and the
 * real requireScopes; only the header validation, the service and the account
 * limiter are stubbed.
 */

vi.mock('../../../src/auth/tokenValidator.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/auth/tokenValidator.js')>()),
  validateAuthorizationHeader: vi.fn()
}));

vi.mock('../../../src/services/patService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/patService.js')>()),
  createToken: vi.fn(),
  listTokens: vi.fn(),
  revokeToken: vi.fn()
}));

vi.mock('../../../src/api/middleware/rateLimit.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/api/middleware/rateLimit.js')>()),
  rateLimitAccount: vi.fn()
}));

import {
  validateAuthorizationHeader,
  type AuthenticatedUser
} from '../../../src/auth/tokenValidator.js';
import {
  createToken,
  listTokens,
  revokeToken,
  TokenExpiryError
} from '../../../src/services/patService.js';
import { rateLimitAccount } from '../../../src/api/middleware/rateLimit.js';
import { handlePATApiRequest } from '../../../src/api/patApiHandler.js';

const ALL = ['mail:read', 'mail:draft', 'mail:send'];

function jwt(scopes: string[]): AuthenticatedUser {
  return { userId: 'auth0|user-1', authType: 'jwt', scopes, claims: {}, token: 'jwt' };
}

const pat: AuthenticatedUser = {
  userId: 'auth0|user-1',
  authType: 'pat',
  scopes: [],
  claims: {},
  token: 'pat'
};

function request(method: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return Object.assign(Readable.from(chunks), {
    method,
    headers: { authorization: 'Bearer x' }
  }) as unknown as IncomingMessage;
}

function response() {
  const state = { status: 0, body: '', headers: {} as Record<string, unknown> };
  const res = {
    statusCode: 0,
    setHeader(name: string, value: unknown) {
      state.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      state.status = this.statusCode;
      state.body = chunk ?? '';
    }
  };
  return { res: res as unknown as ServerResponse, state };
}

describe('personal access token routes', () => {
  beforeEach(() => {
    vi.mocked(validateAuthorizationHeader).mockReset();
    vi.mocked(createToken).mockReset();
    vi.mocked(listTokens).mockReset();
    vi.mocked(revokeToken).mockReset();
    vi.mocked(rateLimitAccount).mockReset();
    vi.mocked(rateLimitAccount).mockResolvedValue(false);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('refuses to mint a token for a token that can only read, with 403 and a challenge', async () => {
    vi.mocked(validateAuthorizationHeader).mockResolvedValue(jwt(['mail:read']));
    const { res, state } = response();

    await handlePATApiRequest(request('POST', { name: 'Laptop' }), res, '/api/tokens');

    // Red if the handler stops checking the route's scope.
    expect(state.status).toBe(403);
    expect(String(state.headers['www-authenticate'])).toContain('scope="mail:send"');
    expect(createToken).not.toHaveBeenCalled();
  });

  it('mints for a token that can spend', async () => {
    vi.mocked(validateAuthorizationHeader).mockResolvedValue(jwt(ALL));
    vi.mocked(createToken).mockResolvedValue({
      token: 'lirl_pat_example',
      tokenId: 1,
      name: 'Laptop',
      expiresAt: new Date('2026-12-13T00:00:00Z')
    });
    const { res, state } = response();

    await handlePATApiRequest(request('POST', { name: 'Laptop' }), res, '/api/tokens');

    expect(state.status).toBe(201);
    expect(createToken).toHaveBeenCalledWith('auth0|user-1', 'Laptop', { expiresAt: undefined });
  });

  it('refuses to revoke a token for a token that can only read', async () => {
    vi.mocked(validateAuthorizationHeader).mockResolvedValue(jwt(['mail:read']));
    const { res, state } = response();

    await handlePATApiRequest(request('DELETE'), res, '/api/tokens/7');

    expect(state.status).toBe(403);
    expect(revokeToken).not.toHaveBeenCalled();
  });

  it('lets a token that can read list tokens', async () => {
    vi.mocked(validateAuthorizationHeader).mockResolvedValue(jwt(['mail:read']));
    vi.mocked(listTokens).mockResolvedValue([]);
    const { res, state } = response();

    await handlePATApiRequest(request('GET'), res, '/api/tokens');

    expect(state.status).toBe(200);
  });

  it('still lets a personal access token list tokens, and still refuses it minting one', async () => {
    vi.mocked(validateAuthorizationHeader).mockResolvedValue(pat);
    vi.mocked(listTokens).mockResolvedValue([]);

    const list = response();
    await handlePATApiRequest(request('GET'), list.res, '/api/tokens');
    expect(list.state.status).toBe(200);

    const mint = response();
    await handlePATApiRequest(request('POST', { name: 'Laptop' }), mint.res, '/api/tokens');
    expect(mint.state.status).toBe(403);
    expect(JSON.parse(mint.state.body).message).toMatch(/PAT authentication/);
    expect(createToken).not.toHaveBeenCalled();
  });

  it('answers a refused expiry with 400, not 500', async () => {
    vi.mocked(validateAuthorizationHeader).mockResolvedValue(jwt(ALL));
    vi.mocked(createToken).mockRejectedValue(
      new TokenExpiryError('Token expiry must be in the future')
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { res, state } = response();

    await handlePATApiRequest(
      request('POST', { name: 'Laptop', expiresAt: '2020-01-01T00:00:00Z' }),
      res,
      '/api/tokens'
    );

    // Red if the handler lets the error fall through to its generic 500.
    expect(state.status).toBe(400);
    expect(JSON.parse(state.body).message).toBe('Token expiry must be in the future');
  });

  it('answers 503 when the server cannot validate tokens, not a 401 that sends the user to sign in again', async () => {
    vi.mocked(validateAuthorizationHeader).mockRejectedValue(
      new Error('OAuth validation not configured')
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { res, state } = response();

    await handlePATApiRequest(request('GET'), res, '/api/tokens');

    expect(state.status).toBe(503);
    expect(listTokens).not.toHaveBeenCalled();
    // Logged once, with no fields: the validator throws before its own log.
    expect(
      error.mock.calls
        .map(([line]) => String(line))
        .filter(line => line.includes('"event":"auth.validation_not_configured"'))
        .map(line => JSON.parse(line))
    ).toEqual([{ event: 'auth.validation_not_configured', msg: 'auth.validation_not_configured' }]);
  });

  it('applies the account limit once the caller is known, before any route runs', async () => {
    vi.mocked(validateAuthorizationHeader).mockResolvedValue(jwt(['mail:read']));
    vi.mocked(rateLimitAccount).mockResolvedValue(true);
    const req = request('GET');
    const { res } = response();

    expect(await handlePATApiRequest(req, res, '/api/tokens')).toBe(true);

    expect(rateLimitAccount).toHaveBeenCalledWith(req, res, 'auth0|user-1', 'api_account');
    expect(listTokens).not.toHaveBeenCalled();
  });
});
