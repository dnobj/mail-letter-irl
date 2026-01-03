/**
 * Quote and Preview Letter with Header Image
 *
 * Creates a preview of a physical letter WITH a header image at the top.
 * The image appears at the TOP of the letter, like custom letterhead or branding.
 *
 * REQUIRES: An image attachment or imageUrl parameter.
 */

import { Address, McpToolDefinition, ToolContext } from "../contracts/types.js";
import {
  quoteAndPreviewLetterWithHeaderImageInputSchema,
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
import { downloadAndProcessLetterImageWithPreview, ImageProcessingError } from "../services/imageService.js";
import type { ImageFileParam } from "../services/types.js";

// ============================================================================
// Types
// ============================================================================

interface QuoteAndPreviewLetterWithHeaderImageInput {
  sender?: Address;
  recipient: Address;
  bodyText: string;
  signOff: string;
  // Image from OpenAI fileParams - injected by MCP framework
  image?: ImageFileParam;
  // Alternative: direct image URL
  imageUrl?: string;
}

// ============================================================================
// Constants
// ============================================================================

const OUTPUT_TEMPLATE = "ui://widgets/LetterPreviewCard.html";

// ============================================================================
// Handler
// ============================================================================

async function handler(
  input: QuoteAndPreviewLetterWithHeaderImageInput,
  context: ToolContext
): Promise<LetterQuoteOutput> {
  const layoutType = 'header_image';

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.letter.header_image.start"
    },
    "Processing quote_and_preview_letter_with_header_image"
  );

  // Get image source - REQUIRED
  const imageSource = input.image?.download_url || input.imageUrl;

  if (!imageSource) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.letter.header_image.no_image"
      },
      "No header image provided"
    );
    throw new Error(
      "No header image provided. This tool requires an image for the letter header.\n\n" +
      "Please either:\n" +
      "1. Attach an image to your message (recommended)\n" +
      "2. Provide an imageUrl parameter with a publicly accessible URL\n\n" +
      "If you want to send a text-only letter, use quote_and_preview_letter instead."
    );
  }

  // Log image source
  if (input.image?.download_url) {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.letter.header_image.from_fileParams"
      },
      "Using header image from OpenAI fileParams"
    );
  } else {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.letter.header_image.from_url",
        imageUrl: imageSource.substring(0, 100)
      },
      "Using header image from URL"
    );
  }

  // Process the image (generates both full-quality and preview versions)
  let headerImageData: string;
  let headerImagePreview: string;
  try {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.letter.header_image.processing"
      },
      "Processing header image"
    );

    const processed = await downloadAndProcessLetterImageWithPreview(
      { url: imageSource },
      'header'
    );
    headerImageData = processed.base64DataUri;
    headerImagePreview = processed.previewDataUri;

    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.letter.header_image.processed",
        originalSize: `${processed.originalWidth}x${processed.originalHeight}`,
        processedSize: `${processed.processedWidth}x${processed.processedHeight}`,
        previewSize: `${Math.round(headerImagePreview.length / 1024)}KB`
      },
      "Header image processed successfully"
    );
  } catch (error) {
    const message = error instanceof ImageProcessingError
      ? error.userMessage
      : 'Could not process header image. Please try a different image.';

    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.letter.header_image.failed",
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      "Header image processing failed"
    );
    throw new Error(message);
  }

  // Prepare sender (use saved return address if not provided)
  const { sender, usedSavedReturnAddress, savedReturnAddressNote } = await prepareSender(input, context);

  // Validate addresses
  validateAddresses(sender, input.recipient, context);

  // Validate character limit (reduced for header image layout)
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
    headerImageData,
    headerImagePreview,  // Small preview for ChatGPT widget
    headerImageUrl: imageSource,
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

export const quoteAndPreviewLetterWithHeaderImageTool: McpToolDefinition<
  QuoteAndPreviewLetterWithHeaderImageInput,
  LetterQuoteOutput
> = {
  name: "quote_and_preview_letter_with_header_image",
  description:
    "PREVIEW a letter with a HEADER IMAGE at the top (letterhead/branding). This does NOT send anything.\n\n" +
    "LIMITS: Must not exceed 1100 characters OR 17 lines. CRITICAL: Write as continuous paragraphs - do NOT put blank lines between sentences. US addresses only.\n\n" +
    "REQUIRES: An image attachment (recommended) or imageUrl parameter.\n\n" +
    "Creates a DRAFT for the user to review. Sending happens via send_letter.\n\n" +
    "Use cases: Business letters with logo, custom letterhead, branded correspondence.\n\n" +
    "Alternative tools:\n" +
    "- quote_and_preview_letter: Text-only (1600 chars, 24 lines)\n" +
    "- quote_and_preview_letter_with_image: Image AFTER signature (800 chars, 12 lines)",
  // readOnly: false because this tool creates draft records in the database
  // See docs/learnings/tool-annotation-decision.md for rationale
  readOnly: false,
  inputSchema: quoteAndPreviewLetterWithHeaderImageInputSchema,
  outputSchema: quoteAndPreviewOutputSchema,
  meta: {
    "openai/outputTemplate": OUTPUT_TEMPLATE,
    "openai/widgetAccessible": true,
    "openai/fileParams": ["image"],  // ENABLE IMAGE UPLOAD
    "openai/toolInvocation/invoking": "Processing letter with header image...",
    "openai/toolInvocation/invoked": "Preview ready"
    // Note: readOnlyHint is set by buildAnnotations() in registerTools.ts
  },
  handler
};
