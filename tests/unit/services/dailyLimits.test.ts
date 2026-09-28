import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../../../src/db/index.js', () => ({ query: mocks.query, transaction: mocks.transaction }));

import {
  configuredDailyLimit,
  dailyLimitNotice,
  DAILY_LIMIT_KEYS,
  effectiveDailyLimits,
  notifyOperatorOfLimit,
  recordDailyLimitRefusal,
  reportDailyLimitDefaults,
  reportDailyLimitReached,
  type DailyLimitKey
} from '../../../src/services/dailyLimits.js';
import * as diagnostics from '../../../src/utils/diagnosticLog.js';

/**
 * The daily limits' values in force, and what happens when one refuses
 * (migration 038). The SQL itself (expiry, the unique gate under concurrent
 * refusals) is proven against PostgreSQL in the integration suite.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mocks.query.mockReset();
  mocks.transaction.mockReset();
});

const ALERT_URL = 'https://hc-ping.example/abc123/fail';

describe('configured values', () => {
  it('reads each limit from its own variable, with its default', () => {
    vi.stubEnv('LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING', '100');
    vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP', '25');
    vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS', '20000');
    vi.stubEnv('LETTER_IRL_GIFT_DAILY_SEND_CAP', '7');
    expect(DAILY_LIMIT_KEYS.map((key) => configuredDailyLimit(key))).toEqual([100, 25, 20000, 7]);
    vi.unstubAllEnvs();
    expect(DAILY_LIMIT_KEYS.map((key) => configuredDailyLimit(key, {}))).toEqual([25, 3, 6000, 20]);
  });
});

describe('effectiveDailyLimits', () => {
  const rows = (list: Array<{ limit_key: string; user_id: string | null; value: number | string }>) => ({
    query: vi.fn(async () => ({ rows: list }))
  });

  it('keeps the configured value when nothing is set', async () => {
    const values = await effectiveDailyLimits(rows([]), ['account_daily_mail'], 'u1', { LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP: '4' });
    expect(values).toEqual({ account_daily_mail: 4 });
  });

  it('never lets an account value apply to a limit for everyone', async () => {
    // The table refuses such a row; this is the belt to that brace.
    const values = await effectiveDailyLimits(
      rows([{ limit_key: 'global_daily_mail', user_id: 'u1', value: 999 }]),
      ['global_daily_mail'],
      'u1',
      {}
    );
    expect(values.global_daily_mail).toBe(25);
  });

  it('ignores a key it was not asked for, an unknown key, and a value that is not a whole number', async () => {
    const values = await effectiveDailyLimits(
      rows([
        { limit_key: 'gift_daily_send', user_id: null, value: 1 },
        { limit_key: 'mystery', user_id: null, value: 1 },
        { limit_key: 'account_daily_mail', user_id: null, value: 'lots' },
        { limit_key: 'account_daily_mail', user_id: null, value: -1 }
      ]),
      ['account_daily_mail'],
      'u1',
      {}
    );
    expect(values).toEqual({ account_daily_mail: 3 });
  });

  it('accepts the value as the driver returns it', async () => {
    const values = await effectiveDailyLimits(
      rows([{ limit_key: 'account_daily_charge_cents', user_id: null, value: '12000' }]),
      ['account_daily_charge_cents'],
      'u1',
      {}
    );
    expect(values.account_daily_charge_cents).toBe(12000);
  });
});

/** A transaction whose client answers the counter's upsert as given. */
function recorderClient(opened: boolean) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO daily_limit_refusals')) return { rows: [{ opened, utc_day: '2026-09-28' }] };
      return { rows: [] };
    })
  };
  const transaction = vi.fn(async (callback: (c: typeof client) => Promise<unknown>) => callback(client));
  return { client, transaction };
}

describe('recordDailyLimitRefusal', () => {
  it('opens the day\'s alert and tells the operator on the first refusal', async () => {
    vi.spyOn(diagnostics, 'writeDiagnostic').mockImplementation(() => {});
    const { client, transaction } = recorderClient(true);
    const notify = vi.fn(async () => 'sent' as const);

    const outcome = await recordDailyLimitRefusal('account_daily_mail', 'auth0|u1', 25, {
      transaction: transaction as never,
      notify
    });

    expect(outcome).toEqual({ opened: true });
    const alert = client.query.mock.calls.find((call) => String(call[0]).includes('commerce_operational_alerts'));
    expect(alert).toBeDefined();
    expect(String(alert![0])).toContain("'daily_limit_reached', 'warning'");
    // The first account is named, so the alert links to it.
    expect(alert![1]).toEqual(['account_daily_mail', '2026-09-28', 25, 'auth0|u1']);
    expect(notify).toHaveBeenCalledWith('account_daily_mail', 25);
  });

  it('names no account for a limit that applies to everyone', async () => {
    vi.spyOn(diagnostics, 'writeDiagnostic').mockImplementation(() => {});
    const { client, transaction } = recorderClient(true);
    await recordDailyLimitRefusal('global_daily_mail', 'auth0|u1', 100, {
      transaction: transaction as never,
      notify: vi.fn(async () => 'sent' as const)
    });
    const alert = client.query.mock.calls.find((call) => String(call[0]).includes('commerce_operational_alerts'));
    expect(alert![1]).toEqual(['global_daily_mail', '2026-09-28', 100, null]);
  });

  it('only counts a later refusal the same day: no alert, no notice', async () => {
    const write = vi.spyOn(diagnostics, 'writeDiagnostic').mockImplementation(() => {});
    const { client, transaction } = recorderClient(false);
    const notify = vi.fn(async () => 'sent' as const);

    const outcome = await recordDailyLimitRefusal('account_daily_mail', 'auth0|u1', 25, {
      transaction: transaction as never,
      notify
    });

    expect(outcome).toEqual({ opened: false });
    expect(client.query.mock.calls.some((call) => String(call[0]).includes('commerce_operational_alerts'))).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith('info', 'limits.daily_limit_reached', {
      limit: 'account_daily_mail',
      firstToday: false
    });
  });

  it('counts per limit and UTC day, as the gate', async () => {
    vi.spyOn(diagnostics, 'writeDiagnostic').mockImplementation(() => {});
    const { client, transaction } = recorderClient(false);
    await recordDailyLimitRefusal('gift_daily_send', null, 20, { transaction: transaction as never, notify: vi.fn() });
    const upsert = String(client.query.mock.calls[0][0]);
    expect(upsert).toContain("(NOW() AT TIME ZONE 'UTC')::date");
    expect(upsert).toContain('ON CONFLICT (limit_key, utc_day)');
    expect(upsert).toContain('refusals = 1 AS opened');
  });

  it('tells nobody when the record does not commit', async () => {
    const notify = vi.fn(async () => 'sent' as const);
    const transaction = vi.fn(async () => {
      throw new Error('connection terminated');
    });
    await expect(
      recordDailyLimitRefusal('global_daily_mail', null, 100, { transaction: transaction as never, notify })
    ).rejects.toThrow('connection terminated');
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('reportDailyLimitReached', () => {
  it('never throws into the refusal, and logs a failed record by class', async () => {
    const write = vi.spyOn(diagnostics, 'writeDiagnostic').mockImplementation(() => {});
    mocks.transaction.mockRejectedValue(Object.assign(new Error('boom'), { code: 'ECONNRESET' }));

    expect(() => reportDailyLimitReached('global_daily_mail', null, 100)).not.toThrow();
    await vi.waitFor(() =>
      expect(write).toHaveBeenCalledWith('error', 'limits.refusal_record_failed', {
        limit: 'global_daily_mail',
        errorClass: 'ECONNRESET'
      })
    );
  });

  it('runs on the pool, never on a caller\'s transaction', async () => {
    vi.spyOn(diagnostics, 'writeDiagnostic').mockImplementation(() => {});
    mocks.transaction.mockResolvedValue(false);
    reportDailyLimitReached('account_daily_mail', 'u1', 25);
    await vi.waitFor(() => expect(mocks.transaction).toHaveBeenCalledTimes(1));
  });
});

describe('notifyOperatorOfLimit', () => {
  const okFetch = () => vi.fn(async () => new Response('OK', { status: 200 }));

  it('does nothing when no address is set', async () => {
    const fetchImpl = okFetch();
    expect(await notifyOperatorOfLimit('global_daily_mail', 100, {}, fetchImpl as never)).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an address that is not https, and says so without naming it', async () => {
    const write = vi.spyOn(diagnostics, 'writeDiagnostic').mockImplementation(() => {});
    const fetchImpl = okFetch();
    for (const bad of ['http://hc-ping.example/x/fail', 'https://user:pass@hc-ping.example/x', 'not a url']) {
      expect(await notifyOperatorOfLimit('global_daily_mail', 100, { LETTER_IRL_OPERATOR_ALERT_URL: bad }, fetchImpl as never)).toBe('invalid');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(write.mock.calls)).not.toContain('hc-ping');
  });

  it('posts the notice as plain text, with the environment and the value in force', async () => {
    const fetchImpl = okFetch();
    const env = { LETTER_IRL_OPERATOR_ALERT_URL: ALERT_URL, RAILWAY_ENVIRONMENT_NAME: 'production' };
    expect(await notifyOperatorOfLimit('account_daily_charge_cents', 20000, env, fetchImpl as never)).toBe('sent');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ALERT_URL);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(
      "Letter IRL (production): the daily limit on spending per account per day ($200.00) refused a customer for the first time today (UTC). Review it, or raise it, on the admin panel's Limits page."
    );
  });

  it('reports a refused post and a network failure by status or class, never the URL', async () => {
    const write = vi.spyOn(diagnostics, 'writeDiagnostic').mockImplementation(() => {});
    const env = { LETTER_IRL_OPERATOR_ALERT_URL: ALERT_URL };
    const refused = vi.fn(async () => new Response('no', { status: 404 }));
    expect(await notifyOperatorOfLimit('global_daily_mail', 100, env, refused as never)).toBe('failed');
    expect(write).toHaveBeenCalledWith('warn', 'limits.operator_alert_failed', { status: 404 });

    const down = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    });
    expect(await notifyOperatorOfLimit('global_daily_mail', 100, env, down as never)).toBe('failed');
    expect(write).toHaveBeenCalledWith('warn', 'limits.operator_alert_failed', { errorClass: 'ECONNREFUSED' });

    const slow = vi.fn(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    expect(await notifyOperatorOfLimit('global_daily_mail', 100, env, slow as never)).toBe('failed');
    expect(write).toHaveBeenCalledWith('warn', 'limits.operator_alert_failed', { errorClass: 'ETIMEDOUT' });
    expect(JSON.stringify(write.mock.calls)).not.toContain('hc-ping');
  });

  it('words each limit, and letters as numbers', () => {
    const notices = (['global_daily_mail', 'account_daily_mail', 'gift_daily_send'] as DailyLimitKey[]).map((key) =>
      dailyLimitNotice(key, 25, {})
    );
    expect(notices[0]).toContain('letters per day, all accounts (25)');
    expect(notices[1]).toContain('letters per account per day (25)');
    expect(notices[2]).toContain('gift letters per day, all accounts (25)');
    expect(notices[0].startsWith('Letter IRL: ')).toBe(true);
  });
});

describe('reportDailyLimitDefaults', () => {
  it('writes every limit the process runs with, in one statement', async () => {
    const target = { query: vi.fn(async () => ({ rows: [] })) };
    const env = {
      LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING: '100',
      LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP: '25',
      LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS: '20000'
    };
    expect(await reportDailyLimitDefaults(env, target as never)).toBe(true);
    expect(target.query).toHaveBeenCalledTimes(1);
    const [sql, params] = target.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (limit_key) DO UPDATE');
    expect(params).toEqual([[...DAILY_LIMIT_KEYS], [100, 25, 20000, 20]]);
  });

  it('keeps a huge configured value inside the column', async () => {
    const target = { query: vi.fn(async () => ({ rows: [] })) };
    await reportDailyLimitDefaults({ LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS: '99999999999' }, target as never);
    const params = (target.query.mock.calls[0] as unknown as [string, number[][]])[1];
    expect(params[1][2]).toBe(2_147_483_647);
  });

  it('never throws, and logs a failure by class', async () => {
    const write = vi.spyOn(diagnostics, 'writeDiagnostic').mockImplementation(() => {});
    const target = { query: vi.fn(async () => { throw Object.assign(new Error('x'), { code: '42P01' }); }) };
    expect(await reportDailyLimitDefaults({}, target as never)).toBe(false);
    expect(write).toHaveBeenCalledWith('warn', 'limits.defaults_report_failed', { errorClass: '42P01' });
  });
});
