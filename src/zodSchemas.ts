import { z } from "zod";

export const addressZ = z.object({
  name: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string().optional(),
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

// Image file param schema - INTENTIONALLY PERMISSIVE for runtime validation
// Note: The JSON schema (schemas.ts) uses strict typing to tell OpenAI how to transform files.
// This Zod schema is permissive to gracefully handle edge cases at runtime:
// - Mobile sends "attached" string instead of file object (platform limitation)
// - Empty strings or undefined values
// Actual validation happens in tool handlers with graceful error messages.
const imageFileParamZ = z.any();

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
  title: z.string(),
  description: z.string(),
  category: z.enum([
    "new_feature",
    "improvement",
    "integration",
    "mail_type",
    "international",
    "other"
  ]).optional(),
  attemptedAction: z.string().optional(),
  contactEmail: z.string().optional(),
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
// Generate Image Schema (AI image generation via OpenAI)
// ============================================================================

export const generateImageInputZ = z.object({
  prompt: z.string(),
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

const addressValidationZ = z.object({
  status: z.enum(["verified", "corrected", "failed"]).optional(),
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

export const quoteAndPreviewOutputZ = z.object({
  lettersRequired: z.number(),
  canSendNow: z.boolean(),
  reasonCannotSend: z.string().optional(),
  deliveryClass: z.string().optional(),
  estimatedDeliveryDays: z.number().int().optional(),
  deliveryEstimate: z.string().optional(),
  deliveryDisclaimer: z.string().optional(),
  draftId: z.string(),
  draftExpiresAt: z.string(),
  layoutType: z.enum(["text_only", "header_image", "inline_image"]),
  usedSavedReturnAddress: z.boolean().optional(),
  savedReturnAddressNote: z.string().optional(),
  senderName: z.string().optional(),
  recipientName: z.string().optional(),
  senderAddressValidation: addressValidationZ.optional(),
  recipientAddressValidation: addressValidationZ.optional()
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
    recipientName: z.string().optional(),
    mailType: z.string().optional(),
    status: z.string().optional(),
    currentStatus: z.string().optional(),
    sentAt: z.string().optional(),
    createdAt: z.string().optional()
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
  deliveryClass: z.string().optional(),
  estimatedDeliveryDays: z.number().int().optional(),
  deliveryEstimate: z.string().optional(),
  deliveryDisclaimer: z.string().optional(),
  draftId: z.string(),
  draftExpiresAt: z.string(),
  message: z.string().optional(),
  recipientName: z.string().optional(),
  senderName: z.string().optional(),
  usedSavedReturnAddress: z.boolean().optional(),
  savedReturnAddressNote: z.string().optional(),
  senderAddressValidation: addressValidationZ.optional(),
  recipientAddressValidation: addressValidationZ.optional()
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

export const getStartedOutputZ = z.object({
  title: z.string(),
  overview: z.string(),
  purchaseStep: z.string(),
  examplePrompts: z.array(z.string())
});

export const uploadImageOutputZ = z.object({
  status: z.string(),
  message: z.string(),
  acceptedFormats: z.string(),
  maxSizeMB: z.number(),
  context: z.string(),
  debugEnabled: z.boolean(),
  debugEndpoint: z.string().optional()
});

export const generateImageOutputZ = z.object({
  message: z.string(),
  suggestedNextStep: z.string(),
  generationsRemaining: z.number().int(),
  generatedImageUrl: z.string().optional()
});

export const confirmUploadedImageOutputZ = z.object({
  status: z.string(),
  imageUrl: z.string(),
  suggestedNextStep: z.string()
});
