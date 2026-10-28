/**
 * The address request routes' wiring in the server (#604, #606 review round 1).
 *
 * Source-shape assertions, as rateLimitCoverage.test.ts makes for the other
 * routes: the dispatch is a sequence of `if` statements in one request
 * handler, and there is nothing to enumerate at runtime without booting the
 * server. What could break is the wiring: the routes moved behind a sign-in,
 * their preflight left to a later branch, or another route shadowing them.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { RATE_LIMITS } from '../../../src/api/middleware/rateLimit.js';

const httpServer = fs.readFileSync(path.resolve(__dirname, '../../../src/mcp/httpServer.ts'), 'utf-8');
const START = 'if (url.pathname.startsWith(ADDRESS_REQUEST_API_PREFIX)) {';
const NEXT = "url.pathname.startsWith('/api/public/promo/validate/')";

describe('the address request routes in the server (#604)', () => {
  it('are dispatched before the promo and gift routes, and before every signed-in route', () => {
    const at = httpServer.indexOf(START);
    expect(at).toBeGreaterThan(-1);
    for (const later of [NEXT, "url.pathname.startsWith('/api/public/gift/')", 'handleReturnAddressApiRequest(req, res', 'handleSendConfirmationApiRequest(req, res']) {
      const where = httpServer.indexOf(later);
      expect(where, later).toBeGreaterThan(at);
    }
  });

  it('answer their own preflight, then hand every request to the routes, with no sign-in', () => {
    const code = httpServer.slice(httpServer.indexOf(START), httpServer.indexOf(NEXT));
    expect(code).toContain('const origin = resolveCorsOrigin(req.headers.origin);');
    expect(code).toContain("if (req.method === 'OPTIONS') {");
    expect(code).toContain('respondToCorsPreflight(res, origin);');
    expect(code).toContain('await handleAddressRequestApiRequest(req, res, url.pathname, origin);');
    expect(code).not.toMatch(/authenticat|requireAuth|bearer/i);
  });

  it('have a rate limit of their own, per address', () => {
    expect(RATE_LIMITS.address_public).toEqual({ windowMs: 60_000, maxRequests: 20 });
  });
});
