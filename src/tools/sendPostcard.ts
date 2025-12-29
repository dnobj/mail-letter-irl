/**
 * Send Postcard Tool
 *
 * Sends a postcard using a draft from quote_and_preview_postcard.
 * Handles idempotency, credit deduction, and job queueing.
 *
 * User Stories:
 * - US-POSTCARD-02: Send a Postcard
 */

import { randomUUID } from "node:crypto";
import {
  McpToolDefinition,
  ToolContext,
  Address
} from "../contracts/types.js";
import { sendPostcardInputSchema, sendPostcardOutputSchema } from "../schemas.js";
import { deductCredits as deductCreditsFromDatabase } from "../services/creditService.js";
import { createLetterJob } from "../services/letterJobService.js";
import { query } from "../db/index.js";
import { consumeDraft, getPostcardDraft, linkDraftToLetter } from "../services/draftService.js";
import type { Letter, PostcardDraft } from "../services/types.js";
import { hasReturnAddress } from "../services/returnAddressService.js";

// ============================================================================
// Types
// ============================================================================

interface SendPostcardInput {
  draftId: string;
  confirm: boolean;
}

interface SendPostcardOutput {
  orderId: string;
  currentStatus: "queued_for_print" | "printing" | "mailed";
  statusTimeline: { timestampISO: string; statusText: string }[];
  recipientSummary: { name: string; city: string; state: string };
  lettersRemaining: number;  // User-facing: number of letters remaining
  previewFrontHtml?: string;
  previewBackHtml?: string;
  isRetry?: boolean;  // true if this was an idempotent retry
  // Suggestion to save return address
  suggestSaveReturnAddress?: boolean;
  saveReturnAddressNote?: string;
}

// ============================================================================
// Handler
// ============================================================================

async function handler(
  input: SendPostcardInput,
  context: ToolContext
): Promise<SendPostcardOutput> {
  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "send.postcard.start",
      draftId: input.draftId
    },
    "Processing send_postcard"
  );

  // Validate confirm flag
  if (!input.confirm) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "send.postcard.confirmation_missing"
      },
      "send_postcard called without confirm flag"
    );
    throw new Error("send_postcard requires confirm: true");
  }

  // Validate draftId is provided
  if (!input.draftId) {
    throw new Error(
      "send_postcard requires a draftId from quote_and_preview_postcard. " +
      "Please call quote_and_preview_postcard first to get a draftId."
    );
  }

  const userId = context.user.userId;
  const now = context.now().toISOString();
  const orderId = randomUUID();

  // Verify this is a postcard draft before consuming
  const postcardDraft = await getPostcardDraft(input.draftId);
  if (!postcardDraft) {
    // Check if it's a letter draft instead
    const letterDraft = await query(
      `SELECT mail_type FROM letter_drafts WHERE draft_id = $1`,
      [input.draftId]
    );

    if (letterDraft.rows.length > 0 && letterDraft.rows[0].mail_type === 'letter') {
      throw new Error(
        `This is a letter draft, not a postcard draft. ` +
        "Please use send_letter instead, or call quote_and_preview_postcard to create a postcard draft."
      );
    }

    throw new Error(
      `Postcard draft not found: ${input.draftId}. ` +
      "Please call quote_and_preview_postcard to create a new draft."
    );
  }

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
        "Please call quote_and_preview_postcard to create a new draft."
      );
    }
    if (error.code === 'DRAFT_NOT_OWNED') {
      throw new Error(
        `This draft does not belong to your account. ` +
        "Please call quote_and_preview_postcard to create a new draft."
      );
    }
    if (error.code === 'DRAFT_EXPIRED') {
      throw new Error(
        `Draft has expired (drafts are valid for 24 hours). ` +
        "Please call quote_and_preview_postcard to create a new draft."
      );
    }
    if (error.code === 'DRAFT_CANCELLED') {
      throw new Error(
        `This draft was cancelled. ` +
        "Please call quote_and_preview_postcard to create a new draft."
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
        event: "send.postcard.idempotent_retry",
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
          { timestampISO: now, statusText: "Postcard already sent (duplicate request)" }
        ],
        recipientSummary: {
          name: recipient.name,
          city: recipient.city,
          state: recipient.state
        },
        lettersRemaining: Math.floor(context.user.creditsRemaining / 2),
        isRetry: true
      };
    }
  }

  // Cast draft to PostcardDraft type
  const postcardData = draft as unknown as PostcardDraft;

  // Extract postcard content from the draft
  const sender = postcardData.sender as unknown as Address;
  const recipient = postcardData.recipient as unknown as Address;
  const message = postcardData.body_text;  // Message is stored in body_text
  const frontImageData = postcardData.front_image_data;
  const postcardSize = postcardData.postcard_size;
  const requiredCredits = postcardData.required_credits;

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "send.postcard.draft_consumed",
      draftId: input.draftId,
      requiredCredits,
      postcardSize
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
      description: `Postcard to ${recipient.name} in ${recipient.city}, ${recipient.state}`
    });

    creditsRemaining = result.user.credits;

    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "send.postcard.credits_deducted",
        creditsDeducted: requiredCredits,
        creditsRemaining
      },
      "Credits deducted from database"
    );
  } catch (error: any) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "send.postcard.insufficient_credits",
        requiredCredits,
        error: error.message
      },
      "Insufficient credits for send_postcard"
    );
    throw error;
  }

  // Create letter in database with mail_type='postcard'
  const letterId = orderId;
  const letterResult = await query<Letter>(
    `INSERT INTO letters (
      letter_id, user_id, content, recipient, credits_cost, status, preview_html, mail_type
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'postcard')
    RETURNING *`,
    [
      letterId,
      userId,
      JSON.stringify({
        message,
        sender,
        frontImageData,
        postcardSize
      }),
      JSON.stringify(recipient),
      requiredCredits,
      'draft',
      postcardData.preview_html
    ]
  );

  const letter = letterResult.rows[0];

  // Link the draft to the letter now that the letter exists (satisfies FK constraint)
  await linkDraftToLetter(input.draftId, letterId);

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "send.postcard.created",
      letterId,
      status: letter.status,
      mailType: 'postcard'
    },
    "Postcard created in database"
  );

  // Queue the postcard for background processing
  const letterJob = await createLetterJob(letter);

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "send.postcard.queued",
      letterId,
      jobId: letterJob.job_id,
      status: letterJob.status
    },
    "Postcard queued for processing"
  );

  // Update context.user credits
  context.user.creditsRemaining = creditsRemaining;
  await context.persist(context.user);

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "send.postcard.success",
      orderId,
      letterId,
      jobId: letterJob.job_id,
      draftId: input.draftId,
      creditsRemaining: context.user.creditsRemaining
    },
    "Postcard queued for print and mail"
  );

  // Check if user has a saved return address - if not, suggest saving it
  let suggestSaveReturnAddress: boolean | undefined;
  let saveReturnAddressNote: string | undefined;

  const userHasReturnAddress = await hasReturnAddress(userId);
  if (!userHasReturnAddress) {
    suggestSaveReturnAddress = true;
    saveReturnAddressNote =
      `Tip: You don't have a saved return address. Would you like to save "${sender.name}, ${sender.addressLine1}, ${sender.city}, ${sender.state}" ` +
      `as your default return address? Use the set_return_address tool to save it for future mail.`;

    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "send.postcard.suggest_save_return_address",
        senderCity: sender.city,
        senderState: sender.state
      },
      "Suggesting user save return address"
    );
  }

  return {
    orderId,
    currentStatus: "queued_for_print" as const,
    statusTimeline: [
      { timestampISO: now, statusText: "Postcard received" },
      { timestampISO: now, statusText: "Letter deducted from balance" },
      { timestampISO: now, statusText: "Queued for printing" }
    ],
    recipientSummary: {
      name: recipient.name,
      city: recipient.city,
      state: recipient.state
    },
    lettersRemaining: Math.floor(context.user.creditsRemaining / 2),
    previewFrontHtml: postcardData.preview_html,
    isRetry: false,
    suggestSaveReturnAddress,
    saveReturnAddressNote
  };
}

// ============================================================================
// Tool Definition
// ============================================================================

export const sendPostcardTool: McpToolDefinition<SendPostcardInput, SendPostcardOutput> = {
  name: "send_postcard",
  description:
    "Send a postcard using a draft from quote_and_preview_postcard.\n\n" +
    "IMPORTANT - Draft Requirement:\n" +
    "1. You MUST call quote_and_preview_postcard first to get a draftId.\n" +
    "2. Pass the draftId to this tool along with confirm: true.\n" +
    "3. The draft contains all postcard details (image, message, addresses) - you don't need to pass them again.\n\n" +
    "Return Address Suggestion:\n" +
    "- If the user doesn't have a saved return address, the response will suggest saving the sender address.\n" +
    "- Check suggestSaveReturnAddress in the response to see if you should prompt the user.\n\n" +
    "Idempotency:\n" +
    "- If you call this tool twice with the same draftId, the second call will return the existing order without charging again.\n" +
    "- This protects against duplicate charges if the network request is retried.\n" +
    "- If isRetry: true in the response, it means the postcard was already sent previously.",
  readOnly: false,
  inputSchema: sendPostcardInputSchema,
  outputSchema: sendPostcardOutputSchema,
  meta: {
    "openai/toolInvocation/invoking": "Sending postcard...",
    "openai/toolInvocation/invoked": "Postcard sent",
    "openai/widgetAccessible": true,
    // OpenAI Apps SDK annotations
    openWorldHint: true,    // Sends physical mail via PostGrid/USPS
    idempotentHint: true    // Draft consumption makes retries safe
  },
  handler
};
