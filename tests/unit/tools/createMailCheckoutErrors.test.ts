/**
 * friendlyCheckoutError is the last translator between a classified commerce
 * fault and the words a paying customer reads. Terminality is DERIVED from
 * the carried class (#278 round 6): a terminal fault must never carry retry
 * advice no retry can honor, and a blip must never read as permanent.
 */

import { describe, expect, it } from 'vitest';
import { friendlyCheckoutError } from '../../../src/tools/createMailCheckout.js';

describe('friendlyCheckoutError terminality (#278)', () => {
  it('never tells a permanently blocked account to try again', () => {
    // ACCOUNT_SENDS_BLOCKED fell to the default branch, which replaced a
    // terminal block (carrying its own "contact support") with retry advice
    // no retry can honour - the precise mistake this function exists to
    // prevent (#278 round 11).
    const friendly = friendlyCheckoutError(
      Object.assign(new Error('Sending is disabled on this account (fraud_review). Contact support.'), {
        code: 'ACCOUNT_SENDS_BLOCKED'
      })
    );

    expect(friendly.message).not.toMatch(/try again/i);
    expect(friendly.message).toMatch(/support/i);
  });

  it('drops a non-string carried class instead of passing it on', () => {
    // The hand-rolled cast this replaced asserted the property was a string
    // without checking, so a non-string class flowed into the terminality
    // test and back out on the friendly error, where the server's own
    // carried read then rejected it and logged unknown_error (#278 round 9).
    const friendly = friendlyCheckoutError(
      Object.assign(new Error('internal detail'), {
        code: 'PROVIDER_ERROR',
        diagnosticClass: { nested: 'configuration_error' }
      })
    );

    expect((friendly as { diagnosticClass?: unknown }).diagnosticClass).toBeUndefined();
  });

  it.each([
    // [code, diagnosticClass, mustMatch, mustNotMatch]
    ['JIT_NOT_CONFIGURED', 'configuration_error', /not configured/, /try again/i],
    ['JIT_NOT_CONFIGURED', 'StripeConnectionError', /temporarily unavailable/, /not configured/],
    ['PACK_AMOUNT_NOT_CONFIGURED', 'amount_too_small', /not configured/, /try again/i],
    ['PROVIDER_ERROR', 'resource_missing', /cannot complete/, /try again/i],
    ['PROVIDER_ERROR', 'StripeConnectionError', /try again/i, /instead/]
  ])('%s + %s picks the right message', (code, diagnosticClass, mustMatch, mustNotMatch) => {
    const friendly = friendlyCheckoutError(
      Object.assign(new Error('internal detail'), { code, diagnosticClass })
    );

    expect(friendly.message).toMatch(mustMatch as RegExp);
    expect(friendly.message).not.toMatch(mustNotMatch as RegExp);
    // The classification survives the rebuild for the server log.
    expect((friendly as { diagnosticClass?: string }).diagnosticClass).toBe(diagnosticClass);
  });

  it('never leaks the internal message', () => {
    const friendly = friendlyCheckoutError(
      Object.assign(new Error('cs_private pi_private'), { code: 'PROVIDER_ERROR' })
    );
    expect(friendly.message).not.toContain('cs_private');
  });
});
