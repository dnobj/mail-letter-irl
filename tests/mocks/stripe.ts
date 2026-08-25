/**
 * The one Stripe mock. Several suites used to declare their own near-identical
 * MockStripe classes with subtly different surfaces - two of them disagreed on
 * whether a Price carries `active`, so they exercised different validation
 * paths for what was meant to be the same object (#278 review). Adding a
 * Stripe surface now means editing one file.
 *
 * Usage. `vi.hoisted` runs before imports, so the FNS must be created there
 * inline; the vi.mock FACTORY runs lazily, so it may call in here:
 *
 *   const stripeMocks = vi.hoisted(() => ({ sessionCreate: vi.fn(), ... }));
 *   vi.mock('stripe', () => stripeMockModule(stripeMocks));
 *
 * Every surface is optional - a suite passes only the fns it asserts on, and
 * the rest are inert stubs. That is what lets one class serve the checkout,
 * price, reconciliation and webhook suites without any of them carrying
 * methods they never touch.
 */

import { vi } from 'vitest';

export interface StripeMockFns {
  sessionCreate: ReturnType<typeof vi.fn>;
  sessionList: ReturnType<typeof vi.fn>;
  sessionRetrieve: ReturnType<typeof vi.fn>;
  priceRetrieve: ReturnType<typeof vi.fn>;
  refundList: ReturnType<typeof vi.fn>;
  refundCreate: ReturnType<typeof vi.fn>;
  refundRetrieve: ReturnType<typeof vi.fn>;
  constructEvent: ReturnType<typeof vi.fn>;
}

export function stripeMockModule(fns: Partial<StripeMockFns>): { default: unknown } {
  const stub = (): ReturnType<typeof vi.fn> => vi.fn();
  const sessionCreate = fns.sessionCreate ?? stub();
  const sessionList = fns.sessionList ?? stub();
  const sessionRetrieve = fns.sessionRetrieve ?? stub();
  // An inert default RESOLVED undefined - a shape real stripe-node can never
  // produce - so a suite that forgot to wire priceRetrieve silently recorded
  // a fake transient outage instead of failing (#278 round 7). Rejecting with
  // a PLAIN error only moved the problem: the catalog swallowed it as
  // price.lookup_failed/provider_error, which is the same fake outage. It
  // carries the catalog's own sentinel name, which that catch rethrows
  // (#278 round 9).
  const priceRetrieve =
    fns.priceRetrieve ??
    vi.fn(() =>
      Promise.reject(
        Object.assign(new Error('stripeMockModule: priceRetrieve not wired'), {
          name: 'PriceRetrieverMissingError'
        })
      )
    );
  const refundList = fns.refundList ?? stub();
  const refundCreate = fns.refundCreate ?? stub();
  const refundRetrieve = fns.refundRetrieve ?? stub();
  const constructEvent = fns.constructEvent ?? stub();
  return {
    default: class MockStripe {
      checkout = { sessions: { create: sessionCreate, list: sessionList, retrieve: sessionRetrieve } };
      prices = { retrieve: priceRetrieve };
      refunds = { list: refundList, create: refundCreate, retrieve: refundRetrieve };
      webhooks = { constructEvent };
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
    type: string;
    recurring: Record<string, unknown> | null;
  }> = {}
): Record<string, unknown> {
  return {
    id: 'price_fixture',
    active: true,
    unit_amount: 1000,
    currency: 'usd',
    product: 'prod_fixture',
    // A real Stripe Price ALWAYS carries these; omitting them made every
    // healthy-path test resolve through validate()'s absent-type leniency
    // branch instead of the shape production sees (#278 round 6).
    type: 'one_time',
    recurring: null,
    ...overrides
  };
}
