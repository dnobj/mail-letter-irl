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
  rememberVerifiedToken,
  resetVerifiedTokens,
  VERIFIED_TOKEN_CONFIG
} from '../../../src/auth/signInPool.js';
import { validateAuthorizationHeader, validateJWTToken } from '../../../src/auth/tokenValidator.js';
import { validateToken } from '../../../src/services/patService.js';
import {
  checkGlobalRateLimit,
  clearRateLimitState,
  rateLimitMiddlewareWithTier
} from '../../../src/api/middleware/rateLimit.js';

const T0 = 1_000_000_000_000;

describe('tokens verified recently (#730)', () => {
  beforeEach(() => resetVerifiedTokens());

  it('knows a verified token by its bearer header, until it expires or ten minutes pass', () => {
    rememberVerifiedToken('tok-a', undefined, T0);
    expect(carriesVerifiedToken('Bearer tok-a', T0 + 1)).toBe(true);
    expect(carriesVerifiedToken('bearer tok-a', T0 + 1)).toBe(true);
    expect(carriesVerifiedToken(['Bearer tok-a'], T0 + 1)).toBe(true);
    expect(carriesVerifiedToken('Bearer tok-b', T0 + 1)).toBe(false);
    expect(carriesVerifiedToken(undefined, T0 + 1)).toBe(false);
    expect(carriesVerifiedToken('Basic tok-a', T0 + 1)).toBe(false);
    expect(carriesVerifiedToken('Bearer tok-a', T0 + VERIFIED_TOKEN_CONFIG.verifiedForMs)).toBe(false);

    rememberVerifiedToken('tok-c', T0 + 5000, T0);
    expect(carriesVerifiedToken('Bearer tok-c', T0 + 4999)).toBe(true);
    expect(carriesVerifiedToken('Bearer tok-c', T0 + 5000)).toBe(false);
  });

  it('keeps no expired token, so none can crowd out a live one', () => {
    rememberVerifiedToken('live', undefined, T0);
    for (let i = 0; i < VERIFIED_TOKEN_CONFIG.maxVerified; i += 1) rememberVerifiedToken(`gone-${i}`, T0 - 1, T0);
    expect(carriesVerifiedToken('Bearer live', T0 + 1)).toBe(true);
  });

  it('holds a bounded number of tokens, dropping the oldest', () => {
    for (let i = 0; i <= VERIFIED_TOKEN_CONFIG.maxVerified; i += 1) rememberVerifiedToken(`tok-${i}`, undefined, T0);
    expect(carriesVerifiedToken('Bearer tok-0', T0)).toBe(false);
    expect(carriesVerifiedToken('Bearer tok-1', T0)).toBe(true);
    expect(carriesVerifiedToken(`Bearer tok-${VERIFIED_TOKEN_CONFIG.maxVerified}`, T0)).toBe(true);
  });

  it('is emptied with the rate-limit state', () => {
    rememberVerifiedToken('tok-a');
    clearRateLimitState();
    expect(carriesVerifiedToken('Bearer tok-a')).toBe(false);
  });
});

describe('what the token validator remembers (#730)', () => {
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
    resetVerifiedTokens();
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

  it('remembers a token that verifies, until it expires', async () => {
    const token = await sign();
    await validateJWTToken(token, keySet, ['mail:send']);
    expect(carriesVerifiedToken(`Bearer ${token}`)).toBe(true);
    expect(carriesVerifiedToken(`Bearer ${token}`, Date.now() + 5 * 60 * 1000 + 1000)).toBe(false);
  });

  it('remembers neither a token whose signature fails nor one short of a scope', async () => {
    const other = await generateKeyPair('RS256');
    const forged = await sign(undefined, other.privateKey);
    await expect(validateJWTToken(forged, keySet)).rejects.toThrow();
    const short = await sign('mail:read');
    await expect(validateJWTToken(short, keySet, ['mail:send'])).rejects.toThrow('insufficient_scope');
    expect(carriesVerifiedToken(`Bearer ${forged}`)).toBe(false);
    expect(carriesVerifiedToken(`Bearer ${short}`)).toBe(false);
  });

  it('remembers a personal access token that passes, and not one that fails', async () => {
    vi.mocked(validateToken).mockResolvedValueOnce({ valid: false, error: 'Invalid token' } as never);
    await expect(validateAuthorizationHeader('Bearer lirl_pat_bad')).rejects.toThrow();
    vi.mocked(validateToken).mockResolvedValueOnce({ valid: true, userId: 'pat-user', tokenId: 't1', scopes: [] } as never);
    await validateAuthorizationHeader('Bearer lirl_pat_good');
    expect(carriesVerifiedToken('Bearer lirl_pat_good')).toBe(true);
    expect(carriesVerifiedToken('Bearer lirl_pat_bad')).toBe(false);
  });

  it('does not remember a personal access token whose account is not admitted', async () => {
    vi.stubEnv('LETTER_IRL_BETA_GATE_ENABLED', 'true');
    vi.stubEnv('LETTER_IRL_BETA_ALLOWED_SUBJECTS', 'someone-else');
    vi.stubEnv('LETTER_IRL_ADMIN_USER_IDS', '');
    vi.mocked(validateToken).mockResolvedValueOnce({ valid: true, userId: 'pat-user', tokenId: 't2', scopes: [] } as never);
    await expect(validateAuthorizationHeader('Bearer lirl_pat_outsider')).rejects.toThrow();
    expect(carriesVerifiedToken('Bearer lirl_pat_outsider')).toBe(false);
  });
});

describe('the MCP and REST backstop leaves a recently verified token alone (#730)', () => {
  function request(authorization: string | undefined, address: string): IncomingMessage {
    return {
      headers: { 'x-forwarded-for': address, ...(authorization ? { authorization } : {}) },
      socket: { remoteAddress: '10.0.0.1' }
    } as unknown as IncomingMessage;
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
  const addressOf = (i: number) => `198.51.${Math.floor(i / 250)}.${i % 250}`;

  beforeEach(() => clearRateLimitState());

  it.each(['mcp', 'api'] as const)('%s: junk from many addresses fills it, refusing junk and the unknown, never a verified token', async type => {
    rememberVerifiedToken('good-token');
    const ceiling = checkGlobalRateLimit(type).limit; // this call takes one slot
    let refused = 0;
    for (let i = 0; i < ceiling; i += 1) {
      const { res } = response();
      if (await rateLimitMiddlewareWithTier(request('Bearer junk', addressOf(i)), res, type)) refused += 1;
    }
    expect(refused).toBe(1);
    const junk = response();
    expect(await rateLimitMiddlewareWithTier(request('Bearer junk', '203.0.113.1'), junk.res, type)).toBe(true);
    expect(junk.state.status).toBe(429);
    expect(junk.state.headers['x-ratelimit-scope']).toBe('global');
    const unknown = response();
    expect(await rateLimitMiddlewareWithTier(request(undefined, '203.0.113.2'), unknown.res, type)).toBe(true);
    for (let i = 0; i < 50; i += 1) {
      const good = response();
      expect(await rateLimitMiddlewareWithTier(request('Bearer good-token', `203.0.114.${i}`), good.res, type)).toBe(false);
    }
  });

  it('counts nothing for a verified token, so signed-in traffic cannot fill it either', async () => {
    rememberVerifiedToken('good-token');
    const before = checkGlobalRateLimit('mcp').remaining;
    for (let i = 0; i < 20; i += 1) {
      const { res } = response();
      await rateLimitMiddlewareWithTier(request('Bearer good-token', addressOf(i)), res, 'mcp');
    }
    expect(checkGlobalRateLimit('mcp').remaining).toBe(before - 1);
  });

  it('still holds a verified token to its per-address limit', async () => {
    rememberVerifiedToken('good-token');
    let refused = false;
    for (let i = 0; i < 1000 && !refused; i += 1) {
      const { res } = response();
      refused = await rateLimitMiddlewareWithTier(request('Bearer good-token', '198.51.100.7'), res, 'mcp');
    }
    expect(refused).toBe(true);
  });

  it('leaves the other routes to their own backstops, verified or not', async () => {
    rememberVerifiedToken('good-token');
    const ceiling = checkGlobalRateLimit('checkout').limit;
    let refused = 0;
    for (let i = 0; i < ceiling; i += 1) {
      const { res } = response();
      if (await rateLimitMiddlewareWithTier(request('Bearer good-token', addressOf(i)), res, 'checkout')) refused += 1;
    }
    expect(refused).toBe(1);
  });
});
