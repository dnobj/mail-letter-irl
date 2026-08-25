/**
 * Issue #275. The amount charged and the amount booked both come from the
 * resolved Stripe Price - there is no second copy to drift. What remains to
 * guard at checkout is narrower and sharper:
 *
 *  - an UNPRICEABLE product must refuse WITHOUT creating a session, carrying
 *    WHY (configuration vs transient), because order cleanup keys off that;
 *  - a priced checkout must still charge by price id, under an idempotency
 *    key - the only thing between a client retry and a double charge.
 *
 * The stage-B comparator that used to live here compared the env amount to the
 * Price; once the env amount WAS the Price it compared Stripe to itself and
 * could never fire (#278 review), so it is gone and these tests guard what is
 * real. Refusal tests assert the session was never created: returning an error
 * while still charging would be the worst outcome available.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { priceFixture, stripeMockModule } from '../../mocks/stripe.js';

const stripeMocks = vi.hoisted(() => {
  // vi.hoisted runs before imports, so the fns are built inline here; the
  // vi.mock factory below runs lazily and can use the shared class.
  return {
    sessionCreate: vi.fn(),
    // Wired with the LOUD default rather than a bare vi.fn(): the shared mock
    // installs its unwired-retriever sentinel only when the key is absent, so
    // passing an implementation-less fn defeated it - in the one suite that
    // drives the real retriever and could ever fire it. A vi.fn(impl) returns
    // to this implementation after the global restoreAllMocks in
    // tests/setup.ts, so a case that forgets serveHealthyPrices() fails
    // loudly instead of resolving undefined into a fake outage (#278 r10).
    priceRetrieve: vi.fn(() =>
      Promise.reject(
        Object.assign(new Error('stripePriceVerification: priceRetrieve not wired'), {
          name: 'PriceRetrieverMissingError'
        })
      )
    ),
    refundCreate: vi.fn(),
    refundList: vi.fn()
  };
});

vi.mock('stripe', () => stripeMockModule(stripeMocks));

const {
  createPackCheckoutSession,
  createPaymentRefund,
  findPaymentRefund,
  getPackProductConfig,
  verifyWebhookSignature
} = await import('../../../src/services/stripeService.js');

/**
 * The legacy pack-checkout call shape (deleted from production in #278 round
 * 9 as a dead export - see the note in creditPurchase.test.ts). Reproduced
 * exactly so this case keeps exercising the productId-based entry it was
 * written for.
 */
async function createCheckoutSession(params: {
  userId: string;
  userEmail: string;
  productId: string;
  successUrl: string;
  cancelUrl: string;
}) {
  await ensurePriceCatalog(params.productId);
  const product = getPackProductConfig(params.productId as never);
  if (!product) {
    return { success: false as const, error: `Invalid product ID: ${params.productId}` };
  }
  const orderId = `legacy-${params.userId}-1`;
  return createPackCheckoutSession({
    orderId,
    userEmail: params.userEmail,
    product,
    successUrl: params.successUrl,
    cancelUrl: params.cancelUrl,
    idempotencyKey: `legacy-pack:${orderId}`
  });
}
const {
  resetPriceCatalog,
  ensurePriceCatalog,
  getResolvedPriceForProduct,
  useDefaultPriceRetriever
} = await import('../../../src/services/priceCatalog.js');
const { resetStripeClient } = await import('../../../src/services/stripeClient.js');
const StripeCtor = (await import('stripe')).default as unknown as {
  lastConstructorArgs: unknown[] | null;
};

function packEnv(): void {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_dummy');
  vi.stubEnv('STRIPE_CURRENCY', 'usd');
  vi.stubEnv('STRIPE_PRICE_STARTER', 'price_starter');
  vi.stubEnv('STRIPE_PRICE_REGULAR', 'price_regular');
  vi.stubEnv('STRIPE_PRICE_POWER', 'price_power');
}

const PRICE_AMOUNTS: Record<string, number> = {
  price_starter: 500,
  price_regular: 1000,
  price_power: 9000
};

function serveHealthyPrices(): void {
  stripeMocks.priceRetrieve.mockImplementation(async (priceId: string) =>
    priceFixture({ id: priceId, unit_amount: PRICE_AMOUNTS[priceId] ?? 1000 })
  );
}

function checkout(product: Record<string, unknown>) {
  return createPackCheckoutSession({
    orderId: 'order-1',
    product: product as never,
    successUrl: 'https://example.test/ok',
    cancelUrl: 'https://example.test/no',
    idempotencyKey: 'key-1'
  });
}

describe('checkout pricing guards (#275)', () => {
  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: clearAllMocks wipes CALLS but keeps
    // whatever implementation a previous case installed, so the loud unwired
    // priceRetrieve default was dead from the second test onward - a case
    // that forgot its wiring silently inherited a sibling's healthy prices,
    // the exact fake-green the sentinel exists to prevent (#278 round 11,
    // probed). resetAllMocks restores each vi.fn(impl) to its own impl.
    vi.resetAllMocks();
    resetPriceCatalog();
    // This is the ONE suite that drives the real retriever, against a mocked
    // stripe module, so its per-request bounds are observable at all. Reset
    // deliberately installs a throwing retriever otherwise (#278 review r3).
    useDefaultPriceRetriever();
    resetStripeClient();
    packEnv();
    stripeMocks.sessionCreate.mockResolvedValue({
      id: 'cs_test_1',
      url: 'https://checkout.test/session',
      expires_at: 1900000000
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetPriceCatalog();
  });

  it('charges by price id under the idempotency key when the product is priced', async () => {
    serveHealthyPrices();

    // The legacy adapter is a real chokepoint: it must self-ensure the
    // catalog, because older callers do not.
    const result = await createCheckoutSession({
      userId: 'user-1',
      userEmail: 'person@example.test',
      productId: 'credit-pack-10',
      successUrl: 'https://example.test/ok',
      cancelUrl: 'https://example.test/no'
    });

    expect(result.success).toBe(true);
    const [args, options] = stripeMocks.sessionCreate.mock.calls[0];
    // Still charged from the price id - resolution changes what we refuse,
    // never what Stripe is asked to bill.
    expect(args.line_items).toEqual([{ price: 'price_regular', quantity: 1 }]);
    // Nothing else in the repo pins this. It is the only thing between a
    // client retry and a second charge.
    expect(options).toMatchObject({ idempotencyKey: expect.stringContaining('legacy-pack:') });
  });

  it('refuses an unpriceable product without creating a session', async () => {
    stripeMocks.priceRetrieve.mockImplementation(async (priceId: string) => {
      if (priceId === 'price_regular') return priceFixture({ id: priceId, active: false });
      return priceFixture({ id: priceId, unit_amount: PRICE_AMOUNTS[priceId] });
    });
    await ensurePriceCatalog();

    const result = await checkout({
      productCode: 'credit-pack-10',
      priceId: 'price_regular',
      amountCents: 0,
      currency: 'usd',
      name: 'Regular Pack',
      description: 'Five prepaid letters'
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PACK_AMOUNT_NOT_CONFIGURED');
    // Archived price = a human must change config; cleanup cancels the order.
    expect(result.diagnosticClass).toBe('configuration_error');
    // Must not transact. Charged-but-recorded-failed is the worst outcome.
    expect(stripeMocks.sessionCreate).not.toHaveBeenCalled();
  });

  it('marks a transiently-unpriced product transient, so the order is not cancelled', async () => {
    stripeMocks.priceRetrieve.mockRejectedValue(
      Object.assign(new Error('down'), { type: 'StripeConnectionError' })
    );
    await ensurePriceCatalog();

    const result = await checkout({
      productCode: 'credit-pack-10',
      priceId: 'price_regular',
      amountCents: 0,
      currency: 'usd',
      name: 'Regular Pack',
      description: 'Five prepaid letters'
    });

    expect(result.errorCode).toBe('PACK_AMOUNT_NOT_CONFIGURED');
    // A Stripe blip must never cancel a customer's order (#276 cleanup
    // semantics): the class is the signal order cleanup keys off.
    expect(result.diagnosticClass).toBe('StripeConnectionError');
    expect(stripeMocks.sessionCreate).not.toHaveBeenCalled();
  });

  it('treats an unattempted product as transient, not as a reason to cancel', async () => {
    // No recorded failure at all - the catalog has not attempted this product,
    // or an attempt is in flight. priceCatalog documents that state as
    // "transient by definition", but this branch defaulted it to
    // configuration_error, which is precisely what drives
    // markCheckoutCreationFailure's UPDATE orders SET status='cancelled'. The
    // wrong default sat directly under a header promising a Stripe blip never
    // cancels a customer's order (#278 review round 2).
    //
    // The pack path cannot reach here today - assertConfiguredAmount throws 22
    // lines earlier - so this is the only place the branch is exercised, and
    // without this test the default was free to be wrong.
    const result = await checkout({
      productCode: 'credit-pack-10',
      priceId: 'price_regular',
      amountCents: 0,
      currency: 'usd',
      name: 'Regular Pack',
      description: 'Five prepaid letters'
    });

    expect(result.errorCode).toBe('PACK_AMOUNT_NOT_CONFIGURED');
    expect(result.diagnosticClass).toBe('provider_error');
    expect(stripeMocks.sessionCreate).not.toHaveBeenCalled();
  });

  it('refuses a missing price id as configuration, before any Stripe call', async () => {
    const result = await checkout({
      productCode: 'credit-pack-10',
      priceId: '',
      amountCents: 0,
      currency: 'usd',
      name: 'Regular Pack',
      description: 'Five prepaid letters'
    });

    expect(result.errorCode).toBe('PRICE_ID_NOT_CONFIGURED');
    expect(result.diagnosticClass).toBe('configuration_error');
    expect(stripeMocks.sessionCreate).not.toHaveBeenCalled();
  });

  it('bounds each price lookup more tightly than the shared client', async () => {
    // A checkout or quote may be waiting on this, and stripe-node's retry math
    // compounds; the batch settles only with its slowest member. Unpinned,
    // deleting the third argument reverted every lookup to the client's 10s/1
    // (~20.5s with the retry) with nothing red (#278 review round 3).
    stripeMocks.priceRetrieve.mockResolvedValue(priceFixture({ unit_amount: 500 }));
    await ensurePriceCatalog();

    expect(stripeMocks.priceRetrieve.mock.calls[0]?.[2]).toMatchObject({
      timeout: 5_000,
      maxNetworkRetries: 1
    });
  });

  it('rebuilds the client when the secret key CHANGES, not just when it appears', async () => {
    // Memoizing on presence meant removing the key threw while replacing it was
    // a silent no-op, so a rotated credential kept signing with the revoked one
    // - and in the test lane every suite stubbing a different key transacted
    // against a client built from the first (#278 review round 3).
    serveHealthyPrices();
    await ensurePriceCatalog();
    const first = StripeCtor.lastConstructorArgs?.[0];

    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_rotated');
    resetPriceCatalog();
    useDefaultPriceRetriever();
    serveHealthyPrices();
    await ensurePriceCatalog();

    expect(first).toBe('sk_test_dummy');
    expect(StripeCtor.lastConstructorArgs?.[0]).toBe('sk_test_rotated');
  });

  it('gives refund calls the background budget - attempts are spent before Stripe is reached', async () => {
    // requestRefund increments refund_attempts at claim time and never rolls
    // it back on a throw; with the shared client's interactive 10s/1 bound a
    // slow Stripe day burned the finite retry budget without refunds.create
    // ever succeeding, stranding a paid order in refund_pending for manual
    // action (#278 review round 4).
    stripeMocks.refundCreate.mockResolvedValue({ id: 're_1' });
    stripeMocks.refundList.mockResolvedValue({ data: [] });

    await createPaymentRefund('pi_1', 'order-1', 2);
    await findPaymentRefund('pi_1', 'order-1');

    expect(stripeMocks.refundCreate.mock.calls[0][1]).toMatchObject({
      timeout: 60_000,
      maxNetworkRetries: 2,
      idempotencyKey: 'jit-refund:order-1:attempt:2'
    });
    expect(stripeMocks.refundList.mock.calls[0][1]).toMatchObject({
      timeout: 60_000,
      maxNetworkRetries: 2
    });
  });

  it('constructs the client with explicit timeout and retry bounds', async () => {
    // stripe-node defaults to an 80s timeout with 2 retries; on the resolution
    // path that compounded to minutes of hung boot, and on checkout it held a
    // paying customer (#277, #278 review). Deleting these options would keep
    // every other test green - this is the only pin. The static is nulled
    // FIRST: it survives across tests, so without this the assertion could
    // pass on a construction some earlier test triggered (#278 round 4).
    StripeCtor.lastConstructorArgs = null;
    resetStripeClient();
    serveHealthyPrices();
    await ensurePriceCatalog();

    const args = StripeCtor.lastConstructorArgs as unknown[] | null;
    expect(args).not.toBeNull();
    expect(args?.[1]).toMatchObject({ timeout: 10_000, maxNetworkRetries: 1 });
  });

  it('reports a checkout-time provider failure without leaking the raw error', async () => {
    serveHealthyPrices();
    await ensurePriceCatalog();
    const sensitive = 'private failure cs_private';
    stripeMocks.sessionCreate.mockRejectedValue(
      Object.assign(new Error(sensitive), { type: 'StripeAPIError', rawType: 'api_error' })
    );

    const result = await checkout({
      productCode: 'credit-pack-10',
      priceId: 'price_regular',
      amountCents: 1000,
      currency: 'usd',
      name: 'Regular Pack',
      description: 'Five prepaid letters'
    });

    expect(result).toMatchObject({
      success: false,
      errorCode: 'PROVIDER_ERROR',
      diagnosticClass: 'StripeAPIError',
      error: 'Failed to create checkout session'
    });
    expect(JSON.stringify(result)).not.toContain(sensitive);
  });

  it('drops the memo when Stripe rejects the request, so an archived price stops being sold', async () => {
    // `active` is the one field validate() enforces that Stripe can change
    // under us, and it is deliberately not a signature input - so an archived
    // Price stayed memoized for the process lifetime: /readyz green, quotes
    // still advertising it, and every purchase inserting an order row and
    // then failing at session creation with a non-terminal class, stranding
    // a checkout_pending row per attempt forever (#278 round 10, reproduced
    // by three angles). The checkout rejection is the only moment this
    // process can learn the memo is a lie.
    serveHealthyPrices();
    await ensurePriceCatalog();
    expect(getResolvedPriceForProduct('credit-pack-10')).not.toBeNull();

    stripeMocks.sessionCreate.mockRejectedValue(
      Object.assign(new Error('This price is not active'), {
        type: 'StripeInvalidRequestError',
        // Stripe names the offending parameter; that is the discriminator.
        param: 'line_items[0][price]'
      })
    );

    await checkout({
      productCode: 'credit-pack-10',
      priceId: 'price_regular',
      amountCents: 1000,
      currency: 'usd',
      name: 'Regular Pack',
      description: 'Five prepaid letters'
    });

    // The memo is gone, so the next ensure re-reads it from Stripe - where it
    // will record price.inactive and take readiness red.
    expect(getResolvedPriceForProduct('credit-pack-10')).toBeNull();
  });

  it('keeps the memo when Stripe blames a CALLER-supplied parameter', () => {
    // success_url, cancel_url and customer_email reach this call straight
    // from a request body, and they all fail as the same catch-all class an
    // archived price does. Keying the invalidation on the class alone let any
    // authenticated caller delete a verified memo on demand - /readyz 503 and
    // every OTHER customer's purchase refused until the next resolve. Three
    // round-11 angles found it, one with a live probe (#278 round 11).
    serveHealthyPrices();
    return ensurePriceCatalog().then(async () => {
      expect(getResolvedPriceForProduct('credit-pack-10')).not.toBeNull();

      stripeMocks.sessionCreate.mockRejectedValue(
        Object.assign(new Error('Not a valid URL'), {
          type: 'StripeInvalidRequestError',
          param: 'success_url'
        })
      );

      await checkout({
        productCode: 'credit-pack-10',
        priceId: 'price_regular',
        amountCents: 1000,
        currency: 'usd',
        name: 'Regular Pack',
        description: 'Five prepaid letters'
      });

      expect(getResolvedPriceForProduct('credit-pack-10')).not.toBeNull();
    });
  });

  it('classifies a missing key at the WEBHOOK catch as configuration, not a blip', () => {
    // This try wraps getStripeClient(), whose missing-key throw carries
    // configuration_error. Bare classification filed a credential fault as a
    // provider blip, so an operator chased a Stripe signing problem while
    // every webhook failed on an unset key - the #213 mislabel, one function
    // away from where round 7 fixed it (#278 round 9).
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    resetStripeClient();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(verifyWebhookSignature('body', 'sig')).toBeNull();

      const lines = warn.mock.calls
        .flat()
        .map(String)
        .filter(line => line.includes('"event":"stripe.webhook_signature_invalid"'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"errorClass":"configuration_error"');
    } finally {
      warn.mockRestore();
    }
  });

  it('prefers a diagnosticClass carried on the thrown error over reclassification', async () => {
    // getStripeClient's missing-key throw is a plain Error carrying
    // diagnosticClass 'configuration_error'. classifyDiagnosticError sees no
    // Stripe type on it and would file it as 'provider_error' - transient, so
    // the order stays pending and the customer is told to retry a checkout
    // that can never succeed. The catch must read the carried class first
    // (#278 round 7).
    serveHealthyPrices();
    await ensurePriceCatalog();
    stripeMocks.sessionCreate.mockRejectedValue(
      Object.assign(new Error('STRIPE_SECRET_KEY is not configured'), {
        diagnosticClass: 'configuration_error'
      })
    );

    const result = await checkout({
      productCode: 'credit-pack-10',
      priceId: 'price_regular',
      amountCents: 1000,
      currency: 'usd',
      name: 'Regular Pack',
      description: 'Five prepaid letters'
    });

    expect(result).toMatchObject({
      success: false,
      errorCode: 'PROVIDER_ERROR',
      diagnosticClass: 'configuration_error'
    });
  });
});
