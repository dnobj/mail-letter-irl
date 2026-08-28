/**
 * friendlyCheckoutError is the last translator between a classified commerce
 * fault and the words a paying customer reads. Terminality is DERIVED from
 * the carried class (#278 round 6): a terminal fault must never carry retry
 * advice no retry can honor, and a blip must never read as permanent.
 */

import { describe, expect, it } from 'vitest';
import { friendlyCheckoutError } from '../../../src/tools/createMailCheckout.js';
import { friendlyDraftError as letterDraftError } from '../../../src/tools/sendLetter.js';
import { friendlyDraftError as postcardDraftError } from '../../../src/tools/sendPostcard.js';

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
    // And the message is SERVER-AUTHORED: forwarding the upstream text
    // carried the internal block label (users.sends_blocked_reason) to the
    // customer, the one exemption in a function whose job is producing
    // customer-safe copy (#278 round 12).
    expect(friendly.message).not.toMatch(/fraud_review/);
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

/**
 * The same guarantee on the SEND surface. `friendlyCheckoutError` is
 * default-deny (every branch returns server-authored text); the send tools'
 * `friendlyDraftError` is default-allow, so an unmapped code forwards the
 * upstream message verbatim - which for ACCOUNT_SENDS_BLOCKED carries the
 * internal users.sends_blocked_reason label. Round 12 fixed the checkout
 * surface only; four round-13 angles found the send path still open, and it
 * is the higher-traffic one because Pay & Send ships disabled (#278 r13).
 */
describe('account-blocked wording on the send surface (#278)', () => {
  // Round 13 pinned this by GREPPING the two source files, which cannot fail
  // for the defect it exists to catch: a round-14 angle replaced the branch's
  // return with a no-op - so the raw label reached the customer again - and
  // the suite still passed. Exercise the formatter instead (#278 round 14).
  it.each([
    ['send_letter', letterDraftError],
    ['send_postcard', postcardDraftError]
  ])('%s redacts the internal block label', (_name, friendlyDraftError) => {
    // The shape mailSendService actually throws: draftError() Object.assigns
    // .code onto an Error whose message interpolates users.sends_blocked_reason.
    const upstream = Object.assign(
      new Error('Sending is disabled on this account (payment_disputed). Contact support.'),
      { code: 'ACCOUNT_SENDS_BLOCKED' }
    );

    const friendly = friendlyDraftError(upstream, 'draft-1');

    // The assertion that encodes the requirement: the moderation label is gone.
    expect(friendly.message).not.toContain('payment_disputed');
    expect(friendly.message).toBe('Sending is disabled on this account. Please contact support.');
  });

  it.each([
    ['send_letter', letterDraftError],
    ['send_postcard', postcardDraftError]
  ])('%s reaches the block branch BEFORE any earlier return', (_name, friendlyDraftError) => {
    // A grep passes on a branch placed below the default-allow tail. This
    // fails if the branch is ever moved or made unreachable.
    const upstream = Object.assign(new Error('raw upstream text'), {
      code: 'ACCOUNT_SENDS_BLOCKED'
    });

    expect(friendlyDraftError(upstream, 'draft-1').message).not.toBe('raw upstream text');
  });
});
