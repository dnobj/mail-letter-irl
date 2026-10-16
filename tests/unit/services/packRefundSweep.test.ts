import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/index.js', () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../../../src/services/commerceService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/commerceService.js')>()),
  compensatePackRefund: vi.fn(async () => 'compensated'),
  lockPackRefund: vi.fn(),
  raisePackRefundAlertOnce: vi.fn(async () => undefined),
  settlePackRefund: vi.fn(async () => 'succeeded'),
  recordOrderEvent: vi.fn(async () => undefined)
}));

import { query, transaction } from '../../../src/db/index.js';
import {
  compensatePackRefund,
  lockPackRefund,
  raisePackRefundAlertOnce,
  settlePackRefund,
  type PackRefundRow
} from '../../../src/services/commerceService.js';
import { reconcilePackRefunds } from '../../../src/services/packRefundService.js';
import { wholeRefundList } from '../../../src/services/stripeService.js';

const ROW = {
  pack_refund_id: 'pr-1',
  order_id: 'order-1',
  created_at: new Date(),
  user_id: 'user-1',
  letters: 2,
  credits: 4,
  amount_cents: 400,
  currency: 'usd',
  status: 'letters_revoked',
  stripe_payment_intent_id: 'pi-1',
  stripe_refund_id: null,
  stripe_idempotency_key: 'idem-1',
  stripe_attempts: 5
} as unknown as PackRefundRow;

const client = { query: vi.fn(async () => ({ rows: [] })) };

function stripeSeam(list: () => Promise<unknown[]>) {
  return {
    createPartialPaymentRefund: vi.fn(async () => ({ id: 're_new', status: 'pending' })),
    listPaymentRefunds: vi.fn(list),
    retrieveRefund: vi.fn()
  };
}

describe('the pack-refund sweep asks Stripe before it compensates (#730)', () => {
  beforeEach(() => {
    vi.stubEnv('PACK_REFUND_STRIPE_ATTEMPT_LIMIT', '5');
    vi.mocked(query).mockImplementation((async (sql: string) =>
      sql.includes("status = 'letters_revoked' AND updated_at") ? { rows: [ROW] } : { rows: [] }) as never);
    vi.mocked(transaction).mockImplementation((async (work: (c: typeof client) => unknown) => work(client)) as never);
    vi.mocked(lockPackRefund).mockResolvedValue({ ...ROW } as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('adopts a refund Stripe holds at the attempt limit, and compensates nothing', async () => {
    const stripe = stripeSeam(async () => [{ id: 're_late', status: 'succeeded', amount: 400, metadata: { packRefundId: 'pr-1' } }]);
    const result = await reconcilePackRefunds(stripe as never, { retryDelaySeconds: 60 });
    expect(result).toMatchObject({ adopted: 1, compensated: 0 });
    expect(settlePackRefund).toHaveBeenCalledWith(client, expect.objectContaining({ pack_refund_id: 'pr-1' }), expect.objectContaining({ id: 're_late', status: 'succeeded' }), 'pack_refund.sweep_adopted');
    expect(compensatePackRefund).not.toHaveBeenCalled();
    expect(stripe.createPartialPaymentRefund).not.toHaveBeenCalled();
  });

  it("does not adopt a refund that names the command for another amount: at the limit it is as if Stripe held none (#730)", async () => {
    const stripe = stripeSeam(async () => [{ id: 're_odd', status: 'succeeded', amount: 900, metadata: { packRefundId: 'pr-1' } }]);
    const result = await reconcilePackRefunds(stripe as never, { retryDelaySeconds: 60 });
    expect(result).toMatchObject({ adopted: 0, compensated: 1 });
    expect(settlePackRefund).not.toHaveBeenCalled();
    expect(compensatePackRefund).toHaveBeenCalledWith(client, expect.objectContaining({ pack_refund_id: 'pr-1' }), expect.objectContaining({ lastErrorCode: 'PACK_REFUND_NOT_AT_STRIPE' }));
  });

  it('adopts the refund for its amount when another names it too (#730)', async () => {
    const stripe = stripeSeam(async () => [
      { id: 're_odd', status: 'succeeded', amount: 900, metadata: { packRefundId: 'pr-1' } },
      { id: 're_ours', status: 'succeeded', amount: 400, metadata: { packRefundId: 'pr-1' } }
    ]);
    const result = await reconcilePackRefunds(stripe as never, { retryDelaySeconds: 60 });
    expect(result).toMatchObject({ adopted: 1, compensated: 0 });
    expect(settlePackRefund).toHaveBeenCalledWith(client, expect.anything(), expect.objectContaining({ id: 're_ours' }), 'pack_refund.sweep_adopted');
  });

  it("ignores another refund's metadata", async () => {
    const stripe = stripeSeam(async () => [{ id: 're_other', status: 'succeeded', metadata: { packRefundId: 'pr-2' } }]);
    const result = await reconcilePackRefunds(stripe as never, { retryDelaySeconds: 60 });
    expect(result).toMatchObject({ adopted: 0, compensated: 1 });
  });

  it('compensates at the attempt limit once Stripe says it holds no refund', async () => {
    const stripe = stripeSeam(async () => []);
    const result = await reconcilePackRefunds(stripe as never, { retryDelaySeconds: 60 });
    expect(result).toMatchObject({ compensated: 1, retried: 0 });
    expect(compensatePackRefund).toHaveBeenCalledWith(client, expect.objectContaining({ pack_refund_id: 'pr-1' }), expect.objectContaining({ lastErrorCode: 'PACK_REFUND_NOT_AT_STRIPE', failureReason: 'not_at_stripe' }));
    expect(stripe.createPartialPaymentRefund).not.toHaveBeenCalled();
  });

  it('waits, with one alert, when Stripe cannot be asked at the limit', async () => {
    const stripe = stripeSeam(async () => {
      throw Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' });
    });
    const result = await reconcilePackRefunds(stripe as never, { retryDelaySeconds: 60 });
    expect(result).toMatchObject({ compensated: 0, adopted: 0, retried: 0 });
    expect(compensatePackRefund).not.toHaveBeenCalled();
    expect(raisePackRefundAlertOnce).toHaveBeenCalledWith(client, expect.objectContaining({ pack_refund_id: 'pr-1' }), 'stripe_unconfirmed', expect.objectContaining({ attempts: 5 }));
    // Its turn moves back, so it does not hold the front of the queue.
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('SET updated_at = NOW()'), ['pr-1']);
  });

  it('writes nothing for a row that settled while Stripe could not be asked', async () => {
    vi.mocked(lockPackRefund).mockResolvedValue({ ...ROW, status: 'succeeded' } as never);
    const stripe = stripeSeam(async () => {
      throw new Error('down');
    });
    await reconcilePackRefunds(stripe as never, { retryDelaySeconds: 60 });
    expect(raisePackRefundAlertOnce).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('SET updated_at = NOW()'), expect.anything());
  });

  it('decides on a whole list of refunds only', () => {
    const refund = { id: 're_1' } as never;
    expect(wholeRefundList({ data: [refund], has_more: false })).toEqual([refund]);
    expect(() => wholeRefundList({ data: [refund], has_more: true })).toThrow(expect.objectContaining({ diagnosticClass: 'refund_list_incomplete' }));
  });

  it('alerts for a row below the limit once it has waited a day on a Stripe that cannot be asked', async () => {
    const old = { ...ROW, stripe_attempts: 1, created_at: new Date(Date.now() - 25 * 60 * 60 * 1000) };
    vi.mocked(query).mockImplementation((async (sql: string) =>
      sql.includes("status = 'letters_revoked' AND updated_at") ? { rows: [old] } : { rows: [] }) as never);
    vi.mocked(lockPackRefund).mockResolvedValue({ ...old } as never);
    const down = stripeSeam(async () => {
      throw new Error('down');
    });
    await reconcilePackRefunds(down as never, { retryDelaySeconds: 60 });
    expect(raisePackRefundAlertOnce).toHaveBeenCalledWith(client, expect.objectContaining({ pack_refund_id: 'pr-1' }), 'stripe_unconfirmed', expect.objectContaining({ attempts: 1 }));
    expect(compensatePackRefund).not.toHaveBeenCalled();
  });

  it('takes the least recently touched rows first', async () => {
    await reconcilePackRefunds(stripeSeam(async () => []) as never, { retryDelaySeconds: 60 });
    const [sql] = vi.mocked(query).mock.calls.find(([text]) => String(text).includes("status = 'letters_revoked' AND updated_at"))!;
    expect(String(sql)).toMatch(/ORDER BY updated_at ASC, created_at ASC/);
  });

  it('below the limit, retries the create when Stripe holds none, and stays quiet when it cannot be asked', async () => {
    vi.mocked(query).mockImplementation((async (sql: string) =>
      sql.includes("status = 'letters_revoked' AND updated_at") ? { rows: [{ ...ROW, stripe_attempts: 2 }] } : { rows: [] }) as never);
    const empty = stripeSeam(async () => []);
    expect(await reconcilePackRefunds(empty as never, { retryDelaySeconds: 60 })).toMatchObject({ retried: 1, compensated: 0 });
    expect(empty.createPartialPaymentRefund).toHaveBeenCalled();

    const down = stripeSeam(async () => {
      throw new Error('down');
    });
    await reconcilePackRefunds(down as never, { retryDelaySeconds: 60 });
    expect(raisePackRefundAlertOnce).not.toHaveBeenCalled();
    expect(compensatePackRefund).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('SET updated_at = NOW()'), ['pr-1']);
  });
});

describe('the "Stripe could not be asked" alert closes when the command settles (#730)', () => {
  it('is resolved when a letters_revoked command settles or is compensated, and not otherwise', async () => {
    const actual = await vi.importActual<typeof import('../../../src/services/commerceService.js')>(
      '../../../src/services/commerceService.js'
    );
    const resolved = (db: { query: ReturnType<typeof vi.fn> }) =>
      db.query.mock.calls.some(([sql, params]) => String(sql).includes("resolution_code = 'pack_refund_settled'") && (params as unknown[])[0] === 'pr-1');
    for (const outcome of ['succeeded', 'pending', 'failed'] as const) {
      const db = { query: vi.fn(async (..._args: unknown[]) => ({ rows: [] })) };
      await actual.settlePackRefund(db as never, { ...ROW } as PackRefundRow, { id: 're_1', status: outcome }, 'refund.updated');
      expect(resolved(db), outcome).toBe(true);
    }
    const settled = { query: vi.fn(async (..._args: unknown[]) => ({ rows: [] })) };
    await actual.settlePackRefund(settled as never, { ...ROW, status: 'succeeded' } as PackRefundRow, { id: 're_1', status: 'succeeded' }, 'refund.updated');
    expect(resolved(settled)).toBe(false);
  });
});

describe('a refund that succeeds after it was given up on (#730)', () => {
  it('raises one alert for a compensated or failed row, and none for a settled one', async () => {
    const actual = await vi.importActual<typeof import('../../../src/services/commerceService.js')>(
      '../../../src/services/commerceService.js'
    );
    for (const status of ['compensated', 'failed', 'succeeded'] as const) {
      const db = { query: vi.fn(async (..._args: unknown[]) => ({ rows: [] })) };
      await actual.settlePackRefund(db as never, { ...ROW, status } as PackRefundRow, { id: 're_1', status: 'succeeded' }, 'refund.updated');
      const alert = db.query.mock.calls.find(([sql]) => String(sql).includes("'pack_refund_failed'"));
      if (status === 'succeeded') {
        expect(alert, status).toBeUndefined();
      } else {
        expect(alert, status).toBeDefined();
        const [sql, params] = alert as unknown as [string, unknown[]];
        expect(sql).toContain('WHERE NOT EXISTS');
        const kind = status === 'compensated' ? 'refunded_after_compensation' : 'refunded_after_withheld';
        expect(JSON.parse(String(params[1]))).toMatchObject({ packRefundId: 'pr-1', kind, settledAfter: status, stripeRefundId: 're_1' });
        expect(params.slice(2)).toEqual(['pr-1', kind]);
      }
    }
  });
});
