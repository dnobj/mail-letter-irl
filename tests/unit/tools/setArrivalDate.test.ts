/**
 * set_arrival_date (#535): a preview's arrival date set, moved or cleared
 * without previewing again. The date is checked as the previews check theirs,
 * before the draft is read; the draft changes only through setDraftSchedule,
 * whose refusals become sentences the model can act on. Behind
 * LETTER_IRL_ARRIVE_BY_ENABLED.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/draftService.js', () => ({
  setDraftSchedule: vi.fn()
}));

import { setDraftSchedule } from '../../../src/services/draftService.js';
import {
  ArrivalDateRefusedError,
  SET_ARRIVAL_DATE_TOOL,
  setArrivalDateTool
} from '../../../src/tools/setArrivalDate.js';
import { DELIVERY_ESTIMATE } from '../../../src/content/delivery.js';
import { setArrivalDateInputSchema, setArrivalDateOutputSchema } from '../../../src/schemas.js';
import type { ToolContext } from '../../../src/contracts/types.js';

const DRAFT_ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
// A Thursday, 10:00 in New York: today is still a mail date.
const THURSDAY_MORNING = new Date('2026-10-01T14:00:00Z');

function context(now = THURSDAY_MORNING): ToolContext {
  return {
    user: { userId: 'auth0|owner', creditsRemaining: 0, orders: [] } as unknown as ToolContext['user'],
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
    now: () => now,
    persist: vi.fn()
  };
}

const set = (input: Record<string, unknown>, ctx = context()) => setArrivalDateTool.handler(input as never, ctx);

describe('set_arrival_date (#535)', () => {
  beforeEach(() => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'true');
    vi.mocked(setDraftSchedule).mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sets a draft's dates as a preview would choose them, and says so", async () => {
    const ctx = context();
    const result = await set({ draftId: DRAFT_ID, arriveBy: '2026-10-16' }, ctx);

    // Oct 16 is a Friday: seven business days before it is Tue, Oct 6, as
    // the previews work it (Columbus Day, Oct 12, is no business day).
    expect(setDraftSchedule).toHaveBeenCalledWith(
      DRAFT_ID,
      'auth0|owner',
      { arriveBy: '2026-10-16', mailOn: '2026-10-06' },
      THURSDAY_MORNING
    );
    expect(result).toEqual({
      draftId: DRAFT_ID,
      schedule: {
        arriveBy: '2026-10-16',
        mailOn: '2026-10-06',
        releasesAt: '2026-10-06T13:00:00.000Z',
        earliestArrival: '2026-10-13',
        latestArrival: '2026-11-30'
      },
      deliveryEstimate: 'Goes to the printer Tue, Oct 6, and aims to arrive by Fri, Oct 16.',
      message:
        'Arrival date set. Goes to the printer Tue, Oct 6, and aims to arrive by Fri, Oct 16. ' +
        'Nothing has been sent: if it is sent, it is held until then. USPS does not guarantee First-Class dates.'
    });
  });

  it('names the year of a date in another year', async () => {
    const result = await set({ draftId: DRAFT_ID, arriveBy: '2027-01-08' }, context(new Date('2026-11-20T15:00:00Z')));
    expect(result.schedule?.mailOn).toBe('2026-12-29');
    expect(result.deliveryEstimate).toBe('Goes to the printer Tue, Dec 29, and aims to arrive by Fri, Jan 8, 2027.');
  });

  it.each([
    ['left out', {}],
    ['empty', { arriveBy: '' }],
    ['blank', { arriveBy: '   ' }]
  ])('clears the dates when arriveBy is %s', async (_label, extra) => {
    const result = await set({ draftId: DRAFT_ID, ...extra });

    expect(setDraftSchedule).toHaveBeenCalledWith(DRAFT_ID, 'auth0|owner', null, THURSDAY_MORNING);
    expect(result).toEqual({
      draftId: DRAFT_ID,
      deliveryEstimate: DELIVERY_ESTIMATE,
      message: 'No arrival date: once this mail is sent, it goes to the printer as soon as it can. Nothing has been sent.'
    });
    expect(result).not.toHaveProperty('schedule');
  });

  it('trims the draft id and the date', async () => {
    const result = await set({ draftId: `  ${DRAFT_ID} `, arriveBy: ' 2026-10-16 ' });
    expect(vi.mocked(setDraftSchedule).mock.calls[0][0]).toBe(DRAFT_ID);
    expect(result.draftId).toBe(DRAFT_ID);
    expect(result.schedule?.arriveBy).toBe('2026-10-16');
  });

  it.each([
    ['too soon', '2026-10-12', 'The earliest this can arrive is Tue, Oct 13 (2026-10-13). Choose that date or later, or leave arriveBy out to mail as soon as possible.'],
    ['too late', '2026-12-01', 'The latest arrival date on offer is Mon, Nov 30 (2026-11-30). Choose an earlier date, or preview it again nearer the time.'],
    ['not a date', 'Oct 16', 'arriveBy must be a date written YYYY-MM-DD, such as 2026-10-13.']
  ])('refuses a date that is %s before the draft is read', async (_label, arriveBy, message) => {
    await expect(set({ draftId: DRAFT_ID, arriveBy })).rejects.toMatchObject({
      message,
      diagnosticClass: 'validation_error'
    });
    expect(setDraftSchedule).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 'DRAFT_NOT_FOUND', "That preview wasn't found. Make a new preview, then try again."],
    ['sent', 'DRAFT_ALREADY_SENT', "This mail has already been sent, so its arrival date can't change. list_orders shows it."],
    ['expired', 'DRAFT_EXPIRED', 'This preview has expired. Make a new preview: the preview tools take arriveBy themselves.'],
    ['checkout_pending', 'DRAFT_CHECKOUT_PENDING', "This preview is tied to a Pay & Send payment, so its arrival date can't change now."]
  ] as const)('refuses a draft the service left alone (%s)', async (reason, code, message) => {
    vi.mocked(setDraftSchedule).mockResolvedValue(reason);
    const ctx = context();

    const refused = set({ draftId: DRAFT_ID, arriveBy: '2026-10-16' }, ctx);

    await expect(refused).rejects.toBeInstanceOf(ArrivalDateRefusedError);
    await expect(refused).rejects.toMatchObject({ code, diagnosticClass: code, message });
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'draft.arrival_date_refused', reason }),
      expect.any(String)
    );
  });

  it('refuses a draft id of the wrong shape as not found, without reading anything', async () => {
    await expect(set({ draftId: 'not-a-draft', arriveBy: '2026-10-16' })).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
    await expect(set({ draftId: 42 })).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
    expect(setDraftSchedule).not.toHaveBeenCalled();
  });

  it('refuses everything while arrival dates are off, clearing included', async () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', '');
    for (const input of [{ draftId: DRAFT_ID, arriveBy: '2026-10-16' }, { draftId: DRAFT_ID }]) {
      await expect(set(input)).rejects.toMatchObject({
        code: 'ARRIVE_BY_DISABLED',
        message: 'Arrival dates are not available yet. The preview mails as soon as it is sent.'
      });
    }
    expect(setDraftSchedule).not.toHaveBeenCalled();
  });

  it('takes a lead time of 0 in development, as the previews do', async () => {
    vi.stubEnv('LETTER_IRL_SCHEDULE_LEAD_DAYS', '0');
    const result = await set({ draftId: DRAFT_ID, arriveBy: '2026-10-01' });
    expect(result.schedule).toMatchObject({ arriveBy: '2026-10-01', mailOn: '2026-10-01' });
  });

  it('is a drafting tool that is not read-only, and repeats safely', () => {
    expect(setArrivalDateTool.name).toBe(SET_ARRIVAL_DATE_TOOL);
    expect(SET_ARRIVAL_DATE_TOOL).toBe('set_arrival_date');
    expect(setArrivalDateTool.readOnly).toBe(false);
    expect(setArrivalDateTool.meta).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    expect(setArrivalDateTool.meta).not.toHaveProperty('destructiveHint');
    expect(setArrivalDateTool.inputSchema).toBe(setArrivalDateInputSchema);
    expect(setArrivalDateTool.outputSchema).toBe(setArrivalDateOutputSchema);
    expect(setArrivalDateInputSchema.required).toEqual(['draftId']);
    expect(setArrivalDateOutputSchema.required).toEqual(['draftId', 'deliveryEstimate', 'message']);
  });
});
