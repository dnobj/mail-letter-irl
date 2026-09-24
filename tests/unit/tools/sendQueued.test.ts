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
