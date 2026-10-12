/**
 * One letter-preview pipeline (#689)
 *
 * The three letter-preview tools (quote_and_preview_letter, …_with_header_image and
 * …_with_image) run the same sequence; only the image differs. Each tool names its layout
 * and its log events, and this runs the steps once, in this order:
 *
 *   1. schedule            2. mail service
 *  2a. (image layouts) the picture's source, refused when there is none
 *   3. sender              4. addresses          5. early gift choice, and the renderer read once
 *   6. stationery          7. signature          8. character cap
 *   9. printable check
 *  9a. (image layouts) the picture downloaded and processed
 *  10. layout             11. gift layout       12. provider address check
 *  13. draft and output
 *
 * The order is the contract: the date and the mail service are refused before anything is
 * looked up (#535, #625); the picture is only looked up before the checks on the addresses and the
 * text, and downloaded after them, so a refusal costs no image work (#526); the gift is known
 * before what prints is checked when it can be (#534), and otherwise settled by the pages
 * (#586); and the provider is asked last.
 */

import { Address, ToolContext } from "../contracts/types.js";
import type { ImageFileParam, LetterLayoutType } from "../services/types.js";
import { printRenderer } from "../config/printRenderer.js";
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
  createLetterDraftAndBuildOutput,
  type LetterQuoteOutput
} from "./letterHelpers.js";
import { previewSchedule } from "./arriveByInput.js";
import { chooseStationery } from "./stationeryInput.js";
import { chooseSignature } from "./signatureInput.js";
import { chooseMailService } from "./mailServiceInput.js";
import { downloadAndProcessLetterImageWithPreview, ImageProcessingError } from "../services/imageService.js";
import { MOBILE_IMAGE_ERRORS } from "../utils/mobileDetection.js";
import { resolvePreviewImageSource } from "../services/previewImageSource.js";

/** What any letter-preview tool takes; the image fields only where the tool serves them. */
export interface LetterPreviewInput {
  sender?: Address;
  recipient: Address;
  bodyText: string;
  signOff: string;
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
  // Image from OpenAI fileParams - injected by MCP framework
  // Union type handles ChatGPT mobile sending '' when no file attached
  image?: ImageFileParam | string;
  // Alternative: direct image URL
  imageUrl?: string;
}

/** A layout that prints a picture, and how its log lines name it. */
export interface LetterImageStep {
  layoutType: "header_image" | "inline_image";
  /** How the picture is processed: as letterhead or as an enclosure. */
  processAs: "header" | "inline";
  /** The picture in log lines and the processing refusal: "header image" or "image". */
  noun: string;
}

export interface LetterPreviewPlan {
  /** The prefix of every log event the tool writes: quote.letter.text_only, quote.letter.image, quote.letter.header_image. */
  events: string;
  /** The tool's start log line. */
  startMessage: string;
  /** The picture the layout prints; none for a text-only letter. */
  image?: LetterImageStep;
}

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The picture's source: a file ChatGPT resolved, then imageUrl, then a recent upload
 * through the upload card (see previewImageSource.ts). REQUIRED: none is refused.
 */
async function imageSourceFor(
  input: LetterPreviewInput,
  step: LetterImageStep,
  events: string,
  context: ToolContext
): Promise<string> {
  const resolved = await resolvePreviewImageSource(input, context.user.userId, step.layoutType);

  if (resolved.kind === "file") {
    context.logger.info(
      { correlationId: context.correlationId, event: `${events}.from_fileParams` },
      `Using ${step.noun} from OpenAI fileParams`
    );
    return resolved.url;
  }
  if (resolved.kind === "url") {
    context.logger.info(
      { correlationId: context.correlationId, event: `${events}.from_url`, imageSource: "provided" },
      `Using ${step.noun} from URL`
    );
    return resolved.url;
  }
  if (resolved.kind === "recent_upload") {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: `${events}.from_recent_upload`,
        imageAgeMs: resolved.ageMs,
        unresolvedReference: resolved.unresolvedReference
      },
      `Using recent uploaded image fallback for letter with ${step.noun}`
    );
    return resolved.url;
  }

  context.logger.warn(
    {
      correlationId: context.correlationId,
      event: `${events}.no_image`,
      isMobile: context.isMobile,
      unresolvedReference: resolved.unresolvedReference,
      skippedUploadAgeMs: resolved.skippedUploadAgeMs
    },
    `No ${step.noun} provided`
  );
  // US-POSTCARD-04: Mobile Image Graceful Degradation
  // Provide mobile-specific error message with guidance to use text-only letter
  throw new Error(
    context.isMobile
      ? MOBILE_IMAGE_ERRORS.letterWithImage
      : MOBILE_IMAGE_ERRORS.desktop
  );
}

/** The picture processed: the full-quality version that prints and a small preview for the card. */
async function processImage(
  source: string,
  step: LetterImageStep,
  events: string,
  context: ToolContext
): Promise<{ data: string; preview: string }> {
  try {
    context.logger.info(
      { correlationId: context.correlationId, event: `${events}.processing` },
      `Processing ${step.noun}`
    );
    const processed = await downloadAndProcessLetterImageWithPreview(
      { url: source },
      step.processAs,
      { actorId: context.user.userId }
    );
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: `${events}.processed`,
        originalSize: `${processed.originalWidth}x${processed.originalHeight}`,
        processedSize: `${processed.processedWidth}x${processed.processedHeight}`,
        previewSize: `${Math.round(processed.previewDataUri.length / 1024)}KB`
      },
      `${capitalised(step.noun)} processed successfully`
    );
    return { data: processed.base64DataUri, preview: processed.previewDataUri };
  } catch (error) {
    const message = error instanceof ImageProcessingError
      ? error.userMessage
      : `Could not process ${step.noun}. Please try a different image.`;
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: `${events}.failed`,
        errorCode: error instanceof ImageProcessingError ? error.code : "UNKNOWN",
        errorClass: "validation_error"
      },
      `${capitalised(step.noun)} processing failed`
    );
    throw new Error(message);
  }
}

/** Runs the letter-preview sequence once, for the layout the plan names. */
export async function previewLetter(
  input: LetterPreviewInput,
  context: ToolContext,
  plan: LetterPreviewPlan
): Promise<LetterQuoteOutput> {
  const { events, image: step } = plan;
  const layoutType: LetterLayoutType = step?.layoutType ?? "text_only";

  context.logger.info(
    { correlationId: context.correlationId, event: `${events}.start` },
    plan.startMessage
  );

  // 1. Arrive-by (#535): checked first, so a date that cannot be met is refused
  // before any picture is fetched or address validated.
  const schedule = previewSchedule(input.arriveBy, context);

  // 2. Certified mail (#625): asked for, and offered, checked here for the same reason, and
  // known before the gift is decided: no gift letter pays for it.
  const mailService = chooseMailService(input.mailService, context);

  // 2a. The picture's source, REQUIRED for an image layout. Only found here: it is downloaded
  // and decoded after the checks on the addresses and the text, so a refusal costs no
  // image work (#526).
  const imageSource = step ? await imageSourceFor(input, step, events, context) : undefined;

  // 3. Sender (use saved return address if not provided)
  const { sender, usedSavedReturnAddress, savedReturnAddressNote } = await prepareSender(input, context);

  // 4. Addresses
  validateAddresses(sender, input.recipient, context);

  // 5. Decided first: a gift send's card page draws the sender's name, which
  // must print and fit (#534). Not while room to write is offered (#586): the
  // gift then waits for the pages (giftForLayout). The renderer is read once,
  // so every check agrees.
  const early = await earlyGiftChoice(input, context, mailService);
  const renderer = printRenderer();

  // 6. Stationery (#563): the theme, asked for or remembered, and what it
  // prints, checked before the printable check reads its initials and
  // headline and the layout draws it.
  const stationery = await chooseStationery(input, sender.name, context, renderer);

  // 7. The person's signature (#608): asked for or remembered, read once, and
  // laid out with the letter, so the fit counts its three lines.
  const signature = await chooseSignature(input.signature, context);

  // 8. Character limit (reduced for an image layout)
  validateCharacterLimitForLayout(input.bodyText, input.signOff, layoutType, context, renderer);

  // 9. Refuse characters the print shows as boxes (#526)
  validatePrintableLetter(
    { sender, recipient: input.recipient, bodyText: input.bodyText, signOff: input.signOff, senderIsSaved: usedSavedReturnAddress },
    context,
    renderer,
    early?.card,
    stationery
  );

  // 9a. The picture, processed now the checks on the addresses and the text have passed.
  const picture = step && imageSource !== undefined ? await processImage(imageSource, step, events, context) : undefined;
  const imageData = picture?.data;

  // 10. Our renderer measures the page, with the picture that prints (#534)
  const printLayout = layoutLetterForPreview(
    { bodyText: input.bodyText, signOff: input.signOff, layoutType, imageData, stationery, signatureImage: signature.image },
    context,
    renderer
  );

  // 11. The gift, by the pages the letter takes, when it was not decided first (#586).
  const gift = await giftForLayout(
    early,
    { sender, recipient: input.recipient, bodyText: input.bodyText, signOff: input.signOff, senderIsSaved: usedSavedReturnAddress, sendAsGift: input.sendAsGift },
    printLayout,
    context,
    renderer,
    // A signed letter its band pushes past one page fits without it (#608).
    () => signature.image !== undefined && !letterRunsPast({ bodyText: input.bodyText, signOff: input.signOff, layoutType, imageData, stationery }, 1)
  );

  // 12. Validate with PostGrid provider
  const { senderValidation, recipientValidation, addressWarnings } = await validateAddressesWithProvider(
    sender,
    input.recipient,
    context
  );

  // 13. Create draft and build output. The card shows the small preview; the draft keeps
  // the picture that prints and where it came from.
  const pictureFields = picture === undefined
    ? {}
    : layoutType === "header_image"
      ? { headerImageData: picture.data, headerImagePreview: picture.preview, headerImageUrl: imageSource }
      : { inlineImageData: picture.data, inlineImagePreview: picture.preview, inlineImageUrl: imageSource };

  return createLetterDraftAndBuildOutput({
    sender,
    recipient: input.recipient,
    bodyText: input.bodyText,
    signOff: input.signOff,
    layoutType,
    ...pictureFields,
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
