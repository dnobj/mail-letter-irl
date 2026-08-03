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

interface SendLetterInput {
  draftId: string;
  confirm: boolean;
}

type PublicStatus =
  | 'pending'
  | 'accepted'
  | 'printing'
  | 'in_transit'
  | 'delivered'
  | 'returned'
  | 'failed'
  | 'cancelled';

interface SendLetterOutput {
  orderId: string;
  currentStatus: PublicStatus;
  statusTimeline: { timestampISO: string; statusText: string }[];
  recipientSummary: { name: string; city: string; state: string };
  lettersRemaining: number;
  previewFirstPageHtml?: string;
  isRetry?: boolean;
  suggestSaveReturnAddress?: boolean;
  saveReturnAddressNote?: string;
  trackingSupport: 'none' | 'estimated_only' | 'carrier_tracking';
}

function publicStatus(status: LetterStatus): PublicStatus {
  if (status === 'queued' || status === 'processing' || status === 'held' || status === 'draft') return 'pending';
  if (status === 'sent') return 'accepted';
  return status;
}

function friendlyDraftError(error: unknown, draftId: string): Error {
  const code = (error as { code?: string })?.code;
  if (code === 'DRAFT_NOT_FOUND') {
    return new Error(`Draft not found: ${draftId}. Please call quote_and_preview_letter to create a new draft.`);
  }
  if (code === 'DRAFT_NOT_OWNED') {
    return new Error('This draft does not belong to your account. Please create a new letter draft.');
  }
  if (code === 'DRAFT_EXPIRED') {
    return new Error('Draft has expired (drafts are valid for 24 hours). Please create a new letter draft.');
  }
  if (code === 'DRAFT_CANCELLED') {
    return new Error('This draft was cancelled. Please create a new letter draft.');
  }
  if (code === 'DRAFT_CHECKOUT_PENDING') {
    return new Error(
      'This draft has an active Pay & Send checkout. Complete or wait for that checkout to expire before using prepaid balance.'
    );
  }
  if (code === 'DRAFT_WRONG_MAIL_TYPE') {
    return new Error('This is a postcard draft. Please use send_postcard instead.');
  }
  if (code === 'DRAFT_INCOMPLETE') {
    return new Error('This draft is in an incomplete state. Please contact Letter IRL support before retrying.');
  }
  return error instanceof Error ? error : new Error('Unable to send letter');
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
    });
  } catch (error) {
    throw friendlyDraftError(error, input.draftId);
  }

  const sender = created.draft.sender as unknown as Address;
  const recipient = created.draft.recipient as unknown as Address;
  context.user.creditsRemaining = created.creditsRemaining;

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
      currentStatus: publicStatus(created.letter.status),
      statusTimeline: [{ timestampISO: now, statusText: 'Existing order returned (duplicate request)' }],
      recipientSummary: { name: recipient.name, city: recipient.city, state: recipient.state },
      lettersRemaining: Math.floor(created.creditsRemaining / 2),
      isRetry: true,
      trackingSupport: 'estimated_only',
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
  const currentStatus: PublicStatus = submission.completed
    ? 'accepted'
    : submission.retryScheduled
      ? 'pending'
      : 'failed';
  const submissionText = submission.completed
    ? 'Accepted by print provider'
    : submission.retryScheduled
      ? 'Provider temporarily unavailable; retry scheduled'
      : 'Provider submission failed';

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
    },
    'Letter transaction committed and provider submission attempted'
  );

  return {
    orderId: created.letter.letter_id,
    currentStatus,
    statusTimeline: [
      { timestampISO: now, statusText: 'Order placed' },
      { timestampISO: now, statusText: 'Letter deducted from balance' },
      { timestampISO: now, statusText: submissionText },
    ],
    recipientSummary: orderRecord.recipientSummary,
    lettersRemaining: Math.floor(created.creditsRemaining / 2),
    previewFirstPageHtml: orderRecord.previewFirstPageHtml,
    isRetry: false,
    suggestSaveReturnAddress,
    saveReturnAddressNote,
    trackingSupport: 'estimated_only',
  };
}

export const sendLetterTool: McpToolDefinition<SendLetterInput, SendLetterOutput> = {
  name: 'send_letter',
  description:
    'Send a physical letter using a draft from a preview tool. Requires a draftId and confirm: true. Safe retries return the existing order instead of charging twice, and the response may suggest saving the sender as your return address.',
  readOnly: false,
  inputSchema: sendLetterInputSchema,
  outputSchema: sendLetterOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Sending letter...',
    'openai/toolInvocation/invoked': 'Letter sent',
    'openai/widgetAccessible': true,
    openWorldHint: true,
    idempotentHint: true,
  },
  handler,
};
