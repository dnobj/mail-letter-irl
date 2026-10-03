import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { requestSendInputSchema, requestSendOutputSchema } from '../schemas.js';
import { getDraft } from '../services/draftService.js';
import { draftScheduleOf } from '../services/draftSchedule.js';
import { earliestMailOn } from '../services/deliverySchedule.js';
import type { LetterDraft } from '../services/types.js';
import { sendConfirmationUrl } from '../config/sendConfirmation.js';
import { draftMailOption, isExtraService, isPackPayable, mailServiceOf } from '../config/products.js';
import type { CertifiedMailService } from '../services/types.js';

/**
 * A link where the person checks a draft and sends it themselves (#470).
 *
 * Nothing is sent here and nothing changes: the tool reads the draft and hands
 * back the letterirl.com page that shows its preview with a Send button. That
 * page, not the model, is what sends. It is also what a send tool answers with
 * when it is called from an app that cannot show our card
 * (src/mcp/registerTools.ts), so there is one link whichever way the model
 * asks.
 *
 * Registered only while the send rule is on (isSendConfirmationEnabled): the
 * page it points to is part of the same rollout.
 */
export const REQUEST_SEND_TOOL = 'request_send';

interface RequestSendInput {
  draftId: string;
}

export interface RequestSendOutput {
  draftId: string;
  mailType: 'letter' | 'postcard';
  confirmationUrl: string;
  expiresAtISO: string;
  recipientSummary: { name: string; city: string; state: string };
  /** The preview's arrival dates (#535): once sent, it waits for its mail date. */
  schedule?: { arriveBy: string; mailOn: string };
  /**
   * Present when the page takes a Pay & Send payment for this mail: packs and
   * gift letters pay only for one-page letters and 6x9 postcards (#579), and
   * never for certified mail (#625).
   */
  paidPerSend?: true;
  /** Present only for certified mail (#625): which service, so the words around the link do not give it the pack rule. */
  mailService?: CertifiedMailService;
}

/** The draft's dates, or none: a link is never refused over dates it cannot read. */
function scheduleOf(draft: LetterDraft): { arriveBy: string; mailOn: string } | undefined {
  try {
    return draftScheduleOf(draft) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Refusals the model can act on. The draft id is the model's own input, but
 * none of these repeat it - the same rule as src/tools/draftErrors.ts, whose
 * messages never interpolate internal values.
 */
export class SendConfirmationRefusedError extends Error {
  /** The code is a fixed identifier, so it doubles as the log's class. */
  readonly diagnosticClass: string;

  constructor(
    readonly code: 'DRAFT_NOT_FOUND' | 'DRAFT_ALREADY_SENT' | 'DRAFT_EXPIRED' | 'SCHEDULE_PASSED',
    message: string
  ) {
    super(message);
    this.name = 'SendConfirmationRefusedError';
    this.diagnosticClass = code;
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// letter_drafts.draft_id is a UUID column: anything else would reach
// PostgreSQL as an invalid cast (22P02) rather than a draft that is not there.
const DRAFT_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDraftIdShape(value: string): boolean {
  return DRAFT_ID_SHAPE.test(value);
}

async function handler(
  input: RequestSendInput,
  context: ToolContext
): Promise<RequestSendOutput> {
  const draftId = typeof input.draftId === 'string' ? input.draftId.trim() : '';
  const draft = isDraftIdShape(draftId) ? await getDraft(draftId) : null;

  // Someone else's draft is refused in the same words as a missing one, so the
  // answer says nothing about whether the id exists.
  if (!draft || draft.user_id !== context.user.userId) {
    throw new SendConfirmationRefusedError(
      'DRAFT_NOT_FOUND',
      "That preview wasn't found. Make a new preview, then ask again."
    );
  }
  if (draft.status === 'consumed') {
    throw new SendConfirmationRefusedError(
      'DRAFT_ALREADY_SENT',
      'This mail has already been sent. list_orders shows it.'
    );
  }
  const expiresAt = new Date(draft.expires_at);
  if (
    draft.status === 'expired' ||
    draft.status === 'cancelled' ||
    !(expiresAt.getTime() > context.now().getTime())
  ) {
    throw new SendConfirmationRefusedError(
      'DRAFT_EXPIRED',
      'This preview has expired. Make a new preview, then ask again.'
    );
  }

  // A mail date that has passed (#535): the page would refuse the send, by
  // the send's own rule (src/services/mailSendService.ts), so no link
  // promises it.
  const schedule = scheduleOf(draft);
  if (schedule && schedule.mailOn < earliestMailOn(context.now())) {
    const noun = draft.mail_type === 'postcard' ? 'postcard' : 'letter';
    throw new SendConfirmationRefusedError(
      'SCHEDULE_PASSED',
      `The day this ${noun} was to go to the printer has passed, so it can no longer arrive by its date. ` +
        'Preview it again with a new arrival date, or with none to send it as soon as possible, then ask again.'
    );
  }

  const recipient = (draft.recipient ?? {}) as Record<string, unknown>;
  context.logger.info(
    { correlationId: context.correlationId, event: 'send.confirmation_link' },
    'Returned a send confirmation link'
  );

  return {
    draftId: draft.draft_id,
    mailType: draft.mail_type === 'postcard' ? 'postcard' : 'letter',
    confirmationUrl: sendConfirmationUrl(draft.draft_id),
    expiresAtISO: expiresAt.toISOString(),
    recipientSummary: {
      name: text(recipient.name),
      city: text(recipient.city),
      state: text(recipient.state)
    },
    ...(schedule ? { schedule } : {}),
    ...(isPackPayable(draftMailOption(draft)) ? {} : { paidPerSend: true as const }),
    ...(isExtraService(mailServiceOf(draft.mail_service)) ? { mailService: mailServiceOf(draft.mail_service) as CertifiedMailService } : {})
  };
}

export const requestSendTool: McpToolDefinition<RequestSendInput, RequestSendOutput> = {
  name: REQUEST_SEND_TOOL,
  title: 'Get a link to send a preview',
  description:
    'Get a link where the person checks a previewed letter or postcard and sends it themselves on letterirl.com. ' +
    'Nothing is sent by this tool, and nothing is sent until the person presses Send on that page, ' +
    'or pays there with Pay & Send for mail no letter pack pays for. ' +
    'Use it when the person wants to send a preview and no preview card with a Send button is showing.',
  readOnly: true,
  inputSchema: requestSendInputSchema,
  outputSchema: requestSendOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Getting a link to send it...',
    'openai/toolInvocation/invoked': 'Link ready',
    // Reads the draft and changes nothing. No idempotentHint beside it, as
    // with the other read-only tools (a consistency test enforces one or the
    // other).
    readOnlyHint: true
  },
  handler
};
