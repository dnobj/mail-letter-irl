import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  friendlyDraftError,
  HANDLED_DRAFT_ERROR_CODES,
  type DraftMailType
} from '../../../src/tools/draftErrors.js';

/**
 * The send surface's redaction guarantee, made exhaustive (#179).
 *
 * mailSendService throws sixteen distinct codes through draftError(), and the
 * formatter branched on eight. The tail was `return error instanceof Error ?
 * error : ...`, so the other seven forwarded the service's own message
 * verbatim - and those messages interpolate draft ids, order ids and raw
 * status columns: "Draft <uuid> is held", "Order <uuid> is payment_failed".
 *
 * The two lists are read from SOURCE rather than restated here, because a new
 * service code with no formatter branch is exactly the defect that keeps
 * happening and exactly the thing nobody remembers to check.
 *
 * And every case EXERCISES the formatter. #278 round 14 found that a
 * grep-based version of this test passed while the branch it was guarding had
 * been replaced with a no-op.
 */

const SERVICE = new URL('../../../src/services/mailSendService.ts', import.meta.url);

/** Every code the service actually throws, multi-line call sites included. */
function codesThrownByService(): string[] {
  const source = readFileSync(SERVICE, 'utf8');
  const found = new Set<string>();
  const pattern = /draftError\(\s*'([A-Z_]+)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) found.add(match[1]);
  return [...found].sort();
}

const MAIL_TYPES: DraftMailType[] = ['letter', 'postcard'];

describe('draft error coverage', () => {
  it('finds the codes it is guarding', () => {
    // If draftError() is renamed or the call shape changes, fail loudly rather
    // than silently guard an empty list.
    expect(codesThrownByService().length).toBeGreaterThanOrEqual(16);
  });

  it('handles every code the service throws', () => {
    const thrown = codesThrownByService();
    const handled = new Set<string>(HANDLED_DRAFT_ERROR_CODES);
    const unhandled = thrown.filter(code => !handled.has(code));
    expect(
      unhandled,
      `mailSendService throws these with no branch in draftErrors.ts: ${unhandled.join(', ')}`
    ).toEqual([]);
  });

  it('claims no code the service does not throw', () => {
    // The other direction, so the list cannot rot into fiction.
    const thrown = new Set(codesThrownByService());
    expect(HANDLED_DRAFT_ERROR_CODES.filter(code => !thrown.has(code))).toEqual([]);
  });
});

describe('no internal value survives the formatter', () => {
  // Shaped like what draftError() actually produces: .code assigned onto an
  // Error whose message interpolates internal values.
  const DRAFT_ID = '11111111-2222-3333-4444-555555555555';
  const LEAKS = [DRAFT_ID, 'payment_disputed', 'held', 'payment_failed'];

  for (const mailType of MAIL_TYPES) {
    it.each(HANDLED_DRAFT_ERROR_CODES)(`${mailType}: %s is rewritten`, code => {
      const upstream = Object.assign(
        new Error(`Draft ${DRAFT_ID} is held (payment_disputed) order ${DRAFT_ID} payment_failed`),
        { code }
      );

      const friendly = friendlyDraftError(upstream, DRAFT_ID, mailType);

      for (const leak of LEAKS) {
        // DRAFT_NOT_FOUND legitimately names the draft id back to the caller -
        // it is the id THEY passed in, not a value read out of the database.
        if (leak === DRAFT_ID && code === 'DRAFT_NOT_FOUND') continue;
        expect(friendly.message, `${code} leaked ${leak}`).not.toContain(leak);
      }
      expect(friendly.message).not.toBe(upstream.message);
    });
  }
});

describe('the fall-through', () => {
  it('refuses to forward an UNRECOGNISED code', () => {
    // The gap that let seven codes through. A code means the service authored
    // the message for its own consumers, so a missing branch must not be read
    // as permission to forward it.
    const upstream = Object.assign(new Error('Order 42 is payment_failed'), {
      code: 'SOME_FUTURE_CODE'
    });
    const friendly = friendlyDraftError(upstream, 'draft-1', 'letter');
    expect(friendly.message).not.toContain('payment_failed');
    expect(friendly.message).toBe('Unable to send letter. Please contact Letter IRL support.');
  });

  it('still forwards an error with NO code', () => {
    // Credit arithmetic and pricing errors arrive without a code and are
    // already written for customers. Swallowing them would replace useful
    // guidance with a shrug.
    const upstream = new Error('You need 2 more credits to send this letter.');
    expect(friendlyDraftError(upstream, 'draft-1', 'letter').message).toBe(
      'You need 2 more credits to send this letter.'
    );
  });

  it('handles a non-Error throw', () => {
    expect(friendlyDraftError('a string', 'draft-1', 'postcard').message).toBe(
      'Unable to send postcard'
    );
  });
});

describe('mail-type wording', () => {
  const withCode = (code: string) => Object.assign(new Error('upstream'), { code });

  it('points a wrong-type draft at the other tool', () => {
    expect(friendlyDraftError(withCode('DRAFT_WRONG_MAIL_TYPE'), 'd', 'letter').message).toBe(
      'This is a postcard draft. Please use send_postcard instead.'
    );
    expect(friendlyDraftError(withCode('DRAFT_WRONG_MAIL_TYPE'), 'd', 'postcard').message).toBe(
      'This is a letter draft. Please use send_letter instead.'
    );
  });

  it('names the right noun in shared branches', () => {
    expect(friendlyDraftError(withCode('DRAFT_CANCELLED'), 'd', 'letter').message).toContain(
      'letter draft'
    );
    expect(friendlyDraftError(withCode('DRAFT_CANCELLED'), 'd', 'postcard').message).toContain(
      'postcard draft'
    );
  });

  it('keeps the two send tools delegating to this module', async () => {
    // The wrappers exist so the old two-argument callers keep working. If one
    // ever grows its own copy again, these diverge - which is how the same
    // redaction bug got fixed on one surface and not the other (#278 r12/r13).
    const { friendlyDraftError: fromLetter } = await import('../../../src/tools/sendLetter.js');
    const { friendlyDraftError: fromPostcard } = await import('../../../src/tools/sendPostcard.js');
    const blocked = withCode('ACCOUNT_SENDS_BLOCKED');
    expect(fromLetter(blocked, 'd').message).toBe(
      friendlyDraftError(blocked, 'd', 'letter').message
    );
    expect(fromPostcard(blocked, 'd').message).toBe(
      friendlyDraftError(blocked, 'd', 'postcard').message
    );
  });
});
