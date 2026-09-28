import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), reported: vi.fn() }));
vi.mock('../../../src/db/index.js', () => ({ query: mocks.query, transaction: vi.fn() }));
// The values in force stay real; the refusal report is watched, not run.
vi.mock('../../../src/services/dailyLimits.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/dailyLimits.js')>()),
  reportDailyLimitReached: mocks.reported
}));

import {
  assertChargeWithinDailyCap,
  assertGiftSendWithinDailyCap,
  assertMailWithinDailyCaps,
  SpendLimitError
} from '../../../src/services/betaSpendLimits.js';
import * as diagnostics from '../../../src/utils/diagnosticLog.js';

/**
 * The daily ceilings (#179).
 *
 * Nothing capped outbound mail or money before these. The only existing
 * ceiling, LETTER_IRL_IMAGE_DAILY_CEILING, fails OPEN by design - right there,
 * because image generation degrades to a free redirect card, and wrong for
 * anything that mails paper or charges a card. So the property these tests
 * care about most is the direction of failure.
 */

/** A client whose two COUNT queries answer independently. */
function client(counts: { perAccount?: number; global?: number } | 'malformed') {
  return {
    query: vi.fn(async (sql: string) => {
      if (counts === 'malformed') return { rows: [{}] };
      const scoped = sql.includes('user_id = $1');
      return {
        rows: [{ count: String(scoped ? (counts.perAccount ?? 0) : (counts.global ?? 0)) }]
      };
    })
  } as never;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mocks.query.mockReset();
  mocks.reported.mockReset();
});

describe('the per-account mail cap', () => {
  it('allows a send that lands exactly on the cap', async () => {
    vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP', '3');
    // Two already today plus this one is three: at the cap, not over it.
    await expect(
      assertMailWithinDailyCaps(client({ perAccount: 2 }), 'u1', 1)
    ).resolves.toBeUndefined();
  });

  it('refuses the one that would exceed it', async () => {
    vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP', '3');
    await expect(
      assertMailWithinDailyCaps(client({ perAccount: 3 }), 'u1', 1)
    ).rejects.toMatchObject({ code: 'ACCOUNT_DAILY_MAIL_CAP' });
  });

  it('counts an already-inserted row via inFlight 0, not by guessing', async () => {
    // The send path checks AFTER inserting the letters row, so the count
    // already includes it. Same three-item cap, same verdict, different offset:
    // this is why inFlight is a parameter rather than baked into each caller.
    vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP', '3');
    await expect(
      assertMailWithinDailyCaps(client({ perAccount: 3 }), 'u1', 0)
    ).resolves.toBeUndefined();
    await expect(
      assertMailWithinDailyCaps(client({ perAccount: 4 }), 'u1', 0)
    ).rejects.toMatchObject({ code: 'ACCOUNT_DAILY_MAIL_CAP' });
  });

  it('treats 0 as a kill switch, not as unlimited', async () => {
    vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP', '0');
    await expect(
      assertMailWithinDailyCaps(client({ perAccount: 0 }), 'u1', 1)
    ).rejects.toMatchObject({ code: 'ACCOUNT_DAILY_MAIL_CAP' });
  });
});

describe('the global mail ceiling', () => {
  it('refuses once the day is spent, even for an account well under its own cap', async () => {
    vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP', '3');
    vi.stubEnv('LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING', '25');
    await expect(
      assertMailWithinDailyCaps(client({ perAccount: 0, global: 25 }), 'u1', 1)
    ).rejects.toMatchObject({ code: 'GLOBAL_DAILY_MAIL_CEILING' });
  });

  it('does not tell the customer our operating numbers', async () => {
    vi.stubEnv('LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING', '25');
    try {
      await assertMailWithinDailyCaps(client({ global: 99 }), 'u1', 1);
      expect.unreachable('should have refused');
    } catch (error) {
      // The account cap names its number because the customer can act on it.
      // The global one is our posture and they cannot.
      expect((error as Error).message).not.toMatch(/\d/);
    }
  });
});

describe('the sending kill switch', () => {
  it('stops everything before a single count is run', async () => {
    vi.stubEnv('LETTER_IRL_MAIL_SENDING_ENABLED', 'false');
    const c = client({ perAccount: 0, global: 0 });
    await expect(assertMailWithinDailyCaps(c, 'u1', 1)).rejects.toMatchObject({
      code: 'MAIL_SENDING_DISABLED'
    });
    expect((c as unknown as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
  });

  it('stops on a TYPO, unlike the numeric caps', async () => {
    // The reason this is a separate boolean rather than "set the ceiling to
    // zero": positiveIntegerSetting falls back to its DEFAULT on an
    // unparseable value, so a mistyped ceiling silently restores 25.
    vi.stubEnv('LETTER_IRL_MAIL_SENDING_ENABLED', 'fasle');
    await expect(assertMailWithinDailyCaps(client({}), 'u1', 1)).rejects.toMatchObject({
      code: 'MAIL_SENDING_DISABLED'
    });

    vi.stubEnv('LETTER_IRL_MAIL_SENDING_ENABLED', 'true');
    vi.stubEnv('LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING', 'O');
    await expect(
      assertMailWithinDailyCaps(client({ global: 24 }), 'u1', 1)
    ).resolves.toBeUndefined();
  });
});

describe('failing closed', () => {
  it('refuses when a count cannot be read', async () => {
    // The opposite of the image ceiling, deliberately. "We could not check"
    // must never resolve to "go ahead" on a path that mails paper.
    await expect(assertMailWithinDailyCaps(client('malformed'), 'u1', 1)).rejects.toMatchObject({
      code: 'SPEND_LIMIT_UNVERIFIABLE'
    });
  });

  it('lets a query failure propagate rather than swallowing it', async () => {
    const c = { query: vi.fn().mockRejectedValue(new Error('connection terminated')) } as never;
    await expect(assertMailWithinDailyCaps(c, 'u1', 1)).rejects.toThrow('connection terminated');
  });
});

describe('the day window', () => {
  it('anchors both sides in UTC, and leaves the column bare', async () => {
    // letters.created_at is TIMESTAMP while image_generation_reservations is
    // TIMESTAMPTZ, so countGenerationsToday's `>= date_trunc('day', NOW())`
    // cannot be copied: comparing a timestamp against timestamptz converts
    // through the session time zone and moves the boundary. Wrapping the
    // COLUMN instead would fix the types and lose the index.
    const c = client({});
    await assertMailWithinDailyCaps(c, 'u1', 1);
    const sql = (c as unknown as { query: ReturnType<typeof vi.fn> }).query.mock.calls
      .map(call => String(call[0]))
      .join('\n');

    expect(sql).toContain("NOW() AT TIME ZONE 'UTC'");
    expect(sql).not.toMatch(/date_trunc\('day',\s*NOW\(\)\s*\)/);
    expect(sql).toMatch(/created_at >= date_trunc/);
  });

  it('applies no status filter', async () => {
    // A cap that forgives cancelled or failed rows is one an error loop walks
    // straight through.
    const c = client({});
    await assertMailWithinDailyCaps(c, 'u1', 1);
    const sql = (c as unknown as { query: ReturnType<typeof vi.fn> }).query.mock.calls
      .map(call => String(call[0]))
      .join('\n');
    expect(sql).not.toContain('status');
  });
});

describe('the per-account charge cap', () => {
  const spent = (cents: number) =>
    mocks.query.mockResolvedValue({ rows: [{ total: String(cents) }] });

  it('allows a purchase that lands exactly on the cap', async () => {
    vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS', '6000');
    spent(4000);
    await expect(assertChargeWithinDailyCap('u1', 2000)).resolves.toBeUndefined();
  });

  it('refuses the purchase that would exceed it', async () => {
    vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS', '6000');
    spent(4000);
    await expect(assertChargeWithinDailyCap('u1', 2001)).rejects.toMatchObject({
      code: 'ACCOUNT_DAILY_CHARGE_CAP'
    });
  });

  it('counts every order today whatever its status', async () => {
    // An abandoned checkout is still an intent to charge; excluding them would
    // let a retry loop walk past the ceiling.
    spent(0);
    await assertChargeWithinDailyCap('u1', 1);
    const sum = mocks.query.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes('SUM('));
    expect(sum).toBeDefined();
    expect(sum).not.toContain('status');
  });

  it('fails closed when the total cannot be read', async () => {
    mocks.query.mockResolvedValue({ rows: [{}] });
    await expect(assertChargeWithinDailyCap('u1', 1)).rejects.toMatchObject({
      code: 'SPEND_LIMIT_UNVERIFIABLE'
    });
  });

  it('is a SpendLimitError, so the send formatter forwards its wording', async () => {
    vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS', '100');
    spent(100);
    await expect(assertChargeWithinDailyCap('u1', 1)).rejects.toBeInstanceOf(SpendLimitError);
  });

  it('refuses a purchase above the whole day, and says tomorrow will not help', async () => {
    // The $90 Power Pack under the default $60 limit (2026-09-28): no account
    // could ever buy it, and "try again tomorrow" was untrue.
    const writeSpy = vi.spyOn(diagnostics, 'writeDiagnostic').mockImplementation(() => {});
    try {
      spent(0);
      const refusal = assertChargeWithinDailyCap('u1', 9000);
      await expect(refusal).rejects.toBeInstanceOf(SpendLimitError);
      await expect(refusal).rejects.toMatchObject({ code: 'CHARGE_ABOVE_DAILY_CAP' });
      await expect(refusal).rejects.toThrow('more than one account can spend in a day');
      await expect(refusal).rejects.not.toThrow(/tomorrow/);
      // Decided before the day's total is read: spending cannot change the answer.
      expect(mocks.query.mock.calls.some((call) => String(call[0]).includes('SUM('))).toBe(false);
      // Only the operator can fix it, so it is logged with both figures.
      expect(writeSpy).toHaveBeenCalledWith('error', 'commerce.purchase_above_daily_charge_cap', {
        amountCents: 9000,
        capCents: 6000
      });
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('still allows a purchase of exactly the whole day', async () => {
    vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS', '9000');
    spent(0);
    await expect(assertChargeWithinDailyCap('u1', 9000)).resolves.toBeUndefined();
  });
});

/**
 * The values in force (migration 038): an operator's value, set in the admin
 * panel, replaces the environment's; an account's own value replaces the one
 * for everyone. The expiry and the clearing are the query's (the PostgreSQL
 * suite proves those against real rows); these prove the choice between the
 * rows it returns.
 */
describe('operator values', () => {
  type Override = { limit_key: string; user_id: string | null; value: number };

  /** A client whose override read returns the given rows, and counts as given. */
  function withOverrides(overrides: Override[], counts: { perAccount?: number; global?: number; gifts?: number } = {}) {
    return {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM daily_limit_overrides')) return { rows: overrides };
        if (sql.includes("funding_type = 'gift_letter'")) return { rows: [{ count: String(counts.gifts ?? 0) }] };
        const scoped = sql.includes('user_id = $1');
        return { rows: [{ count: String(scoped ? (counts.perAccount ?? 0) : (counts.global ?? 0)) }] };
      })
    } as never;
  }

  it('raises the per-account letter limit for everyone', async () => {
    vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP', '3');
    const everyone = [{ limit_key: 'account_daily_mail', user_id: null, value: 10 }];
    await expect(assertMailWithinDailyCaps(withOverrides(everyone, { perAccount: 9 }), 'u1', 1)).resolves.toBeUndefined();
    await expect(assertMailWithinDailyCaps(withOverrides(everyone, { perAccount: 10 }), 'u1', 1)).rejects.toMatchObject({
      code: 'ACCOUNT_DAILY_MAIL_CAP',
      message: 'This account has reached its daily limit of 10 items. Please try again tomorrow.'
    });
  });

  it("lets an account's own value win over everyone's, in whatever order the rows come", async () => {
    vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP', '3');
    const rows = [
      { limit_key: 'account_daily_mail', user_id: 'u1', value: 40 },
      { limit_key: 'account_daily_mail', user_id: null, value: 5 }
    ];
    for (const order of [rows, [...rows].reverse()]) {
      await expect(assertMailWithinDailyCaps(withOverrides(order, { perAccount: 39 }), 'u1', 1)).resolves.toBeUndefined();
    }
  });

  it("ignores another account's value", async () => {
    vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP', '3');
    const other = [{ limit_key: 'account_daily_mail', user_id: 'u2', value: 40 }];
    await expect(assertMailWithinDailyCaps(withOverrides(other, { perAccount: 3 }), 'u1', 1)).rejects.toMatchObject({
      code: 'ACCOUNT_DAILY_MAIL_CAP'
    });
  });

  it('reads the values for this account and these limits only', async () => {
    const c = withOverrides([]);
    await assertMailWithinDailyCaps(c, 'u1', 1);
    const read = (c as unknown as { query: ReturnType<typeof vi.fn> }).query.mock.calls.find((call) =>
      String(call[0]).includes('FROM daily_limit_overrides')
    );
    expect(read).toBeDefined();
    expect(String(read![0])).toContain('cleared_at IS NULL');
    expect(String(read![0])).toContain('expires_at > NOW()');
    expect(read![1]).toEqual([['account_daily_mail', 'global_daily_mail'], 'u1']);
  });

  it('raises the letters-per-day ceiling for everyone', async () => {
    vi.stubEnv('LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING', '25');
    const raised = [{ limit_key: 'global_daily_mail', user_id: null, value: 200 }];
    await expect(assertMailWithinDailyCaps(withOverrides(raised, { global: 150 }), 'u1', 1)).resolves.toBeUndefined();
  });

  it('can lower a limit too: 0 stops that limit, like the environment 0', async () => {
    const zero = [{ limit_key: 'global_daily_mail', user_id: null, value: 0 }];
    await expect(assertMailWithinDailyCaps(withOverrides(zero), 'u1', 1)).rejects.toMatchObject({
      code: 'GLOBAL_DAILY_MAIL_CEILING'
    });
  });

  it('raises the money limit for one account', async () => {
    vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS', '6000');
    mocks.query.mockImplementation(async (sql: string) =>
      sql.includes('FROM daily_limit_overrides')
        ? { rows: [{ limit_key: 'account_daily_charge_cents', user_id: 'u1', value: 50000 }] }
        : { rows: [{ total: '20000' }] }
    );
    await expect(assertChargeWithinDailyCap('u1', 9000)).resolves.toBeUndefined();
  });

  it('raises the gift letter limit for everyone', async () => {
    vi.stubEnv('LETTER_IRL_GIFT_DAILY_SEND_CAP', '20');
    const raised = [{ limit_key: 'gift_daily_send', user_id: null, value: 30 }];
    await expect(assertGiftSendWithinDailyCap(withOverrides(raised, { gifts: 30 }))).resolves.toBeUndefined();
    await expect(assertGiftSendWithinDailyCap(withOverrides(raised, { gifts: 31 }))).rejects.toMatchObject({
      code: 'GIFT_DAILY_SEND_CAP'
    });
  });

  it('refuses when the values cannot be read, like any other count', async () => {
    const c = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM daily_limit_overrides')) throw new Error('relation does not exist');
        return { rows: [{ count: '0' }] };
      })
    } as never;
    await expect(assertMailWithinDailyCaps(c, 'u1', 1)).rejects.toThrow('relation does not exist');
  });
});

/**
 * A refusal is reported, so the first of the day opens an alert and tells the
 * operator (src/services/dailyLimits.ts); anything that is not a daily limit
 * is not.
 */
describe('refusal reports', () => {
  it('reports the per-account letter limit with its value in force', async () => {
    vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP', '3');
    await expect(assertMailWithinDailyCaps(client({ perAccount: 3 }), 'u1', 1)).rejects.toBeInstanceOf(SpendLimitError);
    expect(mocks.reported).toHaveBeenCalledWith('account_daily_mail', 'u1', 3);
  });

  it('reports the ceiling for everyone', async () => {
    vi.stubEnv('LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING', '25');
    await expect(assertMailWithinDailyCaps(client({ global: 25 }), 'u1', 1)).rejects.toBeInstanceOf(SpendLimitError);
    expect(mocks.reported).toHaveBeenCalledWith('global_daily_mail', 'u1', 25);
  });

  it('reports the money limit, both when the day is spent and when one purchase is above it', async () => {
    vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS', '6000');
    mocks.query.mockResolvedValue({ rows: [{ total: '6000' }] });
    await expect(assertChargeWithinDailyCap('u1', 1)).rejects.toMatchObject({ code: 'ACCOUNT_DAILY_CHARGE_CAP' });
    expect(mocks.reported).toHaveBeenLastCalledWith('account_daily_charge_cents', 'u1', 6000);
    vi.spyOn(diagnostics, 'writeDiagnostic').mockImplementation(() => {});
    await expect(assertChargeWithinDailyCap('u1', 9000)).rejects.toMatchObject({ code: 'CHARGE_ABOVE_DAILY_CAP' });
    expect(mocks.reported).toHaveBeenLastCalledWith('account_daily_charge_cents', 'u1', 6000);
    expect(mocks.reported).toHaveBeenCalledTimes(2);
  });

  it('reports the gift letter limit', async () => {
    vi.stubEnv('LETTER_IRL_GIFT_DAILY_SEND_CAP', '20');
    const c = { query: vi.fn(async () => ({ rows: [{ count: '21' }] })) } as never;
    await expect(assertGiftSendWithinDailyCap(c)).rejects.toMatchObject({ code: 'GIFT_DAILY_SEND_CAP' });
    expect(mocks.reported).toHaveBeenCalledWith('gift_daily_send', null, 20);
  });

  it('reports nothing for a send within the limits, the sending stop, or an unreadable count', async () => {
    await assertMailWithinDailyCaps(client({}), 'u1', 1);
    vi.stubEnv('LETTER_IRL_MAIL_SENDING_ENABLED', 'false');
    await expect(assertMailWithinDailyCaps(client({}), 'u1', 1)).rejects.toMatchObject({ code: 'MAIL_SENDING_DISABLED' });
    vi.unstubAllEnvs();
    await expect(assertMailWithinDailyCaps(client('malformed'), 'u1', 1)).rejects.toMatchObject({
      code: 'SPEND_LIMIT_UNVERIFIABLE'
    });
    expect(mocks.reported).not.toHaveBeenCalled();
  });
});
