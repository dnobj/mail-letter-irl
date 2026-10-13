import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Scopes on personal access token management (audit A-02, A-03).
 *
 * A token that can only read must not be able to mint one: that would turn a
 * read grant into a standing credential. A personal access token carries read
 * and draft (migration 037, #470), and the handler refuses one on minting and
 * revoking whatever it carries. These drive the real handler and the real
 * requireScopes; only the header validation, the service and the account
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

// The account behind the caller (#446 review): opened or found, unless a test refuses it.
vi.mock('../../../src/auth/identity.js', () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue('person@example.com')
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
import * as diagnostics from '../../../src/utils/diagnosticLog.js';
import { handlePATApiRequest } from '../../../src/api/patApiHandler.js';
import { prepareAuthenticatedUser } from '../../../src/auth/identity.js';
import { AccountErasedError, ACCOUNT_ERASED_MESSAGE } from '../../../src/auth/accountErased.js';

const ALL = ['mail:read', 'mail:draft', 'mail:send'];

const WEBSITE = 'website-client-id';

/** A token Auth0 issued to `azp`: the website's own application unless a test says another. */
function jwt(scopes: string[], azp: string = WEBSITE): AuthenticatedUser {
  return { userId: 'auth0|user-1', authType: 'jwt', scopes, claims: { azp }, token: 'jwt' };
}

// What migration 037 gives every token (#470): read and draft, never send.
const pat: AuthenticatedUser = {
  userId: 'auth0|user-1',
  authType: 'pat',
  scopes: ['mail:read', 'mail:draft'],
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
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(validateAuthorizationHeader).mockReset();
    vi.mocked(createToken).mockReset();
    vi.mocked(listTokens).mockReset();
    vi.mocked(revokeToken).mockReset();
    vi.mocked(rateLimitAccount).mockReset();
    vi.mocked(rateLimitAccount).mockResolvedValue(false);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeSpy = vi.spyOn(diagnostics, 'writeDiagnostic');
    vi.stubEnv('LETTER_IRL_WEBSITE_CLIENT_ID', WEBSITE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('made and revoked on the website only (#730)', () => {
    it.each([
      ['another application', jwt(ALL, 'claude-code-client')],
      ['a token naming no application', { ...jwt(ALL), claims: {} }]
    ])('refuses minting and revoking for %s, with nothing made or revoked', async (_label, user) => {
      vi.mocked(validateAuthorizationHeader).mockResolvedValue(user as AuthenticatedUser);

      const mint = response();
      await handlePATApiRequest(request('POST', { name: 'Laptop' }), mint.res, '/api/tokens');
      expect(mint.state.status).toBe(403);
      expect(JSON.parse(mint.state.body)).toEqual({ error: 'website_only', message: 'Personal access tokens are managed on letterirl.com.' });

      const revoke = response();
      await handlePATApiRequest(request('DELETE'), revoke.res, '/api/tokens/7');
      expect(revoke.state.status).toBe(403);

      expect(createToken).not.toHaveBeenCalled();
      expect(revokeToken).not.toHaveBeenCalled();
      expect(writeSpy).toHaveBeenCalledWith('warn', 'auth.pat_client_refused', { configured: true });
    });

    it.each([
      ["the website's", jwt(ALL)],
      ['no', { ...jwt(ALL), claims: {} }]
    ])("refuses everyone when the website's application is not configured: a token naming %s application", async (_label, user) => {
      vi.stubEnv('LETTER_IRL_WEBSITE_CLIENT_ID', '');
      vi.mocked(validateAuthorizationHeader).mockResolvedValue(user as AuthenticatedUser);
      const mint = response();
      await handlePATApiRequest(request('POST', { name: 'Laptop' }), mint.res, '/api/tokens');
      expect(mint.state.status).toBe(403);
      const revoke = response();
      await handlePATApiRequest(request('DELETE'), revoke.res, '/api/tokens/7');
      expect(revoke.state.status).toBe(403);
      expect(createToken).not.toHaveBeenCalled();
      expect(revokeToken).not.toHaveBeenCalled();
      expect(writeSpy).toHaveBeenCalledWith('warn', 'auth.pat_client_refused', { configured: false });
    });

    it('reads the client id before azp, as the send rule does', async () => {
      vi.mocked(validateAuthorizationHeader).mockResolvedValue({
        ...jwt(ALL),
        claims: { client_id: 'claude-code-client', azp: WEBSITE }
      } as AuthenticatedUser);
      const mint = response();
      await handlePATApiRequest(request('POST', { name: 'Laptop' }), mint.res, '/api/tokens');
      expect(mint.state.status).toBe(403);
      expect(createToken).not.toHaveBeenCalled();
    });

    it('rate-limits another application before refusing it', async () => {
      vi.mocked(validateAuthorizationHeader).mockResolvedValue(jwt(ALL, 'claude-code-client'));
      vi.mocked(rateLimitAccount).mockImplementation(async (_req, res) => {
        res.statusCode = 429;
        res.end('{"error":"rate_limited"}');
        return true;
      });
      const mint = response();
      await handlePATApiRequest(request('POST', { name: 'Laptop' }), mint.res, '/api/tokens');
      expect(mint.state.status).toBe(429);
      expect(writeSpy).not.toHaveBeenCalledWith('warn', 'auth.pat_client_refused', expect.anything());
    });

    it('still lets another application list tokens', async () => {
      vi.mocked(validateAuthorizationHeader).mockResolvedValue(jwt(['mail:read'], 'claude-code-client'));
      vi.mocked(listTokens).mockResolvedValue([]);
      const list = response();
      await handlePATApiRequest(request('GET'), list.res, '/api/tokens');
      expect(list.state.status).toBe(200);
    });

    it('lets the website revoke one', async () => {
      vi.mocked(validateAuthorizationHeader).mockResolvedValue(jwt(ALL));
      vi.mocked(revokeToken).mockResolvedValue(true as never);
      const revoke = response();
      await handlePATApiRequest(request('DELETE'), revoke.res, '/api/tokens/7');
      expect(revokeToken).toHaveBeenCalledWith('auth0|user-1', 7);
      expect(revoke.state.status).toBe(200);
    });
  });

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
    // Refused by its scopes now (#470: a token carries read and draft, and
    // minting needs mail:send), before the handler's own PAT refusal is reached.
    expect(String(mint.state.headers['www-authenticate'])).toContain('scope="mail:send"');
    expect(createToken).not.toHaveBeenCalled();
  });

  it('refuses a personal access token minting or revoking even if it ever carries mail:send', async () => {
    // Migration 037 keeps mail:send an allowed value for a later, explicit
    // grant. The handler's own PAT refusals are then all that stop such a
    // token minting a standing credential, so they are pinned here.
    vi.mocked(validateAuthorizationHeader).mockResolvedValue({ ...pat, scopes: ALL });

    const mint = response();
    await handlePATApiRequest(request('POST', { name: 'Laptop' }), mint.res, '/api/tokens');
    expect(mint.state.status).toBe(403);
    expect(JSON.parse(mint.state.body).message).toMatch(/PAT authentication/);
    expect(createToken).not.toHaveBeenCalled();

    const revoke = response();
    await handlePATApiRequest(request('DELETE'), revoke.res, '/api/tokens/7');
    expect(revoke.state.status).toBe(403);
    expect(JSON.parse(revoke.state.body).message).toMatch(/PAT authentication/);
    expect(revokeToken).not.toHaveBeenCalled();
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
  it('refuses an erased account before any route runs (#446 review)', async () => {
    // An access token issued before the erasure is valid for up to a day; it
    // must not create a named token on the tombstone.
    vi.mocked(validateAuthorizationHeader).mockResolvedValue(jwt(ALL));
    vi.mocked(prepareAuthenticatedUser).mockRejectedValueOnce(new AccountErasedError());
    const { res, state } = response();

    await handlePATApiRequest(request('POST', { name: 'Laptop' }), res, '/api/tokens');

    expect(state.status).toBe(403);
    expect(JSON.parse(state.body)).toEqual({ error: 'Forbidden', message: ACCOUNT_ERASED_MESSAGE });
    expect(createToken).not.toHaveBeenCalled();
  });
});
