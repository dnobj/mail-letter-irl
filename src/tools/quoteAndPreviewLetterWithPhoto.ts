/**
 * Quote and Preview Letter with Photo
 *
 * Creates a preview of a physical letter WITH a photo enclosed after the signature.
 * The photo appears AFTER the signature, like enclosing a printed photo with your letter.
 *
 * REQUIRES: A photo attachment or imageUrl parameter.
 */

import { Address, McpToolDefinition, ToolContext } from "../contracts/types.js";
import {
  quoteAndPreviewLetterWithPhotoInputSchema,
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
import { downloadAndProcessLetterImage, ImageProcessingError } from "../services/imageService.js";
import type { ImageFileParam } from "../services/types.js";

// ============================================================================
// Types
// ============================================================================

interface QuoteAndPreviewLetterWithPhotoInput {
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
  input: QuoteAndPreviewLetterWithPhotoInput,
  context: ToolContext
): Promise<LetterQuoteOutput> {
  const layoutType = 'inline_image';

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.letter.photo.start"
    },
    "Processing quote_and_preview_letter_with_photo"
  );

  // Get image source - REQUIRED
  const imageSource = input.image?.download_url || input.imageUrl;

  if (!imageSource) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.letter.photo.no_image"
      },
      "No photo provided"
    );
    throw new Error(
      "No photo provided. This tool requires a photo to include with your letter.\n\n" +
      "Please either:\n" +
      "1. Attach a photo to your message (recommended)\n" +
      "2. Provide an imageUrl parameter with a publicly accessible URL\n\n" +
      "If you want to send a text-only letter, use quote_and_preview_letter instead."
    );
  }

  // Log image source
  if (input.image?.download_url) {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.letter.photo.from_fileParams"
      },
      "Using photo from OpenAI fileParams"
    );
  } else {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.letter.photo.from_url",
        imageUrl: imageSource.substring(0, 100)
      },
      "Using photo from URL"
    );
  }

  // Process the image
  let inlineImageData: string;
  try {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.letter.photo.processing"
      },
      "Processing photo"
    );

    const processed = await downloadAndProcessLetterImage(
      { url: imageSource },
      'inline'
    );
    inlineImageData = processed.base64DataUri;

    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.letter.photo.processed",
        originalSize: `${processed.originalWidth}x${processed.originalHeight}`,
        processedSize: `${processed.processedWidth}x${processed.processedHeight}`
      },
      "Photo processed successfully"
    );
  } catch (error) {
    const message = error instanceof ImageProcessingError
      ? error.userMessage
      : 'Could not process photo. Please try a different image.';

    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.letter.photo.failed",
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      "Photo processing failed"
    );
    throw new Error(message);
  }

  // Prepare sender (use saved return address if not provided)
  const { sender, usedSavedReturnAddress, savedReturnAddressNote } = await prepareSender(input, context);

  // Validate addresses
  validateAddresses(sender, input.recipient, context);

  // Validate character limit (reduced for photo layout)
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

export const quoteAndPreviewLetterWithPhotoTool: McpToolDefinition<
  QuoteAndPreviewLetterWithPhotoInput,
  LetterQuoteOutput
> = {
  name: "quote_and_preview_letter_with_photo",
  description:
    "WHEN TO USE: Create a preview of a letter WITH A PHOTO enclosed after the signature.\n\n" +
    "The photo appears AFTER your signature, like enclosing a printed photo with your letter.\n\n" +
    "REQUIRES: A photo attachment (recommended) or imageUrl parameter.\n\n" +
    "Use cases: Sending photos to family/friends, thank you cards with pictures, " +
    "letters with vacation photos, sharing artwork or drawings, memory sharing.\n\n" +
    "PREVIEW IS FREE: Generating a preview costs nothing.\n\n" +
    "Alternative tools:\n" +
    "- quote_and_preview_letter: Text-only letters (no image)\n" +
    "- quote_and_preview_letter_with_header_image: Image at TOP (letterhead/branding)\n\n" +
    "Sender Address: If not provided, your saved return address is used automatically.\n\n" +
    "Restrictions: US addresses only, max ~1200 characters (shorter due to photo).",
  readOnly: true,
  inputSchema: quoteAndPreviewLetterWithPhotoInputSchema,
  outputSchema: quoteAndPreviewOutputSchema,
  meta: {
    "openai/outputTemplate": OUTPUT_TEMPLATE,
    "openai/widgetAccessible": true,
    "openai/fileParams": ["image"],  // ENABLE IMAGE UPLOAD
    "openai/toolInvocation/invoking": "Processing letter with photo...",
    "openai/toolInvocation/invoked": "Preview ready",
    readOnlyHint: true
  },
  handler
};
