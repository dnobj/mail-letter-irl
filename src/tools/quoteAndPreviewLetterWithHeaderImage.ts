/**
 * Quote and Preview Letter with Header Image
 *
 * Creates a preview of a physical letter WITH a header image at the top.
 * The image appears at the TOP of the letter, like custom letterhead or branding.
 *
 * REQUIRES: An image attachment or imageUrl parameter.
 */

import { Address, McpToolDefinition, ToolContext } from "../contracts/types.js";
import { widgetTemplateUri } from "../mcp/widgetUris.js";
import { printRenderer } from "../config/printRenderer.js";
import {
  quoteAndPreviewLetterWithHeaderImageInputSchema,
  quoteAndPreviewOutputSchema
} from "../schemas.js";
import {
  prepareSender,
  validateAddresses,
  validateAddressesWithProvider,
  validateCharacterLimitForLayout,
  validatePrintableLetter,
  earlyGiftChoice,
  giftForLayout,
  layoutLetterForPreview,
  letterRunsPast,
  roomToWriteSentence,
  createLetterDraftAndBuildOutput,
  type LetterQuoteOutput
} from "./letterHelpers.js";
import { previewSchedule } from "./arriveByInput.js";
import { chooseStationery } from "./stationeryInput.js";
import { chooseSignature } from "./signatureInput.js";
import { certifiedMailSentence, chooseMailService } from "./mailServiceInput.js";
import { previewSendStep } from "./previewSendStep.js";
import { downloadAndProcessLetterImageWithPreview, ImageProcessingError } from "../services/imageService.js";
import type { ImageFileParam } from "../services/types.js";
import { MOBILE_IMAGE_ERRORS } from "../utils/mobileDetection.js";
import { resolvePreviewImageSource } from "../services/previewImageSource.js";

// ============================================================================
// Types
// ============================================================================

interface QuoteAndPreviewLetterWithHeaderImageInput {
  sender?: Address;
  recipient: Address;
  bodyText: string;
  signOff: string;
  // Image from OpenAI fileParams - injected by MCP framework
  // Union type handles ChatGPT mobile sending '' when no file attached
  image?: ImageFileParam | string;
  // Alternative: direct image URL
  imageUrl?: string;
  /** Send as the account's gift letter (docs/gift-letters.md). */
  sendAsGift?: boolean;
  /** The date it should arrive by, YYYY-MM-DD (#535); served only while the flag is on. */
  arriveBy?: string;
  /** The page's theme, its initials and its headline (#563); served only while stationery is offered. */
  stationery?: string;
  monogram?: string;
  headline?: string;
  /** The person's saved signature on the letter, or not (#608); left out, their last choice. */
  signature?: boolean;
  /** USPS Certified Mail, with or without an electronic return receipt (#625); served only while it is offered. */
  mailService?: string;
}

// ============================================================================
// Constants
// ============================================================================

// Its own template name, so the card knows which tool to repeat when a call
// never reached the server (#411; see WIDGET_VARIANTS in registerTools.ts).
const OUTPUT_TEMPLATE = widgetTemplateUri("LetterHeaderImagePreviewCard");

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

  // Arrive-by (#535): checked first, so a date that cannot be met is refused
  // before any picture is fetched or address validated.
  const schedule = previewSchedule(input.arriveBy, context);

  // Certified mail (#625): asked for, and offered, checked here for the same reason, and
  // known before the gift is decided: no gift letter pays for it.
  const mailService = chooseMailService(input.mailService, context);

  // Get image source - REQUIRED. A file ChatGPT resolved, then imageUrl, then
  // a recent upload through the upload card (see previewImageSource.ts).
  const resolved = await resolvePreviewImageSource(input, context.user.userId, "header_image");
  const imageSource = resolved.kind === "none" ? undefined : resolved.url;

  // Log image source
  if (resolved.kind === "file") {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.letter.header_image.from_fileParams"
      },
      "Using header image from OpenAI fileParams"
    );
  } else if (resolved.kind === "url") {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.letter.header_image.from_url",
        imageSource: "provided"
      },
      "Using header image from URL"
    );
  } else if (resolved.kind === "recent_upload") {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.letter.header_image.from_recent_upload",
        imageAgeMs: resolved.ageMs,
        unresolvedReference: resolved.unresolvedReference
      },
      "Using recent uploaded image fallback for letter with header image"
    );
  }

  if (!imageSource) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.letter.header_image.no_image",
        isMobile: context.isMobile,
        unresolvedReference: resolved.kind === "none" && resolved.unresolvedReference,
        skippedUploadAgeMs: resolved.kind === "none" ? resolved.skippedUploadAgeMs : undefined
      },
      "No header image provided"
    );

    // US-POSTCARD-04: Mobile Image Graceful Degradation
    // Provide mobile-specific error message with guidance to use text-only letter
    if (context.isMobile) {
      throw new Error(MOBILE_IMAGE_ERRORS.letterWithImage);
    } else {
      throw new Error(MOBILE_IMAGE_ERRORS.desktop);
    }
  }

  // The checks on the addresses and the text come before the picture is
  // downloaded and decoded, so a refusal costs no image work (#526).

  // Prepare sender (use saved return address if not provided)
  const { sender, usedSavedReturnAddress, savedReturnAddressNote } = await prepareSender(input, context);

  // Validate addresses
  validateAddresses(sender, input.recipient, context);

  // Decided first: a gift send's card page draws the sender's name, which
  // must print and fit (#534). Not while room to write is offered (#586): the
  // gift then waits for the pages (giftForLayout). The renderer is read once,
  // so every check agrees.
  const early = await earlyGiftChoice(input, context, mailService);
  const renderer = printRenderer();

  // Stationery (#563): the theme, asked for or remembered, and what it
  // prints, checked before the printable check reads its initials and
  // headline and the layout draws it.
  const stationery = await chooseStationery(input, sender.name, context, renderer);

  // The person's signature (#608): asked for or remembered, read once, and
  // laid out with the letter, so the fit counts its three lines.
  const signature = await chooseSignature(input.signature, context);

  // Validate character limit (reduced for header image layout)
  validateCharacterLimitForLayout(input.bodyText, input.signOff, layoutType, context, renderer);

  // Refuse characters the print shows as boxes (#526)
  validatePrintableLetter(
    { sender, recipient: input.recipient, bodyText: input.bodyText, signOff: input.signOff, senderIsSaved: usedSavedReturnAddress },
    context,
    renderer,
    early?.card,
    stationery
  );

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
      'header',
      { actorId: context.user.userId }
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
        errorCode: error instanceof ImageProcessingError ? error.code : "UNKNOWN",
        errorClass: 'validation_error'
      },
      "Header image processing failed"
    );
    throw new Error(message);
  }

  // Our renderer measures the page with the image that prints (#534)
  const printLayout = layoutLetterForPreview(
    { bodyText: input.bodyText, signOff: input.signOff, layoutType, imageData: headerImageData, stationery, signatureImage: signature.image },
    context,
    renderer
  );

  // The gift, by the pages the letter takes, when it was not decided first (#586).
  const gift = await giftForLayout(
    early,
    { sender, recipient: input.recipient, bodyText: input.bodyText, signOff: input.signOff, senderIsSaved: usedSavedReturnAddress, sendAsGift: input.sendAsGift },
    printLayout,
    context,
    renderer,
    // A signed letter its band pushes past one page fits without it (#608).
    () => signature.image !== undefined && !letterRunsPast({ bodyText: input.bodyText, signOff: input.signOff, layoutType, imageData: headerImageData, stationery }, 1)
  );

  // Validate with PostGrid provider
  const { senderValidation, recipientValidation, addressWarnings } = await validateAddressesWithProvider(
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
    addressWarnings,
    gift,
    printLayout,
    schedule,
    stationery,
    signature,
    mailService,
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
  title: "Preview a letter with a header image",
  // The last sentence follows the send rule and the app (#516).
  description: (client) =>
    "Preview a physical letter draft with a header image at the top. This does not send mail. Requires a real U.S. recipient mailing address. If the user refers to an image already generated, shown, or attached earlier in this conversation, call this tool first to reuse that image. Otherwise prefer a direct file attachment or explicit imageUrl. Use upload_image only after an actual failed handoff or upload problem. " +
    roomToWriteSentence() +
    certifiedMailSentence() +
    previewSendStep("send_letter", client),
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
