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

// ============================================================================
// Upload Image Schema (Widget-based image upload)
// ============================================================================

export const uploadImageInputZ = z.object({
  context: z.string().optional()
});
