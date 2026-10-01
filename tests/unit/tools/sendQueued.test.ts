/**
 * What send_letter and send_postcard tell the customer about the handover to
 * the printer (#444). A job the send could not claim is queued, not failed:
 * the outbox is paused, or another process took it first, and either way it
 * goes out from the queue.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../src/contracts/types.js';

const mocks = vi.hoisted(() => ({
  createMailOrderFromDraft: vi.fn(),
  processLetterJob: vi.fn()
}));

vi.mock('../../../src/services/mailSendService.js', () => ({
  createMailOrderFromDraft: mocks.createMailOrderFromDraft,
  asPostcardDraft: (draft: unknown) => draft
}));
vi.mock('../../../src/services/letterJobService.js', () => ({
  processLetterJob: mocks.processLetterJob
}));
vi.mock('../../../src/services/returnAddressService.js', () => ({
  hasReturnAddress: vi.fn().mockResolvedValue(true)
}));

import { sendLetterTool } from '../../../src/tools/sendLetter.js';
import { sendPostcardTool } from '../../../src/tools/sendPostcard.js';

const ADDRESS = { name: 'Sam', addressLine1: '2 Road', city: 'Leeds', state: 'NY', postalCode: '10001', country: 'US' };

function created() {
  return {
    alreadyConsumed: false,
    creditsRemaining: 4,
    fundingType: 'credits',
    draft: {
      sender: ADDRESS,
      recipient: ADDRESS,
      body_text: 'Hello',
      sign_off: 'Love',
      required_credits: 2,
      preview_html: '<p>front</p>'
    },
    letter: { letter_id: 'letter-1', status: 'queued' },
    job: { job_id: 'job-1' }
  };
}

function context(): ToolContext {
  return {
    user: { userId: 'user-1', creditsRemaining: 0, orders: [] },
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
    now: () => new Date('2026-09-23T12:00:00Z'),
    persist: vi.fn()
  } as unknown as ToolContext;
}

const tools = [
  ['send_letter', sendLetterTool],
  ['send_postcard', sendPostcardTool]
] as const;

describe("send_postcard's front (#534 Phase 4)", () => {
  const run = () =>
    (sendPostcardTool.handler as (input: unknown, ctx: ToolContext) => Promise<any>)({ draftId: 'draft-1', confirm: true }, context());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processLetterJob.mockResolvedValue({ claimed: true, completed: true, retryScheduled: false });
  });

  it("returns the legacy front, and none for a draft our renderer drew, whose document holds both sides", async () => {
    mocks.createMailOrderFromDraft.mockResolvedValue(created());
    expect((await run()).previewFrontHtml).toBe('<p>front</p>');

    const rendered = created();
    Object.assign(rendered.draft, { renderer_version: 'pdf-1', preview_html: '<body data-renderer="pdf-1"><svg></svg><svg></svg></body>' });
    mocks.createMailOrderFromDraft.mockResolvedValue(rendered);
    expect((await run()).previewFrontHtml).toBeUndefined();
  });
});

describe.each(tools)('%s', (_name, tool) => {
  const run = () =>
    (tool.handler as (input: unknown, ctx: ToolContext) => Promise<any>)({ draftId: 'draft-1', confirm: true }, context());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMailOrderFromDraft.mockResolvedValue(created());
  });

  it('reports an unclaimed job as queued, not failed', async () => {
    mocks.processLetterJob.mockResolvedValue({ claimed: false, completed: false, retryScheduled: false });

    const result = await run();

    expect(result.currentStatus).toBe('pending');
    expect(result.statusTimeline.at(-1).statusText).toBe('Queued for the print provider');
  });

  it('still reports a claimed job the provider refused as failed', async () => {
    mocks.processLetterJob.mockResolvedValue({ claimed: true, completed: false, retryScheduled: false });

    const result = await run();

    expect(result.currentStatus).toBe('failed');
    expect(result.statusTimeline.at(-1).statusText).toBe('Provider submission failed');
  });

  it('reports a scheduled retry as pending, with its own words', async () => {
    mocks.processLetterJob.mockResolvedValue({ claimed: true, completed: false, retryScheduled: true });

    const result = await run();

    expect(result.currentStatus).toBe('pending');
    expect(result.statusTimeline.at(-1).statusText).toBe('Provider temporarily unavailable; retry scheduled');
  });

  it('reports an accepted handover as accepted', async () => {
    mocks.processLetterJob.mockResolvedValue({ claimed: true, completed: true, retryScheduled: false });

    const result = await run();

    expect(result.currentStatus).toBe('accepted');
    expect(result.statusTimeline.at(-1).statusText).toBe('Accepted by print provider');
  });
});

describe.each(tools)('%s with an arrival date (#535)', (name, tool) => {
  const run = (ctx: ToolContext = context()) =>
    (tool.handler as (input: unknown, ctx: ToolContext) => Promise<any>)({ draftId: 'draft-1', confirm: true }, ctx);
  const DATES = { arriveBy: '2026-10-16', mailOn: '2026-10-06' };
  // The job a dated send writes is held until 09:00 New York time on its mail date.
  const RELEASE = new Date('2026-10-06T13:00:00Z');
  function dated(overrides: Record<string, unknown> = {}, nextAttemptAt: Date = RELEASE) {
    const result = created();
    Object.assign(result.letter, { arrive_by: DATES.arriveBy, mail_on: DATES.mailOn, funding_type: 'prepaid_balance', ...overrides });
    Object.assign(result.job, { next_attempt_at: nextAttemptAt });
    return result;
  }

  beforeEach(() => vi.clearAllMocks());

  it('says it is scheduled, with its dates, while it waits for its mail date', async () => {
    mocks.createMailOrderFromDraft.mockResolvedValue(dated());
    mocks.processLetterJob.mockResolvedValue({ claimed: false, completed: false, retryScheduled: false });
    const ctx = context();

    const output = await run(ctx);

    expect(output.currentStatus).toBe('scheduled');
    expect(output.schedule).toEqual(DATES);
    expect(output.cancellable).toBe(true);
    expect(output.statusTimeline.at(-1).statusText).toBe(
      'Scheduled: Goes to the printer Tue, Oct 6, and aims to arrive by Fri, Oct 16. It can be cancelled free until then.'
    );
    if (name === 'send_letter') {
      // The order this session holds says the same.
      expect(ctx.user.orders[0]).toMatchObject({ currentStatus: 'scheduled', schedule: DATES, cancellable: true });
    }
  });

  it('says what happened, with its dates and no cancel, once the dispatch has taken it', async () => {
    mocks.createMailOrderFromDraft.mockResolvedValue(dated());
    mocks.processLetterJob.mockResolvedValue({ claimed: true, completed: true, retryScheduled: false });

    const output = await run();

    expect(output.currentStatus).toBe('accepted');
    expect(output.schedule).toEqual(DATES);
    expect(output.cancellable).toBe(false);
    expect(output.statusTimeline.at(-1).statusText).toBe('Accepted by print provider');
  });

  it('says nothing of dates for mail sent without one', async () => {
    mocks.createMailOrderFromDraft.mockResolvedValue(created());
    mocks.processLetterJob.mockResolvedValue({ claimed: false, completed: false, retryScheduled: false });

    const output = await run();

    expect(output.currentStatus).toBe('pending');
    expect(output.statusTimeline.at(-1).statusText).toBe('Queued for the print provider');
    expect(JSON.parse(JSON.stringify(output))).not.toHaveProperty('schedule');
    expect(JSON.parse(JSON.stringify(output))).not.toHaveProperty('cancellable');
  });

  it('is not scheduled when its mail date has come: due now and not taken, it is queued as any letter', async () => {
    // Sent after 09:00 New York on its mail date: due at once. Not claimed
    // means a pause or another process, not a wait for a date.
    mocks.createMailOrderFromDraft.mockResolvedValue(dated({}, new Date('2026-09-23T11:00:00Z')));
    mocks.processLetterJob.mockResolvedValue({ claimed: false, completed: false, retryScheduled: false });

    const output = await run();

    expect(output.currentStatus).toBe('pending');
    expect(output.statusTimeline.at(-1).statusText).toBe('Queued for the print provider');
    expect(output.schedule).toEqual(DATES);
    expect(output.cancellable).toBe(false);
  });

  it('is not scheduled once the dispatch has claimed it, even to try again later', async () => {
    mocks.createMailOrderFromDraft.mockResolvedValue(dated({}, new Date('2026-09-23T11:00:00Z')));
    mocks.processLetterJob.mockResolvedValue({ claimed: true, completed: false, retryScheduled: true });

    const output = await run();

    expect(output.currentStatus).toBe('pending');
    expect(output.statusTimeline.at(-1).statusText).toBe('Provider temporarily unavailable; retry scheduled');
    expect(output.cancellable).toBe(false);
  });

  it('answers a retry of a dated send as the letter stands now', async () => {
    const waiting = dated();
    waiting.alreadyConsumed = true;
    mocks.createMailOrderFromDraft.mockResolvedValue(waiting);
    expect(await run()).toMatchObject({ isRetry: true, currentStatus: 'scheduled', schedule: DATES, cancellable: true });

    const mailed = dated({ status: 'accepted' });
    mailed.alreadyConsumed = true;
    mocks.createMailOrderFromDraft.mockResolvedValue(mailed);
    expect(await run()).toMatchObject({ isRetry: true, currentStatus: 'accepted', schedule: DATES, cancellable: false });
    expect(mocks.processLetterJob).not.toHaveBeenCalled();
  });

  it('answers a retry of a draft Pay & Send consumed as scheduled but not cancellable', async () => {
    // mailSendService hands a balance caller the letter a payment already made.
    const paid = dated({ funding_type: 'jit_order' });
    paid.alreadyConsumed = true;
    mocks.createMailOrderFromDraft.mockResolvedValue(paid);

    expect(await run()).toMatchObject({ isRetry: true, currentStatus: 'scheduled', schedule: DATES, cancellable: false });
  });
});
