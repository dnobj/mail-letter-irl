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

export const quoteAndPreviewInputSchema: JsonSchema = {
  type: "object",
  required: ["sender", "recipient", "bodyText", "signOff"],
  properties: {
    sender: addressSchema,
    recipient: addressSchema,
    bodyText: { type: "string" },
    signOff: { type: "string", description: "Closing/signature block" }
  }
};

export const quoteAndPreviewOutputSchema: JsonSchema = {
  type: "object",
  required: ["previewHtml", "letterCost", "canSendNow", "draftId", "draftExpiresAt"],
  properties: {
    previewHtml: { type: "string" },
    letterCost: { type: "number", description: "Number of letters this will cost (always 1 for standard letter)" },
    canSendNow: { type: "boolean" },
    reasonCannotSend: { type: "string" },
    deliveryClass: { type: "string" },
    estimatedDeliveryDays: { type: "integer" },
    draftId: { type: "string", description: "Unique draft ID required for send_letter" },
    draftExpiresAt: { type: "string", description: "ISO timestamp when draft expires (24h)" },
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
    currentStatus: { type: "string", enum: ["queued_for_print", "printing", "mailed"] },
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
    isRetry: { type: "boolean", description: "True if this was an idempotent retry (draft already consumed)" }
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
  required: ["orderId", "currentStatus", "statusTimeline", "recipientSummary", "previewThumbnailHtml"],
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
    previewThumbnailHtml: { type: "string" },
    canSendFollowUp: { type: "boolean" },
    followUpSuggestedPrompt: { type: "string" }
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
    }
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
    }
  }
};

export const quoteAndPreviewPostcardOutputSchema: JsonSchema = {
  type: "object",
  required: ["previewFrontHtml", "previewBackHtml", "postcardCost", "canSendNow", "draftId", "draftExpiresAt"],
  properties: {
    previewFrontHtml: { type: "string", description: "HTML preview of postcard front (image)" },
    previewBackHtml: { type: "string", description: "HTML preview of postcard back (message)" },
    postcardCost: { type: "number", description: "Cost in letters (always 1 for 6x9 postcard)" },
    canSendNow: { type: "boolean" },
    reasonCannotSend: { type: "string" },
    deliveryClass: { type: "string" },
    estimatedDeliveryDays: { type: "integer" },
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
    currentStatus: { type: "string", enum: ["queued_for_print", "printing", "mailed"] },
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
    isRetry: { type: "boolean", description: "True if this was an idempotent retry (draft already consumed)" }
  }
};
