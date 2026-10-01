/**
 * A preview's arrival date (#535): the `arriveBy` the four preview tools take,
 * checked against the schedule (src/services/deliverySchedule.ts), and the
 * words the preview uses for it.
 */

import type { ToolContext } from '../contracts/types.js';
import { isArriveByEnabled, scheduleHorizonDays, scheduleLeadDays } from '../config/arriveBy.js';
import { checkArrival, newYorkDate, type CalendarDate } from '../services/deliverySchedule.js';
import type { DraftSchedule } from '../services/types.js';

/** What a preview's output says about its arrival date (zodSchemas.ts's previewScheduleZ). */
export interface PreviewScheduleOutput {
  /** The date asked for, YYYY-MM-DD in New York. */
  arriveBy: string;
  /** The day it goes to the printer, YYYY-MM-DD. */
  mailOn: string;
  /** When the hold ends, an ISO instant: 09:00 New York time on the mail date; the hourly run sends it to the printer within the hour. */
  releasesAt: string;
  /** The first and last dates on offer when this preview was made. */
  earliestArrival: string;
  latestArrival: string;
}

export interface PreviewSchedule {
  /** For the draft. */
  draft: DraftSchedule;
  /** For the output. */
  output: PreviewScheduleOutput;
}

/** A refusal the preview tools surface as the person's to fix, not a fault. */
function refusal(message: string): Error {
  return Object.assign(new Error(message), { diagnosticClass: 'validation_error' });
}

/**
 * A calendar date as a preview says it: "Tue, Oct 13", with the year when it
 * is not this year in New York.
 */
export function describeDate(date: CalendarDate, now: Date): string {
  const sameYear = date.slice(0, 4) === newYorkDate(now).slice(0, 4);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' as const }),
    timeZone: 'UTC'
  }).format(new Date(`${date}T12:00:00Z`));
}

/** The preview's one sentence about a held mail's dates. */
export function scheduleSentence(schedule: Pick<PreviewScheduleOutput, 'arriveBy' | 'mailOn'>, now: Date): string {
  return `Goes to the printer ${describeDate(schedule.mailOn, now)}, and aims to arrive by ${describeDate(schedule.arriveBy, now)}.`;
}

/**
 * The arrival date a preview was asked for, checked: its schedule, or a
 * refusal that names the dates on offer so the person or the model can choose
 * again. Undefined when none was asked for, an empty string included, which
 * models send for an optional field they leave unset. While the feature is
 * off the schema does not offer `arriveBy`, and a call that passes it anyway
 * (an app that cached the schema) is refused rather than quietly mailed at
 * once: registerTools passes it through to here.
 */
export function previewSchedule(arriveBy: unknown, context: ToolContext): PreviewSchedule | undefined {
  if (arriveBy === undefined || arriveBy === null) return undefined;
  if (typeof arriveBy === 'string' && arriveBy.trim() === '') return undefined;
  if (!isArriveByEnabled()) {
    throw refusal('Arrival dates are not available yet. Leave arriveBy out to mail as soon as possible.');
  }
  const now = context.now();
  const check = checkArrival(typeof arriveBy === 'string' ? arriveBy.trim() : '', now, {
    leadDays: scheduleLeadDays(),
    horizonDays: scheduleHorizonDays()
  });
  const on = (date: CalendarDate) => `${describeDate(date, now)} (${date})`;
  if (!check.ok) {
    context.logger.warn(
      { correlationId: context.correlationId, event: 'quote.arrive_by_refused', reason: check.reason },
      'An arrival date was refused'
    );
    switch (check.reason) {
      case 'invalid_date':
        throw refusal(`arriveBy must be a date written YYYY-MM-DD, such as ${check.earliestArrival}.`);
      case 'unavailable':
        throw refusal('Arrival dates cannot be scheduled right now. Leave arriveBy out to mail as soon as possible.');
      case 'too_soon':
        throw refusal(
          `The earliest this can arrive is ${on(check.earliestArrival)}. ` +
            'Choose that date or later, or leave arriveBy out to mail as soon as possible.'
        );
      case 'too_late':
        throw refusal(
          `The latest arrival date on offer is ${on(check.latestArrival)}. ` +
            'Choose an earlier date, or preview it again nearer the time.'
        );
    }
  }
  return {
    draft: { arriveBy: check.arriveBy, mailOn: check.mailOn },
    output: {
      arriveBy: check.arriveBy,
      mailOn: check.mailOn,
      releasesAt: check.dispatchAt.toISOString(),
      earliestArrival: check.earliestArrival,
      latestArrival: check.latestArrival
    }
  };
}
