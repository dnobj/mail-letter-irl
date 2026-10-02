import { z } from "zod";
import { preprocessImageFileParam } from "./utils/imageFileParam.js";
import { STATIONERY_THEMES } from "./render/stationery.js";
import { MAX_LETTER_PAGES } from "./render/geometry.js";

export const addressZ = z.object({
  name: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string().optional().describe('Apartment, suite, or unit, e.g. "Suite 8701" - never fold it into addressLine1.'),
  city: z.string(),
  state: z.string(),
  postalCode: z.string(),
  country: z.string()
});

// Gift letters (docs/gift-letters.md). Functional wording only: tool text is
// not a place to promote anything (docs/apps-sdk-guidelines.md).
const SEND_AS_GIFT_DESCRIPTION =
  "Set true only when the user asks to send this as their gift letter: it is free and adds a printed page with a card for the recipient. Leave it out otherwise; a gift letter is then used only if the balance cannot pay.";
const sendAsGiftZ = z.boolean().optional().describe(SEND_AS_GIFT_DESCRIPTION);

// Arrive-by (#535). Served only while LETTER_IRL_ARRIVE_BY_ENABLED is on:
// registerTools strips it from the four preview tools' shapes otherwise.
export const ARRIVE_BY_DESCRIPTION =
  "Optional. The date the mail should arrive by, YYYY-MM-DD, such as a birthday or an event. " +
  "Letter IRL holds the mail and sends it to the printer in time; USPS does not guarantee First-Class dates. " +
  "Omit it to mail as soon as possible.";
const arriveByZ = z.string().optional().describe(ARRIVE_BY_DESCRIPTION);

/** The arrival dates on offer (#535), on every preview while the feature is on. */
export const ARRIVAL_WINDOW_DESCRIPTION =
  "The arrival dates that can be chosen now: what can be scheduled, not when this mail arrives";
const arrivalWindowZ = z.object({
  earliestArrival: z.string().describe("The first arrival date on offer, YYYY-MM-DD"),
  latestArrival: z.string().describe("The last arrival date on offer, YYYY-MM-DD")
});

/** A preview's arrival date (#535), when it was given one. */
const previewScheduleZ = z.object({
  arriveBy: z.string(),
  mailOn: z.string(),
  releasesAt: z.string(),
  earliestArrival: z.string(),
  latestArrival: z.string()
});

// Stationery (#563). Served on the three letter previews only while it is
// offered (LETTER_IRL_STATIONERY_ENABLED, with our renderer drawing them):
// registerTools strips these from their shapes otherwise. Functional wording
// only, as for gift letters.
export const STATIONERY_DESCRIPTION =
  "Optional. The letter's stationery: classic, a plain page; monogram, initials in a ring; " +
  "botanical, a line-drawn sprig; celebration, confetti with an optional headline; " +
  "typewriter, the letter typed in a monospace face, which fits fewer words on the page; " +
  "or handwritten, the letter in a handwriting face on faint ruled lines, which has no Greek, Hebrew or Vietnamese. " +
  "Each but classic prints the date at the top right. " +
  "Left out, the letter is in the account's last choice, or classic if it has none. " +
  "Leave it out unless the user asks for a style or for a plain page (classic), or names an occasion a style suits.";
export const MONOGRAM_DESCRIPTION =
  "Optional, for the monogram stationery only: the initials to print, one to three letters, such as \"JMS\". " +
  "Leave it out to use the initials of the return address's name.";
export const HEADLINE_DESCRIPTION =
  "Optional, for the celebration stationery only: a short line printed large above the letter, " +
  "such as \"Happy Birthday, Sam!\". It must fit on one line, and takes three of the page's lines; " +
  "leave it out for confetti alone.";

/**
 * A theme as asked for: its name in any case, or none for an empty string or
 * null, which models send for an optional field they leave unset. Anything
 * else is left for the enum to refuse.
 */
function themeName(value: unknown): unknown {
  if (value === null) return undefined;
  if (typeof value !== "string") return value;
  const name = value.trim().toLowerCase();
  return name === "" ? undefined : name;
}
const stationeryZ = z.preprocess(themeName, z.enum(STATIONERY_THEMES).optional()).describe(STATIONERY_DESCRIPTION);
/** None for null, which models send for an optional field they leave unset (#570 review round 2). */
const noneForNull = (value: unknown): unknown => (value === null ? undefined : value);
const monogramZ = z.preprocess(noneForNull, z.string().optional()).describe(MONOGRAM_DESCRIPTION);
const headlineZ = z.preprocess(noneForNull, z.string().optional()).describe(HEADLINE_DESCRIPTION);

/** What a letter preview's output says of its stationery (#563). */
/** A letter of more than one page (#586), on the letter previews' output. */
export const PREVIEW_PAGES_DESCRIPTION =
  "Present only for a letter of more than one page: the pages it prints on, both sides of the paper. No letter pack or gift letter pays for it; it is paid with Pay & Send.";

export const PREVIEW_STATIONERY_DESCRIPTION =
  "While stationery is offered: the stationery the page was drawn in, with the date line, initials and headline " +
  "it prints, and why: asked for, the account's last choice, or classic by default";
export const STATIONERY_SOURCE_DESCRIPTION =
  "Why this stationery: asked for in the call, the account's remembered choice, or classic by default";
const previewStationeryZ = z.object({
  theme: z.enum(STATIONERY_THEMES),
  dateLine: z.string().optional(),
  monogram: z.string().optional(),
  headline: z.string().optional(),
  source: z.enum(["asked", "remembered", "default"]).describe(STATIONERY_SOURCE_DESCRIPTION)
});

// Text-only letter schema
export const quoteAndPreviewInputZ = z.object({
  sender: addressZ.optional(),  // Optional - will use saved return address if not provided
  recipient: addressZ,
  bodyText: z.string(),
  signOff: z.string(),
  sendAsGift: sendAsGiftZ,
  arriveBy: arriveByZ,
  stationery: stationeryZ,
  monogram: monogramZ,
  headline: headlineZ
});

// ============================================================================
// Letter with Image Schemas (for fileParams support)
// ============================================================================

// Image file param schema - THIS IS THE SERVED LAYER. registerTools builds
// the MCP tools/list input schemas from these zod objects (zodInputSchemas),
// so what zod-to-json-schema emits here is exactly what ChatGPT's tool scan
// reads. The scan enforces the Apps SDK file-param contract - an object
// declaring all four of download_url/file_id/mime_type/file_name with only
// the first two required - and STRIPS any deviating property schema to {},
// disabling the file transform for the whole tool. z.any() serialized to {}
// and did precisely that (issue #227: ChatGPT's stored schema showed
// "image": {} and the model could only improvise bare id/path strings).
//
// The permissiveness existed for runtime edge cases - mobile sends strings
// ("attached", "", "chat_upload://image_N") instead of file objects, and a
// sandbox path ("/mnt/data/photo.png") arrives when ChatGPT did not swap in
// the file. That tolerance now lives in the preprocess step: serialization
// uses the inner object (contract-conformant). At runtime "" becomes no
// image, and any other string becomes a marker for a picture the server
// cannot open, which the handlers do not replace with an older upload (#414;
// see utils/imageFileParam.ts and services/previewImageSource.ts).
const imageFileParamZ = z.preprocess(
  preprocessImageFileParam,
  z
    .object({
      download_url: z.string(),
      file_id: z.string(),
      mime_type: z.string().optional(),
      file_name: z.string().optional()
    })
    .optional()
);

// Letter with header image (image at top, like letterhead)
export const quoteAndPreviewLetterWithHeaderImageInputZ = z.object({
  sender: addressZ.optional(),
  recipient: addressZ,
  bodyText: z.string(),
  signOff: z.string(),
  // Image from file attachment - OpenAI Apps SDK requires explicit schema definition
  image: imageFileParamZ.optional(),
  // Alternative: direct image URL
  imageUrl: z.string().optional(),
  sendAsGift: sendAsGiftZ,
  arriveBy: arriveByZ,
  stationery: stationeryZ,
  monogram: monogramZ,
  headline: headlineZ
});

// Letter with inline image (image after signature, like enclosing a photo)
export const quoteAndPreviewLetterWithImageInputZ = z.object({
  sender: addressZ.optional(),
  recipient: addressZ,
  bodyText: z.string(),
  signOff: z.string(),
  // Image from file attachment - OpenAI Apps SDK requires explicit schema definition
  image: imageFileParamZ.optional(),
  // Alternative: direct image URL
  imageUrl: z.string().optional(),
  sendAsGift: sendAsGiftZ,
  arriveBy: arriveByZ,
  stationery: stationeryZ,
  monogram: monogramZ,
  headline: headlineZ
});

export const sendLetterInputZ = z.object({
  draftId: z.string(),
  confirm: z.boolean(),
  sendAnotherCopy: z.boolean().optional().describe("Set true only after the user explicitly asks for another copy of mail that was already sent or paid for in the last 24 hours. Leave it out otherwise.")
});

export const createMailCheckoutInputZ = z.object({
  draftId: z.string(),
  sendAnotherCopy: z.boolean().optional().describe("Set true only after the user explicitly asks for another copy of mail that was already sent or paid for in the last 24 hours. Leave it out otherwise.")
});

export const listLetterPacksInputZ = z.object({});

export const listLetterPacksOutputZ = z.object({
  packs: z.array(
    z.object({
      pack: z.enum(["starter", "regular", "power"]),
      // Letters, never credits: the catalogue names its products after credits
      // ('credit-pack-4' is two letters), which is the confusion this avoids.
      letters: z.number().int().positive(),
      amountCents: z.number().int().positive(),
      currency: z.string(),
      displayAmount: z.string(),
      description: z.string()
    })
  ),
  message: z.string()
});

export const createPackCheckoutInputZ = z.object({
  pack: z.enum(["starter", "regular", "power"])
});

export const redeemPromoCodeInputZ = z.object({
  code: z.string()
});

export const getPurchaseStatusInputZ = z.object({
  orderId: z.string()
});

export const getOrderStatusInputZ = z.object({
  orderId: z.string().optional()
});

export const getAccountBalanceInputZ = z.object({});

// The profile ChatGPT records for a connected account (#424): an id that is
// stable across refresh, reconnect and scope upgrades, and the address.
export const getProfileInputZ = z.object({});
export const getProfileOutputZ = z.object({
  // Served in tools/list, so this is the copy ChatGPT reads. "Be a non-empty,
  // non-whitespace string" - the regex mirrors the pattern in OpenAI's own
  // profile schema.
  id: z
    .string()
    .min(1)
    .regex(/\S/)
    .describe(
      "Stable, opaque account id. Unchanged across token refresh, reconnection and scope upgrades; never reassigned to another profile."
    ),
  email: z.string().optional().describe("The confirmed email address the account is opened on")
});

export const listOrdersInputZ = z.object({
  limit: z.number().optional()
});

export const setReturnAddressInputZ = z.object({
  name: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string().optional(),
  city: z.string(),
  state: z.string(),
  postalCode: z.string(),
  country: z.string().optional()
});

export const getReturnAddressInputZ = z.object({});

export const clearReturnAddressInputZ = z.object({
  confirm: z.boolean()
});

// ============================================================================
// Postcard Schemas (US-POSTCARD-01, US-POSTCARD-02)
// ============================================================================

export const quoteAndPreviewPostcardInputZ = z.object({
  sender: addressZ.optional(),  // Optional - will use saved return address if not provided
  recipient: addressZ,
  message: z.string().describe("Must fit the back of the postcard: 16 lines, about 500 characters of prose"),
  size: z.enum(["6x9"]).optional(),
  // Image from OpenAI fileParams - permissive to handle mobile edge cases
  // Mobile may send file_id without download_url (sediment:// protocol)
  image: imageFileParamZ.optional(),
  // Alternative: direct image URL (for when fileParams isn't available)
  imageUrl: z.string().optional(),
  sendAsGift: sendAsGiftZ,
  arriveBy: arriveByZ
});

export const sendPostcardInputZ = z.object({
  draftId: z.string(),
  confirm: z.boolean(),
  sendAnotherCopy: z.boolean().optional().describe("Set true only after the user explicitly asks for another copy of mail that was already sent or paid for in the last 24 hours. Leave it out otherwise.")
});

// A link where the person sends a preview themselves (#470).
export const requestSendInputZ = z.object({
  draftId: z.string().describe("The draftId from a letter or postcard preview")
});

export const uploadPhotoChunkInputZ = z.object({
  uploadId: z.string().describe("The card's id for this upload, a UUID"),
  index: z.number().int().min(0).describe("This chunk's place, from 0"),
  total: z.number().int().min(1).max(24).describe("How many chunks the photo has"),
  data: z.string().max(512 * 1024).describe("This chunk of the photo, base64"),
  context: z.enum(["postcard", "header_image", "inline_image"]).optional()
});

export const getDraftStatusInputZ = z.object({
  draftId: z.string().describe("The draftId from a letter or postcard preview")
});

// A preview's arrival date, changed without previewing again (#535). Listed
// only while LETTER_IRL_ARRIVE_BY_ENABLED is on (src/server.ts).
export const SET_ARRIVE_BY_DESCRIPTION =
  "The date the mail should arrive by, YYYY-MM-DD. Leave it out to clear the date, so the mail goes to the printer as soon as it is sent.";
export const setArrivalDateInputZ = z.object({
  draftId: z.string().describe("The draftId from a letter or postcard preview"),
  arriveBy: z.string().optional().describe(SET_ARRIVE_BY_DESCRIPTION)
});

// A letter preview's stationery, changed without previewing again (#563).
// Listed only while stationery is offered (src/server.ts).
export const SET_STATIONERY_DESCRIPTION =
  "The stationery to draw the letter in: classic, a plain page; monogram, initials in a ring; " +
  "botanical, a line-drawn sprig; celebration, confetti with an optional headline; " +
  "typewriter, the letter typed in a monospace face, which fits fewer words on the page; " +
  "or handwritten, the letter in a handwriting face on faint ruled lines, which has no Greek, Hebrew or Vietnamese. " +
  "Each but classic prints the date at the top right.";
export const setStationeryInputZ = z.object({
  draftId: z.string().describe("The draftId from a letter preview"),
  stationery: z.preprocess(themeName, z.enum(STATIONERY_THEMES)).describe(SET_STATIONERY_DESCRIPTION),
  monogram: monogramZ,
  headline: headlineZ
});

// Held mail cancelled before it goes to the printer (#535). Listed only while
// LETTER_IRL_ARRIVE_BY_ENABLED is on (src/server.ts).
export const cancelScheduledMailInputZ = z.object({
  orderId: z.string().describe("The orderId of the scheduled letter or postcard, from list_orders"),
  confirm: z.boolean().describe("Set true once the person has agreed: a cancelled order cannot be restored")
});

// ============================================================================
// Feature Request Schema (US-FEEDBACK-01)
// ============================================================================

export const submitFeatureRequestInputZ = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  category: z.enum([
    "new_feature",
    "improvement",
    "integration",
    "mail_type",
    "international",
    "other"
  ]).optional(),
  attemptedAction: z.string().max(255).optional(),
  contactEmail: z.string().max(255).optional(),
  okToContact: z.boolean().optional()
});

export const getStartedInputZ = z.object({});

// ============================================================================
// Upload Image Schema (Widget-based image upload)
// ============================================================================

export const uploadImageInputZ = z.object({
  context: z.string().optional().describe("What the photo is for: 'postcard', 'header_image' or 'inline_image'.")
});

// ============================================================================
// Generate Image For Mail Schema (intent router - does not generate)
// ============================================================================

export const generateImageForMailInputZ = z.object({
  prompt: z.string().optional(),
  context: z.enum(["postcard", "header_image", "inline_image"]).optional()
});

// ============================================================================
// Confirm Uploaded Image Schema (Widget relay for upload URL)
// ============================================================================

export const confirmUploadedImageInputZ = z.object({
  imageUrl: z.string(),
  context: z.string().optional().describe("What the photo is for: 'postcard', 'header_image' or 'inline_image'.")
});

// ============================================================================
// Output Schemas
// ============================================================================
//
// These Zod schemas are used by the MCP SDK for runtime output validation.
// They intentionally describe structuredContent, not widget-only _meta fields.
// Large HTML previews and generated image blobs are moved into _meta by
// registerTools.ts so they do not inflate the model context.

const validatedAddressZ = z.object({
  name: z.string().optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional()
});

const addressValidationZ = z.object({
  status: z.enum(["verified", "corrected", "failed", "unverified"]).optional(),
  originalAddress: validatedAddressZ.optional(),
  verifiedAddress: validatedAddressZ.optional(),
  errors: z.array(z.string()).optional(),
  suggestions: z.string().optional()
});

const recipientSummaryZ = z.object({
  name: z.string(),
  city: z.string(),
  state: z.string()
});

const statusTimelineEntryZ = z.object({
  timestampISO: z.string(),
  statusText: z.string()
});

const trackingSupportZ = z.enum(["none", "estimated_only", "carrier_tracking"]);

export const sendEligibilityZ = z.object({
  payAndSend: z.object({
    available: z.boolean(),
    amountCents: z.number().int().optional(),
    currency: z.string().optional(),
    displayAmount: z.string().optional(),
    productDescription: z.string().optional(),
    unavailableReason: z.string().optional(),
    pageUrl: z
      .string()
      .optional()
      .describe("Where the person pays for this with Pay & Send and so sends it, in an app that cannot open Pay & Send itself")
  }),
  letterPack: z.object({
    available: z.boolean(),
    purchaseUrl: z.string()
  }),
  packPays: z
    .literal(false)
    .optional()
    .describe("False when letter packs and gift letters cannot pay for this mail: it is paid with Pay & Send, whatever the balance")
});

// A gift send's card, for the model and the preview card (docs/gift-letters.md).
const giftCardZ = z.object({
  state: z.enum(["funded", "unfunded"]),
  description: z.string()
});

export const quoteAndPreviewOutputZ = z.object({
  lettersRequired: z.number(),
  canSendNow: z.boolean(),
  reasonCannotSend: z.string().optional(),
  sendEligibility: sendEligibilityZ,
  deliveryClass: z.string().optional(),
  estimatedDeliveryDays: z.number().int().optional(),
  deliveryEstimate: z.string().optional(),
  deliveryDisclaimer: z.string().optional(),
  draftId: z.string(),
  draftExpiresAt: z.string(),
  layoutType: z.enum(["text_only", "header_image", "inline_image"]),
  usedSavedReturnAddress: z.boolean().optional(),
  savedReturnAddressNote: z.string().optional(),
  senderAddressValidation: addressValidationZ.optional(),
  recipientAddressValidation: addressValidationZ.optional(),
  addressWarnings: z.array(z.string()).optional(),
  giftCard: giftCardZ.optional(),
  giftLettersAvailable: z.number().int().nonnegative().optional(),
  schedule: previewScheduleZ.optional(),
  arrivalWindow: arrivalWindowZ.optional().describe(ARRIVAL_WINDOW_DESCRIPTION),
  stationery: previewStationeryZ.optional().describe(PREVIEW_STATIONERY_DESCRIPTION),
  pages: z.number().int().min(2).max(MAX_LETTER_PAGES).optional().describe(PREVIEW_PAGES_DESCRIPTION)
});

/** Held mail's two dates (#535), on what a send and the order status say. */
const heldDatesZ = z.object({ arriveBy: z.string(), mailOn: z.string() });
const HELD_SCHEDULE_DESCRIPTION =
  "Sent with an arrival date: the date it aims to arrive by and the day it goes to the printer, YYYY-MM-DD. It waits until then.";
const CANCELLABLE_DESCRIPTION = "With an arrival date: whether it can still be cancelled free, before it goes to the printer";

export const sendLetterOutputZ = z.object({
  orderId: z.string(),
  currentStatus: z.string(),
  statusTimeline: z.array(statusTimelineEntryZ),
  recipientSummary: recipientSummaryZ,
  lettersRemaining: z.number(),
  isRetry: z.boolean().optional(),
  trackingSupport: trackingSupportZ.optional(),
  saveReturnAddressNote: z.string().optional(),
  suggestSaveReturnAddress: z.boolean().optional(),
  schedule: heldDatesZ.optional().describe(HELD_SCHEDULE_DESCRIPTION),
  cancellable: z.boolean().optional().describe(CANCELLABLE_DESCRIPTION)
});

export const createMailCheckoutOutputZ = z.object({
  orderId: z.string(),
  checkoutUrl: z.string().url().optional(),
  amountCents: z.number().int().positive(),
  currency: z.string(),
  productDescription: z.string(),
  expiresAt: z.string().optional(),
  status: z.string(),
  reused: z.boolean(),
  message: z.string()
});

export const redeemPromoCodeOutputZ = z.object({
  redeemed: z.boolean(),
  // Letters, not credits: the service reports the ledger unit and this is the
  // only unit a customer sees (#308).
  letters: z.number().int().nonnegative().optional(),
  // Gift letters from a gift code (docs/gift-letters.md): free sends that
  // print a card for the recipient.
  giftLetters: z.number().int().nonnegative().optional(),
  expiresAt: z.string().optional(),
  message: z.string()
});

export const createPackCheckoutOutputZ = z.object({
  orderId: z.string(),
  checkoutUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "Stripe-hosted checkout URL. Present it to the customer as a link to click; nothing opens on its own (#322)."
    ),
  // The card's button target: our own start page, which forwards to the same
  // checkout after recording the way back into the conversation (#372).
  checkoutStartUrl: z
    .string()
    .url()
    .optional()
    .describe("Same checkout via Letter IRL's start page; used by the card. Present checkoutUrl to the customer."),
  // The customer-facing count. Credits stay internal - the catalogue names its
  // products after them ('credit-pack-4' is two letters), which is exactly the
  // confusion this field avoids. See
  // tests/unit/tools/letterBalanceEquivalence.test.ts.
  letters: z.number().int().positive(),
  amountCents: z.number().int().positive(),
  currency: z.string(),
  // Server-formatted per currency, so the card and the model quote the same
  // figure and neither recomputes decimals.
  displayAmount: z.string(),
  productDescription: z.string(),
  expiresAt: z.string().optional(),
  status: z.string(),
  reused: z.boolean(),
  message: z.string()
});

export const getPurchaseStatusOutputZ = z.object({
  orderId: z.string(),
  purchaseStatus: z.enum([
    "pending_payment",
    "processing",
    "submitted",
    "payment_failed",
    "refund_pending",
    "refunded",
    "on_hold",
    "cancelled"
  ]),
  orderStatus: z.string(),
  productDescription: z.string(),
  amountCents: z.number().int(),
  currency: z.string(),
  mailType: z.enum(["letter", "postcard"]).optional(),
  letterId: z.string().optional(),
  checkoutExpiresAt: z.string().optional(),
  // Letter packs only. Absent on Pay & Send orders; never null (#323).
  letters: z.number().int().positive().optional(),
  lettersRemaining: z.number().int().nonnegative().optional(),
  lettersRefunded: z.number().int().nonnegative().optional(),
  perLetterCents: z.number().int().positive().optional(),
  refundableAmountCents: z.number().int().nonnegative().optional(),
  amountRefundedCents: z.number().int().nonnegative().optional(),
  updatedAt: z.string(),
  message: z.string()
});

export const getOrderStatusOutputZ = z.object({
  orderId: z.string(),
  currentStatus: z.string(),
  statusTimeline: z.array(statusTimelineEntryZ),
  recipientSummary: recipientSummaryZ,
  canSendFollowUp: z.boolean().optional(),
  followUpSuggestedPrompt: z.string().optional(),
  trackingSupport: trackingSupportZ.optional(),
  arriveBy: z.string().optional().describe("Sent with an arrival date: the date it aims to arrive by, YYYY-MM-DD"),
  mailOn: z.string().optional().describe("Sent with an arrival date: the day it goes to the printer, YYYY-MM-DD"),
  cancellable: z.boolean().optional().describe(CANCELLABLE_DESCRIPTION)
});

export const getAccountBalanceOutputZ = z.object({
  lettersRemaining: z.number(),
  canSendStandardLetter: z.boolean(),
  message: z.string().optional(),
  lettersExpiringSoon: z.number().optional(),
  expiringLettersDetails: z.array(z.object({
    letters: z.number().optional(),
    expiresAt: z.string().optional(),
    daysUntilExpiry: z.number().optional()
  })).optional(),
  imageGenerationsRemaining: z.number().int().optional(),
  imageGenerationsAllowance: z.number().int().optional(),
  // Unsent gift letters, apart from lettersRemaining (docs/gift-letters.md).
  giftLettersRemaining: z.number().int().nonnegative().optional()
});

export const listOrdersOutputZ = z.object({
  orders: z.array(z.object({
    orderId: z.string(),
    recipient: recipientSummaryZ.optional(),
    status: z.string().optional(),
    sentAt: z.string().optional(),
    arriveBy: z.string().optional().describe("Sent with an arrival date: the date it aims to arrive by, YYYY-MM-DD"),
    mailOn: z.string().optional().describe("Sent with an arrival date: the day it goes to the printer, YYYY-MM-DD"),
    cancellable: z.boolean().optional().describe(CANCELLABLE_DESCRIPTION)
  })),
  total: z.number(),
  // Letter-pack purchases, newest first, in get_purchase_status's status
  // vocabulary (#365). Additive: the mail entries above are unchanged.
  packPurchases: z.array(z.object({
    orderId: z.string(),
    productDescription: z.string(),
    letters: z.number().int().nonnegative(),
    purchaseStatus: z.enum([
      "pending_payment",
      "processing",
      "submitted",
      "payment_failed",
      "refund_pending",
      "refunded",
      "on_hold",
      "cancelled"
    ]),
    amountCents: z.number().int(),
    currency: z.string(),
    displayAmount: z.string(),
    createdAt: z.string()
  })),
  packPurchaseTotal: z.number()
});

export const setReturnAddressOutputZ = z.object({
  success: z.boolean(),
  message: z.string(),
  address: addressZ.optional(),
  wasAutoCorrected: z.boolean(),
  correctionDetails: z.string().optional(),
  errors: z.array(z.string()).optional()
});

export const getReturnAddressOutputZ = z.object({
  hasAddress: z.boolean(),
  message: z.string(),
  address: addressZ.optional()
});

export const clearReturnAddressOutputZ = z.object({
  success: z.boolean(),
  message: z.string()
});

export const quoteAndPreviewPostcardOutputZ = z.object({
  lettersRequired: z.number(),
  canSendNow: z.boolean(),
  reasonCannotSend: z.string().optional(),
  sendEligibility: sendEligibilityZ,
  deliveryClass: z.string().optional(),
  estimatedDeliveryDays: z.number().int().optional(),
  deliveryEstimate: z.string().optional(),
  deliveryDisclaimer: z.string().optional(),
  draftId: z.string(),
  draftExpiresAt: z.string(),
  message: z.string().optional(),
  recipientName: z.string().optional(),
  recipientAddressLine1: z.string().optional(),
  recipientAddressLine2: z.string().optional(),
  recipientCity: z.string().optional(),
  recipientState: z.string().optional(),
  recipientPostalCode: z.string().optional(),
  senderName: z.string().optional(),
  senderAddressLine1: z.string().optional(),
  senderAddressLine2: z.string().optional(),
  senderCity: z.string().optional(),
  senderState: z.string().optional(),
  senderPostalCode: z.string().optional(),
  usedSavedReturnAddress: z.boolean().optional(),
  savedReturnAddressNote: z.string().optional(),
  senderAddressValidation: addressValidationZ.optional(),
  recipientAddressValidation: addressValidationZ.optional(),
  addressWarnings: z.array(z.string()).optional(),
  giftCard: giftCardZ.optional(),
  giftLettersAvailable: z.number().int().nonnegative().optional(),
  schedule: previewScheduleZ.optional(),
  arrivalWindow: arrivalWindowZ.optional().describe(ARRIVAL_WINDOW_DESCRIPTION)
});

export const sendPostcardOutputZ = z.object({
  orderId: z.string(),
  currentStatus: z.string(),
  statusTimeline: z.array(statusTimelineEntryZ),
  recipientSummary: recipientSummaryZ,
  lettersRemaining: z.number(),
  isRetry: z.boolean().optional(),
  trackingSupport: trackingSupportZ.optional(),
  saveReturnAddressNote: z.string().optional(),
  suggestSaveReturnAddress: z.boolean().optional(),
  schedule: heldDatesZ.optional().describe(HELD_SCHEDULE_DESCRIPTION),
  cancellable: z.boolean().optional().describe(CANCELLABLE_DESCRIPTION)
});

export const uploadPhotoChunkOutputZ = z.object({
  uploadId: z.string(),
  received: z.number().int(),
  total: z.number().int(),
  done: z.boolean(),
  width: z.number().int().optional(),
  height: z.number().int().optional()
});

export const getDraftStatusOutputZ = z.object({
  draftId: z.string(),
  status: z.enum(["ready", "sent", "expired", "not_found"]),
  orderId: z.string().optional().describe("The order the draft became, once sent"),
  schedule: z
    .object({ arriveBy: z.string(), mailOn: z.string() })
    .optional()
    .describe("Arrival dates, YYYY-MM-DD: a ready draft's, or a sent order's"),
  deliveryEstimate: z.string().optional().describe("A ready draft's delivery estimate, with its dates now"),
  orderStatus: z
    .enum(["scheduled", "cancelled", "sent"])
    .optional()
    .describe("Where a sent draft's order stands: scheduled while it waits for its mail date"),
  cancellable: z.boolean().optional().describe("A sent draft's order: whether it can still be cancelled free"),
  stationery: z
    .object({
      theme: z.enum(STATIONERY_THEMES),
      dateLine: z.string().optional(),
      monogram: z.string().optional(),
      headline: z.string().optional()
    })
    .optional()
    .describe("A ready letter's stationery now, while stationery is offered; its page goes to the card")
});

export const requestSendOutputZ = z.object({
  draftId: z.string(),
  mailType: z.enum(["letter", "postcard"]),
  confirmationUrl: z.string().describe("Where the person checks the preview and sends it themselves"),
  expiresAtISO: z.string(),
  recipientSummary: recipientSummaryZ,
  schedule: z
    .object({ arriveBy: z.string(), mailOn: z.string() })
    .optional()
    .describe("The preview's arrival dates, YYYY-MM-DD: once sent, it waits until its mail date"),
  paidPerSend: z
    .literal(true)
    .optional()
    .describe("Present when the person pays for it with Pay & Send on that page: letter packs and gift letters pay only for one-page letters and 6x9 postcards")
});

export const cancelScheduledMailOutputZ = z.object({
  orderId: z.string(),
  status: z.enum(["cancelled"]),
  alreadyCancelled: z.boolean().describe("True when it had already been cancelled: nothing changed now"),
  returned: z.object({
    kind: z.enum(["letters", "gift_letter"]),
    count: z.number().int()
  }).describe("What went back to the account"),
  message: z.string()
});

export const setArrivalDateOutputZ = z.object({
  draftId: z.string(),
  schedule: previewScheduleZ.optional().describe("The draft's dates now; absent when it mails as soon as it is sent"),
  deliveryEstimate: z.string(),
  message: z.string()
});

/** set_stationery's answer (#563); the page drawn again goes to the card in _meta. */
export const SET_STATIONERY_OUTPUT_DESCRIPTION = "The stationery the letter is now drawn in, with the date line, initials and headline it prints";
export const setStationeryOutputZ = z.object({
  draftId: z.string(),
  stationery: previewStationeryZ.describe(SET_STATIONERY_OUTPUT_DESCRIPTION),
  message: z.string()
});

export const submitFeatureRequestOutputZ = z.object({
  success: z.boolean(),
  requestId: z.string(),
  message: z.string(),
  category: z.string()
});

// Deliberately empty: every field of the getting-started guide is card copy,
// routed to _meta by partitionToolResult so the model cannot restate it. The
// model learns what happened from the tool summary instead.
export const getStartedOutputZ = z.object({
  // Empty for ChatGPT, whose card reads the copy from _meta. An app not proven
  // to pass _meta to a card gets it here as well (#474).
  title: z.string().optional(),
  overview: z.string().optional(),
  purchaseStep: z.string().optional(),
  examplePrompts: z.array(z.string()).optional()
});

export const uploadImageOutputZ = z.object({
  status: z.string(),
  message: z.string(),
  acceptedFormats: z.string(),
  maxSizeMB: z.number(),
  context: z.string(),
  debugEnabled: z.boolean(),
  debugEndpoint: z.string().optional(),
  cardUploadAvailable: z.boolean().optional()
});

export const generateImageForMailOutputZ = z.object({
  mode: z.enum(["generated", "redirect"]),
  status: z.string(),
  message: z.string(),
  suggestedNextStep: z.string(),
  prompt: z.string().optional(),
  generatedImageUrl: z.string().optional(),
  generationsRemaining: z.number().int().optional(),
  redirectStyle: z.enum(["resend", "handoff"]).optional()
});

export const confirmUploadedImageOutputZ = z.object({
  status: z.string(),
  imageUrl: z.string(),
  suggestedNextStep: z.string()
});
