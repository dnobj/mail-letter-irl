import { z } from "zod";
import { preprocessImageFileElement, preprocessImageFileParam, preprocessPhotoList } from "./utils/imageFileParam.js";
import { DRAWN_THEMES, STATIONERY_FACES, STATIONERY_ORNAMENTS, STATIONERY_THEMES, STATIONERY_TONES } from "./render/stationery.js";
import { MAX_LETTER_PAGES } from "./render/geometry.js";
import { MAIL_SERVICES } from "./config/certifiedMail.js";
import { EXTRA_SERVICES } from "./config/products.js";

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
/** A saved design (#649): withheld while designs are not offered (withheldInputKeys). */
export const STATIONERY_DESIGN_ID_DESCRIPTION =
  "Optional, only when the user asks for one of their saved stationery designs: its designId, from list_stationery_designs or save_stationery_design. " +
  "The letter is drawn in that design instead of a stationery: leave stationery out with it. With a design, monogram is taken only when its ornament is the monogram, " +
  "and headline prints on any design, whatever monogram's and headline's own descriptions say of the themes.";
const stationeryDesignIdZ = z.preprocess(noneForNull, z.string().optional()).describe(STATIONERY_DESIGN_ID_DESCRIPTION);

/** A letter of more than one page (#586), on the letter previews' output. */
/** The version of a letter's words (#586), which a change of them names. */
export const WORDS_VERSION_DESCRIPTION =
  "While a letter's words can be changed in place: the version of the letter's words, which set_letter_words takes to say which words it replaces";
export const SET_LETTER_WORDS_VERSION_DESCRIPTION =
  "The wordsVersion of the words this change replaces, from the preview or the last change of words. The letter card can change the words too: if they changed since, nothing is changed, and the answer gives the words as they are now";
export const PREVIEW_PAGES_DESCRIPTION =
  "Present only for a letter of more than one page: the pages it prints on, both sides of the paper. No letter pack or gift letter pays for it; it is paid with Pay & Send.";

/** What a letter preview's output says of its stationery (#563). */
export const PREVIEW_STATIONERY_DESCRIPTION =
  "While stationery is offered: the stationery the page was drawn in, with the date line, initials and headline " +
  "it prints, and why: asked for, the account's last choice, or classic by default";
export const STATIONERY_SOURCE_DESCRIPTION =
  "Why this stationery: asked for in the call, the account's remembered choice, or classic by default";
/** A saved design's four choices (#649), as an output says them. */
export const STATIONERY_DESIGN_OUTPUT_DESCRIPTION = "With the custom theme: its design's choices";
export const stationeryDesignZ = z.object({
  face: z.enum(STATIONERY_FACES),
  ornament: z.enum(STATIONERY_ORNAMENTS),
  ruled: z.boolean(),
  tone: z.enum(STATIONERY_TONES)
});
export const STATIONERY_THEME_OUTPUT_DESCRIPTION = "The stationery the page is drawn in";
const previewStationeryZ = z.object({
  theme: z.enum(DRAWN_THEMES).describe(STATIONERY_THEME_OUTPUT_DESCRIPTION),
  designId: z.string().optional().describe("With the custom theme: its design's id"),
  name: z.string().optional().describe("With the custom theme: its design's name"),
  design: stationeryDesignZ.optional().describe(STATIONERY_DESIGN_OUTPUT_DESCRIPTION),
  dateLine: z.string().optional(),
  monogram: z.string().optional(),
  headline: z.string().optional(),
  source: z.enum(["asked", "remembered", "default"]).describe(STATIONERY_SOURCE_DESCRIPTION)
});

// The letter previews' signature (#608): withheld while signatures are not
// offered (withheldInputKeys), as stationery is.
export const PREVIEW_SIGNATURE_DESCRIPTION =
  "Optional. Whether the letter prints the person's saved signature under the sign-off's first line (set_signature saves one). " +
  "Left out, the person's last choice: on once a signature is saved. True with none saved is refused. Pass false to leave it off.";
const previewSignatureZ = z.boolean().optional().describe(PREVIEW_SIGNATURE_DESCRIPTION);

/** A ready letter's signature now (#608 part 4), for a card shown its preview's first answer again. */
export const GET_DRAFT_STATUS_SIGNATURE_DESCRIPTION =
  "A ready letter our renderer drew, while signatures are offered: whether it prints the person's saved signature now; its page goes to the card";

/** What a letter preview's output says of its signature (#608 review round 1). */
export const PREVIEW_SIGNATURE_OUTPUT_DESCRIPTION =
  "While signatures are offered: whether the letter prints the person's saved signature, and why";
export const SIGNATURE_SOURCE_DESCRIPTION =
  "Why: asked for in the call (signature), the account's remembered choice, or none_saved when the account has no signature, whatever the call asked";
const previewSignatureOutputZ = z.object({
  printed: z.boolean(),
  source: z.enum(["asked", "remembered", "none_saved"]).describe(SIGNATURE_SOURCE_DESCRIPTION)
});

// The letter previews' mail service (#625): withheld while certified mail is not
// offered (withheldInputKeys), as the signature is.
export const PREVIEW_MAIL_SERVICE_DESCRIPTION =
  "Optional. How the letter travels: standard (the default), certified (USPS Certified Mail, which gives a tracking number), " +
  "or certified_return_receipt (Certified Mail with an electronic return receipt). Certified mail costs more and is paid with Pay & Send: " +
  "no letter pack and no gift letter pays for it. Leave it out for an ordinary letter.";
// A client that fills an unset field with null or an empty string means no service, as it does for the
// stationery: an ordinary letter, never a certified one.
const noneForNullOrEmpty = (value: unknown): unknown => (value === null || value === '' ? undefined : value);
const previewMailServiceZ = z.preprocess(noneForNullOrEmpty, z.enum(MAIL_SERVICES).optional()).describe(PREVIEW_MAIL_SERVICE_DESCRIPTION);

/** What a letter preview's output says when it is certified mail (#625): which service. Absent for an ordinary letter. */
export const PREVIEW_MAIL_SERVICE_OUTPUT_DESCRIPTION =
  "Present only when the letter goes as certified mail: certified, or certified_return_receipt (with an electronic return receipt). Paid with Pay & Send.";
// The two services of a certified letter: the one list the code ties to the MailService type (products.ts).
const CERTIFIED_MAIL_SERVICES = EXTRA_SERVICES;

// What an order says when it was sent as USPS Certified Mail (#625). Declared whatever the
// flag says: the output schemas are closed, and an order outlives the flag.
export const ORDER_MAIL_SERVICE_DESCRIPTION =
  "Present only for USPS Certified Mail: certified, or certified_return_receipt (with an electronic return receipt).";
export const ORDER_CARRIER_TRACKING_NUMBER_DESCRIPTION =
  "Certified mail only: USPS's tracking number, once the printer has set it and Letter IRL's status sync has stored it. It is not the order id.";
export const ORDER_TRACKING_SUPPORT_DESCRIPTION =
  "How the order can be tracked. estimated_only: the status comes from the printer, and delivery is estimated, not confirmed by a carrier. carrier_tracking: USPS's own tracking number is stored for a letter that went out (certified mail), so USPS's page shows the scans; this status is still the printer's.";
export const ORDER_CARRIER_TRACKING_URL_DESCRIPTION =
  "Certified mail only, with the tracking number: the USPS page that shows where the piece is.";
// How a letter travels (#625), declared once on every answer that carries a letter's terms: get_draft_status,
// set_stationery, set_letter_words, set_letter_signature and set_mail_service.
export const LETTER_TRAVEL_MAIL_SERVICE_DESCRIPTION =
  "With the terms, for a letter that is certified mail now: which service. Absent beside the delivery words: ordinary mail";
export const LETTER_TRAVEL_DELIVERY_CLASS_DESCRIPTION =
  "With the terms, for a letter that is certified mail or while certified mail is offered: how it is delivered now, as a new preview would say it. A card draws it on its Delivery line";
export const LETTER_TRAVEL_DELIVERY_DISCLAIMER_DESCRIPTION = "With it, the words that qualify the delivery";
export const ORDER_CERTIFIED_NOTE_DESCRIPTION =
  "Certified mail only: what to tell the person about the tracking number and the return receipt. It promises nothing about delivery or legal effect.";

// Text-only letter schema
export const quoteAndPreviewInputZ = z.object({
  sender: addressZ.optional(),  // Optional - will use saved return address if not provided
  recipient: addressZ,
  bodyText: z.string(),
  signOff: z.string(),
  sendAsGift: sendAsGiftZ,
  arriveBy: arriveByZ,
  stationery: stationeryZ,
  stationeryDesignId: stationeryDesignIdZ,
  monogram: monogramZ,
  headline: headlineZ,
  signature: previewSignatureZ,
  mailService: previewMailServiceZ
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

/**
 * One photo of a collage's `images` (#616): the same file object, and required.
 * A string in its place is a photo the host did not resolve, blank or not
 * (preprocessImageFileElement).
 */
const imageFileElementZ = z.preprocess(
  preprocessImageFileElement,
  z.object({
    download_url: z.string(),
    file_id: z.string(),
    mime_type: z.string().optional(),
    file_name: z.string().optional()
  })
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
  stationeryDesignId: stationeryDesignIdZ,
  monogram: monogramZ,
  headline: headlineZ,
  signature: previewSignatureZ,
  mailService: previewMailServiceZ
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
  stationeryDesignId: stationeryDesignIdZ,
  monogram: monogramZ,
  headline: headlineZ,
  signature: previewSignatureZ,
  mailService: previewMailServiceZ
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
/**
 * "delivered" is the printer's estimate, never a carrier's scan: every order status a model reads says so (HOME-01),
 * since some apps' models read only the structured result.
 */
const DELIVERED_STATUS_NOTE =
  "delivered means the printer's estimated delivery date has passed; no carrier confirmed it, so say its delivery is estimated, not that it was delivered";
export const HOME_ORDER_STATUS_DESCRIPTION = `Where the mail stands: pending, scheduled, accepted, printing, in_transit, delivered, returned, failed or cancelled. ${DELIVERED_STATUS_NOTE}`;
export const ORDER_STATUS_DESCRIPTION = `The order's status. ${DELIVERED_STATUS_NOTE}`;
export const openLetterHomeInputZ = z.object({}).strict();
const homeRecipientZ = z.object({ name: z.string(), city: z.string(), state: z.string() });
const homeItemZ = {
  recipient: homeRecipientZ,
  mailType: z.enum(['letter', 'postcard']),
  createdAt: z.string(),
  isGiftSend: z.boolean(),
  arriveBy: z.string().optional(),
  mailOn: z.string().optional()
};
export const openLetterHomeOutputZ = z.object({
  drafts: z.array(z.object({
    ...homeItemZ, draftId: z.string(), expiresAt: z.string(), confirmationUrl: z.string()
  })),
  orders: z.array(z.object({
    ...homeItemZ, orderId: z.string(), status: z.string().describe(HOME_ORDER_STATUS_DESCRIPTION),
    cancellable: z.boolean().optional(),
    mailService: z.enum(['certified', 'certified_return_receipt']).optional(),
    carrierTrackingNumber: z.string().optional(), carrierTrackingUrl: z.string().optional(),
    certifiedNote: z.string().optional()
  })),
  recipients: z.array(homeRecipientZ),
  limit: z.number().int().positive(),
  websiteOrigin: z.string().describe("The website's origin: a draft's confirmation link opens only there"),
  appUrl: z.string().optional()
});
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

/**
 * The postcard preview's `message` and `size` as they are served while the
 * 4x6 and 11x6 are not offered (#594): the 6x9 alone, and its message's
 * room, exactly as before them.
 */
export const postcardSixByNineZ = {
  message: z.string().describe("Must fit the back of the postcard: 16 lines, about 500 characters of prose"),
  size: z.enum(["6x9"]).optional()
};

/** A front's caption and place (#594), as the postcard preview and set_postcard_style take them. */
export const POSTCARD_CAPTION_DESCRIPTION =
  "For the border layout only: one handwritten line under the photo, such as \"Cape Cod, August 2026\". Leave it out for none.";
export const POSTCARD_PLACE_DESCRIPTION =
  "For the greetings layout only, and needed there: the place it greets from, such as \"Asheville\", printed in capitals.";

/** A collage's photos (#616): the postcard preview's `images` and `imageUrls`, served while collages are offered. */
export const POSTCARD_COLLAGE_IMAGES_DESCRIPTION =
  "For a collage front: two to four photos attached in the conversation, in the order they should appear. " +
  "The arrangement follows the count: two side by side; three, one large with two beside it; four, two by two. " +
  "Give images or imageUrls, never together with image or imageUrl. Leave it out for a single photo.";
export const POSTCARD_COLLAGE_IMAGE_URLS_DESCRIPTION =
  "For a collage front: two to four links to photos, in the order they should appear, each a public image link or an imageUrl from confirm_uploaded_image. " +
  "The arrangement follows the count: two side by side; three, one large with two beside it; four, two by two. " +
  "Give imageUrls or images, never together with image or imageUrl. Leave it out for a single photo.";

export const quoteAndPreviewPostcardInputZ = z.object({
  sender: addressZ.optional(),  // Optional - will use saved return address if not provided
  recipient: addressZ,
  // Served as postcardSixByNineZ while the 4x6 and 11x6 are not offered (#594).
  message: z.string().describe(
    "Must fit the back of the postcard, which is measured in lines: 16 on a 6x9, about 500 characters of prose. " +
    "size gives the other sizes' room."
  ),
  // Served as postcardSixByNineZ while the 4x6 and 11x6 are not offered (#594).
  size: z.enum(["6x9", "6x4", "6x11"]).optional().describe(
    "The postcard's size: 6x9 (the default), 6x4 for a 4 x 6 in postcard, or 6x11 for an 11 x 6 in one. " +
    "A 4x6 holds 11 lines on its back, about 350 characters of prose; an 11x6 16 lines, about 900. " +
    "Letter packs and gift letters pay only for a 6x9: a 4x6 or 11x6 is paid with Pay & Send."
  ),
  // The front's layout (#594): withheld while layouts are not offered (withheldInputKeys).
  layout: z.enum(["full_bleed", "border", "greetings"]).optional().describe(
    "The front's layout: full_bleed (the default), the photo across the whole front; border, the photo in a white border " +
    "with a caption under it; or greetings, \"Greetings from\" a place over the photo."
  ),
  caption: z.string().optional().describe(POSTCARD_CAPTION_DESCRIPTION),
  place: z.string().optional().describe(POSTCARD_PLACE_DESCRIPTION),
  // Image from OpenAI fileParams - permissive to handle mobile edge cases
  // Mobile may send file_id without download_url (sediment:// protocol)
  image: imageFileParamZ.optional(),
  // Alternative: direct image URL (for when fileParams isn't available)
  imageUrl: z.string().optional(),
  // Two to four photos for a collage (#616): withheld while collages are not offered (withheldInputKeys).
  // A blank string where a list belongs is no list (preprocessPhotoList); the JSON Schema is the array's.
  images: z.preprocess(preprocessPhotoList, z.array(imageFileElementZ).optional()).describe(POSTCARD_COLLAGE_IMAGES_DESCRIPTION),
  imageUrls: z.preprocess(preprocessPhotoList, z.array(z.string()).optional()).describe(POSTCARD_COLLAGE_IMAGE_URLS_DESCRIPTION),
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
/** set_stationery's theme as it is served while saved designs are not offered (#649): required, as before them. */
export const setStationeryThemeRequiredZ = z.preprocess(themeName, z.enum(STATIONERY_THEMES)).describe(SET_STATIONERY_DESCRIPTION);
export const setStationeryInputZ = z.object({
  draftId: z.string().describe("The draftId from a letter preview"),
  stationery: z.preprocess(themeName, z.enum(STATIONERY_THEMES).optional()).describe(SET_STATIONERY_DESCRIPTION),
  stationeryDesignId: stationeryDesignIdZ,
  monogram: monogramZ,
  headline: headlineZ
});

// A letter preview's words, changed without previewing again (#586). Listed
// only while the words can be changed in place: room to write, or the words editor (#647, src/server.ts).
export const SET_LETTER_WORDS_BODY_DESCRIPTION = "The letter's body in full: it replaces the words the preview has";
export const SET_LETTER_WORDS_SIGN_OFF_DESCRIPTION = "The closing and signature in full (e.g., 'Love, Pat')";
export const setLetterWordsInputZ = z.object({
  draftId: z.string().describe("The draftId from a letter preview"),
  bodyText: z.string().describe(SET_LETTER_WORDS_BODY_DESCRIPTION),
  signOff: z.string().describe(SET_LETTER_WORDS_SIGN_OFF_DESCRIPTION),
  wordsVersion: z.string().optional().describe(SET_LETTER_WORDS_VERSION_DESCRIPTION)
});

// A postcard preview's size and front, changed without previewing again
// (#594). Listed only while the sizes or the layouts are offered
// (src/server.ts); `size` is withheld while the sizes are not, and `layout`,
// `caption` and `place` while the layouts are not (withheldInputKeys).
export const SET_POSTCARD_SIZE_DESCRIPTION =
  "The new size: 6x9, 6x4 for a 4 x 6 in postcard, or 6x11 for an 11 x 6 in one. Left out, the size stays. " +
  "A 4x6 holds 11 lines on its back, a 6x9 or 11x6 16. A 4x6 or 11x6 is paid with Pay & Send, and a gift postcard stays a 6x9.";
export const SET_POSTCARD_LAYOUT_DESCRIPTION =
  "The new front: full_bleed, the photo across the whole front; border, the photo in a white border with a caption under it; " +
  "or greetings, \"Greetings from\" a place over the photo. Left out, the front stays as it is.";
export const setPostcardStyleInputZ = z.object({
  draftId: z.string().describe("The draftId from a postcard preview"),
  size: z.enum(["6x9", "6x4", "6x11"]).optional().describe(SET_POSTCARD_SIZE_DESCRIPTION),
  layout: z.enum(["full_bleed", "border", "greetings"]).optional().describe(SET_POSTCARD_LAYOUT_DESCRIPTION),
  caption: z.string().optional().describe(POSTCARD_CAPTION_DESCRIPTION),
  place: z.string().optional().describe(POSTCARD_PLACE_DESCRIPTION)
});

// Held mail cancelled before it goes to the printer (#535). Listed only while
// LETTER_IRL_ARRIVE_BY_ENABLED is on (src/server.ts).
export const cancelScheduledMailInputZ = z.object({
  orderId: z.string().describe("The orderId of the scheduled letter or postcard, from list_orders"),
  confirm: z.boolean().describe("Set true once the person has agreed: a cancelled order cannot be restored")
});

// Address requests (#604). Listed only while LETTER_IRL_ADDRESS_REQUESTS_ENABLED
// is on (src/server.ts).
export const ADDRESS_REQUEST_RECIPIENT_NAME_DESCRIPTION =
  "Who the address is for, as the person calls them, up to 100 characters. It goes on the envelope unless the recipient gives another name; the page never shows it";
export const ADDRESS_REQUEST_SENDER_FIRST_NAME_DESCRIPTION =
  "The first name the page shows as the sender's, up to 40 letters: the only thing it shows of them. Left out, the first name on the saved return address";
export const ADDRESS_REQUEST_ID_DESCRIPTION = "The requestId from request_address";
export const ADDRESS_REQUEST_STATES = ["waiting", "answered", "declined", "cancelled", "expired"] as const;
export const ADDRESS_REQUEST_STATUS_DESCRIPTION =
  "waiting; answered (the address is in recipient); declined; cancelled; or expired, when the link ran out before an answer";
export const ADDRESS_REQUEST_RECIPIENT_DESCRIPTION =
  "The address given, as the recipient typed it and checked as a preview checks one, in the shape a preview tool's recipient takes: only when answered";

export const requestAddressInputZ = z.object({
  recipientName: z.string().describe(ADDRESS_REQUEST_RECIPIENT_NAME_DESCRIPTION),
  senderFirstName: z.string().optional().describe(ADDRESS_REQUEST_SENDER_FIRST_NAME_DESCRIPTION)
});

export const getAddressRequestInputZ = z.object({
  requestId: z.string().describe(ADDRESS_REQUEST_ID_DESCRIPTION)
});

export const cancelAddressRequestInputZ = z.object({
  requestId: z.string().describe(ADDRESS_REQUEST_ID_DESCRIPTION)
});

// A saved signature (#608). Listed only while LETTER_IRL_SIGNATURES_ENABLED is
// on and our renderer draws letters (src/server.ts).
export const SIGNATURE_IMAGE_DESCRIPTION = "A photo of the person's signature, attached in the conversation";
export const SIGNATURE_IMAGE_URL_DESCRIPTION = "A link to a photo of the person's signature, when no file was attached";
export const SIGNATURE_CONFIRM_DESCRIPTION =
  "Set true once the person has agreed: a removed signature cannot be brought back";
export const SIGNATURE_SAVED_AT_DESCRIPTION = "When it was saved, ISO 8601";
export const SIGNATURE_REPLACED_DESCRIPTION = "Whether it replaced a signature saved before";
export const SIGNATURE_REMOVED_DESCRIPTION = "Whether a saved signature was removed: false when none was saved";

export const setSignatureInputZ = z.object({
  image: imageFileParamZ.optional().describe(SIGNATURE_IMAGE_DESCRIPTION),
  imageUrl: z.string().optional().describe(SIGNATURE_IMAGE_URL_DESCRIPTION)
});

export const getSignatureInputZ = z.object({});

export const clearSignatureInputZ = z.object({
  confirm: z.boolean().describe(SIGNATURE_CONFIRM_DESCRIPTION)
});

// A letter preview signed or unsigned without previewing again (#608 part 4).
export const SET_LETTER_SIGNATURE_DESCRIPTION =
  "true prints the person's saved signature under the closing; false takes it off";
export const setLetterSignatureInputZ = z.object({
  draftId: z.string().describe("The draftId from a letter preview"),
  signature: z.boolean().describe(SET_LETTER_SIGNATURE_DESCRIPTION)
});

/** set_mail_service's input (#625): which service the previewed letter travels by. */
export const SET_MAIL_SERVICE_DESCRIPTION =
  "How the letter travels: standard (ordinary first-class mail), certified (USPS Certified Mail) or certified_return_receipt (Certified Mail with an electronic return receipt). " +
  "Certified mail costs more and is paid with Pay & Send: no letter pack and no gift letter pays for it.";
export const setMailServiceInputZ = z.object({
  draftId: z.string().describe("The draftId from a letter preview"),
  mailService: z.enum(MAIL_SERVICES).describe(SET_MAIL_SERVICE_DESCRIPTION)
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
  signature: previewSignatureOutputZ.optional().describe(PREVIEW_SIGNATURE_OUTPUT_DESCRIPTION),
  mailService: z.enum(CERTIFIED_MAIL_SERVICES).optional().describe(PREVIEW_MAIL_SERVICE_OUTPUT_DESCRIPTION),
  pages: z.number().int().min(2).max(MAX_LETTER_PAGES).optional().describe(PREVIEW_PAGES_DESCRIPTION),
  wordsVersion: z.string().optional().describe(WORDS_VERSION_DESCRIPTION)
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
  currentStatus: z.string().describe(ORDER_STATUS_DESCRIPTION),
  statusTimeline: z.array(statusTimelineEntryZ),
  recipientSummary: recipientSummaryZ,
  canSendFollowUp: z.boolean().optional(),
  followUpSuggestedPrompt: z.string().optional(),
  trackingSupport: trackingSupportZ.optional().describe(ORDER_TRACKING_SUPPORT_DESCRIPTION),
  arriveBy: z.string().optional().describe("Sent with an arrival date: the date it aims to arrive by, YYYY-MM-DD"),
  mailOn: z.string().optional().describe("Sent with an arrival date: the day it goes to the printer, YYYY-MM-DD"),
  cancellable: z.boolean().optional().describe(CANCELLABLE_DESCRIPTION),
  mailService: z.enum(CERTIFIED_MAIL_SERVICES).optional().describe(ORDER_MAIL_SERVICE_DESCRIPTION),
  carrierTrackingNumber: z.string().optional().describe(ORDER_CARRIER_TRACKING_NUMBER_DESCRIPTION),
  carrierTrackingUrl: z.string().optional().describe(ORDER_CARRIER_TRACKING_URL_DESCRIPTION),
  certifiedNote: z.string().optional().describe(ORDER_CERTIFIED_NOTE_DESCRIPTION)
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
    status: z.string().optional().describe(ORDER_STATUS_DESCRIPTION),
    sentAt: z.string().optional(),
    arriveBy: z.string().optional().describe("Sent with an arrival date: the date it aims to arrive by, YYYY-MM-DD"),
    mailOn: z.string().optional().describe("Sent with an arrival date: the day it goes to the printer, YYYY-MM-DD"),
    cancellable: z.boolean().optional().describe(CANCELLABLE_DESCRIPTION),
    mailService: z.enum(CERTIFIED_MAIL_SERVICES).optional().describe(ORDER_MAIL_SERVICE_DESCRIPTION),
    carrierTrackingNumber: z.string().optional().describe(ORDER_CARRIER_TRACKING_NUMBER_DESCRIPTION),
    carrierTrackingUrl: z.string().optional().describe(ORDER_CARRIER_TRACKING_URL_DESCRIPTION)
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

/** A postcard preview's size and front (#594), named while each is offered. */
export const PREVIEW_POSTCARD_SIZE_DESCRIPTION = "While the 4x6 and 11x6 are offered: the postcard's size";
export const PREVIEW_POSTCARD_LAYOUT_DESCRIPTION = "While postcard layouts are offered: the front's layout";

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
  arrivalWindow: arrivalWindowZ.optional().describe(ARRIVAL_WINDOW_DESCRIPTION),
  // The postcard maker's choices now, each while it is offered (#594).
  size: z.enum(["6x9", "6x4", "6x11"]).optional().describe(PREVIEW_POSTCARD_SIZE_DESCRIPTION),
  layout: z.enum(["full_bleed", "border", "greetings"]).optional().describe(PREVIEW_POSTCARD_LAYOUT_DESCRIPTION),
  caption: z.string().optional().describe("The border's caption, when it has one"),
  place: z.string().optional().describe("The place the greeting names"),
  collagePhotos: z.number().int().optional().describe("How many photos the front draws, when it is a collage")
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

const letterTravelZ = {
  mailService: z.enum(CERTIFIED_MAIL_SERVICES).optional().describe(LETTER_TRAVEL_MAIL_SERVICE_DESCRIPTION),
  deliveryClass: z.string().optional().describe(LETTER_TRAVEL_DELIVERY_CLASS_DESCRIPTION),
  deliveryDisclaimer: z.string().optional().describe(LETTER_TRAVEL_DELIVERY_DISCLAIMER_DESCRIPTION)
};

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
  pages: z.number().int().min(2).max(MAX_LETTER_PAGES).optional().describe("A ready letter of more than one page: the pages it is laid out on now"),
  canSendNow: z.boolean().optional().describe("A ready letter while room to write or certified mail is offered, or a postcard while its sizes or layouts are: whether the balance or a gift letter pays for it now"),
  ...letterTravelZ,
  reasonCannotSend: z.string().optional(),
  sendEligibility: sendEligibilityZ.optional(),
  size: z.enum(["6x9", "6x4", "6x11"]).optional().describe("A ready postcard our renderer drew, while its sizes or layouts are offered: its size now. Its page goes to the card"),
  layout: z.enum(["full_bleed", "border", "greetings"]).optional().describe("With it, the postcard's front now"),
  caption: z.string().optional().describe("The border's caption, when it has one"),
  place: z.string().optional().describe("The place the greeting names"),
  bodyText: z.string().optional().describe("A ready letter, while a letter's words can be changed in place (room to write, or the words editor): its words now, for the card"),
  signOff: z.string().optional(),
  wordsVersion: z.string().optional().describe(WORDS_VERSION_DESCRIPTION),
  stationery: z
    .object({
      theme: z.enum(DRAWN_THEMES).describe(STATIONERY_THEME_OUTPUT_DESCRIPTION),
      name: z.string().optional().describe("With the custom theme: its design's name when the letter was drawn"),
      design: stationeryDesignZ.optional().describe(STATIONERY_DESIGN_OUTPUT_DESCRIPTION),
      dateLine: z.string().optional(),
      monogram: z.string().optional(),
      headline: z.string().optional()
    })
    .optional()
    .describe("A ready letter's stationery now, while stationery is offered; its page goes to the card"),
  signature: z.boolean().optional().describe(GET_DRAFT_STATUS_SIGNATURE_DESCRIPTION)
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
    .describe("Present when the person pays for it with Pay & Send on that page: letter packs and gift letters pay only for one-page letters and 6x9 postcards, and never for certified mail"),
  mailService: z.enum(CERTIFIED_MAIL_SERVICES).optional().describe(PREVIEW_MAIL_SERVICE_OUTPUT_DESCRIPTION)
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

export const requestAddressOutputZ = z.object({
  requestId: z.string().describe("Pass it to get_address_request and cancel_address_request"),
  status: z.enum(["waiting"]),
  url: z.string().describe("The private link for the person to share with the recipient themselves. It is given only here"),
  recipientName: z.string(),
  senderFirstName: z.string().describe("All the page shows of the sender"),
  expiresAt: z.string().describe("When the link stops working, ISO 8601"),
  message: z.string()
});

export const getAddressRequestOutputZ = z.object({
  requestId: z.string(),
  status: z.enum(ADDRESS_REQUEST_STATES).describe(ADDRESS_REQUEST_STATUS_DESCRIPTION),
  recipientName: z.string(),
  expiresAt: z.string().describe("When the link stops, or stopped, working, ISO 8601"),
  recipient: addressZ.optional().describe(ADDRESS_REQUEST_RECIPIENT_DESCRIPTION),
  message: z.string()
});

export const cancelAddressRequestOutputZ = z.object({
  requestId: z.string(),
  status: z.enum(ADDRESS_REQUEST_STATES).describe(ADDRESS_REQUEST_STATUS_DESCRIPTION),
  alreadyClosed: z.boolean().describe("True when it had already been answered, declined, cancelled or had expired: nothing changed"),
  message: z.string()
});

// The cleaned picture itself travels in _meta, for a card (partitionToolResult).
export const setSignatureOutputZ = z.object({
  saved: z.literal(true),
  replaced: z.boolean().describe(SIGNATURE_REPLACED_DESCRIPTION),
  width: z.number().describe("The cleaned signature's width, in pixels"),
  height: z.number().describe("The cleaned signature's height, in pixels"),
  message: z.string()
});

export const getSignatureOutputZ = z.object({
  saved: z.boolean(),
  width: z.number().optional(),
  height: z.number().optional(),
  savedAt: z.string().optional().describe(SIGNATURE_SAVED_AT_DESCRIPTION),
  message: z.string()
});

// Saved stationery designs (#649): saved, listed and deleted. Listed only while designs are offered (src/server.ts).
export const DESIGN_NAME_DESCRIPTION = "The person's name for the design, 1 to 40 characters, such as \"Garden letters\"; saving under a name the account has replaces that design";
export const DESIGN_FACE_DESCRIPTION =
  "The letter's face: serif (a classic book face), typewriter (a monospace face, fewer words to the page) or handwritten (a handwriting face, no Greek, Hebrew or Vietnamese)";
export const DESIGN_ORNAMENT_DESCRIPTION =
  "What is drawn in the top-right corner beside the address window: none, monogram (initials in a double ring), sprig (a line-drawn sprig with berries) or confetti";
export const DESIGN_RULED_DESCRIPTION = "Whether faint rules are drawn under each line";
export const DESIGN_TONE_DESCRIPTION =
  "The grey of the sprig or the monogram, darkest first: black, dark, medium or light. Confetti keeps its own mix of greys, and none has nothing to colour. Letters print in black and greys only";
export const DESIGN_ID_DESCRIPTION = "The design's id, which stationeryDesignId takes on a letter preview or set_stationery";
export const DESIGN_CONFIRM_DESCRIPTION = "true, once the person has agreed: a deleted design cannot be brought back";
export const saveStationeryDesignInputZ = z.object({
  name: z.string().describe(DESIGN_NAME_DESCRIPTION),
  face: z.enum(STATIONERY_FACES).describe(DESIGN_FACE_DESCRIPTION),
  ornament: z.enum(STATIONERY_ORNAMENTS).describe(DESIGN_ORNAMENT_DESCRIPTION),
  ruled: z.boolean().describe(DESIGN_RULED_DESCRIPTION),
  tone: z.enum(STATIONERY_TONES).describe(DESIGN_TONE_DESCRIPTION)
});
export const listStationeryDesignsInputZ = z.object({});
export const deleteStationeryDesignInputZ = z.object({
  designId: z.string().describe(DESIGN_ID_DESCRIPTION),
  confirm: z.boolean().describe(DESIGN_CONFIRM_DESCRIPTION)
});
const designOutputZ = z.object({
  designId: z.string().describe(DESIGN_ID_DESCRIPTION),
  name: z.string(),
  face: z.enum(STATIONERY_FACES),
  ornament: z.enum(STATIONERY_ORNAMENTS),
  ruled: z.boolean(),
  tone: z.enum(STATIONERY_TONES)
});
export const saveStationeryDesignOutputZ = designOutputZ.extend({
  replaced: z.boolean().describe("Whether a design of the same name was replaced"),
  message: z.string()
});
export const listStationeryDesignsOutputZ = z.object({
  designs: z.array(designOutputZ).describe("The account's saved designs, oldest first"),
  rememberedDesignId: z.string().optional().describe("The design a letter preview that names no stationery is drawn in, when the account remembers one"),
  limit: z.number().int().describe("The most designs an account may keep"),
  message: z.string()
});
export const deleteStationeryDesignOutputZ = z.object({
  deleted: z.boolean().describe("Whether a design was deleted: false when the account has none with that id"),
  message: z.string()
});

export const clearSignatureOutputZ = z.object({
  removed: z.boolean().describe(SIGNATURE_REMOVED_DESCRIPTION),
  message: z.string()
});

/** set_mail_service's answer (#625). */
export const SET_MAIL_SERVICE_OUTPUT_DESCRIPTION =
  "Present only when the letter now goes as certified mail: which service. Absent: an ordinary letter";
export const SET_MAIL_SERVICE_CAN_SEND_DESCRIPTION =
  "Whether the balance or a gift letter pays for the letter as it is now: certified mail is paid with Pay & Send, so it is false for it";
export const setMailServiceOutputZ = z.object({
  draftId: z.string(),
  mailService: z.enum(CERTIFIED_MAIL_SERVICES).optional().describe(SET_MAIL_SERVICE_OUTPUT_DESCRIPTION),
  deliveryClass: letterTravelZ.deliveryClass,
  deliveryDisclaimer: letterTravelZ.deliveryDisclaimer,
  canSendNow: z.boolean().describe(SET_MAIL_SERVICE_CAN_SEND_DESCRIPTION),
  reasonCannotSend: z.string().optional(),
  sendEligibility: sendEligibilityZ,
  pages: z.number().int().min(2).max(MAX_LETTER_PAGES).optional().describe(PREVIEW_PAGES_DESCRIPTION),
  message: z.string()
});

/** set_letter_signature's answer (#608 part 4); the page drawn again and how full it is go to the card in _meta. */
export const SET_LETTER_SIGNATURE_CAN_SEND_DESCRIPTION =
  "Whether the balance or a gift letter pays for the letter as it is now: the signature's lines can change its pages, and so its price";
export const setLetterSignatureOutputZ = z.object({
  draftId: z.string(),
  signature: previewSignatureOutputZ.describe("Whether the letter now prints the person's saved signature: asked for in the call"),
  pages: z.number().int().min(2).max(MAX_LETTER_PAGES).optional().describe(PREVIEW_PAGES_DESCRIPTION),
  canSendNow: z.boolean().describe(SET_LETTER_SIGNATURE_CAN_SEND_DESCRIPTION),
  reasonCannotSend: z.string().optional(),
  sendEligibility: sendEligibilityZ,
  ...letterTravelZ,
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
  pages: z.number().int().min(2).max(MAX_LETTER_PAGES).optional().describe(PREVIEW_PAGES_DESCRIPTION),
  canSendNow: z.boolean().describe("Whether the balance or a gift letter pays for the letter as it is now: a restyle can change its pages, and so its price"),
  reasonCannotSend: z.string().optional(),
  sendEligibility: sendEligibilityZ,
  ...letterTravelZ,
  message: z.string()
});

/** set_letter_words' answer (#586); the page drawn again and how full it is go to the card in _meta. */
export const SET_LETTER_WORDS_CAN_SEND_DESCRIPTION =
  "Whether the balance or a gift letter pays for the letter as it is now: new words can change its pages, and so its price";
export const setLetterWordsOutputZ = z.object({
  draftId: z.string(),
  pages: z.number().int().min(2).max(MAX_LETTER_PAGES).optional().describe(PREVIEW_PAGES_DESCRIPTION),
  canSendNow: z.boolean().describe(SET_LETTER_WORDS_CAN_SEND_DESCRIPTION),
  reasonCannotSend: z.string().optional(),
  sendEligibility: sendEligibilityZ,
  ...letterTravelZ,
  wordsVersion: z.string().describe("The version of the words now, for the next change of them"),
  message: z.string()
});

/** set_postcard_style's answer (#594); the postcard drawn again goes to the card in _meta. */
export const SET_POSTCARD_STYLE_SIZE_OUTPUT_DESCRIPTION = "The postcard's size now: 6x9, 6x4 (a 4x6) or 6x11 (an 11x6)";
export const SET_POSTCARD_STYLE_CAN_SEND_DESCRIPTION =
  "Whether the balance or a gift letter pays for the postcard as it is now: a new size can change how it is paid";
export const setPostcardStyleOutputZ = z.object({
  draftId: z.string(),
  size: z.enum(["6x9", "6x4", "6x11"]).describe(SET_POSTCARD_STYLE_SIZE_OUTPUT_DESCRIPTION),
  layout: z.enum(["full_bleed", "border", "greetings"]).describe("The postcard's front now"),
  caption: z.string().optional().describe("The border's caption, when it has one"),
  place: z.string().optional().describe("The place the greeting names"),
  canSendNow: z.boolean().describe(SET_POSTCARD_STYLE_CAN_SEND_DESCRIPTION),
  reasonCannotSend: z.string().optional(),
  sendEligibility: sendEligibilityZ,
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
