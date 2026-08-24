/**
 * The one Stripe mock. Four suites used to declare their own near-identical
 * MockStripe classes with subtly different surfaces - two of them disagreed on
 * whether a Price carries `active`, so they exercised different validation
 * paths for what was meant to be the same object (#278 review). Adding a
 * Stripe surface now means editing one file.
 *
 * Usage (the vi.mock factory must be self-contained, so callers pass the
 * hoisted fns in):
 *
 *   const stripeMocks = vi.hoisted(() => createStripeMockFns());
 *   vi.mock('stripe', () => stripeMockModule(stripeMocks));
 */

import { vi } from 'vitest';

export interface StripeMockFns {
  sessionCreate: ReturnType<typeof vi.fn>;
  sessionList: ReturnType<typeof vi.fn>;
  priceRetrieve: ReturnType<typeof vi.fn>;
  refundList: ReturnType<typeof vi.fn>;
  refundCreate: ReturnType<typeof vi.fn>;
  refundRetrieve: ReturnType<typeof vi.fn>;
  constructEvent: ReturnType<typeof vi.fn>;
}

export function createStripeMockFns(): StripeMockFns {
  return {
    sessionCreate: vi.fn(),
    sessionList: vi.fn(),
    priceRetrieve: vi.fn(),
    refundList: vi.fn(),
    refundCreate: vi.fn(),
    refundRetrieve: vi.fn(),
    constructEvent: vi.fn()
  };
}

export function stripeMockModule(fns: StripeMockFns): { default: unknown } {
  return {
    default: class MockStripe {
      checkout = { sessions: { create: fns.sessionCreate, list: fns.sessionList } };
      prices = { retrieve: fns.priceRetrieve };
      refunds = { list: fns.refundList, create: fns.refundCreate, retrieve: fns.refundRetrieve };
      webhooks = { constructEvent: fns.constructEvent };
      /** Captured so tests can pin timeout/maxNetworkRetries (#277, #278). */
      static lastConstructorArgs: unknown[] | null = null;
      constructor(...args: unknown[]) {
        MockStripe.lastConstructorArgs = args;
      }
    }
  };
}

/**
 * A Price as this app's validation needs to see it. Defaults describe a
 * healthy, active, in-band USD price; override per case. `active` is present
 * by default deliberately - omitting it exercises the inactive refusal, which
 * one of the old inline mocks did by accident.
 */
export function priceFixture(
  overrides: Partial<{
    id: string;
    active: boolean;
    unit_amount: number | null;
    currency: string;
    product: string;
  }> = {}
): Record<string, unknown> {
  return {
    id: 'price_fixture',
    active: true,
    unit_amount: 1000,
    currency: 'usd',
    product: 'prod_fixture',
    ...overrides
  };
}
