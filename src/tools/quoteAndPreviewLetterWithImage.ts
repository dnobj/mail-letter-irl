/**
 * Quote and Preview Letter with Image
 *
 * Creates a preview of a physical letter WITH an image enclosed after the signature.
 * The image appears AFTER the signature, like enclosing a printed photo with your letter.
 *
 * REQUIRES: An image attachment or imageUrl parameter.
 */

import { Address, McpToolDefinition, ToolContext } from "../contracts/types.js";
import {
  quoteAndPreviewLetterWithImageInputSchema,
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

interface QuoteAndPreviewLetterWithImageInput {
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
  input: QuoteAndPreviewLetterWithImageInput,
  context: ToolContext
): Promise<LetterQuoteOutput> {
  const layoutType = 'inline_image';

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.letter.image.start"
    },
    "Processing quote_and_preview_letter_with_image"
  );

  // Get image source - REQUIRED
  const imageSource = input.image?.download_url || input.imageUrl;

  if (!imageSource) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.letter.image.no_image"
      },
      "No image provided"
    );
    throw new Error(
      "No image provided. This tool requires an image to include with your letter.\n\n" +
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
        event: "quote.letter.image.from_fileParams"
      },
      "Using image from OpenAI fileParams"
    );
  } else {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.letter.image.from_url",
        imageUrl: imageSource.substring(0, 100)
      },
      "Using image from URL"
    );
  }

  // Process the image (generates both full-quality and preview versions)
  let inlineImageData: string;
  let inlineImagePreview: string;
  try {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.letter.image.processing"
      },
      "Processing image"
    );

    const processed = await downloadAndProcessLetterImageWithPreview(
      { url: imageSource },
      'inline'
    );
    inlineImageData = processed.base64DataUri;
    inlineImagePreview = processed.previewDataUri;

    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.letter.image.processed",
        originalSize: `${processed.originalWidth}x${processed.originalHeight}`,
        processedSize: `${processed.processedWidth}x${processed.processedHeight}`,
        previewSize: `${Math.round(inlineImagePreview.length / 1024)}KB`
      },
      "Image processed successfully"
    );
  } catch (error) {
    const message = error instanceof ImageProcessingError
      ? error.userMessage
      : 'Could not process image. Please try a different image.';

    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.letter.image.failed",
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      "Image processing failed"
    );
    throw new Error(message);
  }

  // Prepare sender (use saved return address if not provided)
  const { sender, usedSavedReturnAddress, savedReturnAddressNote } = await prepareSender(input, context);

  // Validate addresses
  validateAddresses(sender, input.recipient, context);

  // Validate character limit (reduced for image layout)
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
    inlineImageData,
    inlineImagePreview,  // Small preview for ChatGPT widget
    inlineImageUrl: imageSource,
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

export const quoteAndPreviewLetterWithImageTool: McpToolDefinition<
  QuoteAndPreviewLetterWithImageInput,
  LetterQuoteOutput
> = {
  name: "quote_and_preview_letter_with_image",
  description:
    "PREVIEW a letter with an IMAGE enclosed after the signature. This does NOT send anything.\n\n" +
    "LIMITS: Must not exceed 800 characters OR 12 lines. CRITICAL: Write as continuous paragraphs - do NOT put blank lines between sentences. US addresses only.\n\n" +
    "REQUIRES: An image attachment (recommended) or imageUrl parameter.\n\n" +
    "Creates a DRAFT for the user to review. Sending happens via send_letter.\n\n" +
    "Use cases: Photos to family/friends, thank you cards with pictures, vacation photos.\n\n" +
    "Alternative tools:\n" +
    "- quote_and_preview_letter: Text-only (1600 chars, 24 lines)\n" +
    "- quote_and_preview_letter_with_header_image: Image at TOP (1100 chars, 17 lines)",
  // readOnly: false because this tool creates draft records in the database
  // See docs/learnings/tool-annotation-decision.md for rationale
  readOnly: false,
  inputSchema: quoteAndPreviewLetterWithImageInputSchema,
  outputSchema: quoteAndPreviewOutputSchema,
  meta: {
    "openai/outputTemplate": OUTPUT_TEMPLATE,
    "openai/widgetAccessible": true,
    "openai/fileParams": ["image"],  // ENABLE IMAGE UPLOAD
    "openai/toolInvocation/invoking": "Processing letter with image...",
    "openai/toolInvocation/invoked": "Preview ready"
    // Note: readOnlyHint is set by buildAnnotations() in registerTools.ts
  },
  handler
};
