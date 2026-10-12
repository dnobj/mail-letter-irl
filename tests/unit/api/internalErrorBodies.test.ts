import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

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
