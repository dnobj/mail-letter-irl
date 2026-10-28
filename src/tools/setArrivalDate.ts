import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { isArriveByEnabled } from '../config/arriveBy.js';
import { DELIVERY_ESTIMATE } from '../content/delivery.js';
import { setDraftSchedule, type DraftScheduleRefusal } from '../services/draftService.js';
import { previewScheduleWithRoom, scheduleSentence, type PreviewScheduleOutput } from './arriveByInput.js';
import { isDraftIdShape } from './requestSend.js';
import { DraftRefusedError, draftRefusals, type DraftRefusal } from './draftEdit.js';

/**
 * A preview's arrival date, set, moved or cleared without previewing again
 * (#535). The date is checked as the preview tools check theirs, with room
 * on its mail date (previewScheduleWithRoom, #700), and the draft's dates
 * change only while it waits to be sent (setDraftSchedule). Nothing is sent
 * here.
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
  /** The draft's content version once changed (#695): the send takes it back. */
  contentVersion?: string;
  /** The version the change was made to (#695): a card takes contentVersion only when this is the one it shows. */
  contentVersionBefore?: string;
  draftId: string;
  /** The draft's dates now; absent when it mails as soon as it is sent. */
  schedule?: PreviewScheduleOutput;
  /** What the preview's Delivery row would say now. */
  deliveryEstimate: string;
  message: string;
}

/** The draft's state, refused in an arrival date's words (#690): a letter or a postcard, so "this mail". */
const { changed: _neverRedrawn, ...ARRIVAL_DATE_STATES } = draftRefusals({
  mail: 'mail',
  what: 'its arrival date',
  previewTakes: 'the preview tools take arriveBy themselves'
});
// Nothing is drawn again for a date, so no change can refuse as 'changed'.
export const ARRIVAL_DATE_REFUSALS: Record<DraftScheduleRefusal, DraftRefusal> = ARRIVAL_DATE_STATES;

async function handler(
  input: SetArrivalDateInput,
  context: ToolContext
): Promise<SetArrivalDateOutput> {
  if (!isArriveByEnabled()) {
    throw new DraftRefusedError(
      'ARRIVE_BY_DISABLED',
      'Arrival dates are not available yet. The preview mails as soon as it is sent.'
    );
  }
  const draftId = typeof input.draftId === 'string' ? input.draftId.trim() : '';
  // The date first, as the previews check theirs: a date that can't be met is
  // refused naming the dates on offer, before the draft is read. None, an
  // empty string included, clears it.
  const schedule = await previewScheduleWithRoom(input.arriveBy, context);
  let contentVersion: string | undefined;
  let contentVersionBefore: string | undefined;
  const refusal = isDraftIdShape(draftId)
    ? await setDraftSchedule(draftId, context.user.userId, schedule?.draft ?? null, context.now(), (version, before) => { contentVersion = version; contentVersionBefore = before; })
    : 'not_found';
  if (refusal) {
    // Logged by the draft's state, as it always was here, where the other editors log the code.
    context.logger.warn(
      { correlationId: context.correlationId, event: 'draft.arrival_date_refused', reason: refusal },
      'An arrival date change was refused'
    );
    throw new DraftRefusedError(...ARRIVAL_DATE_REFUSALS[refusal]);
  }

  if (!schedule) {
    return {
      ...(contentVersion ? { contentVersion, contentVersionBefore } : {}),
      draftId,
      deliveryEstimate: DELIVERY_ESTIMATE,
      message: 'No arrival date: once this mail is sent, it goes to the printer as soon as it can. Nothing has been sent.'
    };
  }
  const sentence = scheduleSentence(schedule.output, context.now());
  return {
    ...(contentVersion ? { contentVersion, contentVersionBefore } : {}),
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
    'goes to the printer as soon as it is sent. With a date set, once it is sent, Letter IRL holds the mail and sends it ' +
    'to the printer in time; USPS does not guarantee First-Class dates.',
  readOnly: false,
  meta: {
    'openai/toolInvocation/invoking': 'Setting the arrival date...',
    'openai/toolInvocation/invoked': 'Arrival date updated',
    // The cards' Arrives picker calls it (#535).
    'openai/widgetAccessible': true,
    // Changes only a draft's dates: a draft expires on its own and sends
    // nothing, and the same date twice changes nothing more.
    readOnlyHint: false,
    idempotentHint: true
  },
  handler
};
