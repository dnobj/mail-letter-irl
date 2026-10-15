/**
 * Telling the operator (#699): one plain-text POST per kind an hour per
 * process, to LETTER_IRL_OPERATOR_ALERT_URL, naming no customer. Never throws,
 * never logs the URL. The daily-limit notice shares the sender
 * (dailyLimits.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as diagnostics from '../../../src/utils/diagnosticLog.js';
import {
  OPERATOR_NOTICE_WINDOW_MS,
  OPERATOR_NOTICES,
  notifyOperator,
  operatorNoticeText,
  postOperatorNotice,
  reportToOperator,
  resetOperatorNoticesForTests,
  settleOperatorNotices
} from '../../../src/services/operatorNotify.js';

const URL_SET = { LETTER_IRL_OPERATOR_ALERT_URL: 'https://hc-ping.example/secret-uuid/fail', RAILWAY_ENVIRONMENT_NAME: 'production' };

function okFetch() {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('OK', { status: 200 }));
}

beforeEach(() => {
  resetOperatorNoticesForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('notifyOperator', () => {
  it('posts the text as plain text, saying which environment it is from', async () => {
    const fetchImpl = okFetch();

    await expect(notifyOperator('missed_mail_day', 'Two letters are late.', { env: URL_SET, fetchImpl })).resolves.toBe('sent');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://hc-ping.example/secret-uuid/fail');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: 'Letter IRL (production): Two letters are late.'
    });
  });

  it('posts nothing while the URL is unset, and says a URL it cannot use is invalid', async () => {
    const fetchImpl = okFetch();
    const diagnostic = vi.spyOn(diagnostics, 'writeDiagnostic');

    await expect(notifyOperator('missed_mail_day', 'x', { env: {}, fetchImpl })).resolves.toBe('skipped');
    resetOperatorNoticesForTests();
    await expect(
      notifyOperator('missed_mail_day', 'x', { env: { LETTER_IRL_OPERATOR_ALERT_URL: 'http://hc-ping.example/x' }, fetchImpl })
    ).resolves.toBe('invalid');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledWith('warn', 'operator.alert_url_invalid');
  });

  it('posts one of each kind an hour: a repeat within it is left, and the next after it is posted', async () => {
    const fetchImpl = okFetch();
    let clock = 1_000_000;
    const options = { env: URL_SET, fetchImpl, now: () => clock };

    await expect(notifyOperator('ambiguous_outcome', 'one', options)).resolves.toBe('sent');
    clock += OPERATOR_NOTICE_WINDOW_MS - 1;
    await expect(notifyOperator('ambiguous_outcome', 'two', options)).resolves.toBe('repeat');
    // Another kind is its own.
    await expect(notifyOperator('held_mail_funding', 'three', options)).resolves.toBe('sent');
    clock += 1;
    await expect(notifyOperator('ambiguous_outcome', 'four', options)).resolves.toBe('sent');

    expect(fetchImpl.mock.calls.map(([, init]) => String(init?.body))).toEqual([
      'Letter IRL (production): one',
      'Letter IRL (production): three',
      'Letter IRL (production): four'
    ]);
  });

  it('holds the hour after a post that failed, so an endpoint that is down is not asked for every letter', async () => {
    const fetchImpl = vi.fn(async () => new Response('down', { status: 503 }));
    const diagnostic = vi.spyOn(diagnostics, 'writeDiagnostic');

    await expect(notifyOperator('provider_cancelled', 'x', { env: URL_SET, fetchImpl })).resolves.toBe('failed');
    await expect(notifyOperator('provider_cancelled', 'y', { env: URL_SET, fetchImpl })).resolves.toBe('repeat');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith('warn', 'operator.alert_failed', { status: 503 });
  });

  it('never throws, and never logs the URL, when the post cannot be made', async () => {
    const diagnostic = vi.spyOn(diagnostics, 'writeDiagnostic');
    const refused = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    });
    const slow = vi.fn(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });

    await expect(notifyOperator('missed_mail_day', 'x', { env: URL_SET, fetchImpl: refused })).resolves.toBe('failed');
    resetOperatorNoticesForTests();
    await expect(notifyOperator('missed_mail_day', 'x', { env: URL_SET, fetchImpl: slow })).resolves.toBe('failed');

    expect(diagnostic).toHaveBeenCalledWith('warn', 'operator.alert_failed', { errorClass: 'ECONNREFUSED' });
    expect(diagnostic).toHaveBeenCalledWith('warn', 'operator.alert_failed', { errorClass: 'ETIMEDOUT' });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('secret-uuid');
  });
});

describe('reportToOperator', () => {
  it('starts the notice without waiting, and settleOperatorNotices waits for it', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return new Response('OK', { status: 200 });
    });

    reportToOperator('held_mail_funding', 'held', { env: URL_SET, fetchImpl });
    let settled = false;
    const settling = settleOperatorNotices().then(() => {
      settled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    release();
    await settling;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('settles at once with nothing started', async () => {
    await expect(settleOperatorNotices()).resolves.toBeUndefined();
  });
});

describe('the words', () => {
  it('say what happened by count, singular or plural, and point to the Alerts page', () => {
    expect(OPERATOR_NOTICES.missedMailDay(1)).toBe(
      '1 letter with an arrival date did not reach the printer by 18:00 New York time on its mail day. See the Alerts page on the admin panel.'
    );
    expect(OPERATOR_NOTICES.missedMailDay(3)).toContain('3 letters with an arrival date did not reach the printer by 18:00 New York time on their mail day.');
    // True whatever paid: a Pay & Send letter's refund is a person's decision (review round 1).
    expect(OPERATOR_NOTICES.providerCancelled(1)).toBe(
      "The print provider cancelled 1 letter before printing. A prepaid or gift letter's payment goes back on its own; a critical alert means a person must decide a refund. See the Alerts page on the admin panel."
    );
    expect(OPERATOR_NOTICES.providerCancelled(2)).toContain('cancelled 2 letters before printing.');
    // True whatever the hold changed: a late signal on a settled job says so too.
    expect(OPERATOR_NOTICES.ambiguousOutcome()).toContain('the outcome is unknown, so it may need checking');
    expect(OPERATOR_NOTICES.heldMailFunding()).toContain('refunded or disputed');
    // Stale by the time someone reads it, perhaps: Stripe first (#730).
    expect(OPERATOR_NOTICES.refundNotCompleted()).toBe(
      'A refund failed or was cancelled at Stripe, and the order waits for a person instead of being refunded again. Check its refunds, any dispute and why the refund failed in Stripe before refunding it again. See the Alerts page on the admin panel.'
    );
  });

  it('prefix the environment only when one is named', () => {
    expect(operatorNoticeText('x', {})).toBe('Letter IRL: x');
    expect(operatorNoticeText('x', { RAILWAY_ENVIRONMENT: 'development' })).toBe('Letter IRL (development): x');
  });
});

describe('postOperatorNotice', () => {
  it("writes the caller's own diagnostics", async () => {
    const diagnostic = vi.spyOn(diagnostics, 'writeDiagnostic');
    const events = { invalid: 'mine.invalid', failed: 'mine.failed' };

    await postOperatorNotice('x', events, { LETTER_IRL_OPERATOR_ALERT_URL: 'ftp://x' }, okFetch());
    await postOperatorNotice('x', events, URL_SET, vi.fn(async () => new Response('', { status: 404 })));

    expect(diagnostic).toHaveBeenCalledWith('warn', 'mine.invalid');
    expect(diagnostic).toHaveBeenCalledWith('warn', 'mine.failed', { status: 404 });
  });
});
