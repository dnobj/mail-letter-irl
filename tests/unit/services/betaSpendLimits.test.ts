import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../../src/db/index.js', () => ({ query: mocks.query, transaction: vi.fn() }));

import {
  assertChargeWithinDailyCap,
  assertMailWithinDailyCaps,
  SpendLimitError
} from '../../../src/services/betaSpendLimits.js';

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
  mocks.query.mockReset();
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
    expect(String(mocks.query.mock.calls[0][0])).not.toContain('status');
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
});
