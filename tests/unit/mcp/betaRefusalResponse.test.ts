import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BetaAccessDeniedError, BETA_ACCESS_MESSAGE } from '../../../src/auth/betaAccess.js';

/**
 * A beta refusal must be 403 with NO challenge (#179).
 *
 * Every failure reaching authenticateRequest is answered with 401 and a
 * WWW-Authenticate header built from the error's own message. For a bad token
 * that is right. For a refused beta account it is a trap with two halves:
 *
 *   - The challenge tells an MCP client to authorize again. ChatGPT sends the
 *     user back through Auth0, they sign in successfully, and the next request
 *     is refused identically. The loop has no exit.
 *   - The raw message is copied into the challenge, the JSON-RPC body AND
 *     _meta["mcp/www_authenticate"], so error_description becomes a leak
 *     surface nobody has audited - the same class as the
 *     users.sends_blocked_reason label in #278.
 *
 * These tests exercise authenticateRequest rather than the writer alone,
 * because the property that matters is that the branch is REACHED before the
 * challenge is built. #278 round 14 caught a test that passed while the branch
 * it guarded had been made unreachable.
 */

vi.mock('../../../src/auth/tokenValidator.js', () => ({
  validateAuthorizationHeader: vi.fn(),
  validateJWTToken: vi.fn(),
  parseTokenScopes: vi.fn(() => []),
  requireScopes: vi.fn()
}));

import { validateAuthorizationHeader } from '../../../src/auth/tokenValidator.js';
import { authenticateRequest, writeBetaRefusal } from '../../../src/mcp/httpServer.js';

/** Minimal ServerResponse capturing what was written. */
function fakeResponse() {
  const captured = {
    status: 0 as number,
    headers: {} as Record<string, string>,
    body: '' as string
  };
  return {
    captured,
    res: {
      writeHead(status: number, headers?: Record<string, string>) {
        captured.status = status;
        Object.assign(captured.headers, headers ?? {});
        return this;
      },
      end(chunk?: string) {
        captured.body = chunk ?? '';
        return this;
      },
      setHeader(name: string, value: string) {
        captured.headers[name] = value;
      }
    } as unknown as import('node:http').ServerResponse
  };
}

const request = (authorization?: string) =>
  ({ headers: authorization ? { authorization } : {} }) as import('node:http').IncomingMessage;

describe('writeBetaRefusal', () => {
  it('answers 403 and sends NO WWW-Authenticate header', () => {
    const { captured, res } = fakeResponse();
    writeBetaRefusal(res);

    expect(captured.status).toBe(403);
    // The assertion this file exists for. A challenge here restarts the loop.
    expect(Object.keys(captured.headers).map(h => h.toLowerCase())).not.toContain(
      'www-authenticate'
    );
  });

  it('carries the fixed message and nothing request-shaped', () => {
    const { captured, res } = fakeResponse();
    writeBetaRefusal(res);

    const body = JSON.parse(captured.body);
    expect(body.error.message).toBe(BETA_ACCESS_MESSAGE);
    // _meta is where the challenge is echoed on the 401 path. It must not
    // appear here, or a client will read a challenge out of the body instead.
    expect(JSON.stringify(body)).not.toContain('www_authenticate');
    expect(body.jsonrpc).toBe('2.0');
  });
});

describe('authenticateRequest reaches the branch', () => {
  beforeEach(() => {
    vi.mocked(validateAuthorizationHeader).mockReset();
  });

  it('refuses with 403 and no challenge when the gate denies', async () => {
    vi.mocked(validateAuthorizationHeader).mockRejectedValue(new BetaAccessDeniedError());

    const { captured, res } = fakeResponse();
    const result = await authenticateRequest(request('Bearer token'), res, 'https://api.example');

    expect(result).toBeNull();
    expect(captured.status).toBe(403);
    expect(Object.keys(captured.headers).map(h => h.toLowerCase())).not.toContain(
      'www-authenticate'
    );
    expect(JSON.parse(captured.body).error.message).toBe(BETA_ACCESS_MESSAGE);
  });

  it('still answers 401 WITH a challenge for an ordinary auth failure', () => {
    // The contrast. If the beta branch ever widened to catch everything, real
    // authentication failures would stop telling clients to authenticate - so
    // this pins that the 401 path is untouched.
    return (async () => {
      vi.mocked(validateAuthorizationHeader).mockRejectedValue(new Error('Missing Authorization header'));

      const { captured, res } = fakeResponse();
      const result = await authenticateRequest(request(), res, 'https://api.example');

      expect(result).toBeNull();
      expect(captured.status).toBe(401);
      expect(Object.keys(captured.headers).map(h => h.toLowerCase())).toContain(
        'www-authenticate'
      );
    })();
  });

  it('does not leak the refusal into the challenge path', async () => {
    // Belt and braces on the ordering: if the beta check ran AFTER
    // buildWwwAuthenticateChallenge, the message would appear in a header.
    vi.mocked(validateAuthorizationHeader).mockRejectedValue(new BetaAccessDeniedError());

    const { captured, res } = fakeResponse();
    await authenticateRequest(request('Bearer token'), res, 'https://api.example');

    expect(JSON.stringify(captured.headers)).not.toContain('invalid_token');
    expect(JSON.stringify(captured.headers)).not.toContain('error_description');
  });
});
