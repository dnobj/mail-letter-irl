import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The checkout route asks for the scope its MCP twin requires and bounds the
 * account (audit A-03), in the same order as the REST handlers: the route's
 * scope at authentication, then the per-account limit once the account is
 * known. rateLimitCoverage.test.ts pins the order in the source; these pin the
 * arguments.
 */

const { authenticateHttpRequest, createPackCheckout, rateLimitAccount } = vi.hoisted(() => ({
  authenticateHttpRequest: vi.fn(),
  createPackCheckout: vi.fn(),
  rateLimitAccount: vi.fn()
}));

vi.mock('../../../src/db/index.js', () => ({ query: vi.fn() }));
vi.mock('../../../src/api/middleware/auth.js', () => ({ authenticateHttpRequest }));
vi.mock('../../../src/services/stripeService.js', () => ({ verifyWebhookSignature: vi.fn() }));
vi.mock('../../../src/services/commerceService.js', () => ({
  createPackCheckout,
  processStripeWebhookEvent: vi.fn()
}));
vi.mock('../../../src/api/middleware/rateLimit.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/api/middleware/rateLimit.js')>()),
  rateLimitAccount
}));

import { handleCreateCheckoutSession } from '../../../src/api/dashboardApiHandler.js';

function checkoutRequest() {
  return {
    headers: {},
    body: {
      productId: 'credit-pack-4',
      successUrl: 'https://example.test/ok',
      cancelUrl: 'https://example.test/no'
    }
  };
}

function stubResponse() {
  return { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
}

describe('checkout authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimitAccount.mockResolvedValue(false);
  });

  it('asks for mail:send, the scope create_pack_checkout requires', async () => {
    authenticateHttpRequest.mockResolvedValue(null);
    const req = checkoutRequest();
    const res = stubResponse();

    await handleCreateCheckoutSession(req as never, res as never);

    // Red if the route stops passing its scopes, or passes a narrower one.
    expect(authenticateHttpRequest).toHaveBeenCalledWith(req, res, ['mail:send']);
    expect(createPackCheckout).not.toHaveBeenCalled();
  });

  it('bounds the account before creating a checkout session', async () => {
    authenticateHttpRequest.mockResolvedValue({
      userId: 'auth0|user-1',
      email: 'user@example.invalid'
    });
    rateLimitAccount.mockResolvedValue(true);
    const req = checkoutRequest();
    const res = stubResponse();

    await handleCreateCheckoutSession(req as never, res as never);

    expect(rateLimitAccount).toHaveBeenCalledWith(req, res, 'auth0|user-1', 'checkout_account');
    expect(createPackCheckout).not.toHaveBeenCalled();
  });
});
