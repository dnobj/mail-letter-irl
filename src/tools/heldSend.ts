/**
 * What a send says of mail sent with an arrival date (#535). It waits in the
 * outbox until 09:00 New York time on its mail date, so the inline dispatch
 * right after the send does not take it, and the send's answer says so
 * instead of "Queued for the print provider".
 */

import { heldDatesOf, scheduleSentence, type CalendarDate } from '../services/deliverySchedule.js';
import type { LetterStatus } from '../services/types.js';

export interface HeldSendFields {
  /** The date it aims to arrive by and the day it goes to the printer. */
  schedule: { arriveBy: CalendarDate; mailOn: CalendarDate };
  /** Whether it can still be cancelled free (cancel_scheduled_mail, or the website). */
  cancellable: boolean;
}

/**
 * A sent letter's dates, and whether it can still be cancelled: undefined for
 * mail sent without a date. `waiting` says whether it still waits for its
 * mail date; false once the outbox has taken it. Pay & Send mail is never
 * cancellable here: its refund is a person's decision, and
 * cancel_scheduled_mail refuses it.
 */
export function heldSendFields(
  letter: { arrive_by?: string | null; mail_on?: string | null; funding_type?: string | null },
  waiting: boolean
): HeldSendFields | undefined {
  const schedule = heldDatesOf(letter.arrive_by, letter.mail_on);
  return schedule ? { schedule, cancellable: waiting && letter.funding_type !== 'jit_order' } : undefined;
}

/**
 * Whether the job a send just wrote waits for its mail date: not claimed by
 * the dispatch right after the send, and held past now, so no dispatch can
 * take it before then (the claim needs next_attempt_at to have passed). A job
 * due now that was not claimed is queued behind a pause or another process,
 * not waiting for a date.
 */
export function heldPastNow(job: { next_attempt_at?: Date | string | null }, claimed: boolean, now: Date): boolean {
  if (claimed || job.next_attempt_at == null) return false;
  return new Date(job.next_attempt_at).getTime() > now.getTime();
}

/** The send's status line for mail that waits for its mail date. */
export function heldSendStatusText(held: HeldSendFields, now: Date): string {
  const cancel = held.cancellable ? ' It can be cancelled free until then.' : '';
  return `Scheduled: ${scheduleSentence(held.schedule, now)}${cancel}`;
}

/** Whether a letter in this status still waits in the outbox, untouched. */
export function waitsInOutbox(status: LetterStatus): boolean {
  return status === 'queued';
}
