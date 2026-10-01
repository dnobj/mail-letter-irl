import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { cancelScheduledMailInputSchema, cancelScheduledMailOutputSchema } from '../schemas.js';
import {
  cancelScheduledMail,
  type CancelledScheduledMail,
  type ScheduledMailRefusal
} from '../services/scheduledMailService.js';

/**
 * Cancels held mail (#535): a letter or postcard sent with an arrival date,
 * while it waits for its mail date. Free until it goes to the printer: its
 * letter, or its gift letter, goes back exactly once (scheduledMailService).
 *
 * The model may cancel (the owner's decision on #535), with `confirm: true`,
 * as for the other tools with an outcome the person cannot undo. Listed only
 * while LETTER_IRL_ARRIVE_BY_ENABLED is on (src/server.ts), and the same
 * service answers the website (POST /api/letters/:id/cancel).
 */
export const CANCEL_SCHEDULED_MAIL_TOOL = 'cancel_scheduled_mail';

interface CancelScheduledMailInput {
  orderId: string;
  confirm: boolean;
}

export interface CancelScheduledMailOutput {
  orderId: string;
  status: 'cancelled';
  /** True when it had already been cancelled: nothing changed now. */
  alreadyCancelled: boolean;
  /** What went back to the account: letters, or a gift letter. */
  returned: { kind: 'letters' | 'gift_letter'; count: number };
  message: string;
}

/**
 * Refusals the model can act on. Like request_send's, none repeats the id, and
 * the code doubles as the log's class.
 */
export class ScheduledMailRefusedError extends Error {
  readonly diagnosticClass: string;

  constructor(
    readonly code:
      | 'CONFIRM_REQUIRED'
      | 'ORDER_NOT_FOUND'
      | 'ORDER_NOT_SCHEDULED'
      | 'ORDER_PAY_AND_SEND'
      | 'ORDER_ALREADY_MAILED'
      | 'ORDER_BEING_SENT',
    message: string
  ) {
    super(message);
    this.name = 'ScheduledMailRefusedError';
    this.diagnosticClass = code;
  }
}

/**
 * The words for each refusal, also used by the website's route. The support
 * address is the one the server instructions give for refunds, which a person
 * decides.
 */
export const SCHEDULED_MAIL_REFUSALS: Record<ScheduledMailRefusal, [ScheduledMailRefusedError['code'], string]> = {
  not_found: ['ORDER_NOT_FOUND', "That order wasn't found. list_orders shows the orders on this account."],
  not_scheduled: [
    'ORDER_NOT_SCHEDULED',
    'Only mail scheduled to arrive by a date can be cancelled. This order goes to the printer as soon as it can.'
  ],
  pay_and_send: [
    'ORDER_PAY_AND_SEND',
    "A Pay & Send order can't be cancelled here. Email support@letterirl.com from the email on your Letter IRL account, " +
      'quoting the order id; refunds are decided by a person.'
  ],
  too_late: ['ORDER_ALREADY_MAILED', "This order has gone to the printer, or did not go out, so it can't be cancelled."],
  busy: [
    'ORDER_BEING_SENT',
    "This order is going to the printer right now, so it can't be cancelled. get_order_status shows where it is."
  ]
};

/** What a cancel says went back, in letters, never credits. */
export function cancelledMessage(cancelled: CancelledScheduledMail): string {
  if (cancelled.alreadyCancelled) {
    return 'This order was already cancelled, so nothing changed.';
  }
  switch (cancelled.shortfall) {
    case 'partial':
      return 'Cancelled. Part of what it cost is back in the balance; the rest had been refunded or had expired.';
    case 'expired':
      return 'Cancelled. What paid for it expired while it waited, so nothing came back to the balance.';
    case 'refunded':
      return 'Cancelled. Nothing went back to the account: what paid for it had already been refunded.';
  }
  const { kind, count } = cancelled.returned;
  if (kind === 'gift_letter') return 'Cancelled. The gift letter is back in the account, to use again.';
  return `Cancelled. ${count === 1 ? 'The letter it cost is' : `The ${count} letters it cost are`} back in the balance.`;
}

async function handler(
  input: CancelScheduledMailInput,
  context: ToolContext
): Promise<CancelScheduledMailOutput> {
  if (input.confirm !== true) {
    throw new ScheduledMailRefusedError(
      'CONFIRM_REQUIRED',
      'Cancelling cannot be undone: check with the person first, then call again with confirm: true.'
    );
  }
  const orderId = typeof input.orderId === 'string' ? input.orderId.trim() : '';
  const result = orderId
    ? await cancelScheduledMail({ letterId: orderId, userId: context.user.userId })
    : ({ ok: false, refusal: 'not_found' } as const);
  if (!result.ok) {
    const [code, message] = SCHEDULED_MAIL_REFUSALS[result.refusal];
    throw new ScheduledMailRefusedError(code, message);
  }

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: 'schedule.cancel_tool',
      alreadyCancelled: result.cancelled.alreadyCancelled
    },
    'Held mail cancelled'
  );
  return {
    orderId,
    status: 'cancelled',
    alreadyCancelled: result.cancelled.alreadyCancelled,
    returned: result.cancelled.returned,
    message: cancelledMessage(result.cancelled)
  };
}

export const cancelScheduledMailTool: McpToolDefinition<CancelScheduledMailInput, CancelScheduledMailOutput> = {
  name: CANCEL_SCHEDULED_MAIL_TOOL,
  title: 'Cancel scheduled mail',
  description:
    'Cancel a letter or postcard that was sent with an arrival date and is waiting for its mail date. ' +
    'Free until it goes to the printer: the letter it cost, or its gift letter, goes back to the account. ' +
    'Requires the orderId (from list_orders or the send) and confirm: true, after the person agrees, because it cannot be undone. ' +
    'Pay & Send orders and mail with no arrival date cannot be cancelled here.',
  readOnly: false,
  inputSchema: cancelScheduledMailInputSchema,
  outputSchema: cancelScheduledMailOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Cancelling the scheduled mail...',
    'openai/toolInvocation/invoked': 'Scheduled mail cancelled',
    // Irreversible (it must be sent again to go out), and a repeat answers as
    // already cancelled.
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true
  },
  handler
};
