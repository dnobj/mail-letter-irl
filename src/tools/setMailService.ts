import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { setMailServiceInputSchema, setMailServiceOutputSchema } from '../schemas.js';
import { MAIL_SERVICES, isCertifiedMailOffered } from '../config/certifiedMail.js';
import { draftMailOption, isExtraService, mailServiceOf } from '../config/products.js';
import type { SendEligibility } from '../services/commerceService.js';
import { getDraftForMailService, setDraftMailService, type MailServiceRefusal } from '../services/draftService.js';
import type { CertifiedMailService } from '../services/types.js';
import { letterPayment } from './letterHelpers.js';
import { isDraftIdShape } from './requestSend.js';
import { giftLetterNote } from './setLetterWords.js';

/**
 * How a previewed letter travels, changed without previewing it again (#625):
 * ordinary first-class mail, or USPS Certified Mail with or without an
 * electronic return receipt. The draft keeps the service only while it waits
 * to be sent (setDraftMailService); its page does not change, but its price
 * does, and with it who can pay: certified mail is Pay & Send only. Nothing is
 * sent here.
 *
 * Listed only while certified mail is offered (src/server.ts). An app that
 * cached the list gets the connection's own unknown-tool error over MCP (an
 * unlisted tool is not registered there); the handler refuses too, for a call
 * that reaches it directly. The letter card's delivery control will call it.
 */
export const SET_MAIL_SERVICE_TOOL = 'set_mail_service';

interface SetMailServiceInput {
  draftId: string;
  /** Required by the served schema; a direct call without one is refused. */
  mailService: string;
}

export interface SetMailServiceOutput {
  draftId: string;
  /** Present only when the letter now goes as certified mail: which service. Absent: an ordinary letter. */
  mailService?: CertifiedMailService;
  /** What the letter costs and how it is paid as it stands now. */
  canSendNow: boolean;
  reasonCannotSend?: string;
  sendEligibility: SendEligibility;
  message: string;
}

type RefusalCode =
  | 'MAIL_SERVICE_NOT_OFFERED'
  | 'MAIL_SERVICE_INVALID'
  | 'DRAFT_NOT_FOUND'
  | 'DRAFT_ALREADY_SENT'
  | 'DRAFT_EXPIRED'
  | 'DRAFT_CHECKOUT_PENDING'
  | 'DRAFT_NOT_A_LETTER'
  | 'DRAFT_IS_GIFT';

/**
 * Refusals the model can act on. Like set_arrival_date's, none repeats the
 * draft id, and the code doubles as the log's class.
 */
export class MailServiceRefusedError extends Error {
  readonly diagnosticClass: string;

  constructor(
    readonly code: RefusalCode,
    message: string
  ) {
    super(message);
    this.name = 'MailServiceRefusedError';
    this.diagnosticClass = code;
  }
}

const REFUSALS: Record<MailServiceRefusal, [RefusalCode, string]> = {
  not_found: ['DRAFT_NOT_FOUND', "That preview wasn't found. Make a new preview, then try again."],
  sent: ['DRAFT_ALREADY_SENT', "This letter has already been sent, so how it travels can't change. list_orders shows it."],
  expired: ['DRAFT_EXPIRED', 'This preview has expired. Make a new preview: the letter previews take mailService themselves.'],
  checkout_pending: [
    'DRAFT_CHECKOUT_PENDING',
    "This preview is tied to a Pay & Send payment, so how it travels can't change now. Finish or let that payment lapse, or make a new preview."
  ],
  not_a_letter: [
    'DRAFT_NOT_A_LETTER',
    'Certified mail is for letters, and a postcard always goes as ordinary mail. Make a letter preview to send certified mail.'
  ],
  gift_send: [
    'DRAFT_IS_GIFT',
    'A gift letter does not pay for certified mail. Make a new preview with mailService certified: it is paid with Pay & Send, not by a gift letter.'
  ]
};

function refused(code: RefusalCode, message: string, context: ToolContext): MailServiceRefusedError {
  context.logger.warn(
    { correlationId: context.correlationId, event: 'draft.mail_service_refused', reason: code },
    'A mail service change was refused'
  );
  return new MailServiceRefusedError(code, message);
}

/** What the tool says it did, for the model and the person. */
function messageFor(service: CertifiedMailService | undefined): string {
  switch (service) {
    case 'certified':
      return 'This letter now goes by USPS Certified Mail once sent. Certified mail is paid with Pay & Send, never a letter pack or a gift letter. Nothing has been sent.';
    case 'certified_return_receipt':
      return 'This letter now goes by USPS Certified Mail with an electronic return receipt once sent. Certified mail is paid with Pay & Send, never a letter pack or a gift letter. Nothing has been sent.';
    default:
      return 'This letter now goes as ordinary first-class mail once sent. Nothing has been sent.';
  }
}

async function handler(input: SetMailServiceInput, context: ToolContext): Promise<SetMailServiceOutput> {
  if (!isCertifiedMailOffered()) {
    throw refused('MAIL_SERVICE_NOT_OFFERED', 'Certified mail is not available right now. The preview stays as it is.', context);
  }
  // A change names its service: none would leave the letter as it is without saying so.
  const requested = input.mailService;
  if (requested !== 'standard' && requested !== 'certified' && requested !== 'certified_return_receipt') {
    throw refused('MAIL_SERVICE_INVALID', `Name the service: ${MAIL_SERVICES.join(', ')}.`, context);
  }
  const draftId = typeof input.draftId === 'string' ? input.draftId.trim() : '';
  const userId = context.user.userId;

  // Read first, to say what the draft is: setDraftMailService allows standard on a postcard (that is what a
  // postcard is), but this tool is for letters, and its answer would price a postcard as a letter.
  const before = isDraftIdShape(draftId) ? await getDraftForMailService(draftId, userId) : null;
  if (!before) throw refused(...REFUSALS.not_found, context);
  if (before.mail_type !== 'letter') throw refused(...REFUSALS.not_a_letter, context);

  const refusal = await setDraftMailService(draftId, userId, requested, context.now());
  if (refusal) throw refused(...REFUSALS[refusal], context);

  // Priced as the draft stands now, as the send and the checkout read it. The lock is released, so a send
  // may have taken it meanwhile: then it is no longer a preview to change.
  const draft = await getDraftForMailService(draftId, userId);
  if (!draft) throw refused(...REFUSALS.not_found, context);
  if (draft.status !== 'pending') throw refused(...(draft.status === 'consumed' ? REFUSALS.sent : REFUSALS.expired), context);
  const service = mailServiceOf(draft.mail_service);
  const certified = isExtraService(service) ? service : undefined;
  // Text that is not a service would be called ordinary mail here and priced as nothing: say nothing instead.
  if (service !== undefined && certified === undefined) throw refused(...REFUSALS.not_found, context);
  context.logger.info(
    { correlationId: context.correlationId, event: 'draft.mail_service_changed', mailService: requested },
    "A preview's mail service was changed"
  );
  const payment = letterPayment(draftMailOption(draft), Number(draft.required_credits ?? 2), draft.is_gift_send === true, context, draftId);
  // Back to ordinary mail, the balance short, and a one-page letter: only a new preview decides a gift (#593).
  // (A gift letter can always send, so it never gets here.)
  const note =
    certified === undefined && !payment.canSendNow && Number(draft.pages ?? 1) === 1 ? await giftLetterNote(context) : '';
  return {
    draftId,
    ...(certified ? { mailService: certified } : {}),
    ...payment,
    message: messageFor(certified) + note
  };
}

export const setMailServiceTool: McpToolDefinition<SetMailServiceInput, SetMailServiceOutput> = {
  name: SET_MAIL_SERVICE_TOOL,
  title: 'Change how a letter travels',
  description:
    'Change how a previewed letter travels without previewing it again: standard (ordinary first-class mail), ' +
    'certified (USPS Certified Mail) or certified_return_receipt (Certified Mail with an electronic return receipt). ' +
    'Only when the person asks to add or remove certified mail: it costs more and is paid with Pay & Send, never a letter pack or ' +
    'a gift letter, and a postcard or a gift letter cannot be certified. ' +
    'Give the draftId from the preview and mailService; the page does not change, its price does. Nothing is sent by this tool.',
  readOnly: false,
  inputSchema: setMailServiceInputSchema,
  outputSchema: setMailServiceOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Changing how the letter travels...',
    'openai/toolInvocation/invoked': 'Mail service changed',
    // The letter card's delivery control will call it (#625).
    'openai/widgetAccessible': true,
    // Changes only a draft's service: a draft expires on its own and sends
    // nothing, and the same service twice changes nothing more.
    readOnlyHint: false,
    idempotentHint: true
  },
  handler
};
