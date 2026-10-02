import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { DELIVERY_ESTIMATE } from '../content/delivery.js';
import { getDraftStatusInputSchema, getDraftStatusOutputSchema } from '../schemas.js';
import { scheduleSentence } from '../services/deliverySchedule.js';
import { getDraftState, type DraftState } from '../services/draftService.js';
import { isStationeryOffered } from '../config/stationery.js';
import { stationeryOf, type Stationery } from '../render/stationery.js';
import { draftScheduleOf } from '../services/draftSchedule.js';
import { heldSendFields, waitsInOutbox } from './heldSend.js';
import { isDraftIdShape } from './requestSend.js';
import { letterPayment, wordsVersionOf } from './letterHelpers.js';
import { letterPageLimit } from '../config/roomToWrite.js';
import type { SendEligibility } from '../services/commerceService.js';

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
 * changed since the preview's first answer, and what they mean for delivery,
 * so a card shown that answer again draws the dates the draft has. For a sent
 * draft it says where the order stands, from the letter itself: scheduled
 * while it waits for its mail date (and whether it can be cancelled),
 * cancelled, or sent. A card never takes a draft's dates for the order's.
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
  /** Ready: the draft's arrival dates (#535). Sent: the order's, from its letter. */
  schedule?: { arriveBy: string; mailOn: string };
  /** Ready: what the preview says about delivery with the draft's dates now. */
  deliveryEstimate?: string;
  /** Sent (#535): where the order stands, when its letter can be read. */
  orderStatus?: 'scheduled' | 'cancelled' | 'sent';
  /**
   * A ready letter's stationery now, while stationery is offered (#563):
   * Classic for a page our renderer drew without a theme.
   */
  stationery?: Stationery;
  /** With it, the page as it is now: for the card, in _meta (partitionToolResult). */
  previewHtml?: string;
  /** Sent and scheduled: whether it can still be cancelled free (not Pay & Send). */
  cancellable?: boolean;
  /** Ready: a letter of more than one page (#586), the pages it is laid out on now. */
  pages?: number;
  /** Ready, while room to write is offered (#586): what it costs now, as a restyle may have changed it. */
  canSendNow?: boolean;
  reasonCannotSend?: string;
  sendEligibility?: SendEligibility;
  /** Ready, while room to write is offered (#586): its words now, and their version, for the card. */
  bodyText?: string;
  signOff?: string;
  wordsVersion?: string;
}

/** The draft's dates, or none: a status answer is never refused over dates it cannot read. */
function scheduleFor(draft: Parameters<typeof draftScheduleOf>[0]): { arriveBy: string; mailOn: string } | undefined {
  try {
    return draftScheduleOf(draft) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where the order a sent draft became stands, from the letter itself: its
 * dates, and scheduled while it waits for them (cancellable unless Pay &
 * Send). Nothing when the letter cannot be read, which the card shows as
 * plainly sent.
 */
function orderFields(draft: DraftState): Pick<GetDraftStatusOutput, 'schedule' | 'orderStatus' | 'cancellable'> {
  if (draft.letter_status == null) return {};
  const waiting = waitsInOutbox(draft.letter_status);
  const held = heldSendFields(
    { arrive_by: draft.letter_arrive_by, mail_on: draft.letter_mail_on, funding_type: draft.letter_funding_type },
    waiting
  );
  const dates = held ? { schedule: held.schedule } : {};
  if (draft.letter_status === 'cancelled') return { ...dates, orderStatus: 'cancelled', cancellable: false };
  if (held && waiting) return { ...dates, orderStatus: 'scheduled', cancellable: held.cancellable };
  return { ...dates, orderStatus: 'sent', cancellable: false };
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
  if (draft.status === 'consumed') {
    return draft.consumed_letter_id
      ? { draftId, status: 'sent', orderId: draft.consumed_letter_id, ...orderFields(draft) }
      : { draftId, status: 'sent' };
  }
  const expiresAt = new Date(draft.expires_at);
  if (
    draft.status === 'expired' ||
    draft.status === 'cancelled' ||
    !(expiresAt.getTime() > context.now().getTime())
  ) {
    return { draftId, status: 'expired' };
  }
  const schedule = scheduleFor(draft);
  const ready: GetDraftStatusOutput = schedule
    ? { draftId, status: 'ready', schedule, deliveryEstimate: scheduleSentence(schedule, context.now()) }
    : { draftId, status: 'ready', deliveryEstimate: DELIVERY_ESTIMATE };
  return { ...ready, ...styleNow(draft), ...pagesNow(draft), ...termsNow(draft, draftId, context), ...wordsNow(draft) };
}

/**
 * What a ready letter drawn by our renderer costs now (#586), while room to
 * write is offered: a restyle may have changed its pages since its preview's
 * first answer, and with them who pays. The preview's own terms
 * (letterPayment), for the balance as it is now.
 */
function termsNow(
  draft: DraftState,
  draftId: string,
  context: ToolContext
): Pick<GetDraftStatusOutput, 'canSendNow' | 'reasonCannotSend' | 'sendEligibility'> {
  if (draft.mail_type !== 'letter' || !draft.renderer_version || letterPageLimit() === 1) return {};
  const pages = Number(draft.pages ?? 1);
  const option = pages > 1 ? { mailType: 'letter' as const, pages } : { mailType: 'letter' as const };
  return letterPayment(option, Number(draft.required_credits ?? 2), draft.is_gift_send === true, context, draftId);
}

/**
 * A ready letter's words now, and their version (#586), while room to write
 * is offered: the chat may have changed them since the card's preview, and
 * the card's Words tab starts from them (#593 review round 1).
 */
function wordsNow(draft: DraftState): Pick<GetDraftStatusOutput, 'bodyText' | 'signOff' | 'wordsVersion'> {
  if (draft.mail_type !== 'letter' || !draft.renderer_version || letterPageLimit() === 1) return {};
  const signOff = draft.sign_off ?? '';
  return { bodyText: draft.body_text, signOff, wordsVersion: wordsVersionOf(draft.body_text, signOff) };
}

/**
 * A ready letter's pages now (#586), when more than one: set_stationery may
 * have changed them since its preview's first answer, and its price with them.
 */
function pagesNow(draft: DraftState): Pick<GetDraftStatusOutput, 'pages'> {
  const pages = Number(draft.pages ?? 1);
  return draft.mail_type === 'letter' && pages > 1 ? { pages } : {};
}

/**
 * A ready letter's style and page as they are now (#563), for a card shown
 * its preview's first answer again: set_stationery may have changed both
 * since. Only while stationery is offered, and only for a page our renderer
 * drew (renderer_version), whose stored theme reads as the print reads it.
 */
function styleNow(draft: DraftState): Pick<GetDraftStatusOutput, 'stationery' | 'previewHtml'> {
  if (!isStationeryOffered() || draft.mail_type !== 'letter' || !draft.renderer_version) return {};
  return {
    stationery: stationeryOf(draft.stationery) ?? { theme: 'classic' },
    ...(draft.preview_html ? { previewHtml: draft.preview_html } : {})
  };
}

export const getDraftStatusTool: McpToolDefinition<GetDraftStatusInput, GetDraftStatusOutput> = {
  name: GET_DRAFT_STATUS_TOOL,
  title: 'Check a preview',
  description:
    "Used by Letter IRL's preview card: says whether a previewed letter or postcard is still ready to send, " +
    'has been sent (with its order id and where that order stands), or has expired. It sends nothing and changes nothing.',
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
