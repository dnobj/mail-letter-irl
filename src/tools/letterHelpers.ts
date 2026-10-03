/**
 * Letter Tool Helpers
 *
 * Shared helper functions for the three letter quote/preview tools:
 * - quoteAndPreviewLetterTextOnly
 * - quoteAndPreviewLetterWithHeaderImage
 * - quoteAndPreviewLetterWithImage
 */

import { createHash } from "node:crypto";
import { Address, ToolContext, LetterLayoutType } from "../contracts/types.js";
import { getReturnAddress } from "../services/returnAddressService.js";
import { getLetterProvider } from "../services/providers/index.js";
import { assessValidation } from "../services/addressVerificationPolicy.js";
import type { AddressValidationInput, AddressValidationResult } from "../services/providers/types.js";
import {
  estimateRequiredCredits,
  letterPrintText,
  renderedPageImage,
  rendererDocumentPages,
  renderLayoutPreviewHtml,
  renderLetterPreviewDocument,
  signatureParagraph,
  stampedAddressLines,
  validateCharacterLimit,
} from "../services/previewService.js";
import { createDraft } from "../services/draftService.js";
import { findUnprintable, unprintableRefusal, type PrintedText, type ThemedFace } from "../services/printableText.js";
import { printRenderer } from "../config/printRenderer.js";
import { isRoomToWriteOffered, letterPageLimit } from "../config/roomToWrite.js";
import {
  bodyFace,
  drawsGrapheme,
  drawsGraphemeIn,
  GiftPageOverflow,
  layoutGiftPage,
  layoutLetter,
  HEADLINE_LINES,
  pageFit,
  readImageDataUri,
  StationeryOverflow,
  renderPreviewSvg,
  rendererVersionFor,
  SIGNATURE_LINES,
  type Layout,
  type PageFit,
  type Stationery
} from "../render/index.js";
import { getSendEligibility, type SendEligibility } from "../services/commerceService.js";
import { isPackPayable, mailServiceOf, type MailOption } from "../config/products.js";
import { callingApp, type ClientProfile } from "../auth/clientProfiles.js";
import { isSendConfirmationEnabled, letterPacksPageUrl, sendConfirmationUrl } from "../config/sendConfirmation.js";
import { GIFT_PAYS_ONE_PAGE, giftCardSummary, resolveGiftSendChoice, type GiftSendChoice } from "./giftSendChoice.js";
import type { CertifiedMailService, MailService } from "../services/types.js";
import { giftLetterPageCopy } from "../services/giftCardRenderer.js";
import { rememberedPrefix, type PreviewStationery } from "./stationeryInput.js";
import { rememberStationery } from "../services/stationeryDefaultService.js";
import { previewSignatureOutput, rememberPreviewSignature, type PreviewSignature, type PreviewSignatureOutput } from "./signatureInput.js";
import {
  previewArrivalWindow,
  scheduleSentence,
  type ArrivalWindow,
  type PreviewSchedule,
  type PreviewScheduleOutput
} from "./arriveByInput.js";
import type { GiftCardContent, GiftCardState } from "../services/giftCardRenderer.js";
import {
  DELIVERY_CLASS,
  DELIVERY_DISCLAIMER,
  DELIVERY_ESTIMATE
} from "../content/delivery.js";

// ============================================================================
// Types
// ============================================================================

export interface LetterInput {
  sender?: Address;
  recipient: Address;
  bodyText: string;
  signOff: string;
}

export interface PreparedSender {
  sender: Address;
  usedSavedReturnAddress: boolean;
  savedReturnAddressNote?: string;
}

export interface ValidationResults {
  senderValidation?: AddressValidationResult;
  recipientValidation?: AddressValidationResult;
  /**
   * One sentence per address that proceeded without full verification
   * (secondary-unit unconfirmed, or the verification service unavailable).
   * Surfaced to the model via the tool summary so the user hears it once.
   */
  addressWarnings?: string[];
}

export interface LetterQuoteOutput {
  previewHtml: string;
  lettersRequired: number;
  canSendNow: boolean;
  reasonCannotSend?: string;
  // Required by quoteAndPreviewOutputZ, which every letter preview tool is
  // registered with. Omitting it here made the field impossible to forget in
  // quoteAndPreview.ts and impossible to remember in this builder: the MCP
  // layer rejected the response with -32602 before a draftId ever reached the
  // caller, so no letter could be sent through any of the three tools that
  // build their output here. See tests/unit/tools/outputSchemaConformance.test.ts.
  sendEligibility: SendEligibility;
  deliveryClass: string;
  estimatedDeliveryDays?: number;
  deliveryEstimate?: string;
  deliveryDisclaimer?: string;
  draftId: string;
  draftExpiresAt: string;
  layoutType: LetterLayoutType;
  // Small preview images for ChatGPT widget (~3KB each)
  // Full images are stored in draft, not sent in response
  headerImagePreview?: string;
  inlineImagePreview?: string;
  usedSavedReturnAddress?: boolean;
  savedReturnAddressNote?: string;
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
  addressWarnings?: string[];
  /** Present on a gift send (docs/gift-letters.md): the card its extra page prints. */
  giftCard?: { state: GiftCardState; description: string };
  /** Unsent gift letters on the account, when there are any. */
  giftLettersAvailable?: number;
  /** The arrival date asked for (#535), when there was one. */
  schedule?: PreviewScheduleOutput;
  /** The arrival dates on offer (#535), while the feature is on: a card's date picker. */
  arrivalWindow?: ArrivalWindow;
  /** The stationery the page was drawn in (#563), while stationery is offered, and why: asked for, remembered, or Classic by default. */
  stationery?: PreviewStationery;
  /** Whether the letter prints the person's saved signature (#608), while signatures are offered, and why. */
  signature?: PreviewSignatureOutput;
  /** Present only when the letter is sent as certified mail (#625): which service. Paid with Pay & Send. */
  mailService?: CertifiedMailService;
  /** A letter of more than one page (#586): the pages it prints on, both sides of the paper, paid with Pay & Send. */
  pages?: number;
  /** While room to write is offered (#586): how full its pages are, for the card's fit line. Card-only (_meta). */
  pageFit?: PageFit;
  /** While room to write is offered (#586): the version of these words, which set_letter_words takes to say which words it replaces. */
  wordsVersion?: string;
}

// ============================================================================
// Address Helpers
// ============================================================================

const REQUIRED_ADDRESS_PROPS = [
  "name",
  "addressLine1",
  "city",
  "state",
  "country"
];

/**
 * Normalize country codes to US (2-letter ISO code)
 * Accept: US, USA, United States, us, usa, etc.
 */
export function normalizeCountryToUS(country?: string): string {
  if (!country) return 'US';
  const normalized = country.toUpperCase().trim();
  if (normalized === 'US' || normalized === 'USA' || normalized === 'UNITED STATES' || normalized === 'U.S.' || normalized === 'U.S.A.') {
    return 'US';
  }
  return normalized;
}

/**
 * Check for missing required address fields
 */
export function collectMissingAddressFields(sender: Address, recipient: Address): string[] {
  const missing: string[] = [];
  for (const [label, block] of [
    ["sender", sender],
    ["recipient", recipient]
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

/**
 * Validate that both addresses are in the US
 */
export function validateUSOnly(sender: Address, recipient: Address, context: ToolContext): void {
  const nonUSAddresses: string[] = [];
  if (sender.country !== 'US') {
    nonUSAddresses.push(`sender address is in ${sender.country}`);
  }
  if (recipient.country !== 'US') {
    nonUSAddresses.push(`recipient address is in ${recipient.country}`);
  }

  if (nonUSAddresses.length > 0) {
    const message = `Letter IRL currently only supports mailing within the United States. ${nonUSAddresses.join(', ')}.`;
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.letter.non_us_address",
        senderCountry: sender.country,
        recipientCountry: recipient.country
      },
      // Constant: a log message is never redacted, and a country is whatever
      // the caller sent, which may be part of an address.
      "Address outside the United States refused"
    );
    throw new Error(message);
  }
}

/**
 * Prepare sender address - use provided or saved return address
 */
export async function prepareSender(
  input: LetterInput,
  context: ToolContext
): Promise<PreparedSender> {
  let usedSavedReturnAddress = false;
  let savedReturnAddressNote: string | undefined;
  let sender: Address;

  if (!input.sender) {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.letter.sender_not_provided"
      },
      "Sender not provided, checking for saved return address"
    );

    const savedAddress = await getReturnAddress(context.user.userId);

    if (savedAddress) {
      sender = savedAddress;
      usedSavedReturnAddress = true;
      savedReturnAddressNote = `Using your saved return address: ${savedAddress.name}, ${savedAddress.addressLine1}, ${savedAddress.city}, ${savedAddress.state} ${savedAddress.postalCode}`;

      context.logger.info(
        {
          correlationId: context.correlationId,
          event: "quote.letter.using_saved_address",
          savedAddressAvailable: true
        },
        "Using saved return address for sender"
      );
    } else {
      context.logger.warn(
        {
          correlationId: context.correlationId,
          event: "quote.letter.no_sender_address"
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
  } else {
    sender = input.sender;
  }

  return { sender, usedSavedReturnAddress, savedReturnAddressNote };
}

/**
 * Validate addresses and normalize them
 */
export function validateAddresses(
  sender: Address,
  recipient: Address,
  context: ToolContext
): void {
  // Check for missing fields
  const missingFields = collectMissingAddressFields(sender, recipient);
  if (missingFields.length > 0) {
    const message = `Missing required address fields: ${missingFields.join(", ")}`;
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.letter.missing_fields",
        missingFields
      },
      message
    );
    throw new Error(
      `${message}. Please provide full sender and recipient addresses (name, street, city, state, postal code, country).`
    );
  }

  // Normalize country codes
  sender.country = normalizeCountryToUS(sender.country);
  recipient.country = normalizeCountryToUS(recipient.country);

  // Validate US-only
  validateUSOnly(sender, recipient, context);
}

/**
 * Validate addresses with PostGrid provider and apply corrections
 */
export async function validateAddressesWithProvider(
  sender: Address,
  recipient: Address,
  context: ToolContext,
  eventPrefix = "quote.letter"
): Promise<ValidationResults> {
  const provider = getLetterProvider();
  let senderValidation: AddressValidationResult | undefined;
  let recipientValidation: AddressValidationResult | undefined;
  const addressWarnings: string[] = [];

  if (provider.validateAddress) {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: `${eventPrefix}.validating_addresses`
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
      line1: recipient.addressLine1,
      line2: recipient.addressLine2,
      city: recipient.city,
      state: recipient.state,
      postalCode: recipient.postalCode,
      country: recipient.country
    };

    recipientValidation = await provider.validateAddress(recipientAddressInput);

    context.logger.info(
      {
        correlationId: context.correlationId,
        event: `${eventPrefix}.addresses_validated`,
        senderStatus: senderValidation.status,
        recipientStatus: recipientValidation.status
      },
      "Address validation complete"
    );

    // Policy pass (issue #200): secondary-unit and service failures proceed
    // with a warning; only genuine address failures block.
    const senderAssessment = assessValidation('Sender', senderValidation);
    const recipientAssessment = assessValidation('Recipient', recipientValidation);

    const blocked = [senderAssessment, recipientAssessment].filter(
      (a) => a.outcome === 'blocked'
    );
    if (blocked.length > 0) {
      context.logger.warn(
        {
          correlationId: context.correlationId,
          event: `${eventPrefix}.address_validation_failed`,
          senderStatus: senderValidation.status,
          recipientStatus: recipientValidation.status,
          senderOutcome: senderAssessment.outcome,
          recipientOutcome: recipientAssessment.outcome
        },
        "Address validation failed - invalid addresses"
      );

      throw new Error(
        `Address validation failed:\n\n${blocked
          .map((a) => a.blockText)
          .join('\n\n')}\n\nPlease correct the invalid address(es) and try again.`
      );
    }

    for (const assessment of [senderAssessment, recipientAssessment]) {
      if (assessment.outcome === 'unverified' && assessment.warning) {
        addressWarnings.push(assessment.warning);
      }
    }
    if (addressWarnings.length > 0) {
      context.logger.info(
        {
          correlationId: context.correlationId,
          event: `${eventPrefix}.address_unverified_proceeding`,
          senderOutcome: senderAssessment.outcome,
          recipientOutcome: recipientAssessment.outcome
        },
        "Proceeding with unverified address(es) per policy"
      );
    }

    // Auto-apply corrections
    if (senderValidation.status === 'corrected' && senderValidation.verifiedAddress) {
      context.logger.info(
        {
          correlationId: context.correlationId,
          event: `${eventPrefix}.sender_address_corrected`,
          correctionApplied: true
        },
        "Auto-applying corrected sender address"
      );

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
          event: `${eventPrefix}.recipient_address_corrected`,
          correctionApplied: true
        },
        "Auto-applying corrected recipient address"
      );

      recipient.addressLine1 = recipientValidation.verifiedAddress.line1;
      recipient.addressLine2 = recipientValidation.verifiedAddress.line2;
      recipient.city = recipientValidation.verifiedAddress.city;
      recipient.state = recipientValidation.verifiedAddress.state;
      recipient.postalCode = recipientValidation.verifiedAddress.postalCode;
      if (recipientValidation.verifiedAddress.country) {
        recipient.country = recipientValidation.verifiedAddress.country;
      }
    }
  }

  return {
    senderValidation,
    recipientValidation,
    addressWarnings: addressWarnings.length > 0 ? addressWarnings : undefined
  };
}

/**
 * The status a validation result should carry in tool output: a "failed"
 * result that policy allowed through reads as "unverified", never "failed".
 */
export function outputValidationStatus(
  validation: AddressValidationResult
): 'verified' | 'corrected' | 'failed' | 'unverified' {
  if (validation.status === 'failed') {
    return 'unverified';
  }
  return validation.status;
}

// ============================================================================
// Character Limit Validation
// ============================================================================

/**
 * The most characters a letter drawn by our renderer may hold on each page it
 * may take: one, or three while room to write is offered (#586). Far more than
 * a page holds even of fully pointed Hebrew; it only bounds the layout's work.
 * The pages themselves are measured by layoutLetterForPreview.
 */
export const RENDERED_LETTER_CHARACTER_CAP = 10_000;

/**
 * A version of a letter's words (#586): the same words give the same version.
 * A change of words names the version it replaces, so one made on the card
 * and one made in the chat, neither of which sees the other's call (#366),
 * cannot overwrite each other unseen (#593 review round 1).
 */
export function wordsVersionOf(bodyText: string, signOff: string | null | undefined): string {
  return createHash("sha256").update(JSON.stringify([bodyText, signOff ?? ""])).digest("hex").slice(0, 12);
}

/**
 * Refuses a letter too long for its page, before anything else is checked.
 * The legacy HTML's limits are estimates (previewService.ts). A letter drawn
 * by our own renderer is measured once its image is known, so here it only
 * meets a generous character cap.
 */
export function validateCharacterLimitForLayout(
  bodyText: string,
  signOff: string,
  layoutType: LetterLayoutType,
  context: ToolContext,
  renderer: 'html' | 'pdf' = printRenderer()
): void {
  if (renderer === 'pdf') {
    const totalChars = bodyText.length + signOff.length;
    // Per page (#590 review round 3): three pages of narrow glyphs or pointed
    // Hebrew run past one page's cap while they still fit.
    const limit = letterPageLimit();
    const cap = RENDERED_LETTER_CHARACTER_CAP * limit;
    if (totalChars <= cap) return;
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.letter.exceeds_character_cap",
        layoutType,
        totalChars,
        charLimit: cap
      },
      "Letter exceeds the character cap"
    );
    // Three pages while room to write is offered (#586), otherwise one.
    const pages = pageWords(limit);
    throw Object.assign(
      new Error(
        `Letter is far too long for ${pages}: ${totalChars}/${cap} characters. ` +
        `Please shorten your message to fit on ${pages}.`
      ),
      { diagnosticClass: "validation_error" }
    );
  }

  const charValidation = validateCharacterLimit(bodyText, signOff, layoutType);
  const isDebug = process.env.NODE_ENV === 'development' ||
                  process.env.RAILWAY_ENVIRONMENT === 'development' ||
                  process.env.DEBUG_CONTENT === 'true';

  if (!charValidation.isValid) {
    // Count newlines for debugging
    const newlineCount = (bodyText.match(/\n/g) || []).length;

    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.letter.exceeds_page_limit",
        layoutType,
        totalChars: charValidation.totalChars,
        charLimit: charValidation.charLimit,
        totalLines: charValidation.totalLines,
        lineLimit: charValidation.lineLimit,
        newlineCount,
        signOffLength: signOff.length,
        debugMode: isDebug
      },
      "Letter exceeds one-page limit"
    );
    throw new Error(
      `${charValidation.error} (${charValidation.totalChars}/${charValidation.limit} characters). ` +
      `Please shorten your message to fit on one page.`
    );
  }
}

/** A stationery slot, in words. */
const SLOT_WORDS: Record<StationeryOverflow["slot"], string> = {
  dateLine: "date line",
  monogram: "initials",
  headline: "headline"
};

/**
 * The letter previews' sentence on length, while room to write is offered
 * (#586); otherwise nothing, and the descriptions are as before.
 */
export function roomToWriteSentence(): string {
  return isRoomToWriteOffered()
    ? "A letter too long for one page runs on to a second or third page, printed on both sides and paid with Pay & Send; three pages is the longest. "
    : "";
}

/** A page limit in words: "one page", or "three pages" while room to write is offered (#586). */
function pageWords(limit: number): string {
  return limit === 1 ? "one page" : `${["", "one", "two", "three"][limit] ?? limit} pages`;
}

const LAYOUT_LABELS: Record<LetterLayoutType, string> = {
  text_only: "",
  header_image: " with a header image",
  inline_image: " with an enclosed image"
};

/** What a letter preview lays out: its printed text, its layout, its image, and its signature (#608). */
function previewContent(letter: { bodyText: string; signOff: string; layoutType: LetterLayoutType; imageData?: string; signatureImage?: string }) {
  return {
    text: letterPrintText(letter.bodyText, letter.signOff),
    layoutType: letter.layoutType,
    image: letter.layoutType !== "text_only" && letter.imageData ? readImageDataUri(letter.imageData) : undefined,
    signature: letter.signatureImage
      ? { image: readImageDataUri(letter.signatureImage), closingParagraph: signatureParagraph(letter.bodyText, letter.signOff) }
      : undefined
  };
}

/**
 * Whether a letter runs past `maxPages` (#586), for a refusal in a caller's
 * own words: a gift letter's, held to one page. Stationery that cannot print
 * is left to the layout to say.
 */
export function letterRunsPast(
  letter: { bodyText: string; signOff: string; layoutType: LetterLayoutType; imageData?: string; signatureImage?: string; stationery?: Stationery | PreviewStationery },
  maxPages: number
): boolean {
  try {
    return layoutLetter({ ...previewContent(letter), stationery: letter.stationery }, { maxPages }).overflowLines > 0;
  } catch {
    return false;
  }
}

/**
 * The letter laid out by our own renderer when previews use it (#534), or
 * undefined for the legacy HTML. `imageData` is the image that prints, so the
 * layout is the print's, drawn in its stationery (#563). A letter that runs
 * past its page is refused, saying by how many lines, before the addresses
 * are checked or a draft is made. Celebration's headline takes room from the
 * body, and Typewriter and Handwritten set it in their own typeface, so they
 * change what fits; a letter they push past the page is told so, with the
 * ways out.
 *
 * While room to write is offered (#586), the letter flows on to up to three
 * pages, and only a letter longer than that is refused: three pages is the
 * longest letter we print. The draft records the pages it took.
 */
export function layoutLetterForPreview(
  letter: { bodyText: string; signOff: string; layoutType: LetterLayoutType; imageData?: string; signatureImage?: string; stationery?: Stationery | PreviewStationery },
  context: ToolContext,
  renderer: 'html' | 'pdf' = printRenderer(),
  /** The most pages it may take: the previews' limit (#586), or a draft's own pages when it is drawn again. */
  maxPages: number = letterPageLimit()
): Layout | undefined {
  if (renderer !== 'pdf') return undefined;
  const { layoutType, stationery } = letter;
  const content = previewContent(letter);
  let layout: Layout;
  try {
    layout = layoutLetter({ ...content, stationery }, { maxPages });
  } catch (error) {
    // A slot that cannot print as its theme draws it. The checks before the
    // layout refuse each in their own words (previewStationery, and the
    // printable check for a headline the font cannot draw); this keeps a
    // caller that skips one from failing unclassified (#570 review round 2).
    if (!(error instanceof StationeryOverflow)) throw error;
    throw Object.assign(
      new Error(`The stationery's ${SLOT_WORDS[error.slot]} does not fit. Shorten it, or choose another stationery.`),
      { diagnosticClass: "validation_error" }
    );
  }
  if (layout.overflowLines === 0) return layout;

  const { linesUsed, linesAvailable } = layout.pages[layout.pages.length - 1];
  const headline = stationery?.theme === "celebration" && stationery.headline !== undefined;
  context.logger.warn(
    {
      correlationId: context.correlationId,
      event: "quote.letter.exceeds_page",
      layoutType,
      linesUsed,
      linesAvailable,
      maxPages,
      stationery: stationery?.theme ?? "classic"
    },
    "Letter runs past its page"
  );
  const over = layout.overflowLines;
  // A theme with its own typeface (#563) sets the text to its own measure.
  const own = ownFaceTheme(stationery);
  // The theme's way out, leaving the headline out or choosing Classic, is
  // offered only when the letter would fit that way (#575 review round 3).
  const themed = headline || own !== undefined;
  const fitsPlain = themed && layoutLetter(content, { maxPages }).overflowLines === 0;
  // One page says how full it is; the longest letter says only that it is (#586).
  const longest = maxPages > 1;
  const past = longest ? pageWords(maxPages) : "the page";
  throw Object.assign(
    new Error(
      // A theme the call did not name says where it came from.
      (themed ? rememberedPrefix(stationery) : "") +
      `Letter is ${over} line${over === 1 ? "" : "s"} too long for ${pageWords(maxPages)}${LAYOUT_LABELS[layoutType]}` +
      `${headline ? " on the celebration stationery with a headline" : own ? ` on the ${own} stationery` : ""}: ` +
      (longest
        ? `${pageWords(maxPages)} is the longest letter we print. `
        : `it takes ${linesUsed} lines and the page holds ${linesAvailable}. `) +
      (headline
        ? fitsPlain
          ? `The headline takes ${HEADLINE_LINES} lines: shorten the message, leave the headline out, or choose the classic stationery.`
          : `The headline takes ${HEADLINE_LINES} lines, and the letter runs past ${past} without it too: shorten the message.`
        : own
          ? fitsPlain
            ? `The ${own} stationery sets the text in its own typeface: shorten the message, or choose the classic stationery.`
            : `The ${own} stationery sets the text in its own typeface, and the letter runs past ${past} on the classic stationery too: shorten the message.`
          : `Please shorten your message to fit on ${pageWords(maxPages)}.`) +
      signatureWords(content, stationery, maxPages)
    ),
    { diagnosticClass: "validation_error" }
  );
}

/** A signed gift letter that fits one page without its signature (#608): the way out. */
export const SIGNATURE_GIFT_WORDS =
  `The signature takes ${SIGNATURE_LINES} lines, and without it the letter fits one page: preview it with signature: false to send it as a gift letter.`;

/**
 * What a signature has to do with a letter too long (#608): its band takes
 * SIGNATURE_LINES lines, and when the letter fits without it, says so.
 */
function signatureWords(
  content: ReturnType<typeof previewContent>,
  stationery: Stationery | PreviewStationery | undefined,
  maxPages: number
): string {
  if (!content.signature) return "";
  const fitsUnsigned = layoutLetter({ ...content, signature: undefined, stationery }, { maxPages }).overflowLines === 0;
  return fitsUnsigned
    ? ` The signature takes ${SIGNATURE_LINES} lines, and without it the letter fits: preview it with signature: false to leave it off.`
    : ` The signature takes ${SIGNATURE_LINES} lines.`;
}

/**
 * The layout with its image drawn from the preview's small copy. The box is
 * the printed image's, so the page is still the print's, but the preview
 * carries a few kilobytes instead of the full image.
 */
export function withDisplayImage(layout: Layout, previewDataUri: string | undefined): Layout {
  if (!previewDataUri) return layout;
  const image = readImageDataUri(previewDataUri);
  return {
    ...layout,
    pages: layout.pages.map(page => ({
      ...page,
      // The signature is not the letter's picture (#608).
      items: page.items.map(item => (item.kind === "image" && item.role !== "signature" ? { ...item, image } : item))
    }))
  };
}

/**
 * A letter draft's preview drawn again from a new layout, in place (#563,
 * #586): the letter's pages, as many as it takes now, with the small copy of
 * its picture from whichever stored page showed it; then the pages after the
 * letter's own, a gift letter's card, as they were. `pages` is how many of
 * the stored pages are the letter's. Null when the stored preview cannot be
 * drawn from: fewer pages than it counts, none, or no picture where the new
 * layout draws one.
 */
export function redrawLetterPreview(
  stored: { previewHtml: string | null; pages: number },
  layout: Layout,
  letter: { sender: Address; recipient: Address; bodyText: string; signOff: string },
  stationery: Stationery | undefined
): string | null {
  const storedPages = rendererDocumentPages(stored.previewHtml);
  const letterPages = storedPages.slice(0, stored.pages);
  const after = storedPages.slice(stored.pages);
  const image = letterPages.map(renderedPageImage).find(found => found !== undefined);
  const drawsImage = layout.pages.some(page => page.items.some(item => item.kind === "image" && item.role !== "signature"));
  const signed = layout.pages.some(page => page.items.some(item => item.kind === "image" && item.role === "signature"));
  if (letterPages.length < stored.pages || letterPages.length === 0 || (drawsImage && !image)) return null;
  const drawn = renderPreviewSvg(withDisplayImage(layout, image), {
    addresses: { from: stampedAddressLines(letter.sender), to: stampedAddressLines(letter.recipient) }
  });
  return renderLetterPreviewDocument(
    [...drawn, ...after],
    { bodyText: letter.bodyText, signOff: letter.signOff },
    rendererVersionFor(stationery, signed)
  );
}

// ============================================================================
// Printable Characters (#526)
// ============================================================================

/** The address as PostGrid prints it in the address block. */
function printedAddress(address: Address): string {
  return [address.name, address.addressLine1, address.addressLine2, address.city, address.state, address.postalCode]
    .filter(Boolean)
    .join("\n");
}

export interface PrintedAddresses {
  sender: Address;
  recipient: Address;
  /** The sender is the saved return address, which the request did not name. */
  senderIsSaved: boolean;
}

/**
 * Refuses mail whose text or addresses hold characters the print shows as
 * empty boxes (#526). It runs before the provider checks the addresses, and
 * before a draft is made. PostGrid stamps the address block in Open Sans,
 * the font it prints the legacy HTML in; each text names its own font.
 */
export function validatePrintableCharacters(
  mail: "letter" | "postcard",
  texts: PrintedText[],
  { sender, recipient, senderIsSaved }: PrintedAddresses,
  context: ToolContext,
  /** A theme whose own typeface prints some of `texts` (#563), for the refusal's closing. */
  themed?: ThemedFace
): void {
  const found = findUnprintable([
    ...texts,
    {
      field: "sender",
      where: senderIsSaved ? "in your saved return address" : "in the sender's address",
      text: printedAddress(sender)
    },
    { field: "recipient", where: "in the recipient's address", text: printedAddress(recipient) }
  ]);
  if (found.length === 0) return;

  // Counts only: the characters are the mail's content.
  context.logger.warn(
    {
      correlationId: context.correlationId,
      event: `quote.${mail}.unprintable_characters`,
      fields: found.map(({ field, characters }) => ({ field, count: characters.length }))
    },
    "Mail holds characters the print cannot show"
  );
  // An expected refusal: logged as validation_error, not unknown_error.
  throw Object.assign(new Error(unprintableRefusal(mail, found, themed)), { diagnosticClass: "validation_error" });
}

/**
 * A theme that sets the letter's text in a typeface of its own (#563:
 * typewriter, handwritten), or undefined for one in Classic's.
 */
export function ownFaceTheme(stationery: Stationery | undefined): Stationery["theme"] | undefined {
  if (!stationery) return undefined;
  return bodyFace(stationery.theme).font === bodyFace("classic").font ? undefined : stationery.theme;
}

/**
 * validatePrintableCharacters for the three letter tools. A letter drawn by
 * our own renderer prints its text in the renderer's font (#534), or in its
 * theme's own typeface (#563); its addresses are stamped in Open Sans either
 * way. The gift card, the initials and the headline print in Tinos.
 */
export function validatePrintableLetter(
  letter: PrintedAddresses & { bodyText: string; signOff: string },
  context: ToolContext,
  renderer: 'html' | 'pdf' = printRenderer(),
  /** A gift send's card: our renderer draws it as the second page, with the sender's name. */
  giftCard?: GiftCardContent,
  /** The page's stationery (#563): its initials and headline print in Tinos, its text in the theme's face. The date line is ours. */
  stationery?: Stationery | PreviewStationery
): void {
  const prints = renderer === "pdf" ? drawsGrapheme : undefined;
  const card = prints ? giftCard : undefined;
  const slots = prints ? stationery : undefined;
  // The text prints in its theme's typeface: one with its own is checked against it.
  const own = prints ? ownFaceTheme(stationery) : undefined;
  const textPrints = own ? drawsGraphemeIn(bodyFace(own).font) : prints;
  const inFace = own ? `, which the ${own} stationery prints in its own typeface` : "";
  validatePrintableCharacters(
    "letter",
    [
      { field: "bodyText", where: `in the text${inFace}`, text: letter.bodyText, prints: textPrints },
      { field: "signOff", where: `in the sign-off${inFace}`, text: letter.signOff, prints: textPrints },
      ...(card
        ? [{ field: "giftCardName", where: "in the sender's name, which the gift card prints", text: letter.sender.name, prints }]
        : []),
      ...(slots?.monogram !== undefined
        ? [{ field: "monogram", where: "in the monogram's initials", text: slots.monogram, prints }]
        : []),
      ...(slots?.headline !== undefined
        ? [{ field: "headline", where: "in the headline", text: slots.headline, prints }]
        : [])
    ],
    letter,
    context,
    own
      ? { theme: own, fields: ["bodyText", "signOff"], drawnInClassic: drawsGrapheme, remembered: rememberedPrefix(stationery) }
      : undefined
  );
  if (card) validateGiftPageFits(card, letter.sender.name, context);
}

/**
 * A gift send's card, checked as validatePrintableLetter checks it: the
 * sender's name prints in Tinos, and the card fits its page. For a gift
 * decided after the layout (giftForLayout, #586), which the printable check
 * ran without.
 */
export function validateGiftCardPrints(
  card: GiftCardContent,
  letter: PrintedAddresses,
  context: ToolContext,
  renderer: 'html' | 'pdf' = printRenderer()
): void {
  if (renderer !== "pdf") return;
  validatePrintableCharacters(
    "letter",
    [{ field: "giftCardName", where: "in the sender's name, which the gift card prints", text: letter.sender.name, prints: drawsGrapheme }],
    letter,
    context
  );
  validateGiftPageFits(card, letter.sender.name, context);
}

/**
 * The card page ends above the bottom margin, as the letter's text does
 * (layoutGiftPage). Its other words are ours, so only the sender's name can
 * push it past, and only at about a thousand characters.
 */
function validateGiftPageFits(card: GiftCardContent, senderName: string, context: ToolContext): void {
  try {
    layoutGiftPage(giftLetterPageCopy(card, senderName));
  } catch (error) {
    if (!(error instanceof GiftPageOverflow)) throw error;
    context.logger.warn(
      { correlationId: context.correlationId, event: "quote.letter.gift_card_overflow", overflowPoints: Math.round(error.overflow) },
      "The gift card runs past the page"
    );
    throw Object.assign(
      new Error("The sender's name is too long to print on the gift card. Shorten it, then preview again."),
      { diagnosticClass: "validation_error" }
    );
  }
}

// ============================================================================
// Draft Creation and Output Building
// ============================================================================

export interface CreateLetterDraftParams {
  sender: Address;
  recipient: Address;
  bodyText: string;
  signOff: string;
  layoutType: LetterLayoutType;
  headerImageData?: string;
  headerImagePreview?: string;  // Small preview for ChatGPT widget
  headerImageUrl?: string;
  inlineImageData?: string;
  inlineImagePreview?: string;  // Small preview for ChatGPT widget
  inlineImageUrl?: string;
  senderValidation?: AddressValidationResult;
  recipientValidation?: AddressValidationResult;
  addressWarnings?: string[];
  usedSavedReturnAddress: boolean;
  savedReturnAddressNote?: string;
  /** Whether this is a gift send, decided before the checks that depend on how it prints (letterGiftChoice). */
  gift: GiftSendChoice;
  /** The letter as our renderer lays it out (layoutLetterForPreview), or undefined for the legacy HTML. */
  printLayout?: Layout;
  /** The arrival date asked for, checked (previewSchedule, #535). */
  schedule?: PreviewSchedule;
  /** The stationery asked for or remembered, checked (chooseStationery, #563); undefined while it is not offered. */
  stationery?: PreviewStationery;
  /** The signature asked for or remembered (chooseSignature, #608): its image when the letter prints one. */
  signature?: PreviewSignature;
  /** The certified service the letter asks for (chooseMailService, #625); undefined for an ordinary letter. */
  mailService?: CertifiedMailService;
  context: ToolContext;
}

/**
 * A gift draft is sent free, so Pay & Send is never offered for it: the
 * checkout refuses a gift draft, and a card should not show a button the
 * server will refuse.
 */
export function giftSendEligibility(eligibility: SendEligibility): SendEligibility {
  return {
    ...eligibility,
    payAndSend: {
      available: false,
      unavailableReason: "This uses a gift letter, so there is nothing to pay."
    }
  };
}

/**
 * An app that takes no purchases (#475) offers neither checkout, so a card
 * there shows no Pay & Send and no Buy a Letter Pack, and the pack link is the
 * website's letter packs page, where the person buys one. Apply it before
 * giftSendEligibility, whose reason for a gift draft is the truer one.
 *
 * Mail no pack pays for (#579) is paid on the confirmation page there, with
 * Pay & Send: the page's address goes with it, for the card's button, while
 * the send rule gives the page.
 */
export function appSendEligibility(
  eligibility: SendEligibility,
  client: ClientProfile,
  draftId?: string
): SendEligibility {
  if (client.inAppPurchases) {
    return eligibility;
  }
  const paidPerSend = eligibility.packPays === false;
  return {
    payAndSend: {
      available: false,
      unavailableReason: "Pay & Send isn't available in this app.",
      ...(paidPerSend && draftId && isSendConfirmationEnabled() ? { pageUrl: sendConfirmationUrl(draftId) } : {})
    },
    letterPack: {
      available: false,
      purchaseUrl: letterPacksPageUrl()
    },
    ...(paidPerSend ? { packPays: false as const } : {})
  };
}

/**
 * Why a preview cannot be sent from the balance as it stands: too few
 * letters, or mail a pack does not pay for (#579), which is paid per send.
 */
export const PAID_PER_SEND_REASON =
  "Letter packs and gift letters pay for one-page letters and 6x9 postcards; this one is paid with Pay & Send.";

export const PAGE_WORDS = ['', 'one page', 'two pages', 'three pages'];

/**
 * What a restyle says of a change in the letter's pages, and so of who pays (#586):
 * a pack pays for one page, and two or three are paid with Pay & Send. Certified mail
 * (#625) is paid with Pay & Send at one price whatever the pages, so for it a change
 * of pages moves nothing about who pays, and the sentence does not say it does.
 */
export function pageChangeSentence(pages: number, pagesBefore: number, mailService?: string | null): string {
  if (pages === pagesBefore) return '';
  if (mailServiceOf(mailService)) {
    return pages === 1 ? ' It now fits on one page.' : ` It now runs to ${PAGE_WORDS[pages]}, printed on both sides. The price is the same.`;
  }
  return pages === 1
    ? ' It now fits on one page, which a letter pack pays for.'
    : ` It now runs to ${PAGE_WORDS[pages]}, printed on both sides, and is paid with Pay & Send.`;
}

/** Why a certified letter cannot be sent from the balance (#625): no pack and no gift letter pays for it. */
export const CERTIFIED_PAID_PER_SEND_REASON = "Certified mail is paid with Pay & Send.";

export function reasonCannotSend(option: MailOption): string {
  if (isPackPayable(option)) return "Not enough letters in your balance.";
  return option.mailService ? CERTIFIED_PAID_PER_SEND_REASON : PAID_PER_SEND_REASON;
}

/**
 * What a preview offers for buying: Pay & Send and the letter pack button, as
 * the account, a gift send and the calling app allow (#475). Both previews,
 * letter and postcard, build it here, priced as the mail option (#578).
 */
export function previewSendEligibility(
  available: number,
  requiredCredits: number,
  option: MailOption,
  isGift: boolean,
  client: ClientProfile,
  draftId?: string
): SendEligibility {
  const eligibility = appSendEligibility(getSendEligibility(available, requiredCredits, option), client, draftId);
  return isGift ? giftSendEligibility(eligibility) : eligibility;
}

/**
 * Whether a letter preview is a gift send, decided before the checks: on our
 * renderer (#534) a gift send's card page draws the sender's name, so the
 * tools check that it prints (validatePrintableLetter). The postcard preview
 * decides its gift the same way, before its checks.
 */
export async function letterGiftChoice(
  letter: { bodyText: string; signOff: string; sendAsGift?: boolean },
  context: ToolContext,
  /** The letter's option, once its pages are known (#586): a gift letter pays for one page only, and for standard mail (#625). */
  option?: MailOption
): Promise<GiftSendChoice> {
  const packPays = option === undefined || isPackPayable(option);
  return resolveGiftSendChoice({
    userId: context.user.userId,
    requested: letter.sendAsGift,
    balanceCanPay: context.user.creditsRemaining >= estimateRequiredCredits(letter.bodyText, letter.signOff),
    ...(option === undefined ? {} : { giftCanPay: packPays }),
    ...(option?.mailService ? { certified: true } : {})
  });
}

/**
 * A letter preview's gift, decided first, so the printable check sees its
 * card (#534). Not while room to write is offered (#586): a letter may then
 * run past one page, which no gift letter pays for (#579), so the gift waits
 * for the layout (giftForLayout).
 */
export async function earlyGiftChoice(
  letter: { bodyText: string; signOff: string; sendAsGift?: boolean },
  context: ToolContext,
  /** The mail service the letter asks for (#625): certified mail is paid per send whatever its pages, so no gift pays for it and that is known at once. */
  mailService?: string | null
): Promise<GiftSendChoice | undefined> {
  const service = mailServiceOf(mailService);
  if (service) return letterGiftChoice(letter, context, { mailType: "letter", mailService: service });
  return letterPageLimit() > 1 ? undefined : letterGiftChoice(letter, context);
}

/**
 * The gift, decided after the layout when it was not decided first
 * (earlyGiftChoice): by the pages the letter takes, so a letter of more than
 * one page is never a gift send. Its card is then checked as the printable
 * check would have checked it.
 */
export async function giftForLayout(
  early: GiftSendChoice | undefined,
  letter: PrintedAddresses & { bodyText: string; signOff: string; sendAsGift?: boolean },
  layout: Layout | undefined,
  context: ToolContext,
  renderer: 'html' | 'pdf' = printRenderer(),
  /** Whether a signed letter fits one page without its signature (#608): asked only when the gift is refused. */
  fitsOnePageUnsigned: () => boolean = () => false
): Promise<GiftSendChoice> {
  if (early) return early;
  let gift: GiftSendChoice;
  try {
    gift = await letterGiftChoice(letter, context, letterOption(layout));
  } catch (error) {
    // A signed letter its band pushed past one page: the way out is no
    // signature, which the gift's refusal says (#612 review round 1).
    if (error instanceof Error && error.message === GIFT_PAYS_ONE_PAGE && fitsOnePageUnsigned()) {
      throw new Error(`${GIFT_PAYS_ONE_PAGE} ${SIGNATURE_GIFT_WORDS}`);
    }
    throw error;
  }
  if (gift.card) validateGiftCardPrints(gift.card, letter, context, renderer);
  return gift;
}

/**
 * Whether a letter can be sent now without paying: a gift letter pays for it,
 * or the balance does, for mail a pack pays for (#579). The preview and a
 * restyle (#586) share it, so they cannot drift (#591 review round 1).
 */
function canSendNowFor(option: MailOption, requiredCredits: number, isGift: boolean, available: number): boolean {
  return isGift || (isPackPayable(option) && available >= requiredCredits);
}

/**
 * What a letter preview's draft costs as it stands, and whether the balance
 * pays: the terms a preview gives (createLetterDraftAndBuildOutput), for a
 * draft whose pages a restyle changed (#586). A gift letter is paid for.
 */
export function letterPayment(
  option: MailOption,
  requiredCredits: number,
  isGift: boolean,
  context: ToolContext,
  draftId: string
): { canSendNow: boolean; reasonCannotSend?: string; sendEligibility: SendEligibility } {
  const available = context.user.creditsRemaining;
  const canSendNow = canSendNowFor(option, requiredCredits, isGift, available);
  return {
    canSendNow,
    ...(canSendNow ? {} : { reasonCannotSend: reasonCannotSend(option) }),
    sendEligibility: previewSendEligibility(available, requiredCredits, option, isGift, callingApp(context), draftId)
  };
}

/**
 * A letter's option for its price (#579, #586, #625): its pages, when its
 * layout runs past one, and the mail service the draft holds, when it is not
 * standard (read as the rest of the code reads a row's: mailServiceOf, so an
 * unknown value is carried and prices as nothing, never as standard mail).
 */
export function letterOption(layout: Layout | undefined, mailService?: MailService | string | null): MailOption {
  const pages = layout?.pages.length ?? 1;
  const service = mailServiceOf(mailService);
  return {
    mailType: "letter",
    ...(pages > 1 ? { pages } : {}),
    ...(service ? { mailService: service } : {})
  };
}

export async function createLetterDraftAndBuildOutput(
  params: CreateLetterDraftParams
): Promise<LetterQuoteOutput> {

  const {
    sender,
    recipient,
    bodyText,
    signOff,
    layoutType,
    headerImageData,
    headerImagePreview,
    headerImageUrl,
    inlineImageData,
    inlineImagePreview,
    inlineImageUrl,
    senderValidation,
    recipientValidation,
    addressWarnings,
    usedSavedReturnAddress,
    savedReturnAddressNote,
    gift,
    printLayout,
    schedule,
    stationery,
    signature,
    mailService,
    context
  } = params;
  // Whether the letter as laid out carries the signature (#608): the draft's
  // version and its copy follow what was drawn.
  const signed = Boolean(printLayout?.pages.some(page => page.items.some(item => item.kind === "image" && item.role === "signature")));

  // Calculate credits, only where a pack pays (#579). The letter's option has
  // the pages it was laid out on (#586), counted before any gift page.
  const option = letterOption(printLayout, mailService);
  const requiredCredits = estimateRequiredCredits(bodyText, signOff);
  const available = context.user.creditsRemaining;
  const canSendNow = canSendNowFor(option, requiredCredits, gift.isGift, available);
  const lettersRequired = Math.max(1, Math.ceil(requiredCredits / 2));

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.letter.computed",
      availableCredits: available,
      requiredCredits,
      lettersRequired,
      canSendNow,
      giftSend: gift.isGift
    },
    "Computed preview requirements"
  );

  // A gift send's card is the second page, drawn as it prints (#534).
  const layout = printLayout && gift.isGift && gift.card
    ? { ...printLayout, pages: [...printLayout.pages, layoutGiftPage(giftLetterPageCopy(gift.card, sender.name))] }
    : printLayout;

  // Generate preview HTML
  // Use preview images (compressed) for the HTML to reduce payload size
  // Full-quality images are stored separately in the draft for PostGrid
  const previewHtml = layout
    ? renderLetterPreviewDocument(
        renderPreviewSvg(
          withDisplayImage(layout, layoutType === "header_image" ? headerImagePreview : inlineImagePreview),
          // Where PostGrid stamps them, so the page shows what prints. These
          // are the addresses as sent: after any correction above.
          { addresses: { from: stampedAddressLines(sender), to: stampedAddressLines(recipient) } }
        ),
        { bodyText, signOff },
        rendererVersionFor(stationery, signed)
      )
    : renderLayoutPreviewHtml({
        sender,
        recipient,
        bodyText,
        signOff,
        layoutType,
        headerImageData: headerImagePreview || headerImageData,
        inlineImageData: inlineImagePreview || inlineImageData,
        giftCard: gift.card,
      });

  // Create draft
  const draftResult = await createDraft({
    userId: context.user.userId,
    sender: sender as unknown as Record<string, unknown>,
    recipient: recipient as unknown as Record<string, unknown>,
    bodyText,
    signOff,
    requiredCredits,
    previewHtml,
    senderValidation: senderValidation ? { status: senderValidation.status } : undefined,
    recipientValidation: recipientValidation ? { status: recipientValidation.status } : undefined,
    layoutType,
    headerImageData,
    headerImageUrl,
    inlineImageData,
    inlineImageUrl,
    isGiftSend: gift.isGift,
    // The letter prints with the renderer its preview was drawn with: pdf-2
    // for a theme (#563), which the draft records with it; pdf-4 with a
    // signature (#608), whose copy the draft keeps.
    rendererVersion: layout ? rendererVersionFor(stationery, signed) : undefined,
    stationery: layout ? stationery : undefined,
    signatureImage: signed ? signature?.image : undefined,
    // Held until its mail date (#535).
    schedule: schedule?.draft,
    // The pages it was laid out on (#586): it prints and is priced on them.
    pages: option.pages ?? 1,
    // How it travels (#625): the send, the checkout and the confirmation page read it from the draft.
    ...(mailService ? { mailService } : {}),
  });

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.letter.draft_created",
      layoutType,
      expiresAt: draftResult.expiresAt.toISOString()
    },
    "Draft created for idempotent send"
  );

  // A theme the call asked for, Classic included, is the account's choice
  // for its next preview (#563). Only once the draft exists: a refused
  // preview chose nothing. Not remembering never fails the preview.
  if (stationery?.source === "asked") {
    try {
      await rememberStationery(context.user.userId, stationery.theme);
    } catch (error) {
      context.logger.warn(
        { correlationId: context.correlationId, event: "quote.stationery_not_remembered", error: (error as Error).message },
        "The stationery chosen was not remembered"
      );
    }
  }

  // A signature the call chose, on or off, is the account's choice for its
  // next preview (#608), once the draft exists, as stationery is.
  if (signature) await rememberPreviewSignature(signature, context);

  // Build output
  const signatureSaid = previewSignatureOutput(signature, signed);
  // Only pass small preview images for ChatGPT widget display (~3KB each)
  // Full-quality images are stored in the draft and retrieved when sending to PostGrid
  const output: LetterQuoteOutput = {
    previewHtml,
    lettersRequired,
    canSendNow,
    reasonCannotSend: canSendNow ? undefined : reasonCannotSend(option),
    sendEligibility: previewSendEligibility(available, requiredCredits, option, gift.isGift, callingApp(context), draftResult.draftId),
    deliveryClass: DELIVERY_CLASS,
    // A held letter's card says when it goes to the printer, not "in 1-2 days".
    deliveryEstimate: schedule ? scheduleSentence(schedule.output, context.now()) : DELIVERY_ESTIMATE,
    deliveryDisclaimer: DELIVERY_DISCLAIMER,
    draftId: draftResult.draftId,
    draftExpiresAt: draftResult.expiresAt.toISOString(),
    layoutType,
    // Small preview images for ChatGPT widget (~3KB each)
    // Full images stored in draft, not sent in response
    headerImagePreview,
    inlineImagePreview,
    usedSavedReturnAddress: usedSavedReturnAddress || undefined,
    savedReturnAddressNote,
    addressWarnings,
    giftCard: gift.card ? giftCardSummary(gift.card.state) : undefined,
    giftLettersAvailable: gift.giftLettersAvailable > 0 ? gift.giftLettersAvailable : undefined,
    schedule: schedule?.output,
    arrivalWindow: previewArrivalWindow(context),
    // Only while stationery is offered (#563): otherwise the output is as before it.
    ...(stationery ? { stationery } : {}),
    // Whether it is signed, and why, while signatures are offered (#608 review
    // round 1): a model without the card hears it from here.
    ...(signatureSaid ? { signature: signatureSaid } : {}),
    // Certified mail (#625): only then, so an ordinary letter's answer is unchanged.
    ...(mailService ? { mailService } : {}),
    // A letter of more than one page (#586), printed on both sides: only then.
    ...(option.pages ? { pages: option.pages } : {}),
    // And how full its pages are, for the card's fit line, while room to write
    // is offered: counted before any gift page, in the theme's face.
    // With the version of its words, which a change of them names (#586).
    ...(printLayout && letterPageLimit() > 1
      ? { pageFit: pageFit(printLayout, stationery), wordsVersion: wordsVersionOf(bodyText, signOff) }
      : {}),
  };

  // Add address validation results
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
      originalAddress: recipient,
      verifiedAddress: recipientValidation.verifiedAddress ? {
        name: recipient.name,
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
