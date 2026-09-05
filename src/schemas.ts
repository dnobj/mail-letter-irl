import { JsonSchema } from "./contracts/types.js";

export const addressSchema: JsonSchema = {
  type: "object",
  required: ["name", "addressLine1", "city", "state", "postalCode", "country"],
  properties: {
    name: { type: "string" },
    addressLine1: { type: "string" },
    addressLine2: { type: "string" },
    city: { type: "string" },
    state: { type: "string" },
    postalCode: { type: "string" },
    country: { type: "string" }
  }
};

// ============================================================================
// Letter Schemas - Three Separate Tools
// ============================================================================

// Text-only letter (simplified - NO image params)
export const quoteAndPreviewLetterTextOnlyInputSchema: JsonSchema = {
  type: "object",
  required: ["recipient", "bodyText", "signOff"],
  properties: {
    sender: {
      ...addressSchema,
      description: "Return address (optional - will use saved return address if not provided)"
    },
    recipient: addressSchema,
    bodyText: { type: "string", description: "Letter body. Must not exceed 1600 characters OR 24 lines. Write as continuous paragraphs - do NOT put blank lines between sentences." },
    signOff: { type: "string", description: "Closing/signature (e.g., 'Sincerely, Name')" }
  }
};

// Header image letter - image field MUST be explicitly defined for fileParams
export const quoteAndPreviewLetterWithHeaderImageInputSchema: JsonSchema = {
  type: "object",
  required: ["recipient", "bodyText", "signOff"],
  properties: {
    sender: {
      ...addressSchema,
      description: "Return address (optional - will use saved return address if not provided)"
    },
    recipient: addressSchema,
    bodyText: { type: "string", description: "Letter body. Must not exceed 1100 characters OR 17 lines. Write as continuous paragraphs - do NOT put blank lines between sentences." },
    signOff: { type: "string", description: "Closing/signature (e.g., 'Sincerely, Name')" },
    // Image from file attachment - OpenAI Apps SDK requires explicit schema definition
    // Schema tells OpenAI how to transform file attachments into the expected format
    image: {
      type: "object",
      description: "Header image file attachment (recommended method)",
      // The Apps SDK file-param contract requires ALL FOUR properties declared
      // and ONLY download_url + file_id required; a deviating schema is
      // silently rejected by the platform's tool scan, which disables the
      // file transform entirely and leaves the model improvising bare
      // strings (issue #227's tool-call evidence).
      properties: {
        download_url: { type: "string" },
        file_id: { type: "string" },
        mime_type: { type: "string" },
        file_name: { type: "string" }
      },
      required: ["download_url", "file_id"]
    },
    imageUrl: {
      type: "string",
      description: "URL of header image (fallback if no file attached)"
    }
  }
};

// Inline image letter - image field MUST be explicitly defined for fileParams
export const quoteAndPreviewLetterWithImageInputSchema: JsonSchema = {
  type: "object",
  required: ["recipient", "bodyText", "signOff"],
  properties: {
    sender: {
      ...addressSchema,
      description: "Return address (optional - will use saved return address if not provided)"
    },
    recipient: addressSchema,
    bodyText: { type: "string", description: "Letter body. Must not exceed 800 characters OR 12 lines. Write as continuous paragraphs - do NOT put blank lines between sentences." },
    signOff: { type: "string", description: "Closing/signature (e.g., 'Sincerely, Name')" },
    // Image from file attachment - OpenAI Apps SDK requires explicit schema definition
    // Schema tells OpenAI how to transform file attachments into the expected format
    image: {
      type: "object",
      description: "Image file attachment (recommended method)",
      // Same four-property contract as the header-image schema above.
      properties: {
        download_url: { type: "string" },
        file_id: { type: "string" },
        mime_type: { type: "string" },
        file_name: { type: "string" }
      },
      required: ["download_url", "file_id"]
    },
    imageUrl: {
      type: "string",
      description: "URL of image (fallback if no file attached)"
    }
  }
};

// DEPRECATED - kept for reference, will be removed
export const quoteAndPreviewInputSchema: JsonSchema = {
  type: "object",
  required: ["sender", "recipient", "bodyText", "signOff"],
  additionalProperties: true,
  properties: {
    sender: addressSchema,
    recipient: addressSchema,
    bodyText: { type: "string" },
    signOff: { type: "string", description: "Closing/signature block" },
    imageUrl: {
      type: "string",
      description: "URL of image to include in the letter (fallback if no file attached)"
    },
    imagePlacement: {
      type: "string",
      enum: ["header", "inline"],
      description: "Where to place image: 'header' (top, like letterhead) or 'inline' (after signature, default)"
    }
  }
};

const sendEligibilitySchema: JsonSchema = {
  type: "object",
  required: ["payAndSend", "letterPack"],
  properties: {
    payAndSend: {
      type: "object",
      required: ["available"],
      properties: {
        available: { type: "boolean" },
        amountCents: { type: "integer" },
        currency: { type: "string" },
        // Declared HERE as well as in zodSchemas.ts. This file is the schema
        // /manifest.json publishes (manifest.ts -> LetterIrlServer.listTools),
        // and it is a genuinely served surface: a consumer that derives the
        // tool's output shape from the manifest saw no displayAmount, dropped
        // it, and fell back to amountCents/100 - 100x wrong for a
        // zero-decimal currency, the exact bug the server-side formatting was
        // added to fix, still live on the second surface. Four round-10
        // angles found it; schemaConsistency.test.ts now compares the layers.
        displayAmount: { type: "string" },
        productDescription: { type: "string" },
        unavailableReason: { type: "string" }
      }
    },
    letterPack: {
      type: "object",
      required: ["available", "purchaseUrl"],
      properties: {
        available: { type: "boolean" },
        purchaseUrl: { type: "string" }
      }
    }
  }
};

export const quoteAndPreviewOutputSchema: JsonSchema = {
  type: "object",
  required: ["previewHtml", "lettersRequired", "canSendNow", "sendEligibility", "draftId", "draftExpiresAt", "layoutType"],
  properties: {
    previewHtml: { type: "string" },
    lettersRequired: { type: "number", description: "Letters required from balance (always 1 for standard letter)" },
    canSendNow: { type: "boolean" },
    reasonCannotSend: { type: "string" },
    sendEligibility: sendEligibilitySchema,
    deliveryClass: { type: "string" },
    estimatedDeliveryDays: { type: "integer" },
    deliveryEstimate: { type: "string" },
    deliveryDisclaimer: { type: "string" },
    draftId: { type: "string", description: "Unique draft ID required for send_letter" },
    draftExpiresAt: { type: "string", description: "ISO timestamp when draft expires (24h)" },
    layoutType: {
      type: "string",
      enum: ["text_only", "header_image", "inline_image"],
      description: "Detected or specified layout type"
    },
    headerImageData: {
      type: "string",
      description: "Base64 data URI of processed header image (for widget preview)"
    },
    inlineImageData: {
      type: "string",
      description: "Base64 data URI of processed inline image (for widget preview)"
    },
    senderAddressValidation: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["verified", "corrected", "failed"] },
        errors: { type: "array", items: { type: "string" } },
        suggestions: { type: "string" }
      }
    },
    recipientAddressValidation: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["verified", "corrected", "failed"] },
        errors: { type: "array", items: { type: "string" } },
        suggestions: { type: "string" }
      }
    }
  }
};

export const sendLetterInputSchema: JsonSchema = {
  type: "object",
  required: ["draftId", "confirm"],
  properties: {
    draftId: { type: "string", description: "Draft ID from quote_and_preview_letter" },
    confirm: { type: "boolean", description: "Must be true or request fails" }
  }
};

export const sendLetterOutputSchema: JsonSchema = {
  type: "object",
  required: ["orderId", "currentStatus", "statusTimeline", "recipientSummary", "lettersRemaining"],
  properties: {
    orderId: { type: "string" },
    currentStatus: { type: "string", enum: ["pending", "accepted", "printing", "in_transit", "delivered", "returned", "failed", "cancelled"] },
    statusTimeline: {
      type: "array",
      items: {
        type: "object",
        required: ["timestampISO", "statusText"],
        properties: {
          timestampISO: { type: "string" },
          statusText: { type: "string" }
        }
      }
    },
    recipientSummary: {
      type: "object",
      required: ["name", "city", "state"],
      properties: {
        name: { type: "string" },
        city: { type: "string" },
        state: { type: "string" }
      }
    },
    lettersRemaining: { type: "number", description: "Number of letters remaining in user's balance" },
    previewFirstPageHtml: { type: "string" },
    isRetry: { type: "boolean", description: "True if this was an idempotent retry (draft already consumed)" },
    trackingSupport: {
      type: "string",
      enum: ["none", "estimated_only", "carrier_tracking"],
      description: "Tracking capability level. 'estimated_only' = periodic status updates available but delivery is estimated (not confirmed). Use get_order_status to check current status."
    }
  }
};

export const createMailCheckoutInputSchema: JsonSchema = {
  type: "object",
  required: ["draftId"],
  properties: {
    draftId: {
      type: "string",
      description: "Owned pending draft ID from a letter or postcard preview"
    }
  }
};

export const createMailCheckoutOutputSchema: JsonSchema = {
  type: "object",
  required: ["orderId", "amountCents", "currency", "productDescription", "status", "reused", "message"],
  properties: {
    orderId: { type: "string" },
    checkoutUrl: { type: "string", description: "Stripe-hosted checkout URL" },
    amountCents: { type: "integer" },
    currency: { type: "string" },
    productDescription: { type: "string" },
    expiresAt: { type: "string" },
    status: { type: "string" },
    reused: { type: "boolean" },
    message: { type: "string" }
  }
};

export const listLetterPacksInputSchema: JsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {}
};

export const listLetterPacksOutputSchema: JsonSchema = {
  type: "object",
  required: ["packs", "message"],
  properties: {
    packs: {
      type: "array",
      items: {
        type: "object",
        required: ["pack", "letters", "amountCents", "currency", "displayAmount", "description"],
        properties: {
          pack: { type: "string", enum: ["starter", "regular", "power"] },
          letters: { type: "integer", description: "Letters this pack adds to the balance" },
          amountCents: { type: "integer" },
          currency: { type: "string" },
          displayAmount: { type: "string", description: "Server-formatted price for this currency" },
          description: { type: "string" }
        }
      }
    },
    message: { type: "string" }
  }
};

export const createPackCheckoutInputSchema: JsonSchema = {
  type: "object",
  required: ["pack"],
  properties: {
    pack: {
      type: "string",
      enum: ["starter", "regular", "power"],
      description: "Pack size: starter (2 letters), regular (5 letters), power (50 letters)"
    }
  }
};

export const createPackCheckoutOutputSchema: JsonSchema = {
  type: "object",
  required: [
    "orderId",
    "letters",
    "amountCents",
    "currency",
    "productDescription",
    "status",
    "reused",
    "message"
  ],
  properties: {
    orderId: { type: "string" },
    checkoutUrl: { type: "string", description: "Stripe-hosted checkout URL" },
    letters: { type: "integer", description: "Letters this pack adds to the balance" },
    amountCents: { type: "integer" },
    currency: { type: "string" },
    productDescription: { type: "string" },
    expiresAt: { type: "string" },
    status: { type: "string" },
    reused: { type: "boolean" },
    message: { type: "string" }
  }
};

export const redeemPromoCodeInputSchema: JsonSchema = {
  type: "object",
  required: ["code"],
  properties: {
    code: {
      type: "string",
      description: "The promo code to redeem"
    }
  }
};

export const redeemPromoCodeOutputSchema: JsonSchema = {
  type: "object",
  required: ["redeemed", "message"],
  properties: {
    redeemed: { type: "boolean" },
    letters: { type: "integer", description: "Letters added to the balance" },
    expiresAt: { type: "string", description: "When the added letters expire, if they do" },
    message: { type: "string" }
  }
};

export const getPurchaseStatusInputSchema: JsonSchema = {
  type: "object",
  required: ["orderId"],
  properties: {
    orderId: {
      type: "string",
      description: "Commerce order ID returned by checkout"
    }
  }
};

export const getPurchaseStatusOutputSchema: JsonSchema = {
  type: "object",
  required: ["orderId", "purchaseStatus", "orderStatus", "productDescription", "amountCents", "currency", "updatedAt", "message"],
  properties: {
    orderId: { type: "string" },
    purchaseStatus: {
      type: "string",
      enum: ["pending_payment", "processing", "submitted", "payment_failed", "refund_pending", "refunded", "on_hold", "cancelled"]
    },
    orderStatus: { type: "string" },
    productDescription: { type: "string" },
    amountCents: { type: "integer" },
    currency: { type: "string" },
    mailType: { type: "string", enum: ["letter", "postcard"] },
    letterId: { type: "string" },
    checkoutExpiresAt: { type: "string" },
    updatedAt: { type: "string" },
    message: { type: "string" }
  }
};

export const getOrderStatusInputSchema: JsonSchema = {
  type: "object",
  properties: {
    orderId: { type: "string" }
  }
};

export const getOrderStatusOutputSchema: JsonSchema = {
  type: "object",
  // Note: previewThumbnailHtml removed for performance (US-LETTER-04, GitHub #83)
  required: ["orderId", "currentStatus", "statusTimeline", "recipientSummary", "trackingSupport"],
  properties: {
    orderId: { type: "string" },
    currentStatus: { type: "string" },
    statusTimeline: {
      type: "array",
      items: {
        type: "object",
        required: ["timestampISO", "statusText"],
        properties: {
          timestampISO: { type: "string" },
          statusText: { type: "string" }
        }
      }
    },
    recipientSummary: {
      type: "object",
      required: ["name", "city", "state"],
      properties: {
        name: { type: "string" },
        city: { type: "string" },
        state: { type: "string" }
      }
    },
    canSendFollowUp: { type: "boolean" },
    followUpSuggestedPrompt: { type: "string" },
    trackingSupport: {
      type: "string",
      enum: ["none", "estimated_only", "carrier_tracking"],
      description: "Tracking capability level. 'estimated_only' = periodic status updates available but delivery is estimated based on mail timing, not confirmed by carrier."
    }
  }
};

export const getAccountBalanceInputSchema: JsonSchema = {
  type: "object",
  properties: {}
};

export const getAccountBalanceOutputSchema: JsonSchema = {
  type: "object",
  required: ["lettersRemaining", "canSendStandardLetter"],
  properties: {
    lettersRemaining: { type: "number", description: "Number of letters remaining in user's balance" },
    canSendStandardLetter: { type: "boolean" },
    message: { type: "string" },
    lettersExpiringSoon: { type: "number", description: "Number of letters expiring within 7 days" },
    expiringLettersDetails: {
      type: "array",
      items: {
        type: "object",
        properties: {
          letters: { type: "number" },
          expiresAt: { type: "string" },
          daysUntilExpiry: { type: "number" }
        }
      }
    },
    imageGenerationsRemaining: { type: "integer", description: "Number of explicit image-entitlement units remaining" },
    imageGenerationsAllowance: { type: "integer", description: "Total image-entitlement units granted by qualifying purchases" }
  }
};

export const listOrdersInputSchema: JsonSchema = {
  type: "object",
  properties: {
    limit: { type: "number", description: "Maximum number of orders to return (default: 10)" }
  }
};

export const listOrdersOutputSchema: JsonSchema = {
  type: "object",
  required: ["orders", "total"],
  properties: {
    orders: {
      type: "array",
      items: {
        type: "object",
        required: ["orderId", "recipient", "status", "sentAt"],
        properties: {
          orderId: { type: "string" },
          recipient: {
            type: "object",
            required: ["name", "city", "state"],
            properties: {
              name: { type: "string" },
              city: { type: "string" },
              state: { type: "string" }
            }
          },
          status: { type: "string" },
          sentAt: { type: "string" }
        }
      }
    },
    total: { type: "number", description: "Total number of orders for this user" }
  }
};

// ============================================================================
// Postcard Schemas (US-POSTCARD-01, US-POSTCARD-02)
// ============================================================================

export const quoteAndPreviewPostcardInputSchema: JsonSchema = {
  type: "object",
  required: ["recipient", "message"],
  properties: {
    sender: {
      ...addressSchema,
      description: "Return address (optional - will use saved return address if not provided)"
    },
    recipient: addressSchema,
    message: {
      type: "string",
      description: "Message for back of postcard (max ~400 characters)",
      maxLength: 500
    },
    size: {
      type: "string",
      enum: ["6x9"],
      default: "6x9",
      description: "Postcard size (currently only 6x9 is supported)"
    },
    // Image from file attachment - OpenAI Apps SDK requires explicit schema definition
    // Schema tells OpenAI how to transform file attachments into the expected format
    image: {
      type: "object",
      description: "Image file attachment for postcard front (recommended method)",
      // Same four-property contract as the letter image schemas above.
      properties: {
        download_url: { type: "string" },
        file_id: { type: "string" },
        mime_type: { type: "string" },
        file_name: { type: "string" }
      },
      required: ["download_url", "file_id"]
    },
    imageUrl: {
      type: "string",
      description: "REQUIRED when using a hosted image: set this to the imageUrl returned by confirm_uploaded_image (the upload widget flow) or another publicly accessible image URL. This is the URL of the image for the postcard front."
    }
  }
};

export const quoteAndPreviewPostcardOutputSchema: JsonSchema = {
  type: "object",
  required: ["previewFrontHtml", "previewBackHtml", "lettersRequired", "canSendNow", "sendEligibility", "draftId", "draftExpiresAt"],
  properties: {
    previewFrontHtml: { type: "string", description: "HTML preview of postcard front (image)" },
    previewBackHtml: { type: "string", description: "HTML preview of postcard back (message)" },
    lettersRequired: { type: "number", description: "Letters required from balance (always 1 for 6x9 postcard)" },
    canSendNow: { type: "boolean" },
    reasonCannotSend: { type: "string" },
    sendEligibility: sendEligibilitySchema,
    deliveryClass: { type: "string" },
    estimatedDeliveryDays: { type: "integer" },
    deliveryEstimate: { type: "string" },
    deliveryDisclaimer: { type: "string" },
    draftId: { type: "string", description: "Unique draft ID required for send_postcard" },
    draftExpiresAt: { type: "string", description: "ISO timestamp when draft expires (24h)" },
    usedSavedReturnAddress: { type: "boolean" },
    savedReturnAddressNote: { type: "string" },
    senderAddressValidation: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["verified", "corrected", "failed"] },
        errors: { type: "array", items: { type: "string" } },
        suggestions: { type: "string" }
      }
    },
    recipientAddressValidation: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["verified", "corrected", "failed"] },
        errors: { type: "array", items: { type: "string" } },
        suggestions: { type: "string" }
      }
    }
  }
};

export const sendPostcardInputSchema: JsonSchema = {
  type: "object",
  required: ["draftId", "confirm"],
  properties: {
    draftId: { type: "string", description: "Draft ID from quote_and_preview_postcard" },
    confirm: { type: "boolean", description: "Must be true or request fails" }
  }
};

export const sendPostcardOutputSchema: JsonSchema = {
  type: "object",
  required: ["orderId", "currentStatus", "statusTimeline", "recipientSummary", "lettersRemaining"],
  properties: {
    orderId: { type: "string" },
    currentStatus: { type: "string", enum: ["pending", "accepted", "printing", "in_transit", "delivered", "returned", "failed", "cancelled"] },
    statusTimeline: {
      type: "array",
      items: {
        type: "object",
        required: ["timestampISO", "statusText"],
        properties: {
          timestampISO: { type: "string" },
          statusText: { type: "string" }
        }
      }
    },
    recipientSummary: {
      type: "object",
      required: ["name", "city", "state"],
      properties: {
        name: { type: "string" },
        city: { type: "string" },
        state: { type: "string" }
      }
    },
    lettersRemaining: { type: "number", description: "Number of letters remaining in user's balance" },
    previewFrontHtml: { type: "string" },
    previewBackHtml: { type: "string" },
    isRetry: { type: "boolean", description: "True if this was an idempotent retry (draft already consumed)" },
    trackingSupport: {
      type: "string",
      enum: ["none", "estimated_only", "carrier_tracking"],
      description: "Tracking capability level. 'estimated_only' = periodic status updates available but delivery is estimated (not confirmed). Use get_order_status to check current status."
    }
  }
};

// ============================================================================
// Feature Request Schemas (US-FEEDBACK-01)
// ============================================================================

export const submitFeatureRequestInputSchema: JsonSchema = {
  type: "object",
  required: ["title", "description"],
  properties: {
    title: {
      type: "string",
      description: "Brief title for the feature request (max 200 characters)",
      maxLength: 200
    },
    description: {
      type: "string",
      description: "Detailed description of the feature you'd like to see (max 2000 characters)",
      maxLength: 2000
    },
    category: {
      type: "string",
      enum: ["new_feature", "improvement", "integration", "mail_type", "international", "other"],
      description: "Category of the feature request. Defaults to 'other' if not specified."
    },
    attemptedAction: {
      type: "string",
      description: "What you were trying to do when you realized this feature was needed (max 255 characters)",
      maxLength: 255
    },
    contactEmail: {
      type: "string",
      description: "Email address to contact about this feature request (optional, uses account email if not provided)",
      maxLength: 255
    },
    okToContact: {
      type: "boolean",
      description: "Whether the user consents to being contacted about this feature request"
    }
  }
};

export const submitFeatureRequestOutputSchema: JsonSchema = {
  type: "object",
  required: ["success", "requestId", "message", "category"],
  properties: {
    success: {
      type: "boolean",
      description: "Whether the feature request was submitted successfully"
    },
    requestId: {
      type: "string",
      description: "Unique identifier for the submitted feature request"
    },
    message: {
      type: "string",
      description: "Confirmation message to display to the user"
    },
    category: {
      type: "string",
      description: "The category assigned to the feature request"
    }
  }
};

// ============================================================================
// Upload Image Schemas (Widget-based image upload)
// ============================================================================

export const uploadImageInputSchema: JsonSchema = {
  type: "object",
  properties: {
    context: {
      type: "string",
      description: "Optional hint for widget guidance text: 'postcard', 'header_image', or 'inline_image'"
    }
  }
};

export const uploadImageOutputSchema: JsonSchema = {
  type: "object",
  required: ["status", "message", "acceptedFormats", "maxSizeMB", "context", "debugEnabled"],
  properties: {
    status: {
      type: "string",
      description: "Always 'awaiting_upload' — actual upload happens in widget"
    },
    message: {
      type: "string",
      description: "Guidance text for the user based on context"
    },
    acceptedFormats: {
      type: "string",
      description: "Accepted image formats (e.g., 'JPEG, PNG, WebP')"
    },
    maxSizeMB: {
      type: "number",
      description: "Maximum file size in megabytes"
    },
    context: {
      type: "string",
      description: "Usage context passed through from input: 'postcard', 'header_image', 'inline_image', or empty string"
    },
    debugEnabled: {
      type: "boolean",
      description: "True when server-side DEBUG flag enables widget diagnostic logging"
    },
    debugEndpoint: {
      type: "string",
      description: "Optional absolute URL for debug beacon ingestion"
    }
  }
};

// ============================================================================
// Confirm Uploaded Image Schemas (Widget relay for upload URL)
// ============================================================================

export const confirmUploadedImageInputSchema: JsonSchema = {
  type: "object",
  required: ["imageUrl"],
  properties: {
    imageUrl: {
      type: "string",
      description: "Download URL of the uploaded image"
    },
    context: {
      type: "string",
      description: "Usage context: 'postcard', 'header_image', or 'inline_image'"
    }
  }
};

export const confirmUploadedImageOutputSchema: JsonSchema = {
  type: "object",
  required: ["status", "imageUrl", "suggestedNextStep"],
  properties: {
    status: {
      type: "string",
      description: "Always 'ready' — image has been uploaded and URL is available"
    },
    imageUrl: {
      type: "string",
      description: "Download URL of the uploaded image"
    },
    suggestedNextStep: {
      type: "string",
      description: "Instruction for which preview tool to call next with the imageUrl"
    }
  }
};
