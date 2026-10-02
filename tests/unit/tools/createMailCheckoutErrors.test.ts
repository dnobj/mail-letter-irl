/**
 * friendlyCheckoutError is the last translator between a classified commerce
 * fault and the words a paying customer reads. Terminality is DERIVED from
 * the carried class (#278 round 6): a terminal fault must never carry retry
 * advice no retry can honor, and a blip must never read as permanent.
 */

import { describe, expect, it } from 'vitest';
import { friendlyCheckoutError } from '../../../src/tools/createMailCheckout.js';
import { SpendLimitError } from '../../../src/services/betaSpendLimits.js';
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

  it('refuses a missed mail date before any charge, with a new preview as the way on (#535)', () => {
    const friendly = friendlyCheckoutError(Object.assign(new Error('Draft has missed its mail date'), { code: 'SCHEDULE_PASSED' }));
    expect(friendly.message).toBe(
      'The day this mail was to go to the printer has passed, so it can no longer arrive by its date. Please create a new preview with a new arrival date.'
    );
    expect((friendly as { code?: string }).code).toBe('SCHEDULE_PASSED');
  });

  it('never leaks the internal message', () => {
    const friendly = friendlyCheckoutError(
      Object.assign(new Error('cs_private pi_private'), { code: 'PROVIDER_ERROR' })
    );
    expect(friendly.message).not.toContain('cs_private');
  });

  it('refuses an option no longer sold, with a new preview as the way on (#578)', () => {
    const friendly = friendlyCheckoutError(
      Object.assign(new Error('Pay & Send does not sell this mail option'), { code: 'JIT_OPTION_NOT_SOLD' })
    );
    expect(friendly.message).toBe("Pay & Send isn't available for this mail. Please create a new preview.");
    expect((friendly as { code?: string }).code).toBe('JIT_OPTION_NOT_SOLD');
  });

  it('says a letter that changed while its payment opened can be tried again, nothing charged (#586)', () => {
    const friendly = friendlyCheckoutError(
      Object.assign(new Error('The draft changed while its checkout was being made'), { code: 'DRAFT_CHANGED' })
    );
    expect(friendly.message).toBe('This letter changed while its payment was being opened, so nothing was charged. Please try again.');
    expect((friendly as { code?: string }).code).toBe('DRAFT_CHANGED');
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

/**
 * A daily limit on Pay & Send (#511's follow-up). Pay & Send checks the day's
 * mail count and the day's spending before it creates anything, and both
 * refusals say when the account can go again. The default branch used to
 * replace them with "Please try again", which cannot work until the next day.
 */
describe('friendlyCheckoutError and the daily limits', () => {
  it.each([
    ['ACCOUNT_DAILY_MAIL_CAP', 'This account has reached its daily limit of 3 letters and postcards. Please try again tomorrow.'],
    ['ACCOUNT_DAILY_CHARGE_CAP', 'This account has reached its daily purchase limit. Please try again tomorrow.'],
    ['CHARGE_ABOVE_DAILY_CAP', 'This purchase is more than one account can spend in a day, so it cannot be bought. Please choose a smaller pack.']
  ])('passes on the %s sentence as it is', (code, sentence) => {
    const friendly = friendlyCheckoutError(new SpendLimitError(code, sentence));
    expect(friendly.message).toBe(sentence);
    expect((friendly as Error & { code?: string }).code).toBe(code);
    expect(friendly.message).not.toBe('Unable to create Pay & Send checkout. Please try again.');
  });
});
