import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The proportional-refund command (#323), against a mocked query log.
 *
 * Each case names the mutation it exists to catch. The PostgreSQL suite
 * (tests/integration/packRefundCommand.postgres.test.ts) proves the same
 * command against the real schema; this file pins the decisions the command
 * makes before and after it touches the database: which lots count, how the
 * amount is computed, what goes to Stripe, and what happens when Stripe says
 * no or says nothing.
 */

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  createPartialPaymentRefund: vi.fn(),
  listPaymentRefunds: vi.fn(),
  retrieveRefund: vi.fn(),
  resolveDeploymentMode: vi.fn()
}));

vi.mock('../../../src/db/index.js', () => ({
  query: mocks.query,
  transaction: mocks.transaction,
  pool: {}
}));

vi.mock('../../../src/services/stripeService.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/services/stripeService.js')>();
  return {
    ...actual,
    createPartialPaymentRefund: mocks.createPartialPaymentRefund,
    listPaymentRefunds: mocks.listPaymentRefunds,
    retrieveRefund: mocks.retrieveRefund
  };
});

vi.mock('../../../src/config/deploymentConfig.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/config/deploymentConfig.js')>();
  return { ...actual, resolveDeploymentMode: mocks.resolveDeploymentMode };
});

import {
  PackRefundError,
  refundPackLetters,
  type RefundPackLettersInput
} from '../../../src/services/packRefundService.js';

const ENABLED_ENV = { LETTER_IRL_PACK_REFUND_COMMAND_ENABLED: 'true' } as NodeJS.ProcessEnv;

const baseOrder = {
  order_id: 'order-1',
  user_id: 'user-1',
  order_type: 'letter_pack',
  product_code: 'starter',
  product_snapshot: { name: 'Starter Pack' },
  credits: 4,
  amount_cents: 500,
  amount_known: true,
  currency: 'usd',
  payment_provider: 'stripe',
  stripe_checkout_session_id: 'cs-1',
  stripe_payment_intent_id: 'pi-1',
  idempotency_key: 'pack-checkout:order-1',
  status: 'fulfilled',
  refund_attempts: 0,
  credits_refunded: 0,
  amount_refunded_cents: 0,
  created_at: new Date('2026-09-01T00:00:00Z'),
  updated_at: new Date('2026-09-06T12:00:00Z')
};

const baseInput: RefundPackLettersInput = {
  orderId: 'order-1',
  letters: 1,
  reasonCode: 'goodwill_unused',
  actor: { id: 'operator-1' },
  idempotencyKey: 'op-key-0001',
  environment: 'development'
};

interface Lot {
  ledger_id: string;
  remaining_amount: number;
}

/**
 * Answers the command's SQL by fragment. Everything not listed returns no
 * rows. The commerce_pack_refunds INSERT echoes its parameters back as the
 * row, and later FOR UPDATE reads of that row return the same object, so the
 * Stripe phase and the finalisation see what Phase 1 wrote.
 */
function router(options: {
  order?: Record<string, unknown> | null;
  lots?: Lot[];
  liveCommand?: boolean;
  disputed?: boolean;
  sendsBlocked?: string | null;
  replay?: Record<string, unknown> | null;
  auditRows?: Array<{ ledger_id: string; initial_amount: number }>;
}) {
  const state: { row: Record<string, unknown> | null } = { row: null };
  mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM commerce_operator_audit_events')) {
      return { rows: options.replay ? [options.replay] : [] };
    }
    if (sql.includes('SELECT * FROM orders WHERE order_id = $1')) {
      return { rows: options.order === null ? [] : [{ ...baseOrder, ...(options.order ?? {}) }] };
    }
    if (sql.includes("status IN ('letters_revoked', 'stripe_pending', 'succeeded')")) {
      return { rows: options.liveCommand ? [{}] : [], rowCount: options.liveCommand ? 1 : 0 };
    }
    if (sql.includes('FROM stripe_disputes')) {
      return { rows: options.disputed ? [{}] : [], rowCount: options.disputed ? 1 : 0 };
    }
    if (sql.includes('SELECT sends_blocked_reason')) {
      return { rows: [{ sends_blocked_reason: options.sendsBlocked ?? null }] };
    }
    if (sql.includes('remaining_amount AS credits')) {
      return { rows: (options.lots ?? [{ ledger_id: 'lot-a', remaining_amount: 4 }]).map(lot => ({ credits: lot.remaining_amount })) };
    }
    if (sql.includes('SELECT ledger_id, remaining_amount FROM credit_ledger')) {
      return { rows: options.lots ?? [{ ledger_id: 'lot-a', remaining_amount: 4 }] };
    }
    if (sql.includes('INSERT INTO commerce_pack_refunds')) {
      const [
        pack_refund_id, order_id, user_id, environment, letters, credits, amount_cents, currency,
        stripe_payment_intent_id, stripe_idempotency_key, reason_code, actor_subject_hash,
        idempotency_key_hash, admin_command_id
      ] = params as [string, string, string, string, number, number, number, string, string, string, string, string, string, string | null];
      state.row = {
        pack_refund_id, order_id, user_id, environment, letters, credits, amount_cents, currency,
        status: 'letters_revoked', stripe_payment_intent_id, stripe_refund_id: null,
        stripe_idempotency_key, stripe_attempts: 0, last_error_code: null, failure_reason: null,
        reason_code, actor_subject_hash, idempotency_key_hash, admin_command_id,
        compensation_ledger_id: null, submitted_at: null, settled_at: null, failed_at: null,
        created_at: new Date(), updated_at: new Date()
      };
      return { rows: [state.row] };
    }
    if (sql.includes('FROM commerce_pack_refunds WHERE pack_refund_id = $1')) {
      return { rows: state.row ? [state.row] : [] };
    }
    if (sql.includes('INSERT INTO credit_ledger') && sql.includes('RETURNING ledger_id')) {
      return { rows: [{ ledger_id: `audit-${Math.random().toString(16).slice(2, 8)}` }] };
    }
    if (sql.includes('SELECT credits FROM users')) {
      return { rows: [{ credits: 4 }] };
    }
    if (sql.includes('UPDATE users') && sql.includes('RETURNING credits')) {
      return { rows: [{ credits: 2 }] };
    }
    if (sql.includes("audit.source_metadata->>'pack_refund_id'")) {
      return {
        rows: (options.auditRows ?? [{ ledger_id: 'audit-1', initial_amount: 2 }]).map(row => ({
          ...row,
          expires_at: new Date('2028-09-01T00:00:00Z'),
          expiration_policy: 'days_from_activation'
        }))
      };
    }
    return { rows: [] };
  });
  return state;
}

function calls(fragment: string): unknown[][] {
  return mocks.query.mock.calls.filter(([sql]) => String(sql).includes(fragment));
}

async function refusal(input: Partial<RefundPackLettersInput> = {}, env = ENABLED_ENV): Promise<string> {
  try {
    await refundPackLetters({ ...baseInput, ...input }, undefined, env);
    return 'no refusal';
  } catch (error) {
    return error instanceof PackRefundError ? error.code : `unexpected: ${String(error)}`;
  }
}

describe('refundPackLetters', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.transaction.mockReset();
    mocks.createPartialPaymentRefund.mockReset();
    mocks.listPaymentRefunds.mockReset();
    mocks.retrieveRefund.mockReset();
    mocks.resolveDeploymentMode.mockReset();
    mocks.transaction.mockImplementation(async callback => callback({ query: mocks.query }));
    mocks.resolveDeploymentMode.mockReturnValue({ mode: 'development', findings: [] });
    mocks.createPartialPaymentRefund.mockResolvedValue({ id: 're-1', status: 'succeeded' });
  });

  it('is off unless the flag says exactly true', async () => {
    router({});
    expect(await refusal({}, {} as NodeJS.ProcessEnv)).toBe('PACK_REFUND_DISABLED');
    expect(await refusal({}, { LETTER_IRL_PACK_REFUND_COMMAND_ENABLED: 'TRUE' } as NodeJS.ProcessEnv)).toBe(
      'PACK_REFUND_DISABLED'
    );
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('refuses a command that names the wrong environment', async () => {
    router({});
    mocks.resolveDeploymentMode.mockReturnValue({ mode: 'production', findings: [] });
    expect(await refusal({ environment: 'development' })).toBe('PACK_REFUND_ENVIRONMENT_MISMATCH');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('refuses more letters than remain, counting only live lots, before writing anything', async () => {
    router({ lots: [{ ledger_id: 'lot-a', remaining_amount: 4 }] });
    expect(await refusal({ letters: 3 })).toBe('PACK_REFUND_TOO_MANY_LETTERS');
    expect(calls('INSERT INTO commerce_pack_refunds')).toHaveLength(0);
    // The lots that count are active, unexpired, and attributed like the refund path's.
    const lotSql = String(calls('remaining_amount AS credits')[0][0]);
    expect(lotSql).toContain('expires_at > NOW()');
    expect(lotSql).toContain("source_type IN ('purchase', 'adjustment')");
    expect(lotSql).toContain("status = 'active'");
    expect(lotSql).toContain('FOR UPDATE');
  });

  it('refuses a refund that would complete the payment: that is a full refund', async () => {
    router({ lots: [{ ledger_id: 'lot-a', remaining_amount: 4 }] });
    expect(await refusal({ letters: 2 })).toBe('PACK_REFUND_WOULD_BE_FULL');
    expect(calls('INSERT INTO commerce_pack_refunds')).toHaveLength(0);
  });

  it.each([
    ['a second command on the same pack', { liveCommand: true }, 'PACK_REFUND_ALREADY_ISSUED'],
    ['a disputed payment', { disputed: true }, 'PACK_REFUND_DISPUTED'],
    ['a send-blocked account', { sendsBlocked: 'dispute_open' }, 'PACK_REFUND_DISPUTED'],
    ['an order that is not fulfilled', { order: { status: 'refund_pending' } }, 'PACK_REFUND_ORDER_STATE'],
    ['a Pay & Send order', { order: { order_type: 'jit_mail', credits: null } }, 'PACK_REFUND_NOT_A_PACK'],
    ['an unknown order', { order: null }, 'PACK_REFUND_NOT_FOUND']
  ] as const)('refuses %s', async (_label, options, code) => {
    router({ ...options });
    expect(await refusal()).toBe(code);
    expect(calls('INSERT INTO commerce_pack_refunds')).toHaveLength(0);
    expect(mocks.createPartialPaymentRefund).not.toHaveBeenCalled();
  });

  it('computes the amount as floor(N x price / letters), in one rounding step', async () => {
    // A hypothetical 50-letter pack at 8999 cents: 49 letters are 8819 cents,
    // not 49 x floor(179.98) = 8771.
    router({ order: { credits: 100, amount_cents: 8999 }, lots: [{ ledger_id: 'lot-a', remaining_amount: 100 }] });
    const result = await refundPackLetters({ ...baseInput, letters: 49 }, undefined, ENABLED_ENV);
    expect(result.amountCents).toBe(8819);
    const insert = calls('INSERT INTO commerce_pack_refunds')[0][1] as unknown[];
    expect(insert[4]).toBe(49);
    expect(insert[5]).toBe(98);
    expect(insert[6]).toBe(8819);
  });

  it('revokes FIFO across lots, leaves them live, and audits each slice with the command id', async () => {
    router({
      order: { credits: 10, amount_cents: 1000 },
      lots: [
        { ledger_id: 'lot-expiring', remaining_amount: 2 },
        { ledger_id: 'lot-later', remaining_amount: 8 }
      ]
    });
    const result = await refundPackLetters({ ...baseInput, letters: 2 }, undefined, ENABLED_ENV);

    // 4 credits: all 2 from the expiring lot, then 2 of the later one.
    const lotUpdates = calls('UPDATE credit_ledger');
    expect(lotUpdates.map(([, params]) => params)).toEqual([
      [0, 'lot-expiring'],
      [6, 'lot-later']
    ]);
    for (const [sql] of lotUpdates) {
      expect(String(sql)).toContain("'depleted'::credit_ledger_status");
      expect(String(sql)).not.toContain("'revoked'");
    }
    const audits = calls("'refund', $3, $4, NOW(), 'never', 'revoked'");
    expect(audits).toHaveLength(2);
    for (const [, params] of audits) {
      const metadata = JSON.parse(String((params as unknown[])[3]));
      expect(metadata).toMatchObject({
        reason: 'partial_refund',
        order_id: 'order-1',
        pack_refund_id: result.packRefundId,
        letters_refunded: 2
      });
    }
    expect((audits[0][1] as unknown[])[1]).toBe(2);
    expect((audits[1][1] as unknown[])[1]).toBe(2);
  });

  it('takes the credits off the balance and lifetime purchases, and books the movement', async () => {
    router({ order: { credits: 10, amount_cents: 1000 }, lots: [{ ledger_id: 'lot-a', remaining_amount: 10 }] });
    await refundPackLetters({ ...baseInput, letters: 3 }, undefined, ENABLED_ENV);

    const userUpdate = calls('SET credits = GREATEST(credits - $1, 0)')[0];
    expect(String(userUpdate[0])).toContain('credits_purchased = GREATEST(credits_purchased - $1, 0)');
    expect(userUpdate[1]).toEqual([6, 'user-1']);
    expect(calls('INSERT INTO credit_transactions')[0][1]).toEqual([
      'user-1',
      -6,
      2,
      'order-1',
      expect.stringContaining('Proportional refund of 3 letters')
    ]);
    expect(calls('SET credits_refunded = credits_refunded + $2')[0][1]).toEqual(['order-1', 6]);
    // The operator audit row is written atomically with the revocation.
    const audit = calls("'pack_refund', 'order'")[0][1] as unknown[];
    expect(audit[3]).toBe('goodwill_unused');
    expect(JSON.parse(String(audit[5]))).toMatchObject({ letters: 3, amountCents: 600, lettersRemaining: 2 });
  });

  it('sends Stripe the computed amount, the command metadata, and the stored idempotency key', async () => {
    router({ order: { credits: 10, amount_cents: 1000 }, lots: [{ ledger_id: 'lot-a', remaining_amount: 10 }] });
    const result = await refundPackLetters({ ...baseInput, letters: 3 }, undefined, ENABLED_ENV);

    expect(mocks.createPartialPaymentRefund).toHaveBeenCalledTimes(1);
    expect(mocks.createPartialPaymentRefund).toHaveBeenCalledWith({
      paymentIntentId: 'pi-1',
      amountCents: 600,
      orderId: 'order-1',
      packRefundId: result.packRefundId,
      lettersRefunded: 3,
      idempotencyKey: `pack-refund:${result.packRefundId}`
    });
    // Stripe said succeeded: the row settles and the order's confirmed figure grows.
    expect(result.status).toBe('succeeded');
    expect(calls("SET status = 'succeeded', stripe_refund_id = $2")[0][1]).toEqual([result.packRefundId, 're-1']);
    expect(calls('SET amount_refunded_cents = amount_refunded_cents + $2')[0][1]).toEqual(['order-1', 600]);
  });

  it('parks the command when Stripe reports the refund pending', async () => {
    router({ order: { credits: 10, amount_cents: 1000 }, lots: [{ ledger_id: 'lot-a', remaining_amount: 10 }] });
    mocks.createPartialPaymentRefund.mockResolvedValue({ id: 're-p', status: 'pending' });
    const result = await refundPackLetters({ ...baseInput, letters: 3 }, undefined, ENABLED_ENV);
    expect(result.status).toBe('stripe_pending');
    expect(calls("SET status = 'stripe_pending', stripe_refund_id = $2")).toHaveLength(1);
    expect(calls('SET amount_refunded_cents = amount_refunded_cents + $2')).toHaveLength(0);
  });

  it('compensates the customer when Stripe refuses the refund outright', async () => {
    router({ order: { credits: 10, amount_cents: 1000 }, lots: [{ ledger_id: 'lot-a', remaining_amount: 10 }] });
    mocks.createPartialPaymentRefund.mockRejectedValue(
      Object.assign(new Error('Charge has already been refunded'), { code: 'charge_already_refunded' })
    );
    const result = await refundPackLetters({ ...baseInput, letters: 3 }, undefined, ENABLED_ENV);

    expect(result.status).toBe('compensated');
    const lot = calls("'adjustment', $3, $4, NOW(), $5, $6, 'active'")[0][1] as unknown[];
    expect(JSON.parse(String(lot[3]))).toMatchObject({
      reason: 'partial_refund_failed',
      pack_refund_id: result.packRefundId,
      compensates_ledger_id: 'audit-1'
    });
    expect(calls('SET credits = credits + $1, credits_purchased = credits_purchased + $1')).toHaveLength(1);
    const statusUpdate = calls("SET status = 'compensated'")[0][1] as unknown[];
    expect(statusUpdate[1]).toBe('charge_already_refunded');
    expect(calls("'pack_refund_failed', 'critical'")).toHaveLength(1);
  });

  it('leaves the letters revoked and counts the attempt when Stripe gives no answer', async () => {
    router({ order: { credits: 10, amount_cents: 1000 }, lots: [{ ledger_id: 'lot-a', remaining_amount: 10 }] });
    mocks.createPartialPaymentRefund.mockRejectedValue(
      Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' })
    );
    const result = await refundPackLetters({ ...baseInput, letters: 3 }, undefined, ENABLED_ENV);

    expect(result.status).toBe('letters_revoked');
    expect(calls('SET stripe_attempts = stripe_attempts + 1')).toHaveLength(1);
    expect(calls("'adjustment', $3, $4, NOW(), $5, $6, 'active'")).toHaveLength(0);
    expect(calls("SET status = 'compensated'")).toHaveLength(0);
  });

  it('withholds compensation while the account is blocked, and says so in the alert', async () => {
    const state = router({ order: { credits: 10, amount_cents: 1000 }, lots: [{ ledger_id: 'lot-a', remaining_amount: 10 }] });
    // The block lands after Phase 1 passed its own check: answer the
    // compensation's read with a reason.
    let reads = 0;
    const base = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes('SELECT sends_blocked_reason')) {
        reads += 1;
        return { rows: [{ sends_blocked_reason: reads > 1 ? 'dispute_open' : null }] };
      }
      return base(sql, params);
    });
    mocks.createPartialPaymentRefund.mockRejectedValue(
      Object.assign(new Error('disputed'), { code: 'refund_disputed_payment' })
    );
    const result = await refundPackLetters({ ...baseInput, letters: 3 }, undefined, ENABLED_ENV);

    expect(state.row).not.toBeNull();
    expect(result.status).toBe('failed');
    expect(calls("'adjustment', $3, $4, NOW(), $5, $6, 'active'")).toHaveLength(0);
    const alert = calls("'pack_refund_failed', 'critical'")[0][1] as unknown[];
    expect(JSON.parse(String(alert[1]))).toMatchObject({ compensationWithheld: 'payment_disputed' });
  });

  it('replays the first outcome for the same idempotency key and never calls Stripe again', async () => {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    router({
      replay: {
        operation: 'pack_refund',
        target_type: 'order',
        target_reference_hash: hash('order-1'),
        actor_subject_hash: hash('operator-1'),
        reason_code: 'goodwill_unused',
        after_state: { packRefundId: 'pr-first', letters: 1 }
      }
    });
    const result = await refundPackLetters(baseInput, undefined, ENABLED_ENV);
    expect(result).toMatchObject({ packRefundId: 'pr-first', replayed: true });
    expect(mocks.createPartialPaymentRefund).not.toHaveBeenCalled();
    expect(calls('INSERT INTO commerce_pack_refunds')).toHaveLength(0);

    // Same key, different intent: refused rather than silently replayed.
    expect(await refusal({ letters: 2 })).toBe('idempotency_conflict');
  });
});
