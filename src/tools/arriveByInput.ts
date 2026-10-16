/**
 * A preview's arrival date (#535): the `arriveBy` the four preview tools take,
 * checked against the schedule (src/services/deliverySchedule.ts), and the
 * words the preview uses for it.
 */

import type { ToolContext } from '../contracts/types.js';
import { isArriveByEnabled, scheduleHorizonDays, scheduleLeadDays } from '../config/arriveBy.js';
import {
  checkArrival,
  describeDate,
  earliestArrival,
  latestArrival,
  scheduleSentence,
  type CalendarDate
} from '../services/deliverySchedule.js';

// The words for held mail's dates live with the schedule (the order store and
// the sends use them too); the previews keep importing them from here.
export { describeDate, scheduleSentence };
import type { DraftSchedule } from '../services/types.js';
import { query } from '../db/index.js';
import { fullMailDate, openArrivalsSentence } from '../services/mailDateCapacity.js';

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

/** The arrival dates on offer when a preview was made (#535): what a card's date picker offers. */
export interface ArrivalWindow {
  earliestArrival: string;
  latestArrival: string;
}

export interface PreviewSchedule {
  /** For the draft. */
  draft: DraftSchedule;
  /** For the output. */
  output: PreviewScheduleOutput;
}

/**
 * The arrival dates on offer now, on every preview while the feature is on,
 * with a date or without, so a card can offer them before one is chosen. The
 * same dates previewSchedule checks against. Undefined while the feature is
 * off, and when no date can be scheduled (a horizon shorter than the lead
 * time, or the end of the holiday list), when previewSchedule refuses any.
 */
export function previewArrivalWindow(context: ToolContext): ArrivalWindow | undefined {
  if (!isArriveByEnabled()) return undefined;
  const now = context.now();
  const earliest = earliestArrival(now, scheduleLeadDays());
  const latest = latestArrival(now, scheduleHorizonDays());
  return earliest > latest ? undefined : { earliestArrival: earliest, latestArrival: latest };
}

/** A refusal the preview tools surface as the person's to fix, not a fault. */
function refusal(message: string): Error {
  return Object.assign(new Error(message), { diagnosticClass: 'validation_error' });
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

/**
 * previewSchedule's check, and then room on its mail date (#700): a date
 * LETTER_IRL_SCHEDULE_DAILY_CAP letters are already held for is refused,
 * naming the nearest arrival dates with room. What the preview tools and
 * set_arrival_date call. A draft holds no place on its date, so the send
 * counts again, under a lock.
 */
export async function previewScheduleWithRoom(arriveBy: unknown, context: ToolContext): Promise<PreviewSchedule | undefined> {
  const schedule = previewSchedule(arriveBy, context);
  if (!schedule) return undefined;
  const now = context.now();
  const full = await fullMailDate({ query }, schedule.draft, now);
  if (!full) return schedule;
  context.logger.warn(
    { correlationId: context.correlationId, event: 'quote.arrive_by_refused', reason: 'full' },
    'An arrival date was refused'
  );
  throw refusal(
    `Mail to arrive by ${describeDate(schedule.draft.arriveBy, now)} (${schedule.draft.arriveBy}) is fully booked. ` +
      `${openArrivalsSentence(full.openArrivals, now, true)} ` +
      (full.openArrivals.length > 0 ? 'Choose one of those, or no date to mail as soon as possible.' : 'Choose no date to mail as soon as possible.')
  );
}
