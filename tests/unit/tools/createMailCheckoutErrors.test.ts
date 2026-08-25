/**
 * friendlyCheckoutError is the last translator between a classified commerce
 * fault and the words a paying customer reads. Terminality is DERIVED from
 * the carried class (#278 round 6): a terminal fault must never carry retry
 * advice no retry can honor, and a blip must never read as permanent.
 */

import { describe, expect, it } from 'vitest';
import { friendlyCheckoutError } from '../../../src/tools/createMailCheckout.js';

describe('friendlyCheckoutError terminality (#278)', () => {
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
