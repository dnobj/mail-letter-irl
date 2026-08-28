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
 * Separate file from restAuthStatus.test.ts because vi.mock is hoisted to the
 * top of whatever file it appears in: mocking restAuth here and testing the
 * real restAuth there cannot coexist.
 */

vi.mock('../../../src/api/middleware/restAuth.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/api/middleware/restAuth.js')>();
  // restAuthErrorLabel stays REAL - it is part of what is under test.
  return { ...actual, authenticateRestRequest: vi.fn() };
});

import { authenticateRestRequest } from '../../../src/api/middleware/restAuth.js';

const request = () => ({ headers: {} }) as unknown as IncomingMessage;

function fakeResponse() {
  const captured = { status: 0, body: '' };
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
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
});
