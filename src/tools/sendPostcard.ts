import {
  type Address,
  type McpToolDefinition,
  type ToolContext,
} from '../contracts/types.js';
import { sendPostcardInputSchema, sendPostcardOutputSchema } from '../schemas.js';
import { processLetterJob } from '../services/letterJobService.js';
import { asPostcardDraft, createMailOrderFromDraft } from '../services/mailSendService.js';
import { hasReturnAddress } from '../services/returnAddressService.js';
import type { LetterStatus } from '../services/types.js';

interface SendPostcardInput {
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

interface SendPostcardOutput {
  orderId: string;
  currentStatus: PublicStatus;
  statusTimeline: { timestampISO: string; statusText: string }[];
  recipientSummary: { name: string; city: string; state: string };
  lettersRemaining: number;
  previewFrontHtml?: string;
  previewBackHtml?: string;
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
  if (code === 'ACCOUNT_SENDS_BLOCKED') {
    // A SERVER-AUTHORED string. The upstream message interpolates
    // users.sends_blocked_reason (an internal moderation label such as
    // "payment_disputed"), and this formatter's default forwards whatever it
    // is handed - so the label reached the customer here even after round 12
    // fixed the checkout surface (#278 round 13).
    return new Error('Sending is disabled on this account. Please contact support.');
  }
  if (code === 'DRAFT_NOT_FOUND') {
    return new Error(`Postcard draft not found: ${draftId}. Please create a new postcard preview.`);
  }
  if (code === 'DRAFT_NOT_OWNED') {
    return new Error('This draft does not belong to your account. Please create a new postcard draft.');
  }
  if (code === 'DRAFT_EXPIRED') {
    return new Error('Draft has expired (drafts are valid for 24 hours). Please create a new postcard draft.');
  }
  if (code === 'DRAFT_CANCELLED') {
    return new Error('This draft was cancelled. Please create a new postcard draft.');
  }
  if (code === 'DRAFT_CHECKOUT_PENDING') {
    return new Error(
      'This draft has an active Pay & Send checkout. Complete or wait for that checkout to expire before using prepaid balance.'
    );
  }
  if (code === 'DRAFT_WRONG_MAIL_TYPE') {
    return new Error('This is a letter draft. Please use send_letter instead.');
  }
  if (code === 'DRAFT_INCOMPLETE') {
    return new Error('This draft is in an incomplete state. Please contact Letter IRL support before retrying.');
  }
  return error instanceof Error ? error : new Error('Unable to send postcard');
}

async function handler(
  input: SendPostcardInput,
  context: ToolContext
): Promise<SendPostcardOutput> {
  context.logger.info(
    { correlationId: context.correlationId, event: 'send.postcard.start' },
    'Processing send_postcard'
  );

  if (!input.confirm) throw new Error('send_postcard requires confirm: true');
  if (!input.draftId) {
    throw new Error('send_postcard requires a draftId from quote_and_preview_postcard.');
  }

  const now = context.now().toISOString();
  let created;
  try {
    created = await createMailOrderFromDraft({
      draftId: input.draftId,
      userId: context.user.userId,
      mailType: 'postcard',
    });
  } catch (error) {
    throw friendlyDraftError(error, input.draftId);
  }

  const postcard = asPostcardDraft(created.draft);
  const sender = postcard.sender as unknown as Address;
  const recipient = postcard.recipient as unknown as Address;
  context.user.creditsRemaining = created.creditsRemaining;

  if (created.alreadyConsumed) {
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
    throw new Error('Postcard was created without an outbox record');
  }

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
      'as your default return address? Use set_return_address to save it for future mail.';
  }

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: 'send.postcard.committed',
      submissionCompleted: submission.completed,
      retryScheduled: submission.retryScheduled,
    },
    'Postcard transaction committed and provider submission attempted'
  );

  return {
    orderId: created.letter.letter_id,
    currentStatus,
    statusTimeline: [
      { timestampISO: now, statusText: 'Order placed' },
      { timestampISO: now, statusText: 'Letter deducted from balance' },
      { timestampISO: now, statusText: submissionText },
    ],
    recipientSummary: { name: recipient.name, city: recipient.city, state: recipient.state },
    lettersRemaining: Math.floor(created.creditsRemaining / 2),
    previewFrontHtml: postcard.preview_html,
    isRetry: false,
    suggestSaveReturnAddress,
    saveReturnAddressNote,
    trackingSupport: 'estimated_only',
  };
}

export const sendPostcardTool: McpToolDefinition<SendPostcardInput, SendPostcardOutput> = {
  name: 'send_postcard',
  description:
    'Send a physical postcard using a draft from quote_and_preview_postcard. Requires a draftId and confirm: true. Safe retries return the existing order instead of charging twice, and the response may suggest saving the sender as your return address.',
  readOnly: false,
  inputSchema: sendPostcardInputSchema,
  outputSchema: sendPostcardOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Sending postcard...',
    'openai/toolInvocation/invoked': 'Postcard sent',
    'openai/widgetAccessible': true,
    openWorldHint: true,
    idempotentHint: true,
  },
  handler,
};
