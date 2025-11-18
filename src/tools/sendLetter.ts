import { randomUUID } from "node:crypto";
import {
  McpToolDefinition,
  ToolContext,
  LetterSnapshot,
  OrderRecord
} from "../contracts/types.js";
import { sendLetterInputSchema, sendLetterOutputSchema } from "../schemas.js";
import { deductCredits as deductCreditsFromDatabase } from "../services/creditService.js";
import { createOrderRecord } from "../services/orderService.js";
import { createLetterJob } from "../services/letterJobService.js";
import { query } from "../db/index.js";
import type { Letter } from "../services/types.js";

interface SendLetterInput extends LetterSnapshot {
  confirm: boolean;
}

interface SendLetterOutput {
  orderId: string;
  currentStatus: "queued_for_print" | "printing" | "mailed";
  statusTimeline: { timestampISO: string; statusText: string }[];
  recipientSummary: { name: string; city: string; state: string };
  creditsRemaining: number;
  previewFirstPageHtml?: string;
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
      requiredCredits: input.requiredCredits
    },
    "Processing send_letter"
  );
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

  // Use database-backed credit deduction (handles balance check atomically)
  const userId = context.user.userId;
  const now = context.now().toISOString();
  const orderId = randomUUID();
  const snapshot: LetterSnapshot = {
    sender: input.sender,
    recipient: input.recipient,
    bodyText: input.bodyText,
    signOff: input.signOff,
    requiredCredits: input.requiredCredits
  };

  let creditsRemaining: number;
  try {
    // Deduct credits from database (throws if insufficient)
    const result = await deductCreditsFromDatabase({
      userId,
      credits: input.requiredCredits,
      letterId: orderId,
      description: `Letter to ${input.recipient.name} in ${input.recipient.city}, ${input.recipient.state}`
    });

    creditsRemaining = result.user.credits;

    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "send.letter.credits_deducted",
        creditsDeducted: input.requiredCredits,
        creditsRemaining
      },
      "Credits deducted from database"
    );
  } catch (error) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "send.letter.insufficient_credits",
        requiredCredits: input.requiredCredits,
        error: error.message
      },
      "Insufficient credits for send_letter"
    );
    throw error;
  }

  // Create letter in database
  const letterId = orderId; // Use same ID for letter and order
  const letterResult = await query<Letter>(
    `INSERT INTO letters (
      letter_id, user_id, content, recipient, credits_cost, status
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *`,
    [
      letterId,
      userId,
      JSON.stringify({ bodyText: input.bodyText, signOff: input.signOff, sender: input.sender }),
      JSON.stringify(input.recipient),
      input.requiredCredits,
      'draft'
    ]
  );

  const letter = letterResult.rows[0];

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
    previewFirstPageHtml: orderRecord.previewFirstPageHtml
  };
}

export const sendLetterTool: McpToolDefinition<SendLetterInput, SendLetterOutput> = {
  name: "send_letter",
  description: "Deduct credits and queue a letter for printing/mailing.",
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
