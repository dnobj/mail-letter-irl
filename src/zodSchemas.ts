import { z } from "zod";

export const addressZ = z.object({
  name: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string().optional().describe('Apartment, suite, or unit, e.g. "Suite 8701" - never fold it into addressLine1.'),
  city: z.string(),
  state: z.string(),
  postalCode: z.string(),
  country: z.string()
});

// Text-only letter schema
export const quoteAndPreviewInputZ = z.object({
  sender: addressZ.optional(),  // Optional - will use saved return address if not provided
  recipient: addressZ,
  bodyText: z.string(),
  signOff: z.string()
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
// ("attached", "", "chat_upload://image_N") instead of file objects. That
// tolerance now lives in the preprocess step: serialization uses the inner
// object (contract-conformant), while any string coerces to undefined at
// runtime and lands on the handlers' existing graceful no-image fallback.
const imageFileParamZ = z.preprocess(
  (value) => (typeof value === "string" ? undefined : value),
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
  imageUrl: z.string().optional()
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
  imageUrl: z.string().optional()
});

export const sendLetterInputZ = z.object({
  draftId: z.string(),
  confirm: z.boolean()
});

export const createMailCheckoutInputZ = z.object({
  draftId: z.string()
});

export const getPurchaseStatusInputZ = z.object({
  orderId: z.string()
});

export const getOrderStatusInputZ = z.object({
  orderId: z.string().optional()
});

export const getAccountBalanceInputZ = z.object({});

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
  message: z.string(),
  size: z.enum(["6x9"]).optional(),
  // Image from OpenAI fileParams - permissive to handle mobile edge cases
  // Mobile may send file_id without download_url (sediment:// protocol)
  image: imageFileParamZ.optional(),
  // Alternative: direct image URL (for when fileParams isn't available)
  imageUrl: z.string().optional()
});

export const sendPostcardInputZ = z.object({
  draftId: z.string(),
  confirm: z.boolean()
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
  context: z.string().optional()
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
  context: z.string().optional()
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
  prepaid: z.object({
    eligible: z.boolean(),
    requiredCredits: z.number().int(),
    availableCredits: z.number().int()
  }),
  payAndSend: z.object({
    available: z.boolean(),
    amountCents: z.number().int().optional(),
    currency: z.string().optional(),
    displayAmount: z.string().optional(),
    productDescription: z.string().optional(),
    unavailableReason: z.string().optional()
  }),
  letterPack: z.object({
    available: z.boolean(),
    purchaseUrl: z.string()
  })
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
  addressWarnings: z.array(z.string()).optional()
});

export const sendLetterOutputZ = z.object({
  orderId: z.string(),
  currentStatus: z.string(),
  statusTimeline: z.array(statusTimelineEntryZ),
  recipientSummary: recipientSummaryZ,
  lettersRemaining: z.number(),
  isRetry: z.boolean().optional(),
  trackingSupport: trackingSupportZ.optional(),
  saveReturnAddressNote: z.string().optional(),
  suggestSaveReturnAddress: z.boolean().optional()
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

export const getPurchaseStatusOutputZ = z.object({
  orderId: z.string(),
  purchaseStatus: z.enum([
    "pending_payment",
    "processing",
    "sent",
    "payment_failed",
    "refund_pending",
    "refunded",
    "cancelled"
  ]),
  orderStatus: z.string(),
  productDescription: z.string(),
  amountCents: z.number().int(),
  currency: z.string(),
  mailType: z.enum(["letter", "postcard"]).optional(),
  letterId: z.string().optional(),
  checkoutExpiresAt: z.string().optional(),
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
  trackingSupport: trackingSupportZ.optional()
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
  imageGenerationsAllowance: z.number().int().optional()
});

export const listOrdersOutputZ = z.object({
  orders: z.array(z.object({
    orderId: z.string(),
    recipient: recipientSummaryZ.optional(),
    status: z.string().optional(),
    sentAt: z.string().optional()
  })),
  total: z.number()
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
  addressWarnings: z.array(z.string()).optional()
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
  suggestSaveReturnAddress: z.boolean().optional()
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
export const getStartedOutputZ = z.object({});

export const uploadImageOutputZ = z.object({
  status: z.string(),
  message: z.string(),
  acceptedFormats: z.string(),
  maxSizeMB: z.number(),
  context: z.string(),
  debugEnabled: z.boolean(),
  debugEndpoint: z.string().optional()
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
