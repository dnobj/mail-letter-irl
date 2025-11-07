import { Address, McpToolDefinition, ToolContext } from "../contracts/types.js";
import {
  quoteAndPreviewInputSchema,
  quoteAndPreviewOutputSchema
} from "../schemas.js";
import {
  estimateRequiredCredits,
  renderPreviewHtml
} from "../services/previewService.js";

interface QuoteAndPreviewInput {
  sender: Address;
  recipient: Address;
  bodyText: string;
  signOff: string;
}

interface QuoteAndPreviewOutput {
  previewHtml: string;
  requiredCredits: number;
  canSendNow: boolean;
  reasonCannotSend?: string;
  deliveryClass?: string;
  estimatedDeliveryDays?: number;
}

const OUTPUT_TEMPLATE = "LetterPreviewCard";

async function handler(
  input: QuoteAndPreviewInput,
  context: ToolContext
): Promise<QuoteAndPreviewOutput> {
  const missingFields = collectMissingAddressFields(input);
  if (missingFields.length > 0) {
    const message = `Missing required address fields: ${missingFields.join(", ")}`;
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.preview.missing_fields",
        missingFields
      },
      message
    );
    throw new Error(
      `${message}. Please provide full sender and recipient addresses (name, street, city, state, postal code, country).`
    );
  }

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.preview.start"
    },
    "Processing quote_and_preview_letter"
  );
  const requiredCredits = estimateRequiredCredits(input.bodyText, input.signOff);
  const available = context.user.creditsRemaining;
  const canSendNow = available >= requiredCredits;

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.preview.computed",
      availableCredits: available,
      requiredCredits,
      canSendNow
    },
    "Computed preview requirements"
  );

  return {
    previewHtml: renderPreviewHtml(input),
    requiredCredits,
    canSendNow,
    reasonCannotSend: canSendNow ? undefined : "Insufficient Letter IRL credits.",
    deliveryClass: "First Class Letter",
    estimatedDeliveryDays: 5
  };
}

export const quoteAndPreviewLetterTool: McpToolDefinition<
  QuoteAndPreviewInput,
  QuoteAndPreviewOutput
> = {
  name: "quote_and_preview_letter",
  description:
    "Generate a printable preview and required Letter IRL credits (requires full sender & recipient addresses).",
  readOnly: true,
  inputSchema: quoteAndPreviewInputSchema,
  outputSchema: quoteAndPreviewOutputSchema,
  meta: {
    "openai/outputTemplate": OUTPUT_TEMPLATE,
    "openai/toolInvocation/invoking": "Generating preview…",
    "openai/toolInvocation/invoked": "Preview ready",
    readOnlyHint: true
  },
  handler
};

const REQUIRED_ADDRESS_PROPS = [
  "name",
  "addressLine1",
  "city",
  "state",
  "postalCode",
  "country"
];

function collectMissingAddressFields(input: QuoteAndPreviewInput): string[] {
  const missing: string[] = [];
  for (const [label, block] of [
    ["sender", input.sender],
    ["recipient", input.recipient]
  ] as const) {
    if (!block) {
      missing.push(`${label}`);
      continue;
    }
    for (const prop of REQUIRED_ADDRESS_PROPS) {
      if (!block[prop as keyof Address]) {
        missing.push(`${label}.${prop}`);
      }
    }
  }
  return missing;
}
