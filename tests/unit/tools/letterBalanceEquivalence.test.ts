/**
 * Pins the equivalence the preview cards rely on when refreshing after a
 * Letter Pack purchase (#306).
 *
 * THE PROBLEM THIS GUARDS.
 *
 * The two sides of the same decision are expressed in different units:
 *
 *   server:  canSendNow = availableCredits >= requiredCredits   (credits)
 *   widget:  lettersRemaining >= lettersRequired                (letters)
 *
 * The widget cannot see credits. get_account_balance reports lettersRemaining,
 * a FLOORED conversion, and lettersRequired is a CEILED one - so the two
 * comparisons are only equivalent by arithmetic coincidence, not by
 * construction. With today's flat pricing (requiredCredits is 2 for both
 * letters and postcards, and 2 credits make a letter) they agree exactly for
 * every balance. Change the pricing and they stop agreeing silently.
 *
 * Concretely, if estimateRequiredCredits ever returned 3:
 *   lettersRequired  = ceil(3 / 2) = 2
 *   3 credits        -> floor(3 / 2) = 1 letter
 *   widget: 1 >= 2 -> "you cannot send"
 *   server: 3 >= 3 -> the user CAN send
 * The customer would be told they are short, having paid. This test fails
 * first, and names the widget as the thing to revisit.
 *
 * WHAT IS REAL AND WHAT IS MIRRORED.
 *
 * requiredCredits comes from the real estimateRequiredCredits, and
 * lettersRemaining from the real get_account_balance handler - so a change to
 * either is caught. The one mirrored line is lettersRequired's formula
 * (letterHelpers.ts:519), which is computed inline mid-quote and cannot be
 * imported. That mirror is safe precisely because requiredCredits above it is
 * real: a pricing change moves requiredCredits, which moves the mirrored
 * value, which breaks the property.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../../src/contracts/types.js';

vi.mock('../../../src/services/creditService.js', () => ({
  getBalance: vi.fn(),
  getDetailedBalance: vi.fn()
}));
vi.mock('../../../src/services/userService.js', () => ({
  findUser: vi.fn()
}));
vi.mock('../../../src/services/imageGenerationLimitService.js', () => ({
  getGenerationQuota: vi.fn()
}));

import { getDetailedBalance } from '../../../src/services/creditService.js';
import { findUser } from '../../../src/services/userService.js';
import { getGenerationQuota } from '../../../src/services/imageGenerationLimitService.js';
import { getAccountBalanceTool } from '../../../src/tools/getAccountBalance.js';
import { estimateRequiredCredits } from '../../../src/services/previewService.js';

const mockGetDetailedBalance = getDetailedBalance as ReturnType<typeof vi.fn>;
const mockFindUser = findUser as ReturnType<typeof vi.fn>;
const mockGetGenerationQuota = getGenerationQuota as ReturnType<typeof vi.fn>;

function context(creditsRemaining: number): ToolContext {
  return {
    user: { userId: 'google-oauth2|test-123', creditsRemaining, orders: [] },
    correlationId: 'test-correlation-id',
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn()
    },
    now: () => new Date('2026-01-15T12:00:00Z'),
    persist: vi.fn()
  } as unknown as ToolContext;
}

/** lettersRemaining for a credit balance, via the real conversion. */
async function lettersFor(credits: number): Promise<number> {
  mockGetDetailedBalance.mockResolvedValue({
    totalAvailable: credits,
    expiringSoon: 0,
    expiringDates: [],
    neverExpiring: credits,
    bySource: []
  });
  const result = await getAccountBalanceTool.handler({} as never, context(credits));
  return result.lettersRemaining;
}

describe('letters/credits equivalence relied on by the preview cards (#306)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUser.mockResolvedValue({
      user_id: 'google-oauth2|test-123',
      email: 'test@example.com'
    });
    mockGetGenerationQuota.mockResolvedValue({ used: 0, allowance: 25, remaining: 25 });
  });

  it('agrees with the server rule at every balance a customer could hold', async () => {
    const requiredCredits = estimateRequiredCredits('Just a quick hello.', 'Best, David');
    // Mirrors letterHelpers.ts:519 - see the header for why this mirror is safe.
    const lettersRequired = Math.max(1, Math.ceil(requiredCredits / 2));

    for (let credits = 0; credits <= 12; credits += 1) {
      const letters = await lettersFor(credits);
      expect(
        letters >= lettersRequired,
        `${credits} credits -> ${letters} letters: widget says ` +
          `${letters >= lettersRequired}, server says ${credits >= requiredCredits}`
      ).toBe(credits >= requiredCredits);
    }
  });

  it('costs the same regardless of letter content, which is what makes it hold', async () => {
    // Not decoration: the equivalence survives only while cost is flat. A
    // length-dependent price is the realistic way this breaks, and the
    // function's own signature (bodyText, signOff, charsPerPage) says it was
    // built to allow one.
    const short = estimateRequiredCredits('Hi.', '- D');
    const long = estimateRequiredCredits('x'.repeat(4000), 'Yours sincerely, David');

    expect(long).toBe(short);
  });

  it('reports whole letters only, never a fraction', async () => {
    // The floor is the other half of the coincidence. If lettersRemaining ever
    // became fractional the widget's >= comparison would start passing at
    // balances the server rejects.
    for (const credits of [0, 1, 2, 3, 5, 7]) {
      const letters = await lettersFor(credits);
      expect(Number.isInteger(letters)).toBe(true);
    }
  });
});
