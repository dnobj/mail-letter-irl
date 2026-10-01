import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { setArrivalDateInputSchema, setArrivalDateOutputSchema } from '../schemas.js';
import { isArriveByEnabled } from '../config/arriveBy.js';
import { DELIVERY_ESTIMATE } from '../content/delivery.js';
import { setDraftSchedule, type DraftScheduleRefusal } from '../services/draftService.js';
import { previewSchedule, scheduleSentence, type PreviewScheduleOutput } from './arriveByInput.js';
import { isDraftIdShape } from './requestSend.js';

/**
 * A preview's arrival date, set, moved or cleared without previewing again
 * (#535). The date is checked as the preview tools check theirs
 * (previewSchedule), and the draft's dates change only while it waits to be
 * sent (setDraftSchedule). Nothing is sent here.
 *
 * Listed only while LETTER_IRL_ARRIVE_BY_ENABLED is on (src/server.ts), and
 * refused while it is off, for an app that cached the list.
 */
export const SET_ARRIVAL_DATE_TOOL = 'set_arrival_date';

interface SetArrivalDateInput {
  draftId: string;
  arriveBy?: string;
}

export interface SetArrivalDateOutput {
  draftId: string;
  /** The draft's dates now; absent when it mails as soon as it is sent. */
  schedule?: PreviewScheduleOutput;
  /** What the preview's Delivery row would say now. */
  deliveryEstimate: string;
  message: string;
}

/**
 * Refusals the model can act on. Like request_send's, none repeats the draft
 * id, and the code doubles as the log's class.
 */
export class ArrivalDateRefusedError extends Error {
  readonly diagnosticClass: string;

  constructor(
    readonly code:
      | 'ARRIVE_BY_DISABLED'
      | 'DRAFT_NOT_FOUND'
      | 'DRAFT_ALREADY_SENT'
      | 'DRAFT_EXPIRED'
      | 'DRAFT_CHECKOUT_PENDING',
    message: string
  ) {
    super(message);
    this.name = 'ArrivalDateRefusedError';
    this.diagnosticClass = code;
  }
}

const REFUSALS: Record<DraftScheduleRefusal, [ArrivalDateRefusedError['code'], string]> = {
  not_found: ['DRAFT_NOT_FOUND', "That preview wasn't found. Make a new preview, then try again."],
  sent: ['DRAFT_ALREADY_SENT', "This mail has already been sent, so its arrival date can't change. list_orders shows it."],
  expired: ['DRAFT_EXPIRED', 'This preview has expired. Make a new preview: the preview tools take arriveBy themselves.'],
  checkout_pending: [
    'DRAFT_CHECKOUT_PENDING',
    "This preview is tied to a Pay & Send payment, so its arrival date can't change now."
  ]
};

async function handler(
  input: SetArrivalDateInput,
  context: ToolContext
): Promise<SetArrivalDateOutput> {
  if (!isArriveByEnabled()) {
    throw new ArrivalDateRefusedError(
      'ARRIVE_BY_DISABLED',
      'Arrival dates are not available yet. The preview mails as soon as it is sent.'
    );
  }
  const draftId = typeof input.draftId === 'string' ? input.draftId.trim() : '';
  // The date first, as the previews check theirs: a date that can't be met is
  // refused naming the dates on offer, before the draft is read. None, an
  // empty string included, clears it.
  const schedule = previewSchedule(input.arriveBy, context);
  const refused = isDraftIdShape(draftId)
    ? await setDraftSchedule(draftId, context.user.userId, schedule?.draft ?? null, context.now())
    : 'not_found';
  if (refused) {
    context.logger.warn(
      { correlationId: context.correlationId, event: 'draft.arrival_date_refused', reason: refused },
      'An arrival date change was refused'
    );
    const [code, message] = REFUSALS[refused];
    throw new ArrivalDateRefusedError(code, message);
  }

  if (!schedule) {
    return {
      draftId,
      deliveryEstimate: DELIVERY_ESTIMATE,
      message: 'No arrival date: once this mail is sent, it goes to the printer as soon as it can. Nothing has been sent.'
    };
  }
  const sentence = scheduleSentence(schedule.output, context.now());
  return {
    draftId,
    schedule: schedule.output,
    deliveryEstimate: sentence,
    message:
      `Arrival date set. ${sentence} Nothing has been sent: if it is sent, it is held until then. ` +
      'USPS does not guarantee First-Class dates.'
  };
}

export const setArrivalDateTool: McpToolDefinition<SetArrivalDateInput, SetArrivalDateOutput> = {
  name: SET_ARRIVAL_DATE_TOOL,
  title: 'Set the arrival date',
  description:
    'Set, change or clear the date a previewed letter or postcard should arrive by, without previewing it again. ' +
    'Give the draftId from the preview and arriveBy as YYYY-MM-DD; leave arriveBy out to clear the date, so the mail ' +
    'goes to the printer as soon as it is sent. Nothing is sent by this tool. Letter IRL holds the mail and sends it ' +
    'to the printer in time; USPS does not guarantee First-Class dates.',
  readOnly: false,
  inputSchema: setArrivalDateInputSchema,
  outputSchema: setArrivalDateOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Setting the arrival date...',
    'openai/toolInvocation/invoked': 'Arrival date updated',
    // Changes only a draft's dates: a draft expires on its own and sends
    // nothing, and the same date twice changes nothing more.
    readOnlyHint: false,
    idempotentHint: true
  },
  handler
};
