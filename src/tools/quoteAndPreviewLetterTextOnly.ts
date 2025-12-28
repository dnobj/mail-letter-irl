/**
 * Quote and Preview Letter (Text-Only)
 *
 * Creates a preview of a text-only physical letter without images.
 * For letters WITH images, use:
 * - quoteAndPreviewLetterWithHeaderImage (logo/letterhead at top)
 * - quoteAndPreviewLetterWithPhoto (photo after signature)
 */

import { Address, McpToolDefinition, ToolContext } from "../contracts/types.js";
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

const OUTPUT_TEMPLATE = "ui://widgets/LetterPreviewCard.html";

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
    "WHEN TO USE: Create a preview of a TEXT-ONLY physical letter (no images).\n\n" +
    "Use cases: Thank you notes, formal correspondence, condolence letters, " +
    "letters to officials, pen pal letters, personal messages.\n\n" +
    "FOR LETTERS WITH IMAGES, use these tools instead:\n" +
    "- quote_and_preview_letter_with_header_image: Logo or letterhead at TOP\n" +
    "- quote_and_preview_letter_with_photo: Photo enclosed AFTER signature\n\n" +
    "PREVIEW IS FREE: Generating a preview costs nothing.\n\n" +
    "Sender Address: If not provided, your saved return address is used automatically.\n\n" +
    "Restrictions: US addresses only, max ~1800 characters.",
  readOnly: true,
  inputSchema: quoteAndPreviewLetterTextOnlyInputSchema,
  outputSchema: quoteAndPreviewOutputSchema,
  meta: {
    "openai/outputTemplate": OUTPUT_TEMPLATE,
    "openai/widgetAccessible": true,
    // NO fileParams - text-only tool does not accept images
    "openai/toolInvocation/invoking": "Generating preview...",
    "openai/toolInvocation/invoked": "Preview ready",
    readOnlyHint: true
  },
  handler
};
