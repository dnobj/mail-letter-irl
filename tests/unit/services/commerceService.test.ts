import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  addCredits: vi.fn(),
  grantEntitlement: vi.fn(),
  createMail: vi.fn(),
  createJitSession: vi.fn(),
  createPackSession: vi.fn(),
  createRefund: vi.fn(),
  findRefund: vi.fn(),
  retrieveRefund: vi.fn(),
  retrieveSession: vi.fn(),
  jitEnabled: vi.fn(),
  getJitProduct: vi.fn(),
  getPackProduct: vi.fn()
}));

vi.mock('../../../src/db/index.js', () => ({
  query: mocks.query,
  transaction: mocks.transaction
}));
vi.mock('../../../src/services/creditLedgerService.js', () => ({
  addCreditsToLedgerWithClient: mocks.addCredits
}));
vi.mock('../../../src/services/imageGenerationLimitService.js', () => ({
  grantImageEntitlementWithClient: mocks.grantEntitlement
}));
vi.mock('../../../src/services/mailSendService.js', () => ({
  createMailOrderFromDraftWithClient: mocks.createMail
}));
vi.mock('../../../src/services/stripeService.js', () => ({
  createJitCheckoutSession: mocks.createJitSession,
  createPackCheckoutSession: mocks.createPackSession,
  createPaymentRefund: mocks.createRefund,
  findPaymentRefund: mocks.findRefund,
  retrieveRefund: mocks.retrieveRefund,
  retrieveCheckoutSession: mocks.retrieveSession,
  isJitPurchaseEnabled: mocks.jitEnabled,
  getJitProductConfig: mocks.getJitProduct,
  getPackProductConfig: mocks.getPackProduct
}));

import {
  createPackCheckout,
  createJitCheckout,
  getSendEligibility,
  processStripeWebhookEvent,
  requestRefund,
  runCommerceMaintenance
} from '../../../src/services/commerceService.js';

const baseOrder = {
  order_id: 'order-1',
  user_id: 'user-1',
  order_type: 'jit_mail',
  draft_id: 'draft-1',
  product_code: 'jit-letter',
  product_snapshot: {
    name: 'Pay & Send One Physical Letter',
    mailType: 'letter'
  },
  amount_cents: 499,
  currency: 'usd',
  payment_provider: 'stripe',
  idempotency_key: 'jit-checkout:order-1',
  status: 'checkout_pending',
  refund_attempts: 0,
  created_at: new Date(),
  updated_at: new Date()
};

function checkoutEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs-1',
        client_reference_id: 'order-1',
        metadata: { orderId: 'order-1' },
        payment_status: 'paid',
        payment_intent: 'pi-1',
        amount_total: 499,
        currency: 'usd',
        expires_at: Math.floor(Date.now() / 1000) + 1800,
        ...overrides
      }
    }
  } as any;
}

describe('commerceService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('IMAGE_ENTITLEMENTS_PER_JIT_ORDER', '1');
    mocks.transaction.mockImplementation(async callback => callback({ query: mocks.query }));
    mocks.jitEnabled.mockReturnValue(true);
    mocks.getJitProduct.mockReturnValue({
      productCode: 'jit-letter',
      priceId: 'price-jit-letter',
      amountCents: 499,
      currency: 'usd',
      name: 'Pay & Send One Physical Letter',
      description: 'Payment authorizes mailing this exact item.',
      mailType: 'letter'
    });
    mocks.getPackProduct.mockReturnValue({
      productCode: 'credit-pack-4',
      priceId: 'price-pack',
      amountCents: 500,
      currency: 'usd',
      name: 'Starter Pack - 2 Letters',
      description: 'Two prepaid physical letters',
      credits: 4
    });
    mocks.createMail.mockResolvedValue({});
    mocks.grantEntitlement.mockResolvedValue({ entitlement_id: 'ent-1' });
    mocks.findRefund.mockResolvedValue(null);
  });

  it('claims concurrent Stripe event replays so only one can send or grant', async () => {
    let claimed = false;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [{ event_id: 'evt-1' }] };
      }
      if (sql.includes('SELECT * FROM orders')) return { rows: [baseOrder] };
      return { rows: [] };
    });

    const [first, replay] = await Promise.all([
      processStripeWebhookEvent(checkoutEvent()),
      processStripeWebhookEvent(checkoutEvent())
    ]);

    expect(first).toMatchObject({
      duplicate: false,
      status: 'fulfillment_pending'
    });
    expect(replay).toEqual({ duplicate: true });
    expect(mocks.createMail).toHaveBeenCalledTimes(1);
    expect(mocks.createMail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        draftId: 'draft-1',
        funding: { type: 'jit_order', orderId: 'order-1' }
      })
    );
    expect(mocks.grantEntitlement).toHaveBeenCalledTimes(1);
  });

  it('rolls back a webhook claim after a transaction crash so replay can recover', async () => {
    let committedClaim = false;
    let crashBeforeOrderLock = true;
    mocks.transaction.mockImplementation(async callback => {
      let transactionClaim = committedClaim;
      const transactionQuery = vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) {
          if (transactionClaim) return { rows: [] };
          transactionClaim = true;
          return { rows: [{ event_id: 'evt-1' }] };
        }
        if (sql.includes('SELECT * FROM orders')) {
          if (crashBeforeOrderLock) {
            crashBeforeOrderLock = false;
            throw new Error('database process terminated before commit');
          }
          return { rows: [baseOrder] };
        }
        return { rows: [] };
      });

      const result = await callback({ query: transactionQuery });
      committedClaim = transactionClaim;
      return result;
    });

    await expect(processStripeWebhookEvent(checkoutEvent())).rejects.toThrow(
      'database process terminated before commit'
    );
    await expect(processStripeWebhookEvent(checkoutEvent())).resolves.toMatchObject({
      duplicate: false,
      status: 'fulfillment_pending'
    });

    expect(mocks.createMail).toHaveBeenCalledTimes(1);
    expect(mocks.grantEntitlement).toHaveBeenCalledTimes(1);
    expect(committedClaim).toBe(true);
  });

  it('persists an authoritative pack order before creating its Stripe session', async () => {
    const pendingPack = {
      ...baseOrder,
      order_id: 'pack-order',
      order_type: 'letter_pack',
      draft_id: undefined,
      credits: 4,
      product_code: 'credit-pack-4',
      product_snapshot: { name: 'Starter Pack - 2 Letters' },
      amount_cents: 500,
      idempotency_key: 'pack-checkout:pack-order'
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [pendingPack] })
      .mockResolvedValueOnce({ rows: [pendingPack] })
      .mockResolvedValueOnce({
        rows: [
          {
            ...pendingPack,
            stripe_checkout_session_id: 'cs-pack',
            checkout_url: 'https://checkout.stripe.com/c/pay/pack'
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [] });
    mocks.createPackSession.mockResolvedValueOnce({
      success: true,
      sessionId: 'cs-pack',
      sessionUrl: 'https://checkout.stripe.com/c/pay/pack'
    });

    const result = await createPackCheckout({
      userId: 'user-1',
      userEmail: 'person@example.com',
      productId: 'credit-pack-4',
      successUrl: 'https://letterirl.com/success',
      cancelUrl: 'https://letterirl.com/cancel'
    });

    expect(result).toMatchObject({
      success: true,
      sessionId: 'cs-pack',
      orderId: 'pack-order'
    });
    expect(mocks.query.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createPackSession.mock.invocationCallOrder[0]
    );
    expect(mocks.createPackSession).toHaveBeenCalledWith(
      expect.objectContaining({
        product: expect.objectContaining({ amountCents: 500, credits: 4 })
      })
    );
  });

  it('does not fulfill checkout.session.completed until payment_status is paid', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-unpaid' }] };
      }
      if (sql.includes('SELECT * FROM orders')) return { rows: [baseOrder] };
      return { rows: [] };
    });

    const result = await processStripeWebhookEvent({
      ...checkoutEvent({ payment_status: 'unpaid', payment_intent: null }),
      id: 'evt-unpaid'
    });

    expect(result).toMatchObject({
      duplicate: false,
      status: 'checkout_pending'
    });
    expect(mocks.createMail).not.toHaveBeenCalled();
    expect(mocks.grantEntitlement).not.toHaveBeenCalled();
  });

  it('claims and ignores an unrelated Checkout session without retrying forever', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-unrelated' }] };
      }
      if (sql.includes('SELECT * FROM orders')) return { rows: [] };
      return { rows: [] };
    });

    const result = await processStripeWebhookEvent({
      ...checkoutEvent({ client_reference_id: null, metadata: {} }),
      id: 'evt-unrelated'
    });

    expect(result).toEqual({ duplicate: false });
    expect(mocks.createMail).not.toHaveBeenCalled();
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it('does not authorize an order from a different attached Checkout session', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-session-mismatch' }] };
      }
      if (sql.includes('SELECT * FROM orders')) {
        return {
          rows: [{ ...baseOrder, stripe_checkout_session_id: 'cs-original' }]
        };
      }
      return { rows: [] };
    });

    const result = await processStripeWebhookEvent({
      ...checkoutEvent(),
      id: 'evt-session-mismatch'
    });

    expect(result).toMatchObject({ status: 'checkout_pending' });
    expect(mocks.createMail).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO commerce_order_events'),
      expect.arrayContaining([
        'order-1',
        'checkout.session.completed',
        'checkout_pending',
        'checkout_pending',
        expect.stringContaining('checkout_session_mismatch')
      ])
    );
  });

  it('moves a paid amount mismatch to refund_pending without fulfillment', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-mismatch' }] };
      }
      if (sql.includes('SELECT * FROM orders')) return { rows: [baseOrder] };
      return { rows: [] };
    });

    const result = await processStripeWebhookEvent({
      ...checkoutEvent({ amount_total: 1 }),
      id: 'evt-mismatch'
    });

    expect(result).toMatchObject({ status: 'refund_pending' });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'refund_pending'"),
      ['order-1', expect.stringContaining('Expected 499 usd; received 1 usd')]
    );
    expect(mocks.createMail).not.toHaveBeenCalled();
  });

  it('ignores a late failure event after an order has already been fulfilled', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-late-failure' }] };
      }
      if (sql.includes('SELECT * FROM orders')) {
        return { rows: [{ ...baseOrder, status: 'fulfilled' }] };
      }
      return { rows: [] };
    });

    const result = await processStripeWebhookEvent({
      ...checkoutEvent({ payment_status: 'unpaid' }),
      id: 'evt-late-failure',
      type: 'checkout.session.async_payment_failed'
    });

    expect(result).toMatchObject({ status: 'fulfilled' });
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'payment_failed'"),
      expect.anything()
    );
  });

  it('rejects cross-user draft checkout before calling Stripe', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          draft_id: 'draft-1',
          user_id: 'other-user',
          status: 'pending',
          expires_at: new Date(Date.now() + 60 * 60_000)
        }
      ]
    });

    await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).rejects.toMatchObject(
      { code: 'DRAFT_NOT_OWNED' }
    );
    expect(mocks.createJitSession).not.toHaveBeenCalled();
  });

  it('reuses the one active checkout for a draft', async () => {
    const existing = {
      ...baseOrder,
      stripe_checkout_session_id: 'cs-1',
      checkout_url: 'https://checkout.stripe.com/c/pay/test',
      checkout_expires_at: new Date(Date.now() + 20 * 60_000)
    };
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            draft_id: 'draft-1',
            user_id: 'user-1',
            mail_type: 'letter',
            required_credits: 2,
            status: 'pending',
            expires_at: new Date(Date.now() + 60 * 60_000)
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [existing] });

    const result = await createJitCheckout({
      userId: 'user-1',
      draftId: 'draft-1'
    });
    expect(result).toMatchObject({
      orderId: 'order-1',
      checkoutUrl: existing.checkout_url,
      reused: true
    });
    expect(mocks.createJitSession).not.toHaveBeenCalled();
  });

  it('reuses the durable order and Stripe key after checkout attachment crashes', async () => {
    const draft = {
      draft_id: 'draft-1',
      user_id: 'user-1',
      mail_type: 'letter',
      required_credits: 2,
      status: 'pending',
      expires_at: new Date(Date.now() + 60 * 60_000)
    };
    let storedOrder: typeof baseOrder & {
      checkout_expires_at?: Date;
      stripe_checkout_session_id?: string;
      checkout_url?: string;
    } | null = null;
    let failAttachment = true;
    mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT * FROM letter_drafts')) return { rows: [draft] };
      if (sql.includes("WHERE draft_id = $1 AND order_type = 'jit_mail'")) {
        return { rows: storedOrder ? [storedOrder] : [] };
      }
      if (sql.includes('SELECT credits FROM users')) return { rows: [{ credits: 0 }] };
      if (sql.includes('INSERT INTO orders')) {
        storedOrder = {
          ...baseOrder,
          order_id: String(params[0]),
          idempotency_key: `jit-checkout:${String(params[0])}`,
          checkout_expires_at: params[8] as Date
        };
        return { rows: [storedOrder] };
      }
      if (sql.startsWith('SELECT * FROM orders WHERE order_id')) {
        return { rows: storedOrder ? [storedOrder] : [] };
      }
      if (sql.includes('SET stripe_checkout_session_id = $2')) {
        if (failAttachment) {
          failAttachment = false;
          throw new Error('database process terminated before checkout attachment commit');
        }
        storedOrder = {
          ...storedOrder!,
          stripe_checkout_session_id: String(params[1]),
          checkout_url: String(params[2])
        };
        return { rows: [storedOrder] };
      }
      return { rows: [] };
    });
    mocks.createJitSession.mockResolvedValue({
      success: true,
      sessionId: 'cs-replayed',
      sessionUrl: 'https://checkout.stripe.com/c/pay/replayed'
    });

    await expect(createJitCheckout({ userId: 'user-1', draftId: 'draft-1' })).rejects.toThrow(
      'checkout attachment commit'
    );
    const recovered = await createJitCheckout({ userId: 'user-1', draftId: 'draft-1' });

    expect(recovered).toMatchObject({
      orderId: storedOrder?.order_id,
      sessionId: 'cs-replayed',
      reused: true
    });
    expect(mocks.createJitSession).toHaveBeenCalledTimes(2);
    const idempotencyKeys = mocks.createJitSession.mock.calls.map(
      ([params]) => params.idempotencyKey
    );
    expect(new Set(idempotencyKeys).size).toBe(1);
    expect(idempotencyKeys[0]).toBe(storedOrder?.idempotency_key);
  });

  it('reports exact server-configured Pay & Send eligibility only when enabled', () => {
    expect(getSendEligibility(0, 2, 'letter')).toMatchObject({
      prepaid: { eligible: false },
      payAndSend: {
        available: true,
        amountCents: 499,
        currency: 'usd'
      }
    });
    mocks.jitEnabled.mockReturnValue(false);
    expect(getSendEligibility(0, 2, 'letter').payAndSend).toMatchObject({
      available: false,
      unavailableReason: 'Pay & Send is not enabled.'
    });
  });

  it('reconciles a missed paid session before expiring pending checkouts', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("order_type = 'jit_mail' AND status = 'paid'")) return { rows: [] };
      if (sql.includes("status = 'checkout_pending' AND stripe_checkout_session_id")) {
        return { rows: [{ order_id: 'order-1', stripe_checkout_session_id: 'cs-1' }] };
      }
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'reconcile-event' }] };
      }
      if (sql.includes('SELECT * FROM orders')) return { rows: [baseOrder] };
      if (sql.includes("UPDATE orders SET status = 'cancelled'")) return { rows: [], rowCount: 0 };
      if (sql.includes("WHERE status = 'refund_pending'")) return { rows: [] };
      if (sql.includes('SELECT COUNT(*) AS count FROM orders')) return { rows: [{ count: '0' }] };
      return { rows: [] };
    });
    mocks.retrieveSession.mockResolvedValue({
      ...checkoutEvent().data.object,
      payment_status: 'paid'
    });

    await runCommerceMaintenance();

    const expiryCall = mocks.query.mock.calls.findIndex(([sql]) =>
      String(sql).includes("UPDATE orders SET status = 'cancelled'")
    );
    expect(expiryCall).toBeGreaterThan(-1);
    expect(mocks.retrieveSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.query.mock.invocationCallOrder[expiryCall]
    );
    expect(mocks.createMail).toHaveBeenCalledTimes(1);
  });

  it('keeps a completed asynchronous Checkout session pending while payment is unpaid', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("order_type = 'jit_mail' AND status = 'paid'")) return { rows: [] };
      if (sql.includes("status = 'checkout_pending' AND stripe_checkout_session_id")) {
        return { rows: [{ order_id: 'order-1', stripe_checkout_session_id: 'cs-1' }] };
      }
      if (sql.includes("UPDATE orders SET status = 'cancelled'")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WHERE status = 'refund_pending'")) return { rows: [] };
      if (sql.includes('SELECT COUNT(*) AS count FROM orders')) return { rows: [{ count: '0' }] };
      return { rows: [] };
    });
    mocks.retrieveSession.mockResolvedValue({
      ...checkoutEvent().data.object,
      status: 'complete',
      payment_status: 'unpaid',
      payment_intent: null
    });

    await expect(runCommerceMaintenance()).resolves.toMatchObject({ expiredCheckouts: 0 });

    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining("WHERE order_id = $1 AND status = 'checkout_pending'"),
      ['order-1']
    );
  });

  it.each(['pending', 'succeeded'])(
    'does not start full-refund recovery or revoke entitlements for a %s partial refund',
    async refundStatus => {
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) {
          return { rows: [{ event_id: 'evt-partial-refund' }] };
        }
        if (sql.includes('SELECT * FROM orders')) {
          return { rows: [{ ...baseOrder, status: 'fulfillment_pending' }] };
        }
        return { rows: [] };
      });

      const result = await processStripeWebhookEvent({
        id: 'evt-partial-refund',
        type: 'refund.updated',
        data: {
          object: {
            id: 're-partial',
            payment_intent: 'pi-1',
            metadata: { orderId: 'order-1' },
            status: refundStatus,
            amount: 100
          }
        }
      } as any);

      expect(result).toMatchObject({ status: 'fulfillment_pending' });
      expect(mocks.query).not.toHaveBeenCalledWith(
        expect.stringContaining('UPDATE image_entitlements'),
        expect.anything()
      );
      expect(mocks.query).not.toHaveBeenCalledWith(
        expect.stringContaining('SET status = $2'),
        expect.anything()
      );
    }
  );

  it('ignores a later full-refund event after the order is already refunded', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-refund-replay' }] };
      }
      if (sql.includes('SELECT * FROM orders')) {
        return {
          rows: [
            {
              ...baseOrder,
              order_type: 'letter_pack',
              credits: 4,
              status: 'refunded'
            }
          ]
        };
      }
      return { rows: [] };
    });

    const result = await processStripeWebhookEvent({
      id: 'evt-refund-replay',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch-1',
          payment_intent: 'pi-1',
          amount_refunded: 499
        }
      }
    } as any);

    expect(result).toMatchObject({ status: 'refunded' });
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE users'),
      expect.anything()
    );
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE image_entitlements'),
      expect.anything()
    );
  });

  it('revokes a refunded pack once and links a refund ledger audit row', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) {
        return { rows: [{ event_id: 'evt-pack-refund' }] };
      }
      if (sql.includes('SELECT * FROM orders')) {
        return {
          rows: [
            {
              ...baseOrder,
              order_type: 'letter_pack',
              credits: 4,
              status: 'fulfilled'
            }
          ]
        };
      }
      if (sql.includes('SELECT ledger_id, initial_amount')) {
        return {
          rows: [
            {
              ledger_id: '00000000-0000-0000-0000-000000000001',
              initial_amount: 4,
              remaining_amount: 2
            }
          ]
        };
      }
      if (sql.includes('UPDATE users')) return { rows: [{ credits: 3 }] };
      return { rows: [] };
    });

    await expect(
      processStripeWebhookEvent({
        id: 'evt-pack-refund',
        type: 'refund.updated',
        data: {
          object: {
            id: 're-pack',
            payment_intent: 'pi-1',
            metadata: { orderId: 'order-1' },
            status: 'succeeded',
            amount: 499
          }
        }
      } as any)
    ).resolves.toMatchObject({ status: 'refunded' });

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('related_ledger_id'),
      expect.arrayContaining([
        'user-1',
        4,
        'order-1',
        expect.stringContaining('payment_refunded'),
        expect.stringContaining('Payment refund'),
        '00000000-0000-0000-0000-000000000001'
      ])
    );
    expect(
      mocks.query.mock.calls.filter(([sql]) => String(sql).includes('UPDATE users'))
    ).toHaveLength(1);
  });

  it('retrieves an existing pending refund instead of creating another refund', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          ...baseOrder,
          status: 'refund_pending',
          refund_attempts: 5,
          stripe_payment_intent_id: 'pi-1',
          stripe_refund_id: 're-1'
        }
      ]
    });
    mocks.retrieveRefund.mockResolvedValue({ id: 're-1', status: 'succeeded' });

    await expect(requestRefund('order-1', 'retry')).resolves.toBe(true);

    expect(mocks.retrieveRefund).toHaveBeenCalledWith('re-1');
    expect(mocks.findRefund).not.toHaveBeenCalled();
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it('leases a refund so concurrent workers make only one external request', async () => {
    let refundClaimed = false;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('WITH candidate AS')) {
        if (refundClaimed) return { rows: [] };
        refundClaimed = true;
        return {
          rows: [
            {
              ...baseOrder,
              status: 'refund_pending',
              refund_attempts: 1,
              previous_refund_attempts: 0,
              stripe_payment_intent_id: 'pi-1'
            }
          ]
        };
      }
      if (sql.includes('SET stripe_refund_id = $2')) {
        return { rows: [{ order_id: 'order-1' }] };
      }
      return { rows: [] };
    });
    mocks.createRefund.mockResolvedValue({ id: 're-1', status: 'pending' });

    const results = await Promise.all([
      requestRefund('order-1', 'provider rejected'),
      requestRefund('order-1', 'provider rejected')
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect(mocks.findRefund).toHaveBeenCalledTimes(1);
    expect(mocks.createRefund).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("updated_at <= NOW() - ($4 * INTERVAL '1 second')"),
      ['order-1', 'provider rejected', 5, 300]
    );
  });

  it('finds a previously created refund before retrying after a persistence failure', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          ...baseOrder,
          status: 'refund_pending',
          refund_attempts: 5,
          previous_refund_attempts: 5,
          stripe_payment_intent_id: 'pi-1',
          stripe_refund_id: null
        }
      ]
    });
    mocks.findRefund.mockResolvedValue({ id: 're-recovered', status: 'pending' });

    await expect(requestRefund('order-1', 'retry')).resolves.toBe(true);

    expect(mocks.findRefund).toHaveBeenCalledWith('pi-1', 'order-1');
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it.each(['failed', 'canceled'])(
    'uses a new idempotency attempt after a known %s refund',
    async terminalRefundStatus => {
      mocks.query
        .mockResolvedValueOnce({
          rows: [
            {
              ...baseOrder,
              status: 'refund_pending',
              refund_attempts: 2,
              stripe_payment_intent_id: 'pi-1',
              stripe_refund_id: 're-failed'
            }
          ]
        })
        .mockResolvedValueOnce({ rows: [{ refund_attempts: 3 }] });
      mocks.retrieveRefund.mockResolvedValue({
        id: 're-failed',
        status: terminalRefundStatus
      });
      mocks.createRefund.mockResolvedValue({ id: 're-retry', status: 'pending' });

      await expect(requestRefund('order-1', 'retry')).resolves.toBe(true);

      expect(mocks.findRefund).toHaveBeenCalledWith('pi-1', 'order-1');
      expect(mocks.createRefund).toHaveBeenCalledWith('pi-1', 'order-1', 3);
    }
  );
});
