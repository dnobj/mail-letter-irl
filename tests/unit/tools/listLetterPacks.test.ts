/**
 * Unit tests for list_letter_packs.
 *
 * The card bought the smallest pack without asking, because it had no way to
 * know what sizes existed or what they cost. Putting that in the quote output
 * would have tripled the price lookups on a path the code has repeatedly been
 * trimmed to keep cheap, so it lives here instead - paid only when someone
 * actually wants to buy.
 *
 * It also fills a gap the card is incidental to: "what letter packs do you
 * sell?" had no tool answer, so the model could only infer one from prose.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../src/contracts/types.js';

const mocks = vi.hoisted(() => ({
  ensurePriceCatalog: vi.fn(),
  getPackProductConfig: vi.fn()
}));

vi.mock('../../../src/services/priceCatalog.js', () => ({
  ensurePriceCatalog: mocks.ensurePriceCatalog
}));
vi.mock('../../../src/services/stripeService.js', () => ({
  getPackProductConfig: mocks.getPackProductConfig
}));

import { listLetterPacksTool } from '../../../src/tools/listLetterPacks.js';
import { PACK_CHOICES, PACK_PRODUCTS } from '../../../src/config/products.js';

const context = {
  user: { userId: 'user-1', creditsRemaining: 0, orders: [] },
  correlationId: 'test-correlation',
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
  now: () => new Date('2026-09-02T12:00:00Z'),
  persist: vi.fn()
} as unknown as ToolContext;

/** Priced exactly as the catalogue expects. */
function pricedAsConfigured(productCode: string) {
  const definition = PACK_PRODUCTS.find(product => product.productCode === productCode)!;
  return {
    productCode,
    priceId: `price_${productCode}`,
    amountCents: definition.expectedAmountCents,
    currency: 'usd',
    name: definition.name,
    description: definition.description,
    credits: definition.credits
  };
}

describe('list_letter_packs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensurePriceCatalog.mockResolvedValue(undefined);
    mocks.getPackProductConfig.mockImplementation((code: string) => pricedAsConfigured(code));
  });

  it('lists every pack the catalogue sells, in customer terms', async () => {
    const result = await listLetterPacksTool.handler({}, context);

    expect(result.packs.map(pack => pack.pack)).toEqual(Object.keys(PACK_CHOICES));
    expect(result.packs.map(pack => pack.letters)).toEqual([2, 5, 50]);
  });

  it('takes letter counts from the catalogue, not from dividing credits', async () => {
    // credits/2 is only correct while pricing is flat, which
    // letterBalanceEquivalence.test.ts pins. The catalogue states the count
    // directly so this tool never has to know the ratio.
    const result = await listLetterPacksTool.handler({}, context);

    for (const option of result.packs) {
      const definition = PACK_PRODUCTS.find(
        product => product.productCode === PACK_CHOICES[option.pack]
      )!;
      expect(option.letters).toBe(definition.letters);
    }
  });

  it('formats the price server-side rather than leaving the widget to divide', async () => {
    // A widget dividing minor units by 100 is 100x wrong for zero-decimal
    // currencies this codebase declares support for (#278 round 6).
    const result = await listLetterPacksTool.handler({}, context);
    const starter = result.packs.find(pack => pack.pack === 'starter')!;

    expect(starter.amountCents).toBe(500);
    expect(starter.displayAmount).toBe('5.00');
  });

  it('omits a pack whose price has not resolved', async () => {
    // amountCents 0 is what an unresolved price yields, and createPackCheckout
    // refuses exactly that. Listing it would offer a button guaranteed to fail.
    mocks.getPackProductConfig.mockImplementation((code: string) =>
      code === 'credit-pack-10'
        ? { ...pricedAsConfigured(code), amountCents: 0 }
        : pricedAsConfigured(code)
    );

    const result = await listLetterPacksTool.handler({}, context);

    expect(result.packs.map(pack => pack.pack)).toEqual(['starter', 'power']);
  });

  it('omits a pack the catalogue no longer defines', async () => {
    mocks.getPackProductConfig.mockImplementation((code: string) =>
      code === 'credit-pack-100' ? null : pricedAsConfigured(code)
    );

    const result = await listLetterPacksTool.handler({}, context);

    expect(result.packs.map(pack => pack.pack)).toEqual(['starter', 'regular']);
  });

  it('answers with an empty list rather than throwing when nothing is priced', async () => {
    // Every pack unpriced is a configuration fault the customer cannot act on.
    // A refusal would read to the model as a broken tool rather than an
    // unavailable product.
    mocks.getPackProductConfig.mockImplementation((code: string) => ({
      ...pricedAsConfigured(code),
      amountCents: 0
    }));

    const result = await listLetterPacksTool.handler({}, context);

    expect(result.packs).toEqual([]);
    expect(result.message).toMatch(/temporarily unavailable/i);
  });

  it('warms the price catalogue before reading it', async () => {
    // Prices resolve lazily; a process that has not warmed would otherwise
    // report every pack as unpriced and answer "temporarily unavailable".
    await listLetterPacksTool.handler({}, context);

    expect(mocks.ensurePriceCatalog).toHaveBeenCalled();
  });

  it('never says "credit", and never exposes a product code', async () => {
    // The catalogue names its products after credits - 'credit-pack-4' is two
    // letters - so a leak here misstates the quantity as well as the word.
    const result = await listLetterPacksTool.handler({}, context);
    const surfaced = JSON.stringify(result) + listLetterPacksTool.description;

    expect(surfaced).not.toMatch(/credit/i);
  });
});
