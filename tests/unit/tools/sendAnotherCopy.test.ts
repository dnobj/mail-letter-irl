/**
 * send_letter and send_postcard pass the model's sendAnotherCopy through, and
 * word a duplicate refusal for their own tool (#412).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../src/contracts/types.js';

const mocks = vi.hoisted(() => ({
  createMailOrderFromDraft: vi.fn()
}));

vi.mock('../../../src/services/mailSendService.js', () => ({
  createMailOrderFromDraft: mocks.createMailOrderFromDraft,
  asPostcardDraft: (draft: unknown) => draft
}));
vi.mock('../../../src/services/letterJobService.js', () => ({
  processLetterJob: vi.fn()
}));
vi.mock('../../../src/services/returnAddressService.js', () => ({
  hasReturnAddress: vi.fn().mockResolvedValue(true)
}));

import { sendLetterTool } from '../../../src/tools/sendLetter.js';
import { sendPostcardTool } from '../../../src/tools/sendPostcard.js';
import { DuplicateMailError } from '../../../src/services/duplicateMailService.js';

const context = {
  user: { userId: 'user-1', creditsRemaining: 0, orders: [] },
  correlationId: 'corr-1',
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
  now: () => new Date('2026-09-17T12:00:00Z'),
  persist: vi.fn()
} as unknown as ToolContext;

const tools = [
  ['send_letter', sendLetterTool, 'letter'],
  ['send_postcard', sendPostcardTool, 'postcard']
] as const;

describe.each(tools)('%s', (name, tool, mailType) => {
  const run = (input: Record<string, unknown>) =>
    (tool.handler as (input: unknown, ctx: ToolContext) => Promise<unknown>)(input, context);

  beforeEach(() => {
    vi.clearAllMocks();
    // Stops the handler right after the service call; only the call matters here.
    mocks.createMailOrderFromDraft.mockRejectedValue(new Error('stop'));
  });

  it.each<[unknown, boolean]>([
    [true, true],
    [undefined, false],
    [false, false],
    ['true', false]
  ])('sendAnotherCopy %j asks the service to allow a duplicate: %s', async (value, allowed) => {
    await run({ draftId: 'draft-1', confirm: true, sendAnotherCopy: value }).catch(() => undefined);
    expect(mocks.createMailOrderFromDraft).toHaveBeenCalledWith({
      draftId: 'draft-1',
      userId: 'user-1',
      mailType,
      allowDuplicate: allowed
    });
  });

  it('words a duplicate refusal for this tool and keeps its details', async () => {
    const duplicate = { kind: 'checkout_open' as const, mailType, recipientName: 'Sam', ageSeconds: 61 };
    mocks.createMailOrderFromDraft.mockRejectedValueOnce(new DuplicateMailError(duplicate));

    const refusal = run({ draftId: 'draft-1', confirm: true });

    await expect(refusal).rejects.toBeInstanceOf(DuplicateMailError);
    await expect(refusal).rejects.toMatchObject({
      duplicate,
      message: expect.stringContaining(`call ${name} again with the same draftId, confirm: true and sendAnotherCopy: true`)
    });
  });

  it('describes the flag in its description', () => {
    expect(tool.description).toContain('sendAnotherCopy: true only after the user asks for another copy');
  });
});
