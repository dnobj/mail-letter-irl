import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two money-adjacent guards (#683): a pack checkout returns only to the website's letter packs page, and the Stripe
 * webhook refuses an event from the other Stripe mode.
 */

const { authenticateHttpRequest, createPackCheckout, rateLimitAccount, verifyWebhookSignature, processStripeWebhookEvent } =
  vi.hoisted(() => ({
    authenticateHttpRequest: vi.fn(),
    createPackCheckout: vi.fn(),
    rateLimitAccount: vi.fn(),
    verifyWebhookSignature: vi.fn(),
    processStripeWebhookEvent: vi.fn()
  }));

vi.mock('../../../src/db/index.js', () => ({ query: vi.fn() }));
vi.mock('../../../src/api/middleware/auth.js', () => ({ authenticateHttpRequest }));
vi.mock('../../../src/services/stripeService.js', () => ({ verifyWebhookSignature }));
vi.mock('../../../src/services/commerceService.js', () => ({ createPackCheckout, processStripeWebhookEvent }));
vi.mock('../../../src/api/middleware/rateLimit.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/api/middleware/rateLimit.js')>()),
  rateLimitAccount
}));

import { handleCreateCheckoutSession, handleStripeWebhook } from '../../../src/api/dashboardApiHandler.js';
import { isLetterPacksReturnUrl } from '../../../src/config/sendConfirmation.js';

function stubResponse() {
  return { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
}
const bodyOf = (res: ReturnType<typeof stubResponse>) => String(res.end.mock.calls[0]?.[0] ?? '');

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitAccount.mockResolvedValue(false);
  authenticateHttpRequest.mockResolvedValue({ userId: 'auth0|user-1', email: 'user@example.invalid' });
  createPackCheckout.mockResolvedValue({ success: true, orderId: 'o', sessionId: 's', sessionUrl: 'https://checkout.test/s' });
  processStripeWebhookEvent.mockResolvedValue({ duplicate: false });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a pack checkout returns only to the website's letter packs page (#683)", () => {
  const SITE = { LETTER_IRL_WEBSITE_BASE_URL: 'https://letterirl.test' };

  it.each([
    ['https://letterirl.test/dashboard/letter-packs?purchase=success'],
    ['https://letterirl.test/dashboard/letter-packs?purchase=cancelled&returnTo=%2Fconfirm%2Fd1'],
    ['https://www.letterirl.test/dashboard/letter-packs'],
    ['https://letterirl.test/dashboard/letter-packs#top']
  ])('takes %s', url => {
    expect(isLetterPacksReturnUrl(url, SITE)).toBe(true);
  });

  it.each([
    ['https://elsewhere.test/dashboard/letter-packs'],
    ['https://letterirl.test.elsewhere.test/dashboard/letter-packs'],
    ['https://evil-letterirl.test/dashboard/letter-packs'],
    ['http://letterirl.test/dashboard/letter-packs'],
    ['https://letterirl.test:8443/dashboard/letter-packs'],
    ['https://letterirl.test/dashboard/letter-packs/'],
    ['https://letterirl.test/dashboard'],
    ['https://letterirl.test/confirm/d1'],
    ['https://user:pass@letterirl.test/dashboard/letter-packs'],
    ['https://api.letterirl.test/dashboard/letter-packs'],
    ['javascript:alert(1)'],
    ['/dashboard/letter-packs'],
    [''],
    [42],
    [`https://letterirl.test/dashboard/letter-packs?x=${'a'.repeat(2100)}`]
  ])('refuses %s', url => {
    expect(isLetterPacksReturnUrl(url, SITE)).toBe(false);
  });

  it('takes the bare host as the twin of a www website', () => {
    expect(isLetterPacksReturnUrl('https://letterirl.test/dashboard/letter-packs', { LETTER_IRL_WEBSITE_BASE_URL: 'https://www.letterirl.test' })).toBe(true);
  });

  it('answers 400 and starts no checkout for a return address elsewhere, in either field', async () => {
    vi.stubEnv('LETTER_IRL_WEBSITE_BASE_URL', 'https://letterirl.test');
    const good = 'https://letterirl.test/dashboard/letter-packs?purchase=success';
    for (const [successUrl, cancelUrl] of [
      ['https://elsewhere.test/dashboard/letter-packs', good],
      [good, 'https://elsewhere.test/dashboard/letter-packs']
    ]) {
      const res = stubResponse();
      await handleCreateCheckoutSession({ headers: {}, body: { productId: 'credit-pack-4', successUrl, cancelUrl } } as never, res as never);
      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toContain("letter packs page");
    }
    expect(createPackCheckout).not.toHaveBeenCalled();
  });

  it("starts the checkout for the website's own addresses", async () => {
    vi.stubEnv('LETTER_IRL_WEBSITE_BASE_URL', 'https://letterirl.test');
    const res = stubResponse();
    await handleCreateCheckoutSession(
      {
        headers: {},
        body: {
          productId: 'credit-pack-4',
          successUrl: 'https://letterirl.test/dashboard/letter-packs?purchase=success',
          cancelUrl: 'https://letterirl.test/dashboard/letter-packs?purchase=cancelled'
        }
      } as never,
      res as never
    );
    expect(createPackCheckout).toHaveBeenCalledTimes(1);
    expect(res.statusCode).not.toBe(400);
  });
});

describe('the Stripe webhook takes only events of this deployment\'s mode (#683)', () => {
  const deliver = async (livemode: unknown) => {
    verifyWebhookSignature.mockReturnValue({ id: 'evt_1', type: 'checkout.session.completed', livemode, data: { object: {} } });
    const res = stubResponse();
    await handleStripeWebhook({ headers: { 'stripe-signature': 'sig' }, body: 'body' } as never, res as never);
    return res;
  };

  it('outside production: a test event is processed, a live one refused', async () => {
    expect((await deliver(false)).statusCode).not.toBe(400);
    expect(processStripeWebhookEvent).toHaveBeenCalledTimes(1);
    processStripeWebhookEvent.mockClear();
    const refused = await deliver(true);
    expect(refused.statusCode).toBe(400);
    expect(processStripeWebhookEvent).not.toHaveBeenCalled();
  });

  it('in production: a live event is processed, a test one refused', async () => {
    vi.stubEnv('LETTER_IRL_DEPLOYMENT_ENVIRONMENT', 'production');
    vi.stubEnv('NODE_ENV', 'production');
    expect((await deliver(true)).statusCode).not.toBe(400);
    expect(processStripeWebhookEvent).toHaveBeenCalledTimes(1);
    processStripeWebhookEvent.mockClear();
    const refused = await deliver(false);
    expect(refused.statusCode).toBe(400);
    expect(processStripeWebhookEvent).not.toHaveBeenCalled();
  });

  it('refuses an event that does not say its mode', async () => {
    const refused = await deliver(undefined);
    expect(refused.statusCode).toBe(400);
    expect(processStripeWebhookEvent).not.toHaveBeenCalled();
  });
});
