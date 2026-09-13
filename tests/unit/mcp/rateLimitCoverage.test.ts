/**
 * Which routes are rate limited, and on what.
 *
 * The 2026-09-13 security review found three gaps that no test could have
 * caught, because every existing case exercised the limiter itself rather
 * than its wiring:
 *
 *  1. The MCP limiter runs before authentication, so `req.auth` was never
 *     set and every tool call was keyed on the source address. Every ChatGPT
 *     user arrives from OpenAI's shared egress, so customers shared one
 *     bucket and the tier multipliers were unreachable code.
 *  2. `POST /mcp/sse/messages` carried no limiter at all, so one SSE stream
 *     bought unlimited tool calls.
 *  3. The credit-API prefix test named `/api/credits` while the handler also
 *     owns `/api/promo/*` and `/api/users/me`, so promo codes could be
 *     guessed at line rate on the authenticated route while the
 *     unauthenticated twin was carefully limited.
 *
 * These are source-shape assertions on purpose. The wiring is a sequence of
 * `if` statements in one request handler; there is nothing to enumerate at
 * runtime without booting the server, and the thing that broke was the
 * wiring, not the algorithm.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { RATE_LIMITS } from '../../../src/api/middleware/rateLimit.js';
import { TIER_RATE_MULTIPLIERS } from '../../../src/services/tierService.js';

function read(relative: string): string {
  return fs.readFileSync(path.resolve(__dirname, '../../../', relative), 'utf-8');
}

const httpServer = read('src/mcp/httpServer.ts');
const creditHandler = read('src/api/creditApiHandler.ts');

describe('the MCP limits', () => {
  it('bounds the account, not only the address it arrived from', () => {
    expect(RATE_LIMITS.mcp_account).toBeDefined();
    expect(RATE_LIMITS.mcp_account.maxRequests).toBe(60);
    expect(RATE_LIMITS.mcp_account.windowMs).toBe(60_000);
  });

  it('leaves the pre-authentication address limit far above one customer', () => {
    // ChatGPT's egress is shared, so this one is a cost gate on admitting a
    // request, not a product limit. It must not be the binding constraint on
    // a handful of concurrent customers.
    expect(RATE_LIMITS.mcp.maxRequests).toBeGreaterThanOrEqual(
      RATE_LIMITS.mcp_account.maxRequests * 5
    );
  });

  it('gives the trusted tier the same headroom on both', () => {
    expect(TIER_RATE_MULTIPLIERS.trusted.mcp_account).toBe(
      TIER_RATE_MULTIPLIERS.trusted.mcp
    );
  });

  it('checks the account limit on both transports', () => {
    // Streamable HTTP, after authenticateRequest returns a subject.
    expect(httpServer).toMatch(
      /\(req as any\)\.auth = authInfo;\s*\n\s*if \(await rateLimitMiddlewareWithTier\(req, res, 'mcp_account'\)\)/
    );
    // Legacy SSE, after the session lookup supplies the subject.
    expect(httpServer).toMatch(
      /\(req as any\)\.auth = session\.authInfo[\s\S]{0,600}?rateLimitMiddlewareWithTier\(req, res, 'mcp_account'\)/
    );
  });

  it('sets the subject before the account limit runs, or it would key on the address again', () => {
    const authAssignment = httpServer.indexOf('(req as any).auth = authInfo;');
    const accountLimit = httpServer.indexOf(
      "rateLimitMiddlewareWithTier(req, res, 'mcp_account')",
      authAssignment
    );
    expect(authAssignment).toBeGreaterThan(-1);
    expect(accountLimit).toBeGreaterThan(authAssignment);
  });
});

describe('the credit API prefixes', () => {
  /** Every path prefix the handler answers on, scraped from its own guard. */
  const handlerPrefixes = Array.from(
    creditHandler.matchAll(/pathname\.startsWith\('([^']+)'\)/g)
  )
    .map(match => match[1])
    .filter(prefix => prefix.startsWith('/api/'));

  const limiterPrefixes = Array.from(
    (httpServer.match(/const CREDIT_API_PREFIXES = \[([^\]]+)\]/) ?? ['', ''])[1].matchAll(
      /'([^']+)'/g
    )
  ).map(match => match[1]);

  it('finds the prefixes in both files', () => {
    // Guards the comparison below against passing vacuously if either shape
    // changes.
    expect(handlerPrefixes.length).toBeGreaterThan(0);
    expect(limiterPrefixes.length).toBeGreaterThan(0);
  });

  it('limits every path the handler owns', () => {
    for (const prefix of handlerPrefixes) {
      expect(
        limiterPrefixes.some(limited => prefix.startsWith(limited)),
        `${prefix} is answered by the credit handler but no limiter prefix covers it`
      ).toBe(true);
    }
  });

  it('gives the authenticated promo routes the tight limit its public twin has', () => {
    expect(RATE_LIMITS.promo_authenticated.maxRequests).toBe(
      RATE_LIMITS.promo_public.maxRequests
    );
    expect(httpServer).toMatch(
      /url\.pathname\.startsWith\('\/api\/promo'\)[\s\S]{0,200}?'promo_authenticated'/
    );
  });
});
