import { randomUUID } from "node:crypto";
import {
  McpToolDefinition,
  ToolContext,
  LetterSnapshot,
  OrderRecord,
  Address
} from "../contracts/types.js";
import { sendLetterInputSchema, sendLetterOutputSchema } from "../schemas.js";
import { deductCredits as deductCreditsFromDatabase } from "../services/creditService.js";
import { createOrderRecord } from "../services/orderService.js";
import { createLetterJob } from "../services/letterJobService.js";
import { query } from "../db/index.js";
import { consumeDraft, getDraft, linkDraftToLetter } from "../services/draftService.js";
import type { Letter, LetterDraft } from "../services/types.js";

// New simplified input: just draftId and confirm
interface SendLetterInput {
  draftId: string;
  confirm: boolean;
}

interface SendLetterOutput {
  orderId: string;
  currentStatus: "queued_for_print" | "printing" | "mailed";
  statusTimeline: { timestampISO: string; statusText: string }[];
  recipientSummary: { name: string; city: string; state: string };
  creditsRemaining: number;
  previewFirstPageHtml?: string;
  isRetry?: boolean;  // true if this was an idempotent retry (draft already consumed)
}

const OUTPUT_TEMPLATE = "LetterConfirmationCard";

async function handler(
  input: SendLetterInput,
  context: ToolContext
): Promise<SendLetterOutput> {
  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "send.letter.start",
      draftId: input.draftId
    },
    "Processing send_letter"
  );

  // Validate confirm flag
  if (!input.confirm) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "send.letter.confirmation_missing"
      },
      "send_letter called without confirm flag"
    );
    throw new Error("send_letter requires confirm: true");
  }

  // Validate draftId is provided
  if (!input.draftId) {
    throw new Error(
      "send_letter requires a draftId from quote_and_preview_letter. " +
      "Please call quote_and_preview_letter first to get a draftId."
    );
  }

  const userId = context.user.userId;
  const now = context.now().toISOString();
  const orderId = randomUUID();

  // Try to consume the draft (idempotent operation)
  let consumeResult;
  try {
    consumeResult = await consumeDraft({
      draftId: input.draftId,
      userId
    });
  } catch (error: any) {
    // Handle specific draft errors with user-friendly messages
    if (error.code === 'DRAFT_NOT_FOUND') {
      throw new Error(
        `Draft not found: ${input.draftId}. ` +
        "Please call quote_and_preview_letter to create a new draft."
      );
    }
    if (error.code === 'DRAFT_NOT_OWNED') {
      throw new Error(
        `This draft does not belong to your account. ` +
        "Please call quote_and_preview_letter to create a new draft."
      );
    }
    if (error.code === 'DRAFT_EXPIRED') {
      throw new Error(
        `Draft has expired (drafts are valid for 24 hours). ` +
        "Please call quote_and_preview_letter to create a new draft."
      );
    }
    if (error.code === 'DRAFT_CANCELLED') {
      throw new Error(
        `This draft was cancelled. ` +
        "Please call quote_and_preview_letter to create a new draft."
      );
    }
    throw error;
  }

  const { draft, alreadyConsumed, existingLetterId } = consumeResult;

  // If draft was already consumed, return the existing order (idempotent retry)
  if (alreadyConsumed && existingLetterId) {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "send.letter.idempotent_retry",
        draftId: input.draftId,
        existingLetterId
      },
      "Idempotent retry - draft already consumed, returning existing order"
    );

    // Fetch the existing letter to return its details
    const existingLetterResult = await query<Letter>(
      `SELECT * FROM letters WHERE letter_id = $1`,
      [existingLetterId]
    );

    if (existingLetterResult.rows.length > 0) {
      const existingLetter = existingLetterResult.rows[0];
      const recipient = existingLetter.recipient as Address;

      return {
        orderId: existingLetterId,
        currentStatus: "queued_for_print" as const,
        statusTimeline: [
          { timestampISO: now, statusText: "Letter already sent (duplicate request)" }
        ],
        recipientSummary: {
          name: recipient.name,
          city: recipient.city,
          state: recipient.state
        },
        creditsRemaining: context.user.creditsRemaining,
        isRetry: true
      };
    }
  }

  // Extract letter content from the draft
  const sender = draft.sender as unknown as Address;
  const recipient = draft.recipient as unknown as Address;
  const bodyText = draft.body_text;
  const signOff = draft.sign_off;
  const requiredCredits = draft.required_credits;

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "send.letter.draft_consumed",
      draftId: input.draftId,
      requiredCredits
    },
    "Draft consumed, proceeding with send"
  );

  // Deduct credits from database
  let creditsRemaining: number;
  try {
    const result = await deductCreditsFromDatabase({
      userId,
      credits: requiredCredits,
      letterId: orderId,
      description: `Letter to ${recipient.name} in ${recipient.city}, ${recipient.state}`
    });

    creditsRemaining = result.user.credits;

    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "send.letter.credits_deducted",
        creditsDeducted: requiredCredits,
        creditsRemaining
      },
      "Credits deducted from database"
    );
  } catch (error: any) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "send.letter.insufficient_credits",
        requiredCredits,
        error: error.message
      },
      "Insufficient credits for send_letter"
    );
    throw error;
  }

  // Create letter in database
  const letterId = orderId;
  const letterResult = await query<Letter>(
    `INSERT INTO letters (
      letter_id, user_id, content, recipient, credits_cost, status, preview_html
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`,
    [
      letterId,
      userId,
      JSON.stringify({ bodyText, signOff, sender }),
      JSON.stringify(recipient),
      requiredCredits,
      'draft',
      draft.preview_html
    ]
  );

  const letter = letterResult.rows[0];

  // Link the draft to the letter now that the letter exists (satisfies FK constraint)
  await linkDraftToLetter(input.draftId, letterId);

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "send.letter.created",
      letterId,
      status: letter.status
    },
    "Letter created in database"
  );

  // Queue the letter for background processing
  const letterJob = await createLetterJob(letter);

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "send.letter.queued",
      letterId,
      jobId: letterJob.job_id,
      status: letterJob.status
    },
    "Letter queued for processing"
  );

  // Create snapshot for order record (backward compatibility)
  const snapshot: LetterSnapshot = {
    sender,
    recipient,
    bodyText,
    signOff,
    requiredCredits
  };

  // Create order record for tracking (still using old system for backward compatibility)
  const orderRecord: OrderRecord = createOrderRecord({
    orderId,
    snapshot,
    timestampISO: now
  });

  // Update context.user for backward compatibility
  context.user.orders.push(orderRecord);
  context.user.creditsRemaining = creditsRemaining;
  await context.persist(context.user);

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "send.letter.success",
      orderId,
      letterId,
      jobId: letterJob.job_id,
      draftId: input.draftId,
      creditsRemaining: context.user.creditsRemaining
    },
    "Letter queued for print and mail"
  );

  return {
    orderId,
    currentStatus: "queued_for_print" as const,
    statusTimeline: [
      { timestampISO: now, statusText: "Letter received" },
      { timestampISO: now, statusText: "Credits deducted" },
      { timestampISO: now, statusText: "Queued for printing" }
    ],
    recipientSummary: orderRecord.recipientSummary,
    creditsRemaining: context.user.creditsRemaining,
    previewFirstPageHtml: orderRecord.previewFirstPageHtml,
    isRetry: false
  };
}

export const sendLetterTool: McpToolDefinition<SendLetterInput, SendLetterOutput> = {
  name: "send_letter",
  description:
    "Send a letter using a draft from quote_and_preview_letter.\n\n" +
    "IMPORTANT - Draft Requirement:\n" +
    "1. You MUST call quote_and_preview_letter first to get a draftId.\n" +
    "2. Pass the draftId to this tool along with confirm: true.\n" +
    "3. The draft contains all letter details (sender, recipient, content) - you don't need to pass them again.\n\n" +
    "Idempotency:\n" +
    "- If you call this tool twice with the same draftId, the second call will return the existing order without charging again.\n" +
    "- This protects against duplicate charges if the network request is retried.\n" +
    "- If isRetry: true in the response, it means the letter was already sent previously.",
  readOnly: false,
  inputSchema: sendLetterInputSchema,
  outputSchema: sendLetterOutputSchema,
  meta: {
    "openai/outputTemplate": OUTPUT_TEMPLATE,
    "openai/toolInvocation/invoking": "Sending letter…",
    "openai/toolInvocation/invoked": "Letter sent"
  },
  handler
};
