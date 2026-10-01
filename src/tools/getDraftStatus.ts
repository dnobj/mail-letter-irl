import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { getDraftStatusInputSchema, getDraftStatusOutputSchema } from '../schemas.js';
import { getDraftState } from '../services/draftService.js';
import { draftScheduleOf } from '../services/draftSchedule.js';
import { isDraftIdShape } from './requestSend.js';

/**
 * What became of a preview's draft (#474), for a preview card whose host keeps
 * no state of its own.
 *
 * ChatGPT gives a card back its own saved state (widgetState) when a
 * conversation is reopened, so the card knows it already sent its mail.
 * MCP Apps has no such store: Claude hands a reopened card the preview's
 * result again, and the card would offer Send for mail that has gone. The card
 * asks this instead, and shows a sent draft as sent and an expired one as
 * expired.
 *
 * It also says the draft's arrival dates (#535), which the card may have
 * changed since the preview's first answer, so a card shown that answer
 * again draws the dates the draft has, and a sent one that waits for its mail
 * date as scheduled.
 *
 * Card-only (APP_ONLY_TOOLS in src/mcp/registerTools.ts): the model has no use
 * for it, and apps that keep card-only tools from the model never show it.
 * Read-only, and a draft that is not the caller's reads as not found.
 */
export const GET_DRAFT_STATUS_TOOL = 'get_draft_status';

interface GetDraftStatusInput {
  draftId: string;
}

export interface GetDraftStatusOutput {
  draftId: string;
  status: 'ready' | 'sent' | 'expired' | 'not_found';
  /** The order the draft became, once sent. */
  orderId?: string;
  /** The draft's arrival dates (#535), when it has them. */
  schedule?: { arriveBy: string; mailOn: string };
}

/** The draft's dates, or none: a status answer is never refused over dates it cannot read. */
function scheduleFor(draft: Parameters<typeof draftScheduleOf>[0]): { arriveBy: string; mailOn: string } | undefined {
  try {
    return draftScheduleOf(draft) ?? undefined;
  } catch {
    return undefined;
  }
}

async function handler(
  input: GetDraftStatusInput,
  context: ToolContext
): Promise<GetDraftStatusOutput> {
  const draftId = typeof input.draftId === 'string' ? input.draftId.trim() : '';
  const draft = isDraftIdShape(draftId) ? await getDraftState(draftId) : null;

  // Someone else's draft reads the same as a missing one.
  if (!draft || draft.user_id !== context.user.userId) {
    return { draftId, status: 'not_found' };
  }
  const schedule = scheduleFor(draft);
  const dates = schedule ? { schedule } : {};
  if (draft.status === 'consumed') {
    return draft.consumed_letter_id
      ? { draftId, status: 'sent', orderId: draft.consumed_letter_id, ...dates }
      : { draftId, status: 'sent', ...dates };
  }
  const expiresAt = new Date(draft.expires_at);
  if (
    draft.status === 'expired' ||
    draft.status === 'cancelled' ||
    !(expiresAt.getTime() > context.now().getTime())
  ) {
    return { draftId, status: 'expired' };
  }
  return { draftId, status: 'ready', ...dates };
}

export const getDraftStatusTool: McpToolDefinition<GetDraftStatusInput, GetDraftStatusOutput> = {
  name: GET_DRAFT_STATUS_TOOL,
  title: 'Check a preview',
  description:
    "Used by Letter IRL's preview card: says whether a previewed letter or postcard is still ready to send, " +
    'has been sent (with its order id), or has expired. It sends nothing and changes nothing.',
  readOnly: true,
  inputSchema: getDraftStatusInputSchema,
  outputSchema: getDraftStatusOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Checking the preview...',
    'openai/toolInvocation/invoked': 'Checked',
    readOnlyHint: true
  },
  handler
};
