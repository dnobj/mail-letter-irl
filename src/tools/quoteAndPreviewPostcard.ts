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
  previewSendEligibility,
  reasonCannotSend,
  validateAddressesWithProvider,
  validatePrintableCharacters,
  outputValidationStatus,
  withDisplayImage
} from "./letterHelpers.js";
import { printRenderer } from "../config/printRenderer.js";
import { offeredPostcardSizes } from "../config/postcardSizes.js";
import { frontPrintedText, previewPostcardFront } from "./postcardFrontInput.js";
import { isPackPayable, type MailOption } from "../config/products.js";
import {
  drawsGrapheme,
  GiftStripOverflow,
  layoutPostcard,
  layoutPostcardBack,
  POSTCARD_GEOMETRY,
  readImageDataUri,
  renderPreviewSvg,
  POSTCARD_FRONT_RENDERER_VERSION,
  RENDERER_VERSION,
  type GiftStripCopy
} from "../render/index.js";
import {
  renderPostcardPreviewDocument,
  stampedAddressLines,
  stampedPostcardReturnLines
} from "../services/previewService.js";
import { callingApp } from "../auth/clientProfiles.js";
import { giftCardSummary, longestSendCard, resolveGiftSendChoice } from "./giftSendChoice.js";
import {
  previewArrivalWindow,
  previewSchedule,
  scheduleSentence,
  type ArrivalWindow,
  type PreviewScheduleOutput
} from "./arriveByInput.js";
import { previewSendStep } from "./previewSendStep.js";
import {
  giftPostcardBlockSvg,
  giftPostcardStripCopy,
  type GiftCardContent,
  type GiftCardState
} from "../services/giftCardRenderer.js";
import { widgetTemplateUri } from "../mcp/widgetUris.js";
import {
  quoteAndPreviewPostcardInputSchema,
  quoteAndPreviewPostcardOutputSchema
} from "../schemas.js";
import type { AddressValidationInput, AddressValidationResult } from "../services/providers/types.js";
import { createPostcardDraft } from "../services/draftService.js";
import { getReturnAddress } from "../services/returnAddressService.js";
import { downloadAndProcessPostcardImageWithPreview, ImageProcessingError, type ImageInput } from "../services/imageService.js";
import type { PostcardSize, ImageFileParam } from "../services/types.js";
import type { SendEligibility } from "../services/commerceService.js";
import { MOBILE_IMAGE_ERRORS } from "../utils/mobileDetection.js";
import { resolvePreviewImageSource } from "../services/previewImageSource.js";
import { isUnresolvedImageReference, usableImageFile } from "../utils/imageFileParam.js";
import {
  DELIVERY_CLASS,
  DELIVERY_DISCLAIMER,
  DELIVERY_ESTIMATE
} from "../content/delivery.js";

// ============================================================================
// Types
// ============================================================================

interface QuoteAndPreviewPostcardInput {
  sender?: Address;  // Optional - will use saved return address if not provided
  recipient: Address;
  message: string;
  size?: PostcardSize;
  /** The front's layout, caption and place while layouts are offered (#594); checked by previewPostcardFront. */
  layout?: unknown;
  caption?: unknown;
  place?: unknown;
  // Image from OpenAI fileParams - injected by MCP framework
  // Union type handles ChatGPT mobile sending '' when no file attached
  image?: ImageFileParam | string;
  // Alternative: direct image URL (for when fileParams isn't available)
  imageUrl?: string;
  /** Send as the account's gift letter (docs/gift-letters.md). */
  sendAsGift?: boolean;
  /** The date it should arrive by, YYYY-MM-DD (#535); served only while the flag is on. */
  arriveBy?: string;
}

export interface QuoteAndPreviewPostcardOutput {
  previewFrontHtml: string;
  previewBackHtml: string;
  /**
   * The postcard as it prints, front and back, when our renderer drew it
   * (#534): the card shows these pages instead of its own front and back.
   */
  previewHtml?: string;
  lettersRequired: number;  // Number of letters from balance (always 1 for postcard)
  canSendNow: boolean;
  reasonCannotSend?: string;
  sendEligibility: SendEligibility;
  deliveryClass?: string;
  estimatedDeliveryDays?: number;
  deliveryEstimate?: string;
  deliveryDisclaimer?: string;
  // Draft for idempotent send
  draftId: string;
  draftExpiresAt: string;  // ISO timestamp
  // Message text (for display in widget)
  message: string;
  // Recipient info (for display in widget)
  recipientName: string;
  recipientAddressLine1: string;
  recipientAddressLine2?: string;
  recipientCity: string;
  recipientState: string;
  recipientPostalCode: string;
  // Sender info (for return address in widget)
  senderName: string;
  senderAddressLine1: string;
  senderAddressLine2?: string;
  senderCity: string;
  senderState: string;
  senderPostalCode: string;
  // Saved return address used (when sender not provided)
  usedSavedReturnAddress?: boolean;
  savedReturnAddressNote?: string;
  addressWarnings?: string[];
  // Address validation results
  senderAddressValidation?: {
    status: 'verified' | 'corrected' | 'failed' | 'unverified';
    originalAddress: Address;
    verifiedAddress?: Address;
    errors?: string[];
    suggestions?: string;
  };
  recipientAddressValidation?: {
    status: 'verified' | 'corrected' | 'failed' | 'unverified';
    originalAddress: Address;
    verifiedAddress?: Address;
    errors?: string[];
    suggestions?: string;
  };
  /** Present on a gift send: the card printed across the foot of the message half. */
  giftCard?: { state: GiftCardState; description: string };
  /** Unsent gift letters on the account, when there are any. */
  giftLettersAvailable?: number;
  /** The arrival date asked for (#535), when there was one. */
  schedule?: PreviewScheduleOutput;
  /** The arrival dates on offer (#535), while the feature is on: a card's date picker. */
  arrivalWindow?: ArrivalWindow;
}

// ============================================================================
// Constants
// ============================================================================

const OUTPUT_TEMPLATE = widgetTemplateUri("PostcardPreviewCard");
const MAX_MESSAGE_LENGTH = 500;
/**
 * On the legacy print a gift postcard gives the foot of the message half,
 * about 1.3in of 5.2in, to the card, so its message is shorter. Checked only
 * once the preview knows it is a gift send. Our renderer counts lines instead:
 * 11 above the card (POSTCARD_STRIP).
 */
const MAX_GIFT_MESSAGE_LENGTH = 350;
/**
 * On our renderer the back is measured, line by line, so the character limit
 * only bounds the work (#534 Phase 4), as RENDERED_LETTER_CHARACTER_CAP does
 * for letters, well above what each back holds: sixteen full lines are about
 * 700 characters on a 6x9 and 1,000 on an 11x6, eleven about 370 on a 4x6
 * (#594).
 */
export const RENDERED_POSTCARD_CHARACTER_CAPS: Readonly<Record<PostcardSize, number>> = {
  '6x9': 1_000,
  '6x4': 1_000,
  '6x11': 2_000
};
/** The 6x9's, as it was before the other sizes. */
export const RENDERED_POSTCARD_CHARACTER_CAP = RENDERED_POSTCARD_CHARACTER_CAPS['6x9'];
/** Each size as a person names it, where ours put the short side first (#594). */
const SIZE_NAMES: Readonly<Record<PostcardSize, string>> = { '6x9': 'A 6x9', '6x4': 'A 4x6', '6x11': 'An 11x6' };
const POSTCARD_CREDITS_COST = 2; // 2 internal credits = 1 letter/postcard

// ============================================================================
// Handler
// ============================================================================

async function handler(
  input: QuoteAndPreviewPostcardInput,
  context: ToolContext
): Promise<QuoteAndPreviewPostcardOutput> {
  const size: PostcardSize = input.size ?? '6x9';
  // The 4x6 and 11x6 only while offered (#594): a size served by an older
  // schema is refused, never printed as a 6x9.
  if (!offeredPostcardSizes().includes(size)) {
    throw Object.assign(
      new Error(
        `${Object.hasOwn(SIZE_NAMES, size) ? `${SIZE_NAMES[size]} postcard` : 'This postcard size'} is not offered here. ` +
        `Leave size out for a 6x9 postcard.`
      ),
      { diagnosticClass: "validation_error" }
    );
  }

  // Arrive-by (#535): checked first, so a date that cannot be met is refused
  // before the picture is fetched or an address validated.
  const schedule = previewSchedule(input.arriveBy, context);

  // Track if we used the saved return address
  let usedSavedReturnAddress = false;
  let savedReturnAddressNote: string | undefined;

  // Determine image source - either fileParams or direct URL
  let imageInput: ImageInput | null = null;
  let imageSourceUrl: string | undefined;

  // Debug flag - enabled in dev environment
  const isDebug = process.env.NODE_ENV === 'development' ||
                  process.env.DEBUG_IMAGE === 'true';

  // DEBUG: Log full details of image parameter for mobile debugging (only in dev)
  if (isDebug) {
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
        mimeType: imageObj?.mime_type as string | undefined,
        // Validation results (#414: the marker for an unreadable reference is
        // an object with an empty download address)
        isUsableFile: usableImageFile(input.image) !== null,
        unresolvedReference: isUnresolvedImageReference(input.image)
      },
      "Debug: Full image parameter details for mobile investigation"
    );
  }

  // A file ChatGPT resolved, then imageUrl, then a recent upload through the
  // upload card (see previewImageSource.ts).
  const resolved = await resolvePreviewImageSource(input, context.user.userId, "postcard");
  if (resolved.kind === "file") {
    // OpenAI fileParams (preferred)
    imageInput = resolved.file;
    imageSourceUrl = resolved.url;
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.postcard.image_from_fileParams"
      },
      "Using image from OpenAI fileParams"
    );
  } else if (resolved.kind === "url") {
    // Direct URL (fallback for code interpreter images)
    imageInput = { url: resolved.url };
    imageSourceUrl = resolved.url;
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.postcard.image_from_url",
        imageSource: "provided"
      },
      "Using image from direct URL"
    );
  } else if (resolved.kind === "recent_upload") {
    imageInput = { url: resolved.url };
    imageSourceUrl = resolved.url;
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.postcard.image_from_recent_upload",
        imageAgeMs: resolved.ageMs,
        unresolvedReference: resolved.unresolvedReference
      },
      "Using recent uploaded image fallback for postcard"
    );
  }

  if (!imageInput) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.postcard.no_image",
        isMobile: context.isMobile,
        unresolvedReference: resolved.kind === "none" && resolved.unresolvedReference,
        skippedUploadAgeMs: resolved.kind === "none" ? resolved.skippedUploadAgeMs : undefined
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

  // Whether this is a gift send decides the message limit, so it is resolved
  // before the limit is checked (docs/gift-letters.md).
  const requiredCredits = POSTCARD_CREDITS_COST;
  const available = context.user.creditsRemaining;
  // The mail option this is: its price (#578), and whether a pack or a gift
  // letter pays for it (#579).
  const option: MailOption = { mailType: "postcard", postcardSize: size };
  const packPays = isPackPayable(option);
  const gift = await resolveGiftSendChoice({
    userId: context.user.userId,
    requested: input.sendAsGift,
    balanceCanPay: available >= requiredCredits,
    giftCanPay: packPays
  });
  // Our renderer draws the postcard at its size, a 6x9 gift send's card
  // included (#534); the 4x6 and 11x6 are offered only on it (#594), so the
  // legacy print and its limits see 6x9s alone. Read once, so every check
  // agrees.
  const renderer = printRenderer();
  const messageLimit = renderer === 'pdf'
    ? RENDERED_POSTCARD_CHARACTER_CAPS[size]
    : gift.isGift ? MAX_GIFT_MESSAGE_LENGTH : MAX_MESSAGE_LENGTH;
  // The front's layout (#594), checked before the picture is fetched: undefined for full bleed.
  const front = previewPostcardFront(input, size, context, renderer);

  // Validate message length
  if (input.message.length > messageLimit) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: renderer === 'pdf' ? "quote.postcard.exceeds_character_cap" : "quote.postcard.message_too_long",
        messageLength: input.message.length,
        maxLength: messageLimit
      },
      "Postcard message too long"
    );
    // An expected refusal: logged as validation_error, not unknown_error.
    throw Object.assign(
      new Error(
        `Postcard message is too long (${input.message.length}/${messageLimit} characters). ` +
        (gift.isGift
          ? `A gift postcard leaves room for the gift card, so please shorten your message.`
          : `Please shorten your message to fit on the postcard back.`)
      ),
      { diagnosticClass: "validation_error" }
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
          savedAddressAvailable: true
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
      // Constant: a log message is never redacted, and a country is whatever
      // the caller sent, which may be part of an address.
      "Address outside the United States refused"
    );
    throw new Error(message);
  }

  // Refuse characters the print shows as boxes (#526), before the picture is fetched
  // On our renderer the message prints in its font (#534), and so does the
  // sender's name on a gift send's card, whichever card the send prints; the
  // addresses are stamped in Open Sans either way.
  const prints = renderer === 'pdf' ? drawsGrapheme : undefined;
  validatePrintableCharacters(
    "postcard",
    [
      { field: "message", where: "in the message", text: input.message, prints },
      ...(prints && gift.card
        ? [{ field: "giftCardName", where: "in the sender's name, which the gift card prints", text: sender.name, prints }]
        : []),
      // A front's line, in the face and case it prints in (#594).
      ...frontPrintedText(front)
    ],
    { sender, recipient: input.recipient, senderIsSaved: usedSavedReturnAddress },
    context
  );

  // On our renderer the back is measured as it prints, before the picture
  // is fetched: 16 lines on a 6x9 or an 11x6 and 11 on a 4x6 (#594), or 11
  // above a 6x9 gift send's card.
  const strip = renderer === 'pdf' && gift.card ? giftStrip(gift.card, sender.name, context) : undefined;
  if (renderer === 'pdf') {
    const { page, overflowLines } = layoutPostcardBack(input.message, strip, size);
    if (overflowLines > 0) {
      context.logger.warn(
        {
          correlationId: context.correlationId,
          event: "quote.postcard.exceeds_back",
          linesUsed: page.linesUsed,
          linesAvailable: page.linesAvailable
        },
        "Postcard message runs past its room on the back"
      );
      throw Object.assign(
        new Error(
          `Postcard message is ${overflowLines} line${overflowLines === 1 ? "" : "s"} too long for the back: ` +
          `it takes ${page.linesUsed} lines and the back holds ${page.linesAvailable}${strip ? " above the gift card" : ""}. ` +
          `Please shorten your message to fit on the postcard back.`
        ),
        { diagnosticClass: "validation_error" }
      );
    }
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

    processedImage = await downloadAndProcessPostcardImageWithPreview(imageInput!, size, {
      actorId: context.user.userId
    });

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
          errorClass: "provider_error"
        },
        "Image processing failed"
      );
      throw new Error(error.userMessage);
    }
    throw error;
  }

  // Validate addresses via the shared policy-aware helper (issue #200):
  // secondary-unit and verification-outage failures proceed with a warning,
  // genuine address failures throw before any draft exists.
  const { senderValidation, recipientValidation, addressWarnings } =
    await validateAddressesWithProvider(sender, input.recipient, context, "quote.postcard");

  // Check credits: only where a pack pays (#579).
  const canSendNow = gift.isGift || (packPays && available >= requiredCredits);
  const lettersRequired = 1; // User-facing: 1 letter = 1 postcard

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.postcard.computed",
      availableCredits: available,
      requiredCredits,
      lettersRequired,
      canSendNow,
      giftSend: gift.isGift
    },
    "Computed preview requirements"
  );

  // Generate preview HTML using smaller preview image (~10-20KB vs ~200-400KB)
  // Full-quality image is stored in draft for PostGrid printing
  const previewFrontHtml = generatePreviewFrontHtml(processedImage.previewDataUri, size);
  const previewBackHtml = generatePreviewBackHtml(input.message, sender, gift.card);
  // On our renderer the draft keeps the postcard as it prints (#534 Phase 4):
  // front and back, laid out with the full image's box and drawn with the
  // small copy, the back with the addresses where PostGrid stamps them. The
  // website's confirm page and the card show it.
  const renderedHtml = renderer === 'pdf'
    ? renderPostcardPreviewDocument(renderPreviewSvg(
        withDisplayImage(
          layoutPostcard({ message: input.message, image: readImageDataUri(processedImage.base64DataUri), strip, size, ...front }),
          processedImage.previewDataUri
        ),
        {
          addresses: { from: stampedPostcardReturnLines(sender), to: stampedAddressLines(input.recipient) },
          stamp: { page: 1, geometry: POSTCARD_GEOMETRY[size].stamp }
        }
      ))
    : undefined;

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
    previewHtml: renderedHtml ?? previewFrontHtml,
    senderValidation: senderValidation ? { status: senderValidation.status } : undefined,
    recipientValidation: recipientValidation ? { status: recipientValidation.status } : undefined,
    isGiftSend: gift.isGift,
    // A front other than full bleed is drawn as pdf-3 (#594, migration 048).
    rendererVersion: renderedHtml ? (front ? POSTCARD_FRONT_RENDERER_VERSION : RENDERER_VERSION) : undefined,
    postcardFront: front ?? null,
    // Held until its mail date (#535).
    schedule: schedule?.draft,
  });

  // After the draft, whose page an app with no checkout pays on (#579).
  const sendEligibility = previewSendEligibility(
    available,
    requiredCredits,
    option,
    gift.isGift,
    callingApp(context),
    draftResult.draftId
  );

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.postcard.draft_created",
      expiresAt: draftResult.expiresAt.toISOString()
    },
    "Draft created for idempotent send"
  );

  // Build response
  const output: QuoteAndPreviewPostcardOutput = {
    previewFrontHtml,
    previewBackHtml,
    ...(renderedHtml ? { previewHtml: renderedHtml } : {}),
    lettersRequired,
    canSendNow,
    reasonCannotSend: canSendNow ? undefined : reasonCannotSend(option),
    sendEligibility,
    deliveryClass: DELIVERY_CLASS,
    // A held postcard's card says when it goes to the printer (#535).
    deliveryEstimate: schedule ? scheduleSentence(schedule.output, context.now()) : DELIVERY_ESTIMATE,
    deliveryDisclaimer: DELIVERY_DISCLAIMER,
    draftId: draftResult.draftId,
    draftExpiresAt: draftResult.expiresAt.toISOString(),
    message: input.message,
    recipientName: input.recipient.name,
    recipientAddressLine1: input.recipient.addressLine1,
    recipientAddressLine2: input.recipient.addressLine2,
    recipientCity: input.recipient.city,
    recipientState: input.recipient.state,
    recipientPostalCode: input.recipient.postalCode,
    senderName: sender.name,
    senderAddressLine1: sender.addressLine1,
    senderAddressLine2: sender.addressLine2,
    senderCity: sender.city,
    senderState: sender.state,
    senderPostalCode: sender.postalCode,
    usedSavedReturnAddress: usedSavedReturnAddress || undefined,
    savedReturnAddressNote: savedReturnAddressNote,
    addressWarnings,
    giftCard: gift.card ? giftCardSummary(gift.card.state, 'postcard') : undefined,
    giftLettersAvailable: gift.giftLettersAvailable > 0 ? gift.giftLettersAvailable : undefined,
    schedule: schedule?.output,
    arrivalWindow: previewArrivalWindow(context),
  };

  // Add address validation results if available
  if (senderValidation) {
    output.senderAddressValidation = {
      status: outputValidationStatus(senderValidation),
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
      status: outputValidationStatus(recipientValidation),
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
  title: "Preview a postcard",
  // The last sentence follows the send rule and the app (#516).
  description: (client) =>
    "Create a preview of a physical postcard draft with a front image and back message. Use this when the user wants to make, create, design, or preview a postcard through Letter IRL. This does not send mail. Requires a real U.S. recipient mailing address. If the user refers to an image already generated, shown, or attached earlier in this conversation, call this tool first to reuse that image. Otherwise prefer a direct file attachment for the image, pass imageUrl when a generated or hosted image is already available, and use upload_image only if no attachment or usable imageUrl made it through after a direct preview attempt. If sender is omitted, the saved return address is used automatically. " +
    previewSendStep("send_postcard", client),
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

/**
 * A gift send's card on our renderer (#534): a strip of fixed height at the
 * foot of the message, so its words must fit it. They are ours but for the
 * sender's name, which must fit this card and the longest card the send could
 * print instead (longestSendCard). A card that does not fit even without the
 * name is a seed campaign's long code, which only a letter has room for.
 */
function giftStrip(card: GiftCardContent, senderName: string, context: ToolContext): GiftStripCopy {
  const overflows = (name: string) => [card, longestSendCard(card)].some(variant => {
    try {
      layoutPostcardBack("", giftPostcardStripCopy(variant, name));
      return false;
    } catch (error) {
      if (error instanceof GiftStripOverflow) return true;
      throw error;
    }
  });
  if (overflows(senderName)) {
    const cause = overflows("") ? "card" : "name";
    context.logger.warn(
      { correlationId: context.correlationId, event: "quote.postcard.gift_card_overflow", cause },
      "The gift card runs past its strip"
    );
    throw Object.assign(
      new Error(cause === "name"
        ? "The sender's name is too long to print on the gift card. Shorten it, then preview again."
        : "This gift letter's card does not fit on a postcard. Send it as a letter, or set sendAsGift to false to pay from the balance."),
      { diagnosticClass: "validation_error" }
    );
  }
  return giftPostcardStripCopy(card, senderName);
}

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

const PREVIEW_FRONT_PIXELS: Record<PostcardSize, { width: number; height: number }> = {
  '6x4': { width: 540, height: 360 },
  '6x9': { width: 810, height: 540 },
  '6x11': { width: 990, height: 540 }
};

/**
 * Generate HTML preview for postcard front (image)
 */
function generatePreviewFrontHtml(imageBase64: string, size: PostcardSize): string {
  // Landscape, at 90 CSS pixels an inch, as PostGrid prints each size: our
  // '6x9' is PostGrid's 9x6.
  const dimensions = PREVIEW_FRONT_PIXELS[size];

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
export function generatePreviewBackHtml(message: string, sender: Address, giftCard?: GiftCardContent): string {
  // The gift strip comes from the renderer the print uses (giftCardRenderer).
  const giftBlock = giftCard ? giftPostcardBlockSvg(giftCard, sender.name) : { css: '', html: '' };
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
    }${giftBlock.css}
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
    <div class="message">${escapedMessage}</div>${giftBlock.html}
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
