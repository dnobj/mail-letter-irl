import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateAdminRequestBoundary } from '../../../src/api/middleware/adminAuth.js';

function response() {
  return { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      host: '127.0.0.1:8787',
      origin: 'http://127.0.0.1:8787',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'x-letter-irl-admin': 'local-operator',
      'x-csrf-token': 'test-csrf-token',
    },
    ...overrides,
  };
}

describe('local admin browser boundary', () => {
  beforeEach(() => {
    vi.stubEnv('ADMIN_LOCAL_ONLY', 'true');
    vi.stubEnv('ADMIN_ALLOWED_ORIGIN', 'http://127.0.0.1:8787');
    vi.stubEnv('ADMIN_CSRF_TOKEN', 'test-csrf-token');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('accepts a same-origin JSON mutation with custom and CSRF headers', () => {
    expect(validateAdminRequestBoundary(request() as never, response() as never)).toBe(true);
  });

  it.each([
    { origin: 'https://evil.example' },
    { 'sec-fetch-site': 'cross-site' },
    { 'x-csrf-token': 'wrong' },
    { 'x-letter-irl-admin': undefined },
    { 'content-type': 'text/plain' },
  ])('rejects unsafe browser input %#', headers => {
    const res = response();
    const req = request({ headers: { ...(request() as any).headers, ...headers } });
    expect(validateAdminRequestBoundary(req as never, res as never)).toBe(false);
    expect(res.end).toHaveBeenCalled();
  });

  it('rejects proxy forwarding and preflight readback', () => {
    const proxied = request({ headers: { ...(request() as any).headers, 'x-forwarded-for': '127.0.0.1' } });
    expect(validateAdminRequestBoundary(proxied as never, response() as never)).toBe(false);
    expect(validateAdminRequestBoundary(request({ method: 'OPTIONS' }) as never, response() as never)).toBe(false);
  });
});
