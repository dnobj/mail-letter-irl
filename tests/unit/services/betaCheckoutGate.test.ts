import { afterEach, describe, expect, it, vi } from 'vitest';
import { BetaAccessDeniedError } from '../../../src/auth/betaAccess.js';

/**
 * A refused account must never be charged (#179).
 *
 * The cohort check sits at the top of both checkout functions, before the
 * price catalog, before the database, and long before Stripe. The assertion
 * that actually proves that is the Stripe stub's CALL COUNT: a check placed
 * after session creation would still throw, and a test that only asserted the
 * throw would pass while the customer's card had already been charged.
 *
 * Same reasoning the file already applies to sends_blocked in
 * createJitCheckout: refuse before a charge exists, never during fulfilment.
 */

const mocks = vi.hoisted(() => ({
  createJitSession: vi.fn(),
  createPackSession: vi.fn(),
  query: vi.fn(),
  transaction: vi.fn(),
  ensurePriceCatalog: vi.fn()
}));

vi.mock('../../../src/services/stripeService.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/services/stripeService.js')>();
  return {
    ...actual,
    createJitCheckoutSession: mocks.createJitSession,
    createPackCheckoutSession: mocks.createPackSession,
    isJitPurchaseEnabled: () => true
  };
});

vi.mock('../../../src/db/index.js', () => ({
  query: mocks.query,
  transaction: mocks.transaction
}));

vi.mock('../../../src/services/priceCatalog.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/services/priceCatalog.js')>();
  return { ...actual, ensurePriceCatalog: mocks.ensurePriceCatalog };
});

import { createJitCheckout, createPackCheckout } from '../../../src/services/commerceService.js';

const ADMITTED = 'auth0|admitted';
const REFUSED = 'auth0|refused';

function gateUp() {
  vi.stubEnv('LETTER_IRL_BETA_GATE_ENABLED', 'true');
  vi.stubEnv('LETTER_IRL_BETA_ALLOWED_SUBJECTS', ADMITTED);
  vi.stubEnv('LETTER_IRL_ADMIN_USER_IDS', '');
}

describe('checkout refuses before any charge', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('refuses a pack purchase without calling Stripe', async () => {
    gateUp();

    await expect(
      createPackCheckout({
        userId: REFUSED,
        userEmail: 'refused@example.com',
        productId: 'credit-pack-10' as never,
        successUrl: 'https://example/ok',
        cancelUrl: 'https://example/no'
      })
    ).rejects.toBeInstanceOf(BetaAccessDeniedError);

    // The assertion that proves the placement is PRE-charge.
    expect(mocks.createPackSession).not.toHaveBeenCalled();
  });

  it('refuses a Pay & Send checkout without calling Stripe', async () => {
    gateUp();

    await expect(
      createJitCheckout({ userId: REFUSED, draftId: 'draft-1' })
    ).rejects.toBeInstanceOf(BetaAccessDeniedError);

    expect(mocks.createJitSession).not.toHaveBeenCalled();
  });

  it('does not even reach the price catalog or the database', async () => {
    // Cheap to check and worth pinning: a refused request should cost nothing.
    gateUp();

    await expect(
      createJitCheckout({ userId: REFUSED, draftId: 'draft-1' })
    ).rejects.toBeInstanceOf(BetaAccessDeniedError);

    expect(mocks.ensurePriceCatalog).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('lets an admitted subject past the gate', async () => {
    // It will fail later on the unmocked path - the point is only that it gets
    // past the gate, so the guard is not refusing everyone.
    gateUp();
    mocks.ensurePriceCatalog.mockResolvedValue(undefined);
    mocks.query.mockResolvedValue({ rows: [{ sends_blocked_reason: null }] });

    await expect(
      createJitCheckout({ userId: ADMITTED, draftId: 'draft-1' })
    ).rejects.not.toBeInstanceOf(BetaAccessDeniedError);
  });

  it('is inert while the gate is down', async () => {
    vi.stubEnv('LETTER_IRL_BETA_GATE_ENABLED', 'false');
    mocks.ensurePriceCatalog.mockResolvedValue(undefined);
    mocks.query.mockResolvedValue({ rows: [{ sends_blocked_reason: null }] });

    await expect(
      createJitCheckout({ userId: REFUSED, draftId: 'draft-1' })
    ).rejects.not.toBeInstanceOf(BetaAccessDeniedError);
  });
});
