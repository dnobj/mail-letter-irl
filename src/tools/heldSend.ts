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
  /** Whether cancel_scheduled_mail can still cancel it free. */
  cancellable: boolean;
}

/**
 * A sent letter's dates, and whether it still waits for them: undefined for
 * mail sent without a date. `waiting` is false once the outbox has taken it.
 */
export function heldSendFields(
  letter: { arrive_by?: string | null; mail_on?: string | null },
  waiting: boolean
): HeldSendFields | undefined {
  const schedule = heldDatesOf(letter.arrive_by, letter.mail_on);
  return schedule ? { schedule, cancellable: waiting } : undefined;
}

/** The send's status line for mail that waits for its mail date. */
export function heldSendStatusText(schedule: HeldSendFields['schedule'], now: Date): string {
  return `Scheduled: ${scheduleSentence(schedule, now)} It can be cancelled free until then.`;
}

/** Whether a letter in this status still waits in the outbox, untouched. */
export function waitsInOutbox(status: LetterStatus): boolean {
  return status === 'queued';
}
