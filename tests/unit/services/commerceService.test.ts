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
  ACTIVE_JIT_STATUSES,
  FUNDED_OR_REVERSED_ORDER_STATUSES,
  PackAmountNotConfiguredError,
  createPackCheckout,
  createJitCheckout,
  getSendEligibility,
  processStripeWebhookEvent,
  repairFulfilledPackGrant,
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

const ACCOUNT_LOCK_SQL = 'SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE';

describe('commerceService', () => {
  it('uses the same active JIT status set as the database uniqueness policy', () => {
    expect(ACTIVE_JIT_STATUSES).toEqual([
      'checkout_pending', 'paid', 'fulfillment_pending', 'refund_pending', 'disputed', 'held'
    ]);
  });

  it('treats every funded, reversed, disputed, or held order as terminal for checkout replay', () => {
    expect(FUNDED_OR_REVERSED_ORDER_STATUSES).toEqual([
      'fulfillment_pending', 'fulfilled', 'refund_pending', 'refunded', 'disputed', 'held'
    ]);
  });
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

  it('commits a dispute alert with its event claim so handler failure can replay', async () => {
    let committedClaim = false;
    let failAlertInsert = true;
    let alertInsertions = 0;
    mocks.transaction.mockImplementation(async callback => {
      let transactionClaim = committedClaim;
      const transactionQuery = vi.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) {
          if (transactionClaim) return { rows: [] };
          transactionClaim = true;
          return { rows: [{ event_id: 'evt-dispute' }] };
        }
        if (sql.includes('INSERT INTO commerce_operational_alerts')) {
          alertInsertions += 1;
          expect(String(params[3])).not.toContain('dp-sensitive');
          expect(String(params[3])).not.toContain('ch-sensitive');
          if (failAlertInsert) {
            failAlertInsert = false;
            throw new Error('alert insert failed before transaction commit');
          }
          return { rows: [] };
        }
        return { rows: [] };
      });
      const result = await callback({ query: transactionQuery });
      committedClaim = transactionClaim;
      return result;
    });
    const event = {
      id: 'evt-dispute',
      type: 'charge.dispute.created',
      data: {
        object: {
          id: 'dp-sensitive',
          charge: 'ch-sensitive',
          amount: 499,
          currency: 'usd',
          reason: 'fraudulent',
          status: 'needs_response'
        }
      }
    } as any;

    await expect(processStripeWebhookEvent(event)).rejects.toThrow('alert insert failed');
    await expect(processStripeWebhookEvent(event)).resolves.toEqual({ duplicate: false });

    expect(alertInsertions).toBe(2);
    expect(committedClaim).toBe(true);
  });

  it.each(['disputed', 'held', 'refunded', 'fulfilled'])(
    'ignores a replayed paid checkout for a %s order instead of re-granting',
    async (status) => {
      const guarded = {
        ...baseOrder, order_type: 'letter_pack', product_code: 'credit-pack-4',
        credits: 4, amount_cents: 500, status
      };
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-1' }] };
        if (sql.includes('SELECT * FROM orders')) return { rows: [guarded] };
        return { rows: [] };
      });

      await expect(processStripeWebhookEvent(checkoutEvent({ amount_total: 500 }) as any))
        .resolves.toMatchObject({ duplicate: false, status });

      expect(mocks.addCredits).not.toHaveBeenCalled();
      expect(mocks.grantEntitlement).not.toHaveBeenCalled();
      expect(mocks.query).not.toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'paid'"),
        expect.anything()
      );
    }
  );

  it('binds a pack grant to its funding order so the database can reject a replay', async () => {
    const pendingPackOrder = {
      ...baseOrder, order_type: 'letter_pack', product_code: 'credit-pack-4',
      credits: 4, amount_cents: 500, draft_id: undefined, status: 'checkout_pending'
    };
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-1' }] };
      if (sql.includes('SELECT * FROM orders')) return { rows: [pendingPackOrder] };
      return { rows: [] };
    });

    await expect(processStripeWebhookEvent(checkoutEvent({ amount_total: 500 }) as any))
      .resolves.toMatchObject({ status: 'fulfilled' });

    expect(mocks.addCredits).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceType: 'purchase', sourceOrderId: 'order-1' })
    );
  });

  // Deterministic proof of the canonical order. The PostgreSQL concurrency
  // tests can only ever show the absence of a deadlock on the interleavings
  // they happen to hit; this asserts the statement order itself.
  it.each([
    ['refund webhook', async () => {
      await processStripeWebhookEvent({
        id: 'evt-refund-lock', type: 'refund.updated', data: { object: {
          id: 're-lock', payment_intent: 'pi-lock', charge: 'ch-lock',
          amount: 500, status: 'succeeded', metadata: {}
        } }
      } as any);
    }],
    ['operator refund request', async () => {
      await requestRefund('order-1', 'operator requested');
    }],
    ['reconciliation pack repair', async () => {
      await repairFulfilledPackGrant({
        orderId: 'order-1', stripeSessionId: 'cs-lock', expectedCredits: 4,
        paidAmountCents: 500, paidCurrency: 'usd'
      });
    }]
  ])('locks the account row before any ledger or entitlement write (%s)', async (_label, run) => {
    const packOrder = {
      ...baseOrder, order_type: 'letter_pack', product_code: 'credit-pack-4',
      draft_id: undefined, credits: 4, amount_cents: 500, currency: 'usd',
      status: 'fulfilled', stripe_checkout_session_id: 'cs-lock',
      stripe_payment_intent_id: 'pi-lock', refund_attempts: 0
    };
    mocks.findRefund.mockResolvedValue({ id: 're-lock', status: 'succeeded' });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-refund-lock' }] };
      if (sql.includes('UPDATE orders') && sql.includes('RETURNING order_id')) {
        return { rows: [{ order_id: 'order-1' }] };
      }
      if (sql.includes('FROM orders')) return { rows: [packOrder] };
      if (sql.includes('FROM credit_ledger')) return { rows: [] };
      return { rows: [] };
    });

    await run().catch(() => undefined);
    // The scenario must actually reach ledger/entitlement work, or the
    // assertion below would be vacuously satisfied by an empty trace.
    expect(mocks.query.mock.calls.some(call =>
      String(call[0]).includes('credit_ledger') ||
      String(call[0]).includes('image_entitlements'))).toBe(true);

    // Exact-match the account lock, not merely "contains FOR UPDATE": the
    // ledger statements this guards against are themselves SELECT ... FOR
    // UPDATE, so a looser predicate would still pass with the lock removed.
    const ordered = mocks.query.mock.calls
      .filter(call =>
        String(call[0]) === ACCOUNT_LOCK_SQL ||
        String(call[0]).includes('credit_ledger') ||
        String(call[0]).includes('image_entitlements'));
    expect([String(ordered[0]?.[0]), ordered[0]?.[1]]).toEqual([ACCOUNT_LOCK_SQL, ['user-1']]);
  });

  it('refuses to adopt a legacy pack session when its amount is not configured', async () => {
    mocks.getPackProduct.mockReturnValue({
      productCode: 'credit-pack-4',
      priceId: 'price-pack',
      amountCents: 0,
      currency: 'usd',
      credits: 4,
      name: 'Starter Pack',
      description: 'Two prepaid letters'
    });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-legacy' }] };
      return { rows: [] };
    });

    await expect(processStripeWebhookEvent(checkoutEvent({
      id: 'cs-legacy',
      client_reference_id: null,
      metadata: { userId: 'user-1', productId: 'credit-pack-4' },
      amount_total: 500
    }) as any)).resolves.toMatchObject({ duplicate: false });

    // Inserting a zero amount would violate the amount_cents CHECK and roll
    // back the webhook claim, leaving Stripe to retry forever with no signal.
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO orders'),
      expect.anything()
    );
    expect(mocks.addCredits).not.toHaveBeenCalled();
    // But refusing must not silently consume paid money either: the event stays
    // unmatched and raises a durable alert, so a recovery path can find it once
    // the amount is configured.
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("processing_status = 'unmatched'"),
      ['evt-1', 'pi-1']
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("'stripe_money_event_unmatched'"),
      expect.arrayContaining(['evt-1'])
    );
  });

  // The gate is "did money move", not "which event carried the news". A
  // delayed-payment method lands its money on async_payment_succeeded, so
  // narrowing this to checkout.session.completed would silently drop it.
  it.each(['checkout.session.completed', 'checkout.session.async_payment_succeeded'])(
    'records unmatched money whichever paid event delivers it (%s)',
    async (eventType) => {
      mocks.getPackProduct.mockReturnValue(null);
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-1' }] };
        return { rows: [] };
      });

      const event = checkoutEvent({ client_reference_id: null, metadata: {} }) as any;
      event.type = eventType;

      await expect(processStripeWebhookEvent(event)).resolves.toMatchObject({ duplicate: false });

      expect(mocks.query).toHaveBeenCalledWith(
        expect.stringContaining("processing_status = 'unmatched'"),
        ['evt-1', 'pi-1']
      );
      expect(mocks.query).toHaveBeenCalledWith(
        expect.stringContaining("'stripe_money_event_unmatched'"),
        expect.arrayContaining(['evt-1'])
      );
    }
  );

  it('does not raise unmatched money for an unpaid session that matches no order', async () => {
    mocks.getPackProduct.mockReturnValue(null);
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-1' }] };
      return { rows: [] };
    });

    await expect(processStripeWebhookEvent(checkoutEvent({
      client_reference_id: null, metadata: {}, payment_status: 'unpaid'
    }) as any)).resolves.toMatchObject({ duplicate: false });

    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining("'stripe_money_event_unmatched'"),
      expect.anything()
    );
  });

  it('refuses a pack checkout when its amount is not configured', async () => {
    mocks.getPackProduct.mockReturnValue({
      productCode: 'credit-pack-4',
      priceId: 'price-pack',
      amountCents: 0,
      currency: 'usd',
      name: 'Starter Pack',
      description: 'Two prepaid letters'
    });

    await expect(createPackCheckout({
      userId: 'user-1', userEmail: 'user@example.test', productId: 'credit-pack-4',
      successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/no'
    } as never)).rejects.toBeInstanceOf(PackAmountNotConfiguredError);

    // No authoritative order may exist for an amount we cannot reconcile.
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO orders'),
      expect.anything()
    );
    expect(mocks.createPackSession).not.toHaveBeenCalled();
  });

  it('carries the Stripe failure class up when the checkout session cannot be created', async () => {
    // Issue #213: when Stripe rejects the session (e.g. a Price ID that does
    // not exist in this account), the thrown error must carry the resolved
    // class so the handler's catch logs the real cause rather than defaulting
    // to a database label.
    mocks.getPackProduct.mockReturnValue({
      productCode: 'credit-pack-4',
      priceId: 'price-pack',
      amountCents: 500,
      currency: 'usd',
      name: 'Starter Pack',
      description: 'Two prepaid letters'
    });
    mocks.query.mockResolvedValue({ rows: [{ order_id: 'order-1' }] });
    mocks.createPackSession.mockResolvedValue({
      success: false,
      errorCode: 'PROVIDER_ERROR',
      diagnosticClass: 'resource_missing',
      error: 'Failed to create checkout session'
    });

    await expect(createPackCheckout({
      userId: 'user-1', userEmail: 'user@example.test', productId: 'credit-pack-4',
      successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/no'
    } as never)).rejects.toMatchObject({ diagnosticClass: 'resource_missing' });
  });

  it('records the required durable resolution code when a Stripe dispute closes', async () => {
    const disputedOrder = { ...baseOrder, status: 'disputed', stripe_payment_intent_id: 'pi-1' };
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) return { rows: [{ event_id: 'evt-close' }] };
      if (sql.includes('SELECT * FROM orders')) return { rows: [disputedOrder] };
      if (sql.includes("alert_type = 'stripe_dispute_created'")) {
        expect(params).toEqual(['order-1', 'stripe_dispute_won', 'dp-closed']);
      }
      return { rows: [] };
    });

    await expect(processStripeWebhookEvent({
      id: 'evt-close', type: 'charge.dispute.closed', data: { object: {
        id: 'dp-closed', payment_intent: 'pi-1', charge: 'ch-closed', amount: 499,
        currency: 'usd', reason: 'fraudulent', status: 'won'
      } }
    } as any)).resolves.toEqual({ duplicate: false });

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('resolution_code = $2'),
      ['order-1', 'stripe_dispute_won', 'dp-closed']
    );
  });

  it('repairs a fulfilled pack grant atomically through the exact order/session binding', async () => {
    const packOrder = {
      ...baseOrder,
      order_id: 'pack-order',
      order_type: 'letter_pack',
      draft_id: undefined,
      status: 'fulfilled',
      credits: 4,
      amount_cents: 500,
      currency: 'usd',
      product_code: 'credit-pack-4',
      stripe_checkout_session_id: 'cs-pack'
    };
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("order_type = 'letter_pack'")) return { rows: [packOrder] };
      if (sql.includes('SELECT ledger_id FROM credit_ledger')) return { rows: [] };
      return { rows: [] };
    });

    await expect(repairFulfilledPackGrant({
      orderId: 'pack-order', stripeSessionId: 'cs-pack', expectedCredits: 4,
      paidAmountCents: 500, paidCurrency: 'usd'
    })).resolves.toBe('repaired');

    expect(mocks.addCredits).toHaveBeenCalledTimes(1);
    expect(mocks.grantEntitlement).toHaveBeenCalledTimes(1);
  });

  it('refuses pack repair when the provider session does not match the locked order', async () => {
    mocks.query.mockResolvedValue({ rows: [{
      ...baseOrder, order_type: 'letter_pack', status: 'fulfilled', credits: 4,
      amount_cents: 500, stripe_checkout_session_id: 'cs-authoritative'
    }] });

    await expect(repairFulfilledPackGrant({
      orderId: 'order-1', stripeSessionId: 'cs-attacker', expectedCredits: 4,
      paidAmountCents: 500, paidCurrency: 'usd'
    })).rejects.toThrow('does not match');
    expect(mocks.addCredits).not.toHaveBeenCalled();
    expect(mocks.grantEntitlement).not.toHaveBeenCalled();
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
    // Issue #150 added a send-block lookup ahead of the draft read. This account
    // is not blocked, so the original assertion below is unchanged.
    mocks.query.mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] });
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
      // Issue #150 added a send-block lookup ahead of the draft read.
      .mockResolvedValueOnce({ rows: [{ sends_blocked_reason: null }] })
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

  it('redacts order, session, and exception details from reconciliation diagnostics', async () => {
    const sensitive = 'private reconciliation failure order-private cs-private pi-private';
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("order_type = 'jit_mail' AND status = 'paid'")) return { rows: [] };
      if (sql.includes("status = 'checkout_pending' AND stripe_checkout_session_id")) {
        return {
          rows: [{ order_id: 'order-private', stripe_checkout_session_id: 'cs-private' }]
        };
      }
      if (sql.includes("UPDATE orders SET status = 'cancelled'")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WHERE status = 'refund_pending'")) return { rows: [] };
      if (sql.includes('SELECT COUNT(*) AS count FROM orders')) {
        return { rows: [{ count: '0' }] };
      }
      return { rows: [] };
    });
    mocks.retrieveSession.mockRejectedValue(new Error(sensitive));
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runCommerceMaintenance();

    const output = diagnostic.mock.calls.flat().map(String).join('\n');
    expect(output).toContain('"event":"commerce.checkout_reconciliation_failed"');
    for (const value of [sensitive, 'order-private', 'cs-private', 'pi-private']) {
      expect(output).not.toContain(value);
    }
    diagnostic.mockRestore();
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
      mocks.query.mock.calls.filter(([sql]) => String(sql).includes('SET credits = GREATEST'))
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
