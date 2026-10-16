import type { IncomingMessage, ServerResponse } from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * rateLimitAccount keys its limit on the account, not the address.
 *
 * The website's proxy sends every dashboard user from one address, so an
 * account limit that fell back to the address would be one bucket of sixty a
 * minute shared by all of them. Every handler test stubs rateLimitAccount;
 * this runs the real one, with only the tier lookup (a database read) stubbed.
 */

vi.mock('../../../src/services/tierService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/tierService.js')>()),
  getCachedUserTier: vi.fn().mockResolvedValue('standard')
}));

import {
  clearRateLimitState,
  rateLimitAccount,
  RATE_LIMITS
} from '../../../src/api/middleware/rateLimit.js';

const PROXY_ADDRESS = '203.0.113.10';

function fromAddress(address: string): IncomingMessage {
  return {
    headers: { 'x-forwarded-for': address },
    socket: { remoteAddress: address }
  } as unknown as IncomingMessage;
}

function response() {
  return { statusCode: 200, setHeader: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
}

async function refusals(userId: string, address: string, requests: number): Promise<number> {
  let refused = 0;
  for (let i = 0; i < requests; i += 1) {
    if (await rateLimitAccount(fromAddress(address), response(), userId, 'api_account')) {
      refused += 1;
    }
  }
  return refused;
}

describe('rateLimitAccount', () => {
  beforeEach(() => clearRateLimitState());

  it('gives two accounts behind one address separate budgets', async () => {
    const limit = RATE_LIMITS.api_account.maxRequests;
    expect(await refusals('auth0|first', PROXY_ADDRESS, limit)).toBe(0);
    expect(await refusals('auth0|first', PROXY_ADDRESS, 1)).toBe(1);

    // Red if the limit keys on the address: this account would be refused too.
    expect(await refusals('auth0|second', PROXY_ADDRESS, 1)).toBe(0);
  });

  it('holds one account to one budget across addresses', async () => {
    const limit = RATE_LIMITS.api_account.maxRequests;
    expect(await refusals('auth0|roaming', '198.51.100.1', limit)).toBe(0);

    // Red if the limit keys on the address: a new address would reset it.
    expect(await refusals('auth0|roaming', '198.51.100.2', 1)).toBe(1);
  });

  it('answers a refusal with 429', async () => {
    await refusals('auth0|busy', PROXY_ADDRESS, RATE_LIMITS.api_account.maxRequests);
    const res = response();

    expect(await rateLimitAccount(fromAddress(PROXY_ADDRESS), res, 'auth0|busy', 'api_account')).toBe(true);
    expect(res.statusCode).toBe(429);
  });
});
