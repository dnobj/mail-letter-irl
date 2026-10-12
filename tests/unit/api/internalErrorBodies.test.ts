import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { Readable } from 'node:stream';

/**
 * A REST request that fails inside answers a fixed sentence and a reference, never the error's own text (#682). The
 * database's message can name a table, a constraint or a value; the log gets the class and the same reference.
 */

vi.mock('../../../src/api/middleware/restAuth.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/api/middleware/restAuth.js')>()),
  authenticateRestRequest: vi.fn()
}));
vi.mock('../../../src/api/middleware/rateLimit.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/api/middleware/rateLimit.js')>()),
  rateLimitAccount: vi.fn()
}));
vi.mock('../../../src/db/index.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/db/index.js')>()),
  query: vi.fn()
}));

import { authenticateRestRequest } from '../../../src/api/middleware/restAuth.js';
import { rateLimitAccount } from '../../../src/api/middleware/rateLimit.js';
import { query } from '../../../src/db/index.js';

const SECRET = 'relation "users" column secret_value_42 violates check';

function fakeResponse() {
  const captured = { status: 0, body: '' };
  const res = {
    statusCode: 0,
    setHeader: () => {},
    end(chunk?: string) {
      captured.status = (this as unknown as { statusCode: number }).statusCode;
      captured.body = chunk ?? '';
    }
  };
  return { captured, res: res as unknown as ServerResponse };
}

const HANDLERS = [
  [
    'letters',
    '/api/letters/ltr_1',
    'letters.api_failed',
    async () => (await import('../../../src/api/letterApiHandler.js')).handleLetterApiRequest
  ],
  [
    'return-address',
    '/api/return-address',
    'address.api_failed',
    async () => (await import('../../../src/api/returnAddressApiHandler.js')).handleReturnAddressApiRequest
  ]
] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a REST 500 says a fixed sentence and a reference (#682)', () => {
  it.each(HANDLERS)('%s', async (_name, path, event, load) => {
    vi.mocked(authenticateRestRequest).mockResolvedValue({
      ok: true,
      user: { userId: 'auth0|user-1', scopes: ['mail:read', 'mail:draft', 'mail:send'] }
    } as Awaited<ReturnType<typeof authenticateRestRequest>>);
    vi.mocked(rateLimitAccount).mockResolvedValue(false);
    vi.mocked(query).mockRejectedValue(Object.assign(new Error(SECRET), { code: '23514' }));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { captured, res } = fakeResponse();
    const req = { headers: { host: 'api.test' }, method: 'GET', url: path } as unknown as IncomingMessage;
    expect(await (await load())(req, res, path)).toBe(true);

    expect(captured.status).toBe(500);
    expect(captured.body).not.toContain('secret_value_42');
    const body = JSON.parse(captured.body);
    expect(body.error).toBe('Internal server error');
    expect(body.message).toMatch(/^Unable to complete /);
    expect(body.reference).toMatch(/^[0-9a-f-]{36}$/);

    // The log has the class and the same reference, and not the text either.
    const line = logged.mock.calls.flat().map(String).find(text => text.includes(`"event":"${event}"`));
    expect(line, 'no diagnostic line').toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ errorClass: '23514', reference: body.reference });
    expect(logged.mock.calls.flat().map(String).join('\n')).not.toContain('secret_value_42');
  });
});

describe("a caller's own mistake answers 4xx, not the fixed 500 (#682 review)", () => {
  const signedIn = () => {
    vi.mocked(authenticateRestRequest).mockResolvedValue({
      ok: true,
      user: { userId: 'auth0|user-1', scopes: ['mail:read', 'mail:draft', 'mail:send'] }
    } as Awaited<ReturnType<typeof authenticateRestRequest>>);
    vi.mocked(rateLimitAccount).mockResolvedValue(false);
    vi.mocked(query).mockReset();
    vi.mocked(query).mockResolvedValue({ rows: [{ count: '0' }], rowCount: 0 } as never);
  };
  const posting = (body: string) =>
    Object.assign(Readable.from([Buffer.from(body)]), {
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/api/return-address'
    }) as unknown as IncomingMessage;
  const returnAddress = async () => (await import('../../../src/api/returnAddressApiHandler.js')).handleReturnAddressApiRequest;
  const letters = async () => (await import('../../../src/api/letterApiHandler.js')).handleLetterApiRequest;

  it('a body that is not JSON is 400', async () => {
    signedIn();
    const { captured, res } = fakeResponse();
    await (await returnAddress())(posting('{not json'), res, '/api/return-address');
    expect(captured.status).toBe(400);
    expect(JSON.parse(captured.body).message).toBe('The request body is not valid JSON');
  });

  it('a body over the limit is 413', async () => {
    signedIn();
    const { captured, res } = fakeResponse();
    await (await returnAddress())(posting(`{"name":"${'x'.repeat(300_000)}"}`), res, '/api/return-address');
    expect(captured.status).toBe(413);
  });

  it('a body that arrives too slowly is 408', async () => {
    signedIn();
    const { RequestBodyTimeoutError } = await import('../../../src/utils/requestBody.js');
    const slow = Object.assign(new Readable({ read() { this.destroy(new RequestBodyTimeoutError()); } }), {
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/api/return-address'
    }) as unknown as IncomingMessage;
    const { captured, res } = fakeResponse();
    await (await returnAddress())(slow, res, '/api/return-address');
    expect(captured.status).toBe(408);
  });

  it.each([['/api/letters/%E0%A4%A'], ['/api/letters/%zz/cancel']])('a malformed letter id is 400: %s', async path => {
    signedIn();
    const { captured, res } = fakeResponse();
    const method = path.endsWith('/cancel') ? 'POST' : 'GET';
    await (await letters())({ headers: {}, method, url: path } as unknown as IncomingMessage, res, path);
    expect(captured.status).toBe(400);
    expect(JSON.parse(captured.body).message).toBe('The letter id is malformed');
    expect(query).not.toHaveBeenCalled();
  });

  it('a limit that is not a number is the default, whatever the Host header', async () => {
    signedIn();
    const { captured, res } = fakeResponse();
    const req = { headers: { host: 'bad host:x:y' }, method: 'GET', url: '/api/letters?limit=abc&offset=zz' } as unknown as IncomingMessage;
    await (await letters())(req, res, '/api/letters');
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body)).toMatchObject({ limit: 20, offset: 0 });
    const params = vi.mocked(query).mock.calls.flatMap(call => (call[1] ?? []) as unknown[]);
    expect(params).toContain(20);
    expect(params.some(value => typeof value === 'number' && Number.isNaN(value))).toBe(false);
  });
});
