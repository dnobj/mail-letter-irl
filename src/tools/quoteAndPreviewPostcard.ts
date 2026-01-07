/**
 * Quote and Preview Postcard Tool
 *
 * Generates a preview and cost estimate for a postcard.
 * Validates addresses, processes images, and creates a draft for sending.
 *
 * User Stories:
 * - US-POSTCARD-01: Preview a Postcard
 * - US-POSTCARD-03: Postcard Image Processing
 */

import { Address, McpToolDefinition, ToolContext } from "../contracts/types.js";
import {
  quoteAndPreviewPostcardInputSchema,
  quoteAndPreviewPostcardOutputSchema
} from "../schemas.js";
import { getLetterProvider } from "../services/providers/index.js";
import type { AddressValidationInput, AddressValidationResult } from "../services/providers/types.js";
import { createPostcardDraft } from "../services/draftService.js";
import { getReturnAddress } from "../services/returnAddressService.js";
import { downloadAndProcessPostcardImageWithPreview, ImageProcessingError, type ImageInput } from "../services/imageService.js";
import type { PostcardSize, ImageFileParam } from "../services/types.js";
import { MOBILE_IMAGE_ERRORS } from "../utils/mobileDetection.js";

// ============================================================================
// Types
// ============================================================================

interface QuoteAndPreviewPostcardInput {
  sender?: Address;  // Optional - will use saved return address if not provided
  recipient: Address;
  message: string;
  size?: PostcardSize;
  // Image from OpenAI fileParams - injected by MCP framework
  // Union type handles ChatGPT mobile sending '' when no file attached
  image?: ImageFileParam | string;
  // Alternative: direct image URL (for when fileParams isn't available)
  imageUrl?: string;
}

interface QuoteAndPreviewPostcardOutput {
  previewFrontHtml: string;
  previewBackHtml: string;
  lettersRequired: number;  // Number of letters from balance (always 1 for postcard)
  canSendNow: boolean;
  reasonCannotSend?: string;
  deliveryClass?: string;
  estimatedDeliveryDays?: number;
  // Draft for idempotent send
  draftId: string;
  draftExpiresAt: string;  // ISO timestamp
  // Message text (for display in widget)
  message: string;
  // Recipient info (for display in widget)
  recipientName: string;
  recipientAddressLine1: string;
  recipientCity: string;
  recipientState: string;
  recipientPostalCode: string;
  // Sender info (for return address in widget)
  senderName: string;
  senderAddressLine1: string;
  senderCity: string;
  senderState: string;
  senderPostalCode: string;
  // Saved return address used (when sender not provided)
  usedSavedReturnAddress?: boolean;
  savedReturnAddressNote?: string;
  // Address validation results
  senderAddressValidation?: {
    status: 'verified' | 'corrected' | 'failed';
    originalAddress: Address;
    verifiedAddress?: Address;
    errors?: string[];
    suggestions?: string;
  };
  recipientAddressValidation?: {
    status: 'verified' | 'corrected' | 'failed';
    originalAddress: Address;
    verifiedAddress?: Address;
    errors?: string[];
    suggestions?: string;
  };
}

// ============================================================================
// Constants
// ============================================================================

const OUTPUT_TEMPLATE = "ui://widgets/PostcardPreviewCard.html";
const MAX_MESSAGE_LENGTH = 500;
const POSTCARD_CREDITS_COST = 2; // 2 internal credits = 1 letter/postcard

// ============================================================================
// Handler
// ============================================================================

async function handler(
  input: QuoteAndPreviewPostcardInput,
  context: ToolContext
): Promise<QuoteAndPreviewPostcardOutput> {
  const size: PostcardSize = input.size ?? '6x9';

  // Track if we used the saved return address
  let usedSavedReturnAddress = false;
  let savedReturnAddressNote: string | undefined;

  // Determine image source - either fileParams or direct URL
  let imageInput: ImageInput | null = null;
  let imageSourceUrl: string | undefined;

  // Type guard: Check if image is a valid ImageFileParam object (not empty string from mobile)
  const isValidImageFileParam = (img: unknown): img is ImageFileParam =>
    typeof img === 'object' && img !== null && 'download_url' in img;

  // Check if we have file_id even without download_url (potential mobile workaround via sediment://)
  const hasFileIdOnly = (img: unknown): img is { file_id: string } =>
    typeof img === 'object' && img !== null && 'file_id' in img && !('download_url' in img);

  // DEBUG: Log full details of image parameter for mobile debugging
  const imageObj = input.image as Record<string, unknown> | undefined;
  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.postcard.image_debug",
      imageType: typeof input.image,
      imageIsNull: input.image === null,
      imageIsEmptyString: input.image === '',
      imageIsObject: typeof input.image === 'object' && input.image !== null,
      // Log specific fields if object
      hasDownloadUrl: imageObj && 'download_url' in imageObj,
      hasFileId: imageObj && 'file_id' in imageObj,
      hasMimeType: imageObj && 'mime_type' in imageObj,
      hasFileName: imageObj && 'file_name' in imageObj,
      // Log actual values (truncated for URLs, full for file_id)
      fileId: imageObj?.file_id as string | undefined,  // Full file_id (sediment://) for debugging
      downloadUrlPrefix: typeof imageObj?.download_url === 'string'
        ? imageObj.download_url.substring(0, 80) + '...'
        : undefined,
      mimeType: imageObj?.mime_type as string | undefined,
      fileName: imageObj?.file_name as string | undefined,
      // Raw value for non-objects (e.g., empty string from mobile)
      rawValue: typeof input.image === 'string' ? input.image : undefined,
      // Validation results
      isValidFileParam: isValidImageFileParam(input.image),
      hasFileIdOnly: hasFileIdOnly(input.image)
    },
    "Debug: Full image parameter details for mobile investigation"
  );

  if (input.image && isValidImageFileParam(input.image)) {
    // OpenAI fileParams (preferred)
    imageInput = input.image;
    imageSourceUrl = input.image.download_url;
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.postcard.image_from_fileParams"
      },
      "Using image from OpenAI fileParams"
    );
  } else if (input.imageUrl) {
    // Direct URL (fallback for code interpreter images)
    imageInput = { url: input.imageUrl };
    imageSourceUrl = input.imageUrl;
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.postcard.image_from_url",
        imageUrl: input.imageUrl.substring(0, 100) // Log first 100 chars
      },
      "Using image from direct URL"
    );
  }

  if (!imageInput) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.postcard.no_image",
        isMobile: context.isMobile
      },
      "No image provided for postcard"
    );

    // US-POSTCARD-04: Mobile Image Graceful Degradation
    // Provide mobile-specific error message with guidance to use text-only letter
    if (context.isMobile) {
      throw new Error(MOBILE_IMAGE_ERRORS.postcard);
    } else {
      throw new Error(MOBILE_IMAGE_ERRORS.desktop);
    }
  }

  // Validate message length
  if (input.message.length > MAX_MESSAGE_LENGTH) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.postcard.message_too_long",
        messageLength: input.message.length,
        maxLength: MAX_MESSAGE_LENGTH
      },
      "Postcard message too long"
    );
    throw new Error(
      `Postcard message is too long (${input.message.length}/${MAX_MESSAGE_LENGTH} characters). ` +
      `Please shorten your message to fit on the postcard back.`
    );
  }

  // If sender not provided, try to use saved return address
  if (!input.sender) {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.postcard.sender_not_provided"
      },
      "Sender not provided, checking for saved return address"
    );

    const savedAddress = await getReturnAddress(context.user.userId);

    if (savedAddress) {
      input.sender = savedAddress;
      usedSavedReturnAddress = true;
      savedReturnAddressNote = `Using your saved return address: ${savedAddress.name}, ${savedAddress.addressLine1}, ${savedAddress.city}, ${savedAddress.state} ${savedAddress.postalCode}`;

      context.logger.info(
        {
          correlationId: context.correlationId,
          event: "quote.postcard.using_saved_address",
          savedAddressCity: savedAddress.city,
          savedAddressState: savedAddress.state
        },
        "Using saved return address for sender"
      );
    } else {
      context.logger.warn(
        {
          correlationId: context.correlationId,
          event: "quote.postcard.no_sender_address"
        },
        "No sender address provided and no saved return address"
      );
      throw new Error(
        "No return address provided. Please either:\n" +
        "1. Include a sender address in your request, or\n" +
        "2. Save a return address using the set_return_address tool first.\n\n" +
        "You can set a return address once and it will be used automatically for all future postcards."
      );
    }
  }

  const sender = input.sender as Address;

  // Validate required address fields
  const missingFields = collectMissingAddressFields({ sender, recipient: input.recipient });
  if (missingFields.length > 0) {
    const message = `Missing required address fields: ${missingFields.join(", ")}`;
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.postcard.missing_fields",
        missingFields
      },
      message
    );
    throw new Error(
      `${message}. Please provide full sender and recipient addresses (name, street, city, state, postal code, country).`
    );
  }

  // Normalize country codes to US
  sender.country = normalizeCountryToUS(sender.country);
  input.recipient.country = normalizeCountryToUS(input.recipient.country);

  // Validate US-only service
  const nonUSAddresses: string[] = [];
  if (sender.country !== 'US') {
    nonUSAddresses.push(`sender address is in ${sender.country}`);
  }
  if (input.recipient.country !== 'US') {
    nonUSAddresses.push(`recipient address is in ${input.recipient.country}`);
  }

  if (nonUSAddresses.length > 0) {
    const message = `Letter IRL currently only supports mailing within the United States. ${nonUSAddresses.join(', ')}.`;
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.postcard.non_us_address",
        senderCountry: sender.country,
        recipientCountry: input.recipient.country
      },
      message
    );
    throw new Error(message);
  }

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.postcard.start",
      size,
      messageLength: input.message.length
    },
    "Processing quote_and_preview_postcard"
  );

  // Process the image
  let processedImage;
  try {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.postcard.processing_image"
      },
      "Downloading and processing postcard image"
    );

    processedImage = await downloadAndProcessPostcardImageWithPreview(imageInput!, size);

    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.postcard.image_processed",
        originalWidth: processedImage.originalWidth,
        originalHeight: processedImage.originalHeight,
        processedWidth: processedImage.processedWidth,
        processedHeight: processedImage.processedHeight
      },
      "Image processed successfully"
    );
  } catch (error) {
    if (error instanceof ImageProcessingError) {
      context.logger.warn(
        {
          correlationId: context.correlationId,
          event: "quote.postcard.image_processing_failed",
          errorCode: error.code,
          errorMessage: error.userMessage
        },
        "Image processing failed"
      );
      throw new Error(error.userMessage);
    }
    throw error;
  }

  // Validate addresses using provider if available
  const provider = getLetterProvider();
  let senderValidation: AddressValidationResult | undefined;
  let recipientValidation: AddressValidationResult | undefined;

  if (provider.validateAddress) {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.postcard.validating_addresses"
      },
      "Validating addresses with provider"
    );

    const senderAddressInput: AddressValidationInput = {
      line1: sender.addressLine1,
      line2: sender.addressLine2,
      city: sender.city,
      state: sender.state,
      postalCode: sender.postalCode,
      country: sender.country
    };

    senderValidation = await provider.validateAddress(senderAddressInput);

    const recipientAddressInput: AddressValidationInput = {
      line1: input.recipient.addressLine1,
      line2: input.recipient.addressLine2,
      city: input.recipient.city,
      state: input.recipient.state,
      postalCode: input.recipient.postalCode,
      country: input.recipient.country
    };

    recipientValidation = await provider.validateAddress(recipientAddressInput);

    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.postcard.addresses_validated",
        senderStatus: senderValidation.status,
        recipientStatus: recipientValidation.status
      },
      "Address validation complete"
    );

    // Check for failed addresses
    const hasFailures = senderValidation.status === 'failed' || recipientValidation.status === 'failed';

    if (hasFailures) {
      const errorParts: string[] = [];

      if (senderValidation.status === 'failed') {
        const errorMsg = senderValidation.errors?.map(e => e.message).join('; ') || 'Address is invalid or undeliverable';
        errorParts.push(`Sender address is INVALID: ${errorMsg}`);
      }

      if (recipientValidation.status === 'failed') {
        const errorMsg = recipientValidation.errors?.map(e => e.message).join('; ') || 'Address is invalid or undeliverable';
        errorParts.push(`Recipient address is INVALID: ${errorMsg}`);
      }

      context.logger.warn(
        {
          correlationId: context.correlationId,
          event: "quote.postcard.address_validation_failed",
          senderStatus: senderValidation.status,
          recipientStatus: recipientValidation.status
        },
        "Address validation failed - invalid addresses"
      );

      throw new Error(
        `Address validation failed:\n\n${errorParts.join('\n\n')}\n\nPlease correct the invalid address(es) and try again.`
      );
    }

    // Auto-apply corrected addresses
    if (senderValidation.status === 'corrected' && senderValidation.verifiedAddress) {
      sender.addressLine1 = senderValidation.verifiedAddress.line1;
      sender.addressLine2 = senderValidation.verifiedAddress.line2;
      sender.city = senderValidation.verifiedAddress.city;
      sender.state = senderValidation.verifiedAddress.state;
      sender.postalCode = senderValidation.verifiedAddress.postalCode;
      if (senderValidation.verifiedAddress.country) {
        sender.country = senderValidation.verifiedAddress.country;
      }
    }

    if (recipientValidation.status === 'corrected' && recipientValidation.verifiedAddress) {
      input.recipient.addressLine1 = recipientValidation.verifiedAddress.line1;
      input.recipient.addressLine2 = recipientValidation.verifiedAddress.line2;
      input.recipient.city = recipientValidation.verifiedAddress.city;
      input.recipient.state = recipientValidation.verifiedAddress.state;
      input.recipient.postalCode = recipientValidation.verifiedAddress.postalCode;
      if (recipientValidation.verifiedAddress.country) {
        input.recipient.country = recipientValidation.verifiedAddress.country;
      }
    }
  }

  // Check credits
  const requiredCredits = POSTCARD_CREDITS_COST;
  const available = context.user.creditsRemaining;
  const canSendNow = available >= requiredCredits;
  const lettersRequired = 1; // User-facing: 1 letter = 1 postcard

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.postcard.computed",
      availableCredits: available,
      requiredCredits,
      lettersRequired,
      canSendNow
    },
    "Computed preview requirements"
  );

  // Generate preview HTML using smaller preview image (~10-20KB vs ~200-400KB)
  // Full-quality image is stored in draft for PostGrid printing
  const previewFrontHtml = generatePreviewFrontHtml(processedImage.previewDataUri, size);
  const previewBackHtml = generatePreviewBackHtml(input.message, sender);

  // Create draft for idempotent send
  const draftResult = await createPostcardDraft({
    userId: context.user.userId,
    sender: sender as unknown as Record<string, unknown>,
    recipient: input.recipient as unknown as Record<string, unknown>,
    message: input.message,
    frontImageData: processedImage.base64DataUri,
    frontImageUrl: imageSourceUrl!,
    postcardSize: size,
    requiredCredits,
    previewHtml: previewFrontHtml,
    senderValidation: senderValidation ? { status: senderValidation.status } : undefined,
    recipientValidation: recipientValidation ? { status: recipientValidation.status } : undefined,
  });

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.postcard.draft_created",
      draftId: draftResult.draftId,
      expiresAt: draftResult.expiresAt.toISOString()
    },
    "Draft created for idempotent send"
  );

  // Build response
  const output: QuoteAndPreviewPostcardOutput = {
    previewFrontHtml,
    previewBackHtml,
    lettersRequired,
    canSendNow,
    reasonCannotSend: canSendNow ? undefined : "Not enough letters in your balance.",
    deliveryClass: "First Class Postcard",
    estimatedDeliveryDays: 5,
    draftId: draftResult.draftId,
    draftExpiresAt: draftResult.expiresAt.toISOString(),
    message: input.message,
    recipientName: input.recipient.name,
    recipientAddressLine1: input.recipient.addressLine1,
    recipientCity: input.recipient.city,
    recipientState: input.recipient.state,
    recipientPostalCode: input.recipient.postalCode,
    senderName: sender.name,
    senderAddressLine1: sender.addressLine1,
    senderCity: sender.city,
    senderState: sender.state,
    senderPostalCode: sender.postalCode,
    usedSavedReturnAddress: usedSavedReturnAddress || undefined,
    savedReturnAddressNote: savedReturnAddressNote,
  };

  // Add address validation results if available
  if (senderValidation) {
    output.senderAddressValidation = {
      status: senderValidation.status,
      originalAddress: sender,
      verifiedAddress: senderValidation.verifiedAddress ? {
        name: sender.name,
        addressLine1: senderValidation.verifiedAddress.line1,
        addressLine2: senderValidation.verifiedAddress.line2,
        city: senderValidation.verifiedAddress.city,
        state: senderValidation.verifiedAddress.state,
        postalCode: senderValidation.verifiedAddress.postalCode,
        country: senderValidation.verifiedAddress.country
      } : undefined,
      errors: senderValidation.errors?.map(e => e.message),
      suggestions: senderValidation.status === 'corrected'
        ? `Address was corrected: ${senderValidation.verifiedAddress?.line1}, ${senderValidation.verifiedAddress?.city}, ${senderValidation.verifiedAddress?.state} ${senderValidation.verifiedAddress?.postalCode}`
        : undefined
    };
  }

  if (recipientValidation) {
    output.recipientAddressValidation = {
      status: recipientValidation.status,
      originalAddress: input.recipient,
      verifiedAddress: recipientValidation.verifiedAddress ? {
        name: input.recipient.name,
        addressLine1: recipientValidation.verifiedAddress.line1,
        addressLine2: recipientValidation.verifiedAddress.line2,
        city: recipientValidation.verifiedAddress.city,
        state: recipientValidation.verifiedAddress.state,
        postalCode: recipientValidation.verifiedAddress.postalCode,
        country: recipientValidation.verifiedAddress.country
      } : undefined,
      errors: recipientValidation.errors?.map(e => e.message),
      suggestions: recipientValidation.status === 'corrected'
        ? `Address was corrected: ${recipientValidation.verifiedAddress?.line1}, ${recipientValidation.verifiedAddress?.city}, ${recipientValidation.verifiedAddress?.state} ${recipientValidation.verifiedAddress?.postalCode}`
        : undefined
    };
  }

  return output;
}

// ============================================================================
// Tool Definition
// ============================================================================

export const quoteAndPreviewPostcardTool: McpToolDefinition<
  QuoteAndPreviewPostcardInput,
  QuoteAndPreviewPostcardOutput
> = {
  name: "quote_and_preview_postcard",
  description:
    "WHEN TO USE: Call this tool to CREATE A PREVIEW of a physical postcard. This does NOT send " +
    "anything - it only generates a draft for the user to review. Proactively offer previews when " +
    "the user has created artwork, drawings, photos, or any image they might want to share " +
    "physically (vacation photos, holiday greetings, art projects, thank you cards with images).\n\n" +
    "PREVIEW IS FREE: Generating a preview costs nothing and does not use credits. " +
    "Feel free to create previews so users can see exactly what their postcard will look like.\n\n" +
    "What it does: Takes an image for the front, a message for the back, validates addresses, " +
    "and creates a DRAFT. The user reviews the preview before deciding to send via send_postcard.\n\n" +
    "IMAGE OPTIMIZATION (Recommended for best print quality):\n" +
    "For optimal results and reliable image transfer on all platforms:\n" +
    "1. Use Code Interpreter to resize the image to 1872×1248 pixels (optimal for 6x9 postcard at 300dpi)\n" +
    "2. Save as high-quality JPEG\n" +
    "3. Use the resulting file with this tool\n" +
    "This ensures optimal print quality and works reliably on all platforms including mobile.\n\n" +
    "Image Input (provide ONE):\n" +
    "1. Attach an image directly to your message\n" +
    "2. Use imageUrl parameter with a publicly accessible URL\n" +
    "- Supported: PNG, JPEG, WebP (max 10MB), any size (auto-resized for 6x9 print)\n\n" +
    "Sender Address:\n" +
    "- If not provided, saved return address is used automatically.\n" +
    "- Use set_return_address to save one for all future postcards.\n\n" +
    "Draft Workflow:\n" +
    "1. Creates a DRAFT with draftId (required for send_postcard).\n" +
    "2. Drafts expire after 24 hours.\n" +
    "3. Idempotent - retrying won't charge twice.\n\n" +
    "Restrictions: US addresses only, max ~400 character message.",
  // readOnly: false because this tool creates draft records in the database
  // See docs/learnings/tool-annotation-decision.md for rationale
  readOnly: false,
  inputSchema: quoteAndPreviewPostcardInputSchema,
  outputSchema: quoteAndPreviewPostcardOutputSchema,
  meta: {
    "openai/outputTemplate": OUTPUT_TEMPLATE,
    "openai/widgetAccessible": true,
    "openai/fileParams": ["image"],  // Enables image upload via OpenAI Apps SDK
    "openai/toolInvocation/invoking": "Processing postcard...",
    "openai/toolInvocation/invoked": "Postcard preview ready"
    // Note: readOnlyHint is set by buildAnnotations() in registerTools.ts
  },
  handler
};

// ============================================================================
// Helper Functions
// ============================================================================

const REQUIRED_ADDRESS_PROPS = [
  "name",
  "addressLine1",
  "city",
  "state",
  "country"
];

function collectMissingAddressFields(input: { sender: Address; recipient: Address }): string[] {
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

function normalizeCountryToUS(country?: string): string {
  if (!country) return 'US';
  const normalized = country.toUpperCase().trim();
  if (normalized === 'US' || normalized === 'USA' || normalized === 'UNITED STATES' || normalized === 'U.S.' || normalized === 'U.S.A.') {
    return 'US';
  }
  return normalized;
}

/**
 * Generate HTML preview for postcard front (image)
 */
function generatePreviewFrontHtml(imageBase64: string, size: PostcardSize): string {
  const dimensions = size === '6x9' ? { width: 540, height: 810 } : { width: 540, height: 360 };

  return `<!DOCTYPE html>
<html>
<head>
  <style>
    .postcard-front {
      width: ${dimensions.width}px;
      height: ${dimensions.height}px;
      border: 1px solid #ddd;
      border-radius: 4px;
      overflow: hidden;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .postcard-front img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  </style>
</head>
<body>
  <div class="postcard-front">
    <img src="${imageBase64}" alt="Postcard front" />
  </div>
</body>
</html>`;
}

/**
 * Generate HTML preview for postcard back (message + return address)
 */
function generatePreviewBackHtml(message: string, sender: Address): string {
  const escapedMessage = escapeHtml(message).replace(/\n/g, '<br>');

  return `<!DOCTYPE html>
<html>
<head>
  <style>
    .postcard-back {
      width: 540px;
      height: 810px;
      padding: 24px;
      border: 1px solid #ddd;
      border-radius: 4px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      font-family: 'Georgia', serif;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      background: #fff;
    }
    .return-address {
      font-size: 10px;
      line-height: 1.4;
      color: #666;
      margin-bottom: 24px;
    }
    .message {
      flex: 1;
      font-size: 14px;
      line-height: 1.6;
      color: #333;
      white-space: pre-wrap;
    }
    .divider {
      position: absolute;
      left: 50%;
      top: 0;
      bottom: 0;
      width: 1px;
      background: #ddd;
    }
  </style>
</head>
<body>
  <div class="postcard-back">
    <div class="return-address">
      ${escapeHtml(sender.name)}<br>
      ${escapeHtml(sender.addressLine1)}<br>
      ${sender.addressLine2 ? escapeHtml(sender.addressLine2) + '<br>' : ''}
      ${escapeHtml(sender.city)}, ${escapeHtml(sender.state)} ${escapeHtml(sender.postalCode)}
    </div>
    <div class="message">${escapedMessage}</div>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
