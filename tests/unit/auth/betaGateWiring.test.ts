import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { BetaAccessDeniedError } from '../../../src/auth/betaAccess.js';

/**
 * The gate, actually wired (#179).
 *
 * Steps 1 and 2 built a cohort check and five refusal surfaces that nothing
 * could reach. This is where it starts refusing real requests, so these tests
 * pin WHERE it sits - and the placements are the whole design:
 *
 *   - Both token validators, not just the JWT one. A PAT minted while a
 *     subject was admitted would otherwise outlive their removal.
 *   - LetterIrlServer.execute, because the stdio transport and
 *     LETTER_IRL_REQUIRE_AUTH=false reach the tools with no validator at all.
 *   - Both checkouts BEFORE Stripe, so a refused account is never charged.
 *   - The send path, but NOT for jit_order funding - that runs after Stripe has
 *     taken the money, and refusing there would strand it.
 *
 * getOrCreateUser is deliberately not a site: its only caller swallows its
 * failure into a warn, and three other paths insert into users without it -
 * including the Stripe webhook.
 */

vi.mock('../../../src/services/patService.js', () => ({
  TOKEN_PREFIX: 'lirl_pat_',
  validateToken: vi.fn(),
  updateLastUsed: vi.fn().mockResolvedValue(undefined)
}));

import {
  validateAuthorizationHeader,
  validateJWTToken
} from '../../../src/auth/tokenValidator.js';
import { validateToken } from '../../../src/services/patService.js';

const ISSUER = 'https://dev-test.auth0.com/';
const AUDIENCE = 'https://dev-api.example.com/mcp';
const ADMITTED = 'auth0|admitted';
const REFUSED = 'auth0|refused';

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let publicKey: Awaited<ReturnType<typeof generateKeyPair>>['publicKey'];

const mint = (sub: string) =>
  new SignJWT({ sub, scope: 'mail:read mail:draft mail:send' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

/** Raise the gate and admit exactly one subject. */
function gateUp() {
  vi.stubEnv('LETTER_IRL_BETA_GATE_ENABLED', 'true');
  vi.stubEnv('LETTER_IRL_BETA_ALLOWED_SUBJECTS', ADMITTED);
  vi.stubEnv('LETTER_IRL_ADMIN_USER_IDS', '');
}

describe('the token validators', () => {
  const keySet = async () => publicKey;

  beforeAll(async () => {
    ({ privateKey, publicKey } = await generateKeyPair('RS256'));
  });

  beforeEach(() => {
    vi.stubEnv('LETTER_IRL_OAUTH_ISSUER', ISSUER);
    vi.stubEnv('LETTER_IRL_OAUTH_JWKS_URI', `${ISSUER}.well-known/jwks.json`);
    vi.stubEnv('LETTER_IRL_OAUTH_AUDIENCE', AUDIENCE);
    vi.stubEnv('LETTER_IRL_OAUTH_ALLOWED_ALGORITHMS', 'RS256');
    gateUp();
  });

  afterEach(() => vi.unstubAllEnvs());

  it('refuses a valid JWT whose subject is not admitted', async () => {
    // The token is perfectly good. That is the point: this is not an
    // authentication failure and must not be reported as one.
    await expect(validateJWTToken(await mint(REFUSED), keySet)).rejects.toBeInstanceOf(
      BetaAccessDeniedError
    );
  });

  it('admits a subject on the list', async () => {
    await expect(validateJWTToken(await mint(ADMITTED), keySet)).resolves.toMatchObject({
      userId: ADMITTED,
      authType: 'jwt'
    });
  });

  it('lets everyone through when the gate is down', async () => {
    vi.stubEnv('LETTER_IRL_BETA_GATE_ENABLED', 'false');
    await expect(validateJWTToken(await mint(REFUSED), keySet)).resolves.toMatchObject({
      userId: REFUSED
    });
  });

  it('refuses a PAT for a subject that is not admitted', async () => {
    // Gating only the JWT path would leave a token minted while someone was
    // admitted working forever after their removal.
    vi.mocked(validateToken).mockResolvedValue({
      valid: true,
      userId: REFUSED,
      tokenId: 'tok-1'
    } as never);

    await expect(
      validateAuthorizationHeader('Bearer lirl_pat_something')
    ).rejects.toBeInstanceOf(BetaAccessDeniedError);
  });

  it('admits a PAT for a subject that is', async () => {
    vi.mocked(validateToken).mockResolvedValue({
      valid: true,
      userId: ADMITTED,
      tokenId: 'tok-1'
    } as never);

    await expect(
      validateAuthorizationHeader('Bearer lirl_pat_something')
    ).resolves.toMatchObject({ userId: ADMITTED, authType: 'pat' });
  });
});

describe('the tool execute path', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('refuses before the tool is even looked up', async () => {
    // Called with a tool name that does not exist. If the beta check ran after
    // the lookup, this would fail with "Tool ... is not registered" - so the
    // error type here is what proves the ordering.
    gateUp();
    const { LetterIrlServer } = await import('../../../src/server.js');
    const server = new LetterIrlServer();

    await expect(
      server.execute({ toolName: 'no_such_tool', userId: REFUSED, input: {} } as never)
    ).rejects.toBeInstanceOf(BetaAccessDeniedError);
  });

  it('does not stand in the way when the gate is down', async () => {
    vi.stubEnv('LETTER_IRL_BETA_GATE_ENABLED', 'false');
    const { LetterIrlServer } = await import('../../../src/server.js');
    const server = new LetterIrlServer();

    // Now the ordinary error surfaces, which also confirms the check is not
    // swallowing anything when it passes.
    await expect(
      server.execute({ toolName: 'no_such_tool', userId: REFUSED, input: {} } as never)
    ).rejects.toThrow(/not registered/);
  });
});
