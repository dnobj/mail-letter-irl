import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { generateKeyPair, SignJWT } from 'jose';

vi.mock('../../../src/services/patService.js', () => ({
  TOKEN_PREFIX: 'lirl_pat_',
  validateToken: vi.fn(),
  updateLastUsed: vi.fn().mockResolvedValue(undefined)
}));

import {
  carriesVerifiedToken,
  failedSignInPool,
  recordFailedSignIn,
  rememberVerifiedToken,
  resetSignInPool,
  SIGN_IN_POOL_CONFIG
} from '../../../src/auth/signInPool.js';
import { validateAuthorizationHeader, validateJWTToken } from '../../../src/auth/tokenValidator.js';
import { validateToken } from '../../../src/services/patService.js';
import { clearRateLimitState, rateLimitMiddlewareWithTier } from '../../../src/api/middleware/rateLimit.js';

const T0 = 1_000_000_000_000;

describe('the failed sign-in pool (#730)', () => {
  beforeEach(() => resetSignInPool());

  it('fills at its limit within a minute, and empties with the next', () => {
    for (let i = 0; i < SIGN_IN_POOL_CONFIG.maxFailures - 1; i += 1) recordFailedSignIn(T0);
    expect(failedSignInPool(T0).full).toBe(false);
    recordFailedSignIn(T0);
    expect(failedSignInPool(T0 + 1000)).toMatchObject({ full: true, limit: SIGN_IN_POOL_CONFIG.maxFailures, resetMs: 59_000 });
    expect(failedSignInPool(T0 + SIGN_IN_POOL_CONFIG.windowMs).full).toBe(false);
    recordFailedSignIn(T0 + SIGN_IN_POOL_CONFIG.windowMs);
    expect(failedSignInPool(T0 + SIGN_IN_POOL_CONFIG.windowMs).full).toBe(false);
  });

  it('knows a verified token by its bearer header, until it expires or ten minutes pass', () => {
    rememberVerifiedToken('tok-a', undefined, T0);
    expect(carriesVerifiedToken('Bearer tok-a', T0 + 1)).toBe(true);
    expect(carriesVerifiedToken('bearer tok-a', T0 + 1)).toBe(true);
    expect(carriesVerifiedToken('Bearer tok-b', T0 + 1)).toBe(false);
    expect(carriesVerifiedToken(undefined, T0 + 1)).toBe(false);
    expect(carriesVerifiedToken('Basic tok-a', T0 + 1)).toBe(false);
    expect(carriesVerifiedToken('Bearer tok-a', T0 + SIGN_IN_POOL_CONFIG.verifiedForMs)).toBe(false);

    rememberVerifiedToken('tok-c', T0 + 5000, T0);
    expect(carriesVerifiedToken('Bearer tok-c', T0 + 4999)).toBe(true);
    expect(carriesVerifiedToken('Bearer tok-c', T0 + 5000)).toBe(false);

    rememberVerifiedToken('tok-d', T0 - 1, T0);
    expect(carriesVerifiedToken('Bearer tok-d', T0)).toBe(false);
  });

  it('holds a bounded number of tokens, dropping the oldest', () => {
    for (let i = 0; i <= SIGN_IN_POOL_CONFIG.maxVerified; i += 1) rememberVerifiedToken(`tok-${i}`, undefined, T0);
    expect(carriesVerifiedToken('Bearer tok-0', T0)).toBe(false);
    expect(carriesVerifiedToken('Bearer tok-1', T0)).toBe(true);
    expect(carriesVerifiedToken(`Bearer tok-${SIGN_IN_POOL_CONFIG.maxVerified}`, T0)).toBe(true);
  });
});

describe('what the token validator tells the pool (#730)', () => {
  const issuer = 'https://dev-test.auth0.com/';
  const audience = 'https://dev-api.example.com/mcp';
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  const keySet = async () => keys.publicKey;
  const sign = (scope = 'mail:read mail:draft mail:send', key = keys.privateKey) =>
    new SignJWT({ sub: 'auth0|user-1', scope })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);

  beforeAll(async () => {
    keys = await generateKeyPair('RS256');
  });

  beforeEach(() => {
    resetSignInPool();
    vi.stubEnv('LETTER_IRL_OAUTH_ISSUER', issuer);
    vi.stubEnv('LETTER_IRL_OAUTH_JWKS_URI', `${issuer}.well-known/jwks.json`);
    vi.stubEnv('LETTER_IRL_OAUTH_AUDIENCE', audience);
    vi.stubEnv('LETTER_IRL_OAUTH_ALLOWED_ALGORITHMS', 'RS256');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const failures = () => {
    const before = failedSignInPool().full;
    expect(before).toBe(false);
    // Read the count through the pool's limit: one more failure than recorded fills it.
    let added = 0;
    while (!failedSignInPool().full) {
      recordFailedSignIn();
      added += 1;
    }
    return SIGN_IN_POOL_CONFIG.maxFailures - added;
  };

  it('remembers a token that verifies, and counts nothing', async () => {
    const token = await sign();
    await validateJWTToken(token, keySet, ['mail:send']);
    expect(carriesVerifiedToken(`Bearer ${token}`)).toBe(true);
    expect(failures()).toBe(0);
  });

  it('counts a token whose signature fails, and does not remember it', async () => {
    const other = await generateKeyPair('RS256');
    const token = await sign(undefined, other.privateKey);
    await expect(validateJWTToken(token, keySet)).rejects.toThrow();
    expect(carriesVerifiedToken(`Bearer ${token}`)).toBe(false);
    expect(failures()).toBe(1);
  });

  it('does not count a verified token short of a scope, nor remember it', async () => {
    const token = await sign('mail:read');
    await expect(validateJWTToken(token, keySet, ['mail:send'])).rejects.toThrow('insufficient_scope');
    expect(carriesVerifiedToken(`Bearer ${token}`)).toBe(false);
    expect(failures()).toBe(0);
  });

  it('counts a personal access token that fails, and remembers one that passes', async () => {
    vi.mocked(validateToken).mockResolvedValueOnce({ valid: false, error: 'Invalid token' } as never);
    await expect(validateAuthorizationHeader('Bearer lirl_pat_bad')).rejects.toThrow();
    vi.mocked(validateToken).mockResolvedValueOnce({ valid: true, userId: 'pat-user', tokenId: 't1', scopes: [] } as never);
    await validateAuthorizationHeader('Bearer lirl_pat_good');
    expect(carriesVerifiedToken('Bearer lirl_pat_good')).toBe(true);
    expect(carriesVerifiedToken('Bearer lirl_pat_bad')).toBe(false);
    expect(failures()).toBe(1);
  });
});

describe('the MCP and REST backstop refuses only the unverified, and only while failures fill it (#730)', () => {
  function request(authorization?: string, address = '198.51.100.7'): IncomingMessage {
    return { headers: { 'x-forwarded-for': address, ...(authorization ? { authorization } : {}) }, socket: { remoteAddress: '10.0.0.1' } } as unknown as IncomingMessage;
  }
  function response() {
    const state = { status: 0, headers: {} as Record<string, unknown> };
    const res = {
      set statusCode(value: number) {
        state.status = value;
      },
      get statusCode() {
        return state.status;
      },
      setHeader(name: string, value: unknown) {
        state.headers[name.toLowerCase()] = value;
      },
      end: vi.fn()
    };
    return { res: res as unknown as ServerResponse, state };
  }
  const fill = () => {
    for (let i = 0; i < SIGN_IN_POOL_CONFIG.maxFailures; i += 1) recordFailedSignIn();
  };

  beforeEach(() => clearRateLimitState());

  it.each(['mcp', 'api'] as const)('%s: any request passes while the pool has room, however many there are', async type => {
    for (let i = 0; i < 1500; i += 1) {
      const { res } = response();
      expect(await rateLimitMiddlewareWithTier(request('Bearer junk', `198.51.${Math.floor(i / 250)}.${i % 250}`), res, type)).toBe(false);
    }
  });

  it.each(['mcp', 'api'] as const)('%s: a full pool refuses a junk or missing token, and lets a verified one through', async type => {
    fill();
    rememberVerifiedToken('good-token');
    const junk = response();
    expect(await rateLimitMiddlewareWithTier(request('Bearer junk'), junk.res, type)).toBe(true);
    expect(junk.state.status).toBe(429);
    expect(junk.state.headers['x-ratelimit-scope']).toBe('global');
    expect(Number(junk.state.headers['retry-after'])).toBeGreaterThan(0);
    const none = response();
    expect(await rateLimitMiddlewareWithTier(request(undefined, '198.51.100.8'), none.res, type)).toBe(true);
    const good = response();
    expect(await rateLimitMiddlewareWithTier(request('Bearer good-token', '198.51.100.9'), good.res, type)).toBe(false);
  });

  it('leaves the other routes to their own backstops', async () => {
    fill();
    const { res } = response();
    expect(await rateLimitMiddlewareWithTier(request('Bearer junk'), res, 'checkout')).toBe(false);
  });
});
