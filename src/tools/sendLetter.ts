import { randomUUID } from "node:crypto";
import {
  McpToolDefinition,
  ToolContext,
  LetterSnapshot,
  OrderRecord
} from "../contracts/types.js";
import { sendLetterInputSchema, sendLetterOutputSchema } from "../schemas.js";
import {
  ensureSufficientCredits,
  deductCredits
} from "../services/creditService.js";
import { createOrderRecord } from "../services/orderService.js";

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

  try {
    ensureSufficientCredits(context.user, input.requiredCredits);
  } catch (error) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "send.letter.insufficient_credits",
        availableCredits: context.user.creditsRemaining,
        requiredCredits: input.requiredCredits
      },
      "Insufficient credits for send_letter"
    );
    throw error;
  }

  const now = context.now().toISOString();
  const orderId = randomUUID();
  const snapshot: LetterSnapshot = {
    sender: input.sender,
    recipient: input.recipient,
    bodyText: input.bodyText,
    signOff: input.signOff,
    requiredCredits: input.requiredCredits
  };

  const orderRecord: OrderRecord = createOrderRecord({
    orderId,
    snapshot,
    timestampISO: now
  });

  deductCredits(context.user, input.requiredCredits);

  context.user.orders.push(orderRecord);
  await context.persist(context.user);

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "send.letter.success",
      orderId,
      creditsRemaining: context.user.creditsRemaining
    },
    "Letter queued for print"
  );

  return {
    orderId,
    currentStatus: orderRecord.currentStatus,
    statusTimeline: orderRecord.statusTimeline,
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
