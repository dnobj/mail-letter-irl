import { parseCalendarDate } from './deliverySchedule.js';
import type { DraftSchedule, LetterDraft } from './types.js';

/**
 * A DATE column as the 'YYYY-MM-DD' string src/db/dateParser.ts reads it as.
 * Anything else (a Date, from a pg without that parser) is refused rather
 * than turned into a day, because its day depends on the process's time zone.
 */
function calendarDateColumn(value: unknown, column: string): string {
  const date = typeof value === 'string' ? parseCalendarDate(value) : null;
  if (!date) throw new Error(`letter_drafts.${column} is not a 'YYYY-MM-DD' string`);
  return date;
}

/**
 * A draft's arrive-by dates (#535), or null when it has none. Dates it cannot
 * read as calendar days, or only one of the two, throw. The send and the
 * Pay & Send checkout both read them here, so neither guesses a day, and the
 * checkout fails before its charge on any draft the send would refuse after.
 */
export function draftScheduleOf(draft: Pick<LetterDraft, 'arrive_by' | 'mail_on'>): DraftSchedule | null {
  if (draft.arrive_by == null && draft.mail_on == null) return null;
  return {
    arriveBy: calendarDateColumn(draft.arrive_by, 'arrive_by'),
    mailOn: calendarDateColumn(draft.mail_on, 'mail_on')
  };
}
