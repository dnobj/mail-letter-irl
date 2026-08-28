/**
 * Customer-facing wording for draft/send failures, in one place (#179).
 *
 * This lived as two near-identical copies, in sendLetter.ts and
 * sendPostcard.ts, differing only in whether they said "letter" or "postcard".
 * Two copies of a redaction rule is how #278 went from round 12 to round 13:
 * the checkout surface was fixed and the send surface was not, because nobody
 * had to touch both. One implementation with a mailType parameter removes that
 * possibility.
 *
 * DEFAULT-DENY on codes. The old tail was
 *
 *   return error instanceof Error ? error : new Error('Unable to send letter');
 *
 * which forwards whatever the service wrote. mailSendService authors those
 * messages for ITS OWN consumers and interpolates internal values into them -
 * draft ids, order ids, and raw status labels. Fifteen codes are thrown there
 * and only eight had a branch, so seven of them were reaching the customer
 * verbatim: "Draft <uuid> is held", "Order <uuid> is payment_failed". That is
 * the same leak class as users.sends_blocked_reason, which took two rounds to
 * close on one surface while these stayed open on both.
 *
 * An error with an unrecognised CODE is now refused a passthrough. An error
 * with NO code still forwards: those come from credit arithmetic and the
 * pricing layer, are already written for customers, and swallowing them would
 * replace a useful message with a shrug.
 */

export type DraftMailType = 'letter' | 'postcard';

/**
 * Every code src/services/mailSendService.ts throws through draftError().
 * tests/unit/tools/draftErrors.test.ts reads that file and fails if this list
 * falls behind - a new service code with no branch here is precisely the
 * defect this module exists to prevent, and it is not the kind of thing anyone
 * remembers to check.
 */
export const HANDLED_DRAFT_ERROR_CODES = [
  'ACCOUNT_SENDS_BLOCKED',
  'DRAFT_CANCELLED',
  'DRAFT_CHECKOUT_PENDING',
  'DRAFT_EXPIRED',
  'DRAFT_FUNDING_CONFLICT',
  'DRAFT_INCOMPLETE',
  'DRAFT_INVALID_STATE',
  'DRAFT_NOT_FOUND',
  'DRAFT_NOT_OWNED',
  'DRAFT_WRONG_MAIL_TYPE',
  'FUNDING_AMOUNT_MISMATCH',
  'JIT_ORDER_INVALID',
  'JIT_ORDER_NOT_FOUND',
  'JIT_ORDER_NOT_OWNED',
  'JIT_ORDER_NOT_PAID'
] as const;

export function friendlyDraftError(
  error: unknown,
  draftId: string,
  mailType: DraftMailType
): Error {
  const code = (error as { code?: string })?.code;
  const noun = mailType;
  const other = mailType === 'letter' ? 'postcard' : 'letter';

  // A SERVER-AUTHORED string. The upstream message interpolates
  // users.sends_blocked_reason (an internal moderation label such as
  // "payment_disputed"), and the old default forwarded whatever it was handed,
  // so the label reached the customer here even after round 12 fixed the
  // checkout surface (#278 round 13). Kept first so it can never be shadowed.
  if (code === 'ACCOUNT_SENDS_BLOCKED') {
    return new Error('Sending is disabled on this account. Please contact support.');
  }

  if (code === 'DRAFT_NOT_FOUND') {
    return new Error(
      mailType === 'letter'
        ? `Draft not found: ${draftId}. Please call quote_and_preview_letter to create a new draft.`
        : `Postcard draft not found: ${draftId}. Please create a new postcard preview.`
    );
  }
  if (code === 'DRAFT_NOT_OWNED') {
    return new Error(`This draft does not belong to your account. Please create a new ${noun} draft.`);
  }
  if (code === 'DRAFT_EXPIRED') {
    return new Error(
      `Draft has expired (drafts are valid for 24 hours). Please create a new ${noun} draft.`
    );
  }
  if (code === 'DRAFT_CANCELLED') {
    return new Error(`This draft was cancelled. Please create a new ${noun} draft.`);
  }
  if (code === 'DRAFT_CHECKOUT_PENDING') {
    return new Error(
      'This draft has an active Pay & Send checkout. Complete or wait for that checkout to expire before using prepaid balance.'
    );
  }
  if (code === 'DRAFT_WRONG_MAIL_TYPE') {
    return new Error(`This is a ${other} draft. Please use send_${other} instead.`);
  }
  if (code === 'DRAFT_INCOMPLETE') {
    return new Error('This draft is in an incomplete state. Please contact Letter IRL support before retrying.');
  }

  // The seven that used to fall through. Upstream each of these interpolates a
  // draft id, an order id, or a raw column value into its message.
  if (code === 'DRAFT_FUNDING_CONFLICT') {
    return new Error(`This draft was already paid for another way. Please create a new ${noun} draft.`);
  }
  if (code === 'DRAFT_INVALID_STATE') {
    // Upstream: `Draft ${id} is ${draft.status}` - a raw status column.
    return new Error(`This draft is no longer in a sendable state. Please create a new ${noun} draft.`);
  }
  if (code === 'FUNDING_AMOUNT_MISMATCH') {
    return new Error(
      'The payment recorded for this draft does not match its price. Please contact Letter IRL support before retrying.'
    );
  }
  if (code === 'JIT_ORDER_NOT_FOUND') {
    return new Error('That Pay & Send order could not be found. Please start a new checkout.');
  }
  if (code === 'JIT_ORDER_INVALID') {
    return new Error('That order cannot be used to pay for this draft. Please start a new checkout.');
  }
  if (code === 'JIT_ORDER_NOT_OWNED') {
    return new Error('That order does not belong to your account or to this draft. Please start a new checkout.');
  }
  if (code === 'JIT_ORDER_NOT_PAID') {
    // Upstream: `Order ${id} is ${jitOrder.status}` - a raw status column.
    return new Error('That Pay & Send checkout has not completed yet. Please finish the payment and try again.');
  }

  if (typeof code === 'string' && code.length > 0) {
    // An unrecognised SERVICE code. The service wrote this message for its own
    // consumers and may have interpolated an internal value into it, so it
    // does not get a passthrough just because nobody has added a branch yet.
    return new Error(`Unable to send ${noun}. Please contact Letter IRL support.`);
  }

  // No code: credit arithmetic and pricing errors, already customer-facing.
  return error instanceof Error ? error : new Error(`Unable to send ${noun}`);
}
