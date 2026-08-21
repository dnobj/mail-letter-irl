/**
 * Quote and Preview Letter (Text-Only)
 *
 * Creates a preview of a text-only physical letter without images.
 * For letters WITH images, use:
 * - quoteAndPreviewLetterWithHeaderImage (logo/letterhead at top)
 * - quoteAndPreviewLetterWithImage (image after signature)
 */

import { Address, McpToolDefinition, ToolContext } from "../contracts/types.js";
import { widgetTemplateUri } from "../mcp/widgetUris.js";
import {
  quoteAndPreviewLetterTextOnlyInputSchema,
  quoteAndPreviewOutputSchema
} from "../schemas.js";
import {
  prepareSender,
  validateAddresses,
  validateAddressesWithProvider,
  validateCharacterLimitForLayout,
  createLetterDraftAndBuildOutput,
  type LetterQuoteOutput
} from "./letterHelpers.js";

// ============================================================================
// Types
// ============================================================================

interface QuoteAndPreviewLetterTextOnlyInput {
  sender?: Address;
  recipient: Address;
  bodyText: string;
  signOff: string;
}

// ============================================================================
// Constants
// ============================================================================

const OUTPUT_TEMPLATE = widgetTemplateUri("LetterPreviewCard");

// ============================================================================
// Handler
// ============================================================================

async function handler(
  input: QuoteAndPreviewLetterTextOnlyInput,
  context: ToolContext
): Promise<LetterQuoteOutput> {
  const layoutType = 'text_only';

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.letter.text_only.start"
    },
    "Processing quote_and_preview_letter (text-only)"
  );

  // Prepare sender (use saved return address if not provided)
  const { sender, usedSavedReturnAddress, savedReturnAddressNote } = await prepareSender(input, context);

  // Validate addresses
  validateAddresses(sender, input.recipient, context);

  // Validate character limit
  validateCharacterLimitForLayout(input.bodyText, input.signOff, layoutType, context);

  // Validate with PostGrid provider
  const { senderValidation, recipientValidation } = await validateAddressesWithProvider(
    sender,
    input.recipient,
    context
  );

  // Create draft and build output
  return createLetterDraftAndBuildOutput({
    sender,
    recipient: input.recipient,
    bodyText: input.bodyText,
    signOff: input.signOff,
    layoutType,
    usedSavedReturnAddress,
    savedReturnAddressNote,
    senderValidation,
    recipientValidation,
    context
  });
}

// ============================================================================
// Tool Definition
// ============================================================================

export const quoteAndPreviewLetterTextOnlyTool: McpToolDefinition<
  QuoteAndPreviewLetterTextOnlyInput,
  LetterQuoteOutput
> = {
  name: "quote_and_preview_letter",
  description:
    "Preview a text-only physical letter draft. This does not send mail. Requires a real U.S. recipient mailing address and text that fits the text-only letter limit. Send later with send_letter.",
  // readOnly: false because this tool creates draft records in the database
  // See docs/learnings/tool-annotation-decision.md for rationale
  readOnly: false,
  inputSchema: quoteAndPreviewLetterTextOnlyInputSchema,
  outputSchema: quoteAndPreviewOutputSchema,
  meta: {
    "openai/outputTemplate": OUTPUT_TEMPLATE,
    "openai/widgetAccessible": true,
    // NO fileParams - text-only tool does not accept images
    "openai/toolInvocation/invoking": "Generating preview...",
    "openai/toolInvocation/invoked": "Preview ready"
    // Note: readOnlyHint is set by buildAnnotations() in registerTools.ts
  },
  handler
};
