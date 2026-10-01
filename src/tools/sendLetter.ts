import {
  type Address,
  type LetterSnapshot,
  type McpToolDefinition,
  type OrderRecord,
  type ToolContext,
} from '../contracts/types.js';
import { sendLetterInputSchema, sendLetterOutputSchema } from '../schemas.js';
import { createOrderRecord } from '../services/orderService.js';
import { processLetterJob } from '../services/letterJobService.js';
import { createMailOrderFromDraft } from '../services/mailSendService.js';
import { hasReturnAddress } from '../services/returnAddressService.js';
import type { LetterStatus } from '../services/types.js';
import { heldSendFields, heldSendStatusText, waitsInOutbox, type HeldSendFields } from './heldSend.js';
import { friendlyDraftError as sharedDraftError } from './draftErrors.js';
import { sendToolDescription } from './previewSendStep.js';

interface SendLetterInput {
  draftId: string;
  confirm: boolean;
  sendAnotherCopy?: boolean;
}

type PublicStatus =
  | 'pending'
  | 'accepted'
  | 'printing'
  | 'in_transit'
  | 'delivered'
  | 'returned'
  | 'failed'
  | 'cancelled'
  | 'scheduled';

interface SendLetterOutput {
  orderId: string;
  currentStatus: PublicStatus;
  statusTimeline: { timestampISO: string; statusText: string }[];
  recipientSummary: { name: string; city: string; state: string };
  lettersRemaining: number;
  isRetry?: boolean;
  suggestSaveReturnAddress?: boolean;
  saveReturnAddressNote?: string;
  trackingSupport: 'none' | 'estimated_only' | 'carrier_tracking';
  /** Sent with an arrival date (#535): its dates. */
  schedule?: HeldSendFields['schedule'];
  /** With a schedule: whether cancel_scheduled_mail can still cancel it free. */
  cancellable?: boolean;
}

function publicStatus(status: LetterStatus): PublicStatus {
  if (status === 'queued' || status === 'processing' || status === 'held' || status === 'draft') return 'pending';
  if (status === 'sent') return 'accepted';
  return status;
}

/**
 * Kept as a named export with its original two-argument shape so callers and
 * tests are unchanged; the wording now lives in one place. See
 * src/tools/draftErrors.ts for why the default stopped forwarding.
 */
export function friendlyDraftError(error: unknown, draftId: string): Error {
  return sharedDraftError(error, draftId, 'letter');
}

async function handler(
  input: SendLetterInput,
  context: ToolContext
): Promise<SendLetterOutput> {
  context.logger.info(
    { correlationId: context.correlationId, event: 'send.letter.start' },
    'Processing send_letter'
  );

  if (!input.confirm) throw new Error('send_letter requires confirm: true');
  if (!input.draftId) {
    throw new Error('send_letter requires a draftId from a letter preview tool.');
  }

  const now = context.now().toISOString();
  let created;
  try {
    created = await createMailOrderFromDraft({
      draftId: input.draftId,
      userId: context.user.userId,
      mailType: 'letter',
      allowDuplicate: input.sendAnotherCopy === true,
    });
  } catch (error) {
    throw friendlyDraftError(error, input.draftId);
  }

  const sender = created.draft.sender as unknown as Address;
  const recipient = created.draft.recipient as unknown as Address;
  context.user.creditsRemaining = created.creditsRemaining;

  // A retry of a send already made: the letter as it stands now (#535).
  const retryHeld = created.alreadyConsumed
    ? heldSendFields(created.letter, waitsInOutbox(created.letter.status))
    : undefined;
  if (created.alreadyConsumed) {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: 'send.letter.idempotent_retry',
        alreadyConsumed: true,
      },
      'Returning the existing order for a consumed draft'
    );
    return {
      orderId: created.letter.letter_id,
      currentStatus: retryHeld?.cancellable ? 'scheduled' : publicStatus(created.letter.status),
      statusTimeline: [{ timestampISO: now, statusText: 'Existing order returned (duplicate request)' }],
      recipientSummary: { name: recipient.name, city: recipient.city, state: recipient.state },
      lettersRemaining: Math.floor(created.creditsRemaining / 2),
      isRetry: true,
      trackingSupport: 'estimated_only',
      ...(retryHeld ?? {}),
    };
  }

  if (!created.job) {
    throw new Error('Letter was created without an outbox record');
  }

  const snapshot: LetterSnapshot = {
    sender,
    recipient,
    bodyText: created.draft.body_text,
    signOff: created.draft.sign_off,
    requiredCredits: created.draft.required_credits,
  };
  const orderRecord: OrderRecord = createOrderRecord({
    orderId: created.letter.letter_id,
    snapshot,
    timestampISO: now,
  });

  context.user.orders.push(orderRecord);
  await context.persist(context.user);

  const submission = await processLetterJob(created.job.job_id);
  // Not claimed means queued, not failed: the outbox is paused (#444), or
  // another process took the job first. Either way it goes out from the queue.
  // Sent with an arrival date (#535): until its mail date it waits in the
  // outbox, and the dispatch above does not take it.
  const held = heldSendFields(created.letter, !submission.claimed);
  const currentStatus: PublicStatus = submission.completed
    ? 'accepted'
    : held?.cancellable
      ? 'scheduled'
      : submission.retryScheduled || !submission.claimed
        ? 'pending'
        : 'failed';
  const submissionText = submission.completed
    ? 'Accepted by print provider'
    : held?.cancellable
      ? heldSendStatusText(held.schedule, context.now())
      : !submission.claimed
        ? 'Queued for the print provider'
        : submission.retryScheduled
          ? 'Provider temporarily unavailable; retry scheduled'
          : 'Provider submission failed';

  // The order this session holds says the same.
  if (held) {
    orderRecord.schedule = held.schedule;
    orderRecord.cancellable = held.cancellable;
    if (held.cancellable) orderRecord.currentStatus = 'scheduled';
  }

  let suggestSaveReturnAddress: boolean | undefined;
  let saveReturnAddressNote: string | undefined;
  if (!(await hasReturnAddress(context.user.userId))) {
    suggestSaveReturnAddress = true;
    saveReturnAddressNote =
      `Tip: You don't have a saved return address. Would you like to save "${sender.name}, ${sender.addressLine1}, ${sender.city}, ${sender.state}" ` +
      'as your default return address? Use set_return_address to save it for future letters.';
  }

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: 'send.letter.committed',
      submissionCompleted: submission.completed,
      retryScheduled: submission.retryScheduled,
      claimed: submission.claimed,
    },
    'Letter transaction committed and provider submission attempted'
  );

  return {
    orderId: created.letter.letter_id,
    currentStatus,
    statusTimeline: [
      { timestampISO: now, statusText: 'Order placed' },
      {
        timestampISO: now,
        // A gift letter is free and prints a card (docs/gift-letters.md).
        statusText:
          created.fundingType === 'gift_letter'
            ? (created.giftCard?.state === 'funded'
                ? 'Gift letter used; a card with a gift code for the recipient is included'
                : 'Gift letter used; a Letter IRL card is included')
            : 'Letter deducted from balance'
      },
      { timestampISO: now, statusText: submissionText },
    ],
    recipientSummary: orderRecord.recipientSummary,
    lettersRemaining: Math.floor(created.creditsRemaining / 2),
    isRetry: false,
    suggestSaveReturnAddress,
    saveReturnAddressNote,
    trackingSupport: 'estimated_only',
    ...(held ?? {}),
  };
}

export const sendLetterTool: McpToolDefinition<SendLetterInput, SendLetterOutput> = {
  name: 'send_letter',
  title: 'Send a letter',
  description: (client) =>
    sendToolDescription(
      'Send a physical letter using a draft from a preview tool. Requires a draftId and confirm: true. Safe retries return the existing order instead of charging twice, and the response may suggest saving the sender as your return address. If the same mail was sent or paid for from this account in the last 24 hours, the call is refused and says so; repeat it with sendAnotherCopy: true only after the user asks for another copy.',
      'letter',
      client
    ),
  readOnly: false,
  inputSchema: sendLetterInputSchema,
  outputSchema: sendLetterOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Sending letter...',
    'openai/toolInvocation/invoked': 'Letter sent',
    'openai/widgetAccessible': true,
    destructiveHint: true, // Mail cannot be recalled once printed
    openWorldHint: true,
    idempotentHint: true,
  },
  handler,
};
