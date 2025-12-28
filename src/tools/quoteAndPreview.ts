import { Address, McpToolDefinition, ToolContext, LetterLayoutType } from "../contracts/types.js";
import {
  quoteAndPreviewInputSchema,
  quoteAndPreviewOutputSchema
} from "../schemas.js";
import {
  estimateRequiredCredits,
  renderPreviewHtml,
  renderLayoutPreviewHtml,
  detectLayoutType,
  validateCharacterLimit,
  LAYOUT_CHARACTER_LIMITS,
} from "../services/previewService.js";
import { getLetterProvider } from "../services/providers/index.js";
import type { AddressValidationInput, AddressValidationResult } from "../services/providers/types.js";
import { createDraft } from "../services/draftService.js";
import { getReturnAddress } from "../services/returnAddressService.js";
import { downloadAndProcessLetterImage, ImageProcessingError } from "../services/imageService.js";
import type { ImageFileParam } from "../services/types.js";

interface QuoteAndPreviewInput {
  sender?: Address;  // Optional - will use saved return address if not provided
  recipient: Address;
  bodyText: string;
  signOff: string;
  // Layout fields (US-LAYOUT-01 through US-LAYOUT-06)
  layoutType?: LetterLayoutType;     // Explicit override, or auto-detected from images
  // Primary image param - simplest way to include an image (defaults to inline placement)
  image?: ImageFileParam;            // Attach image directly (recommended) - placed after signature by default
  imageUrl?: string;                 // Alternative: URL for image (placed after signature by default)
  imagePlacement?: 'header' | 'inline';  // Where to place the image (default: 'inline')
  // Specific image params for explicit control (override image/imageUrl)
  headerImage?: ImageFileParam;      // Header/letterhead image (file upload)
  inlineImage?: ImageFileParam;      // Inline image after signature (file upload)
  headerImageUrl?: string;           // URL of header/letterhead image
  inlineImageUrl?: string;           // URL of inline image (after signature)
}

interface QuoteAndPreviewOutput {
  previewHtml: string;
  lettersRequired: number;  // Letters required from balance (always 1 for standard)
  canSendNow: boolean;
  reasonCannotSend?: string;
  deliveryClass?: string;
  estimatedDeliveryDays?: number;
  // Draft for idempotent send
  draftId: string;
  draftExpiresAt: string;  // ISO timestamp
  // Layout fields (US-LAYOUT-01 through US-LAYOUT-06)
  layoutType: LetterLayoutType;
  headerImageData?: string;  // Base64 data URI for widget preview
  inlineImageData?: string;  // Base64 data URI for widget preview
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

const OUTPUT_TEMPLATE = "ui://widgets/LetterPreviewCard.html";

async function handler(
  input: QuoteAndPreviewInput,
  context: ToolContext
): Promise<QuoteAndPreviewOutput> {
  // Track if we used the saved return address
  let usedSavedReturnAddress = false;
  let savedReturnAddressNote: string | undefined;

  // If sender not provided, try to use saved return address
  if (!input.sender) {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.preview.sender_not_provided"
      },
      "Sender not provided, checking for saved return address"
    );

    const savedAddress = await getReturnAddress(context.user.userId);

    if (savedAddress) {
      // Use the saved return address
      input.sender = savedAddress;
      usedSavedReturnAddress = true;
      savedReturnAddressNote = `Using your saved return address: ${savedAddress.name}, ${savedAddress.addressLine1}, ${savedAddress.city}, ${savedAddress.state} ${savedAddress.postalCode}`;

      context.logger.info(
        {
          correlationId: context.correlationId,
          event: "quote.preview.using_saved_address",
          savedAddressCity: savedAddress.city,
          savedAddressState: savedAddress.state
        },
        "Using saved return address for sender"
      );
    } else {
      // No saved address and no sender provided - throw helpful error
      context.logger.warn(
        {
          correlationId: context.correlationId,
          event: "quote.preview.no_sender_address"
        },
        "No sender address provided and no saved return address"
      );
      throw new Error(
        "No return address provided. Please either:\n" +
        "1. Include a sender address in your request, or\n" +
        "2. Save a return address using the set_return_address tool first.\n\n" +
        "You can set a return address once and it will be used automatically for all future letters."
      );
    }
  }

  // At this point, sender is guaranteed to exist (either provided or from saved address)
  const sender = input.sender as Address;

  const missingFields = collectMissingAddressFields({ sender, recipient: input.recipient, bodyText: input.bodyText, signOff: input.signOff });
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

  // Normalize country codes to US (2-letter ISO code)
  // Accept: US, USA, United States, us, usa, etc.
  const normalizeCountryToUS = (country?: string): string => {
    if (!country) return 'US';
    const normalized = country.toUpperCase().trim();
    if (normalized === 'US' || normalized === 'USA' || normalized === 'UNITED STATES' || normalized === 'U.S.' || normalized === 'U.S.A.') {
      return 'US';
    }
    return normalized;
  };

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
        event: "quote.preview.non_us_address",
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
      event: "quote.preview.start"
    },
    "Processing quote_and_preview_letter"
  );

  // =========================================================================
  // Layout Detection and Image Processing (US-LAYOUT-03, US-LAYOUT-04)
  // =========================================================================

  // Determine image sources - check primary image param first, then specific params
  // Primary "image" param defaults to inline placement unless imagePlacement is 'header'
  const primaryImageSource = input.image?.download_url || input.imageUrl;
  const placement = input.imagePlacement || 'inline';  // Default to inline (after signature)

  let headerImageSource: string | undefined;
  let inlineImageSource: string | undefined;

  // Specific params take precedence over primary image param
  if (input.headerImage?.download_url || input.headerImageUrl) {
    headerImageSource = input.headerImage?.download_url || input.headerImageUrl;
  } else if (input.inlineImage?.download_url || input.inlineImageUrl) {
    inlineImageSource = input.inlineImage?.download_url || input.inlineImageUrl;
  } else if (primaryImageSource) {
    // Use primary image param with placement
    if (placement === 'header') {
      headerImageSource = primaryImageSource;
    } else {
      inlineImageSource = primaryImageSource;
    }
  }

  // Log image sources for debugging
  if (primaryImageSource) {
    context.logger.info(
      { correlationId: context.correlationId, event: "quote.preview.image_from_primary", placement },
      `Using primary image param with ${placement} placement`
    );
  }
  if (input.headerImage?.download_url) {
    context.logger.info(
      { correlationId: context.correlationId, event: "quote.preview.header_from_fileParams" },
      "Using header image from OpenAI fileParams"
    );
  }
  if (input.inlineImage?.download_url) {
    context.logger.info(
      { correlationId: context.correlationId, event: "quote.preview.inline_from_fileParams" },
      "Using inline image from OpenAI fileParams"
    );
  }

  // Detect layout type from input (auto-detect from images or use explicit override)
  let layoutType: LetterLayoutType;
  try {
    layoutType = detectLayoutType({
      headerImageUrl: headerImageSource,
      inlineImageUrl: inlineImageSource,
      layoutType: input.layoutType,
    });
  } catch (error) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.preview.layout_detection_failed",
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      "Layout detection failed"
    );
    throw error;
  }

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.preview.layout_detected",
      layoutType,
      hasHeaderImage: !!headerImageSource,
      hasInlineImage: !!inlineImageSource,
      headerFromFileParams: !!input.headerImage?.download_url,
      inlineFromFileParams: !!input.inlineImage?.download_url,
      explicitOverride: !!input.layoutType
    },
    `Layout type detected: ${layoutType}`
  );

  // Process images if provided
  let headerImageData: string | undefined;
  let inlineImageData: string | undefined;

  if (headerImageSource && layoutType === 'header_image') {
    try {
      context.logger.info(
        {
          correlationId: context.correlationId,
          event: "quote.preview.processing_header_image"
        },
        "Processing header image"
      );

      const processed = await downloadAndProcessLetterImage(
        { url: headerImageSource },
        'header'
      );
      headerImageData = processed.base64DataUri;

      context.logger.info(
        {
          correlationId: context.correlationId,
          event: "quote.preview.header_image_processed",
          originalSize: `${processed.originalWidth}x${processed.originalHeight}`,
          processedSize: `${processed.processedWidth}x${processed.processedHeight}`
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
          event: "quote.preview.header_image_failed",
          error: error instanceof Error ? error.message : 'Unknown error'
        },
        "Header image processing failed"
      );
      throw new Error(message);
    }
  }

  if (inlineImageSource && layoutType === 'inline_image') {
    try {
      context.logger.info(
        {
          correlationId: context.correlationId,
          event: "quote.preview.processing_inline_image"
        },
        "Processing inline image"
      );

      const processed = await downloadAndProcessLetterImage(
        { url: inlineImageSource },
        'inline'
      );
      inlineImageData = processed.base64DataUri;

      context.logger.info(
        {
          correlationId: context.correlationId,
          event: "quote.preview.inline_image_processed",
          originalSize: `${processed.originalWidth}x${processed.originalHeight}`,
          processedSize: `${processed.processedWidth}x${processed.processedHeight}`
        },
        "Inline image processed successfully"
      );
    } catch (error) {
      const message = error instanceof ImageProcessingError
        ? error.userMessage
        : 'Could not process inline image. Please try a different image.';

      context.logger.warn(
        {
          correlationId: context.correlationId,
          event: "quote.preview.inline_image_failed",
          error: error instanceof Error ? error.message : 'Unknown error'
        },
        "Inline image processing failed"
      );
      throw new Error(message);
    }
  }

  // =========================================================================
  // Character Limit Validation (layout-specific)
  // =========================================================================

  const charValidation = validateCharacterLimit(input.bodyText, input.signOff, layoutType);

  if (!charValidation.isValid) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.preview.exceeds_page_limit",
        layoutType,
        totalChars: charValidation.totalChars,
        maxChars: charValidation.limit
      },
      "Letter exceeds one-page limit"
    );
    throw new Error(
      `${charValidation.error} (${charValidation.totalChars}/${charValidation.limit} characters). ` +
      `Please shorten your message to fit on one page.`
    );
  }

  // Validate addresses using provider if available
  const provider = getLetterProvider();
  let senderValidation: AddressValidationResult | undefined;
  let recipientValidation: AddressValidationResult | undefined;

  if (provider.validateAddress) {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.preview.validating_addresses"
      },
      "Validating addresses with provider"
    );

    // Validate sender address
    const senderAddressInput: AddressValidationInput = {
      line1: sender.addressLine1,
      line2: sender.addressLine2,
      city: sender.city,
      state: sender.state,
      postalCode: sender.postalCode,
      country: sender.country
    };

    senderValidation = await provider.validateAddress(senderAddressInput);

    // Validate recipient address
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
        event: "quote.preview.addresses_validated",
        senderStatus: senderValidation.status,
        recipientStatus: recipientValidation.status
      },
      "Address validation complete"
    );

    // Check if any addresses failed validation (truly invalid/undeliverable)
    // Corrected addresses are auto-accepted to avoid unnecessary re-submission (US-EDGE-02)
    const hasFailures = senderValidation.status === 'failed' || recipientValidation.status === 'failed';

    if (hasFailures) {
      const errorParts: string[] = [];

      // Handle failed sender address
      if (senderValidation.status === 'failed') {
        const errorMsg = senderValidation.errors?.map(e => e.message).join('; ') || 'Address is invalid or undeliverable';
        errorParts.push(`❌ Sender address is INVALID: ${errorMsg}`);

        if (senderValidation.verifiedAddress) {
          errorParts.push(
            `   Suggested correction:\n` +
            `   ${senderValidation.verifiedAddress.line1}\n` +
            `   ${senderValidation.verifiedAddress.line2 ? senderValidation.verifiedAddress.line2 + '\n   ' : ''}` +
            `   ${senderValidation.verifiedAddress.city}, ${senderValidation.verifiedAddress.state} ${senderValidation.verifiedAddress.postalCode}`
          );
        }
      }

      // Handle failed recipient address
      if (recipientValidation.status === 'failed') {
        const errorMsg = recipientValidation.errors?.map(e => e.message).join('; ') || 'Address is invalid or undeliverable';
        errorParts.push(`❌ Recipient address is INVALID: ${errorMsg}`);

        if (recipientValidation.verifiedAddress) {
          errorParts.push(
            `   Suggested correction:\n` +
            `   ${recipientValidation.verifiedAddress.line1}\n` +
            `   ${recipientValidation.verifiedAddress.line2 ? recipientValidation.verifiedAddress.line2 + '\n   ' : ''}` +
            `   ${recipientValidation.verifiedAddress.city}, ${recipientValidation.verifiedAddress.state} ${recipientValidation.verifiedAddress.postalCode}`
          );
        }
      }

      context.logger.warn(
        {
          correlationId: context.correlationId,
          event: "quote.preview.address_validation_failed",
          senderStatus: senderValidation.status,
          recipientStatus: recipientValidation.status
        },
        "Address validation failed - invalid addresses"
      );

      throw new Error(
        `Address validation failed:\n\n${errorParts.join('\n\n')}\n\nPlease correct the invalid address(es) and try again.`
      );
    }

    // For corrected addresses, auto-apply the correction to the preview/draft
    // This avoids requiring re-submission for minor corrections (ZIP+4, formatting, etc.)
    if (senderValidation.status === 'corrected' && senderValidation.verifiedAddress) {
      context.logger.info(
        {
          correlationId: context.correlationId,
          event: "quote.preview.sender_address_corrected",
          original: `${sender.addressLine1}, ${sender.city}, ${sender.state} ${sender.postalCode}`,
          corrected: `${senderValidation.verifiedAddress.line1}, ${senderValidation.verifiedAddress.city}, ${senderValidation.verifiedAddress.state} ${senderValidation.verifiedAddress.postalCode}`
        },
        "Auto-applying corrected sender address"
      );

      // Update sender with corrected address (this is what will be mailed)
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
      context.logger.info(
        {
          correlationId: context.correlationId,
          event: "quote.preview.recipient_address_corrected",
          original: `${input.recipient.addressLine1}, ${input.recipient.city}, ${input.recipient.state} ${input.recipient.postalCode}`,
          corrected: `${recipientValidation.verifiedAddress.line1}, ${recipientValidation.verifiedAddress.city}, ${recipientValidation.verifiedAddress.state} ${recipientValidation.verifiedAddress.postalCode}`
        },
        "Auto-applying corrected recipient address"
      );

      // Update recipient with corrected address (this is what will be mailed)
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

  // Internal: requiredCredits is in internal units (2 credits = 1 letter)
  const requiredCredits = estimateRequiredCredits(input.bodyText, input.signOff);
  const available = context.user.creditsRemaining;
  const canSendNow = available >= requiredCredits;
  // User-facing: lettersRequired is always 1 for standard letters (2 internal credits)
  const lettersRequired = Math.max(1, Math.ceil(requiredCredits / 2));

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.preview.computed",
      availableCredits: available,
      requiredCredits,
      lettersRequired,
      canSendNow
    },
    "Computed preview requirements"
  );

  // Generate preview HTML (layout-aware)
  const previewHtml = renderLayoutPreviewHtml({
    sender,
    recipient: input.recipient,
    bodyText: input.bodyText,
    signOff: input.signOff,
    layoutType,
    headerImageData,
    inlineImageData,
  });

  // Create draft for idempotent send (including layout fields)
  const draftResult = await createDraft({
    userId: context.user.userId,
    sender: sender as unknown as Record<string, unknown>,
    recipient: input.recipient as unknown as Record<string, unknown>,
    bodyText: input.bodyText,
    signOff: input.signOff,
    requiredCredits,
    previewHtml,
    senderValidation: senderValidation ? { status: senderValidation.status } : undefined,
    recipientValidation: recipientValidation ? { status: recipientValidation.status } : undefined,
    // Layout fields (US-LAYOUT-01 through US-LAYOUT-06)
    layoutType,
    headerImageData,
    headerImageUrl: headerImageSource,  // Resolved from fileParams or URL
    inlineImageData,
    inlineImageUrl: inlineImageSource,  // Resolved from fileParams or URL
  });

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.preview.draft_created",
      draftId: draftResult.draftId,
      layoutType,
      expiresAt: draftResult.expiresAt.toISOString()
    },
    "Draft created for idempotent send"
  );

  // Build response
  const output: QuoteAndPreviewOutput = {
    previewHtml,
    lettersRequired,  // User-facing: 1 letter = 2 internal credits
    canSendNow,
    reasonCannotSend: canSendNow ? undefined : "Not enough letters in your balance.",
    deliveryClass: "First Class Letter",
    estimatedDeliveryDays: 5,
    draftId: draftResult.draftId,
    draftExpiresAt: draftResult.expiresAt.toISOString(),
    // Layout fields (US-LAYOUT-01 through US-LAYOUT-06)
    layoutType,
    headerImageData,
    inlineImageData,
    // Include saved return address info if used
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

export const quoteAndPreviewLetterTool: McpToolDefinition<
  QuoteAndPreviewInput,
  QuoteAndPreviewOutput
> = {
  name: "quote_and_preview_letter",
  description:
    "WHEN TO USE: Call this tool to CREATE A PREVIEW of a physical letter. This does NOT send " +
    "anything - it only generates a draft for the user to review. Proactively offer previews when " +
    "the context suggests the user might want to send a real letter (e.g., thank you notes, " +
    "condolences, formal correspondence, letters to officials, pen pals).\n\n" +
    "PREVIEW IS FREE: Generating a preview costs nothing and does not use credits. " +
    "Feel free to create previews to show users what their letter would look like.\n\n" +
    "What it does: Generates a printable preview, validates addresses, and creates a DRAFT. " +
    "The user reviews the preview before deciding to send via send_letter.\n\n" +
    "Sender Address:\n" +
    "- If not provided, your saved return address is used automatically.\n" +
    "- Use set_return_address to save one for all future letters.\n\n" +
    "Image Input (optional, provide ONE):\n" +
    "1. Attach an image directly to your message (recommended)\n" +
    "2. Use imageUrl parameter with a publicly accessible URL\n" +
    "- Supported: PNG, JPEG, WebP (max 5MB), auto-resized for print quality\n" +
    "- By default, images appear AFTER the signature (like enclosing a photo)\n" +
    "- Use imagePlacement='header' to put the image at the TOP (like letterhead)\n\n" +
    "Character Limits by Layout:\n" +
    "- text_only (no images): ~1800 characters\n" +
    "- header_image: ~1500 characters\n" +
    "- inline_image: ~1200 characters\n\n" +
    "Draft Workflow:\n" +
    "1. Creates a DRAFT with a unique draftId (required for send_letter).\n" +
    "2. Drafts expire after 24 hours.\n" +
    "3. Idempotent - retrying won't charge twice.\n\n" +
    "Restrictions: US addresses only, one layout per letter, max 1 page.",
  readOnly: true,
  inputSchema: quoteAndPreviewInputSchema,
  outputSchema: quoteAndPreviewOutputSchema,
  meta: {
    "openai/outputTemplate": OUTPUT_TEMPLATE,
    "openai/widgetAccessible": true,
    "openai/fileParams": ["image"],  // Enables image upload via OpenAI Apps SDK (like postcard)
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
  // postalCode is optional - PostGrid can suggest it via address validation
  "country"
];

interface ResolvedInput {
  sender: Address;
  recipient: Address;
  bodyText: string;
  signOff: string;
}

function collectMissingAddressFields(input: ResolvedInput): string[] {
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
