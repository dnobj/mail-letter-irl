import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { BETA_ACCESS_MESSAGE } from '../../../src/auth/betaAccess.js';

/**
 * The three REST handlers must USE the status restAuth gives them (#179).
 *
 * They each answered a hardcoded `sendJson(res, 401, { error: 'Unauthorized'
 * ... })` for every failure. Making `status` a required field means the
 * compiler finds every caller, but it cannot make a caller READ the field - a
 * handler can keep its literal 401 and still typecheck. So these call the real
 * handlers with a stubbed outcome, which is the only thing that actually
 * catches a regression to a hardcoded status.
 *
 * The same reasoning covers scopes (audit A-03): the compiler makes each
 * handler pass some scopes, and only these tests check they are its route's.
 *
 * Separate file from restAuthStatus.test.ts because vi.mock is hoisted to the
 * top of whatever file it appears in: mocking restAuth here and testing the
 * real restAuth there cannot coexist.
 */

vi.mock('../../../src/api/middleware/restAuth.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/api/middleware/restAuth.js')>();
  // The failure writer and restAuthErrorLabel stay REAL - they are part of
  // what is under test.
  return { ...actual, authenticateRestRequest: vi.fn() };
});

vi.mock('../../../src/api/middleware/rateLimit.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/api/middleware/rateLimit.js')>()),
  rateLimitAccount: vi.fn()
}));

import { authenticateRestRequest } from '../../../src/api/middleware/restAuth.js';
import { rateLimitAccount } from '../../../src/api/middleware/rateLimit.js';

const request = (method = 'GET') => ({ headers: {}, method }) as unknown as IncomingMessage;

function fakeResponse() {
  const captured = { status: 0, body: '', headers: {} as Record<string, unknown> };
  const res = {
    statusCode: 0,
    setHeader: (name: string, value: unknown) => {
      captured.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      captured.status = (this as unknown as { statusCode: number }).statusCode;
      captured.body = chunk ?? '';
    }
  };
  return { captured, res: res as unknown as ServerResponse };
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
) => Promise<boolean>;

const HANDLERS: ReadonlyArray<readonly [string, string, () => Promise<Handler>]> = [
  [
    'credits',
    '/api/credits',
    async () => (await import('../../../src/api/creditApiHandler.js')).handleCreditApiRequest
  ],
  [
    'letters',
    '/api/letters',
    async () => (await import('../../../src/api/letterApiHandler.js')).handleLetterApiRequest
  ],
  [
    'return-address',
    '/api/return-address',
    async () =>
      (await import('../../../src/api/returnAddressApiHandler.js')).handleReturnAddressApiRequest
  ]
];

describe('every REST handler forwards the status it was given', () => {
  it.each(HANDLERS)('%s answers 403 for a refused beta account', async (_name, path, load) => {
    vi.mocked(authenticateRestRequest).mockResolvedValue({
      ok: false,
      reason: 'forbidden',
      status: 403,
      message: BETA_ACCESS_MESSAGE
    });

    const { captured, res } = fakeResponse();
    await (await load())(request(), res, path);

    // 401 here would send the caller back to Auth0 to succeed and be refused
    // again, forever.
    expect(captured.status, `${path} hardcoded its status`).toBe(403);
    const body = JSON.parse(captured.body);
    expect(body.error).toBe('Forbidden');
    expect(body.message).toBe(BETA_ACCESS_MESSAGE);
  });

  it.each(HANDLERS)('%s answers 503 when the server cannot validate', async (_name, path, load) => {
    vi.mocked(authenticateRestRequest).mockResolvedValue({
      ok: false,
      reason: 'not_configured',
      status: 503,
      message: 'Authentication is not configured on this server'
    });

    const { captured, res } = fakeResponse();
    await (await load())(request(), res, path);

    expect(captured.status).toBe(503);
    expect(JSON.parse(captured.body).error).toBe('Service Unavailable');
  });

  it.each(HANDLERS)('%s still answers 401 for a rejected token', async (_name, path, load) => {
    // The contrast: the ordinary failure is unchanged.
    vi.mocked(authenticateRestRequest).mockResolvedValue({
      ok: false,
      reason: 'rejected',
      status: 401,
      message: 'The bearer token was rejected'
    });

    const { captured, res } = fakeResponse();
    await (await load())(request(), res, path);

    expect(captured.status).toBe(401);
    expect(JSON.parse(captured.body).error).toBe('Unauthorized');
  });

  it.each(HANDLERS)('%s sends the challenge with a missing-scope refusal', async (_name, path, load) => {
    vi.mocked(authenticateRestRequest).mockResolvedValue({
      ok: false,
      reason: 'insufficient_scope',
      status: 403,
      message: 'The bearer token does not grant this action',
      challenge: 'Bearer realm="Letter IRL", scope="mail:send", error="insufficient_scope"'
    });

    const { captured, res } = fakeResponse();
    await (await load())(request(), res, path);

    expect(captured.status).toBe(403);
    // Without it an OAuth client cannot learn which scope to ask for.
    expect(String(captured.headers['www-authenticate'])).toContain('insufficient_scope');
  });
});

const ROUTES = [
  ['credits', 'GET', '/api/credits/balance', ['mail:read']],
  ['credits', 'POST', '/api/promo/redeem', ['mail:send']],
  ['letters', 'GET', '/api/letters/ltr_1', ['mail:read']],
  ['return-address', 'GET', '/api/return-address', ['mail:read']],
  ['return-address', 'POST', '/api/return-address', ['mail:draft']],
  ['return-address', 'DELETE', '/api/return-address', ['mail:draft']]
] as const;

describe('every REST handler asks for the scope its route requires', () => {
  it.each(ROUTES)('%s: %s %s', async (name, method, path, scopes) => {
    vi.mocked(authenticateRestRequest).mockResolvedValue({
      ok: false,
      reason: 'rejected',
      status: 401,
      message: 'The bearer token was rejected'
    });
    const entry = HANDLERS.find(([handlerName]) => handlerName === name);
    if (!entry) throw new Error(`no handler named ${name}`);

    const req = request(method);
    await (await entry[2]())(req, fakeResponse().res, path);

    // Red if a handler stops passing its route's scopes.
    expect(authenticateRestRequest).toHaveBeenLastCalledWith(req, scopes);
  });
});

const WORKING_ROUTES = [
  ['credits', '/api/credits/balance'],
  ['letters', '/api/letters'],
  ['return-address', '/api/return-address']
] as const;

describe('every REST handler bounds the account before doing any work', () => {
  it.each(WORKING_ROUTES)('%s stops at the account limit on %s', async (name, path) => {
    vi.mocked(authenticateRestRequest).mockResolvedValue({
      ok: true,
      user: { userId: 'auth0|user-1', scopes: ['mail:read', 'mail:draft', 'mail:send'] }
    });
    vi.mocked(rateLimitAccount).mockResolvedValue(true);
    const entry = HANDLERS.find(([handlerName]) => handlerName === name);
    if (!entry) throw new Error(`no handler named ${name}`);

    const req = request('GET');
    const { captured, res } = fakeResponse();
    expect(await (await entry[2]())(req, res, path)).toBe(true);

    expect(rateLimitAccount).toHaveBeenCalledWith(req, res, 'auth0|user-1', 'api_account');
    // The stubbed limiter writes nothing, so any response here means the
    // route's work ran before the limit was checked.
    expect(captured.status).toBe(0);
  });
});
