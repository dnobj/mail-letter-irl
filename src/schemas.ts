import { JsonSchema } from "./contracts/types.js";
import { MAX_LETTER_PAGES } from "./render/geometry.js";
import {
  ARRIVAL_WINDOW_DESCRIPTION,
  ARRIVE_BY_DESCRIPTION,
  HEADLINE_DESCRIPTION,
  MONOGRAM_DESCRIPTION,
  PREVIEW_PAGES_DESCRIPTION,
  WORDS_VERSION_DESCRIPTION,
  SET_LETTER_WORDS_VERSION_DESCRIPTION,
  SET_LETTER_WORDS_BODY_DESCRIPTION,
  SET_LETTER_WORDS_SIGN_OFF_DESCRIPTION,
  SET_LETTER_WORDS_CAN_SEND_DESCRIPTION,
  PREVIEW_STATIONERY_DESCRIPTION,
  STATIONERY_SOURCE_DESCRIPTION,
  SET_ARRIVE_BY_DESCRIPTION,
  SET_STATIONERY_DESCRIPTION,
  SET_STATIONERY_OUTPUT_DESCRIPTION,
  STATIONERY_DESCRIPTION,
  SET_POSTCARD_SIZE_DESCRIPTION,
  SET_POSTCARD_LAYOUT_DESCRIPTION,
  POSTCARD_CAPTION_DESCRIPTION,
  POSTCARD_PLACE_DESCRIPTION,
  SET_POSTCARD_STYLE_SIZE_OUTPUT_DESCRIPTION,
  SET_POSTCARD_STYLE_CAN_SEND_DESCRIPTION,
  ADDRESS_REQUEST_RECIPIENT_NAME_DESCRIPTION,
  ADDRESS_REQUEST_SENDER_FIRST_NAME_DESCRIPTION,
  ADDRESS_REQUEST_ID_DESCRIPTION,
  ADDRESS_REQUEST_STATES,
  ADDRESS_REQUEST_STATUS_DESCRIPTION,
  ADDRESS_REQUEST_RECIPIENT_DESCRIPTION
} from "./zodSchemas.js";
import { STATIONERY_THEMES } from "./render/stationery.js";

/** Arrive-by (#535): the preview's input, and what its output says. */
const arriveBySchema = { type: "string", description: ARRIVE_BY_DESCRIPTION } as const;
const previewScheduleSchema = {
  type: "object",
  description: "The arrival date asked for, when there was one (#535): when it goes to the printer and the dates on offer",
  properties: {
    arriveBy: { type: "string", description: "The date it should arrive by, YYYY-MM-DD in New York" },
    mailOn: { type: "string", description: "The day it goes to the printer, YYYY-MM-DD" },
    releasesAt: { type: "string", description: "ISO time the hold ends: 09:00 New York time on the mail date, sent to the printer within the hour" },
    earliestArrival: { type: "string", description: "The first arrival date on offer, YYYY-MM-DD" },
    latestArrival: { type: "string", description: "The last arrival date on offer, YYYY-MM-DD" }
  },
  required: ["arriveBy", "mailOn", "releasesAt", "earliestArrival", "latestArrival"]
} as const;

/** Stationery (#563): the letter previews' input, and what their output says. */
const stationeryInputSchemas = {
  stationery: { type: "string", enum: [...STATIONERY_THEMES], description: STATIONERY_DESCRIPTION },
  monogram: { type: "string", description: MONOGRAM_DESCRIPTION },
  headline: { type: "string", description: HEADLINE_DESCRIPTION }
} as const;
const previewStationerySchema = {
  type: "object",
  description: PREVIEW_STATIONERY_DESCRIPTION,
  properties: {
    theme: { type: "string", enum: [...STATIONERY_THEMES] },
    dateLine: { type: "string", description: "The date it prints at the top right, as written" },
    monogram: { type: "string", description: "The initials it prints" },
    headline: { type: "string", description: "The headline it prints above the letter" },
    source: { type: "string", enum: ["asked", "remembered", "default"], description: STATIONERY_SOURCE_DESCRIPTION }
  },
  required: ["theme", "source"]
} as const;

const arrivalWindowSchema = {
  type: "object",
  description: ARRIVAL_WINDOW_DESCRIPTION,
  properties: {
    earliestArrival: { type: "string", description: "The first arrival date on offer, YYYY-MM-DD" },
    latestArrival: { type: "string", description: "The last arrival date on offer, YYYY-MM-DD" }
  },
  required: ["earliestArrival", "latestArrival"]
} as const;

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
    signOff: { type: "string", description: "Closing/signature (e.g., 'Sincerely, Name')" },
    sendAsGift: {
      type: "boolean",
      description: "Set true only when the user asks to send this as their gift letter: it is free and adds a printed page with a card for the recipient. Leave it out otherwise; a gift letter is then used only if the balance cannot pay."
    },
    arriveBy: arriveBySchema,
    ...stationeryInputSchemas
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
    bodyText: { type: "string", description: "Letter body. Must not exceed 1100 characters OR 15 lines. Write as continuous paragraphs - do NOT put blank lines between sentences." },
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
    },
    sendAsGift: {
      type: "boolean",
      description: "Set true only when the user asks to send this as their gift letter: it is free and adds a printed page with a card for the recipient. Leave it out otherwise; a gift letter is then used only if the balance cannot pay."
    },
    arriveBy: arriveBySchema,
    ...stationeryInputSchemas
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
    },
    sendAsGift: {
      type: "boolean",
      description: "Set true only when the user asks to send this as their gift letter: it is free and adds a printed page with a card for the recipient. Leave it out otherwise; a gift letter is then used only if the balance cannot pay."
    },
    arriveBy: arriveBySchema,
    ...stationeryInputSchemas
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
        unavailableReason: { type: "string" },
        pageUrl: {
          type: "string",
          description: "Where the person pays for this with Pay & Send and so sends it, in an app that cannot open Pay & Send itself"
        }
      }
    },
    letterPack: {
      type: "object",
      required: ["available", "purchaseUrl"],
      properties: {
        available: { type: "boolean" },
        purchaseUrl: { type: "string" }
      }
    },
    packPays: {
      type: "boolean",
      const: false,
      description: "False when letter packs and gift letters cannot pay for this mail: it is paid with Pay & Send, whatever the balance"
    }
  }
};

export const quoteAndPreviewOutputSchema: JsonSchema = {
  type: "object",
  required: ["previewHtml", "lettersRequired", "canSendNow", "sendEligibility", "draftId", "draftExpiresAt", "layoutType"],
  properties: {
    giftCard: {
      type: "object",
      description: "Present on a gift send: the card its extra printed page carries",
      properties: {
        state: { type: "string", enum: ["funded", "unfunded"] },
        description: { type: "string" }
      }
    },
    giftLettersAvailable: { type: "integer", description: "Unsent gift letters on the account, when there are any" },
    schedule: previewScheduleSchema,
    arrivalWindow: arrivalWindowSchema,
    stationery: previewStationerySchema,
    pages: { type: "integer", minimum: 2, maximum: MAX_LETTER_PAGES, description: PREVIEW_PAGES_DESCRIPTION },
    wordsVersion: { type: "string", description: WORDS_VERSION_DESCRIPTION },
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
    confirm: { type: "boolean", description: "Must be true or request fails" },
    sendAnotherCopy: {
      type: "boolean",
      description: "Set true only after the user explicitly asks for another copy of mail that was already sent or paid for in the last 24 hours. Leave it out otherwise."
    }
  }
};

export const sendLetterOutputSchema: JsonSchema = {
  type: "object",
  required: ["orderId", "currentStatus", "statusTimeline", "recipientSummary", "lettersRemaining"],
  properties: {
    orderId: { type: "string" },
    currentStatus: { type: "string", enum: ["pending", "accepted", "printing", "in_transit", "delivered", "returned", "failed", "cancelled", "scheduled"] },
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
    schedule: {
      type: "object",
      description: "Sent with an arrival date: the date it aims to arrive by and the day it goes to the printer, YYYY-MM-DD. It waits until then.",
      properties: { arriveBy: { type: "string" }, mailOn: { type: "string" } },
      required: ["arriveBy", "mailOn"]
    },
    cancellable: { type: "boolean", description: "With an arrival date: whether it can still be cancelled free, before it goes to the printer" },
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
    },
    sendAnotherCopy: {
      type: "boolean",
      description: "Set true only after the user explicitly asks for another copy of mail that was already sent or paid for in the last 24 hours. Leave it out otherwise."
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
    "displayAmount",
    "productDescription",
    "status",
    "reused",
    "message"
  ],
  properties: {
    orderId: { type: "string" },
    checkoutUrl: {
      type: "string",
      description:
        "Stripe-hosted checkout URL. Present it to the customer as a link to click; nothing opens on its own."
    },
    checkoutStartUrl: {
      type: "string",
      description:
        "Same checkout via Letter IRL's start page, which records the way back into the conversation; used by the card. Present checkoutUrl to the customer."
    },
    letters: { type: "integer", description: "Letters this pack adds to the balance" },
    amountCents: { type: "integer" },
    currency: { type: "string" },
    displayAmount: { type: "string", description: "Amount formatted for the currency, e.g. 5.00" },
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
    giftLetters: { type: "integer", description: "Gift letters added: free sends that print a card for the recipient" },
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
    letters: { type: "integer" },
    lettersRemaining: { type: "integer" },
    lettersRefunded: { type: "integer" },
    perLetterCents: { type: "integer" },
    refundableAmountCents: { type: "integer" },
    amountRefundedCents: { type: "integer" },
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
    arriveBy: { type: "string", description: "Sent with an arrival date: the date it aims to arrive by, YYYY-MM-DD" },
    mailOn: { type: "string", description: "Sent with an arrival date: the day it goes to the printer, YYYY-MM-DD" },
    cancellable: { type: "boolean", description: "With an arrival date: whether it can still be cancelled free, before it goes to the printer" },
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
    imageGenerationsAllowance: { type: "integer", description: "Total image-entitlement units granted by qualifying purchases" },
    giftLettersRemaining: { type: "integer", description: "Unsent gift letters: free sends that print a card for the recipient. Not included in lettersRemaining." }
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
  required: ["orders", "total", "packPurchases", "packPurchaseTotal"],
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
          sentAt: { type: "string" },
          arriveBy: { type: "string", description: "Sent with an arrival date: the date it aims to arrive by, YYYY-MM-DD" },
          mailOn: { type: "string", description: "Sent with an arrival date: the day it goes to the printer, YYYY-MM-DD" },
          cancellable: { type: "boolean", description: "With an arrival date: whether it can still be cancelled free, before it goes to the printer" }
        }
      }
    },
    total: { type: "number", description: "Total number of orders for this user" },
    packPurchases: {
      type: "array",
      description: "Letter pack purchases, newest first. Use the orderId with get_purchase_status.",
      items: {
        type: "object",
        required: [
          "orderId",
          "productDescription",
          "letters",
          "purchaseStatus",
          "amountCents",
          "currency",
          "displayAmount",
          "createdAt"
        ],
        properties: {
          orderId: { type: "string" },
          productDescription: { type: "string" },
          letters: { type: "number", description: "Letters the pack adds to the account" },
          purchaseStatus: {
            type: "string",
            enum: [
              "pending_payment",
              "processing",
              "submitted",
              "payment_failed",
              "refund_pending",
              "refunded",
              "on_hold",
              "cancelled"
            ],
            description: "submitted means paid and the letters are on the account"
          },
          amountCents: { type: "number" },
          currency: { type: "string" },
          displayAmount: { type: "string", description: "Amount formatted for the currency, e.g. 5.00" },
          createdAt: { type: "string" }
        }
      }
    },
    packPurchaseTotal: { type: "number", description: "Total number of letter pack purchases for this user" }
  }
};

// ============================================================================
// Postcard Schemas (US-POSTCARD-01, US-POSTCARD-02)
// ============================================================================

/**
 * The postcard preview's `message` and `size` as /manifest.json serves them
 * while the 4x6 and 11x6 are not offered (#594): exactly as before them, the
 * 6x9 alone and its message's limit.
 */
export const postcardSixByNineProperties: Record<string, JsonSchema> = {
  message: {
    type: "string",
    description: "Message for the back of the postcard. It must fit the back: 16 lines, about 500 characters of prose",
    maxLength: 1000
  },
  size: {
    type: "string",
    enum: ["6x9"],
    default: "6x9",
    description: "Postcard size (currently only 6x9 is supported)"
  }
};

export const quoteAndPreviewPostcardInputSchema: JsonSchema = {
  type: "object",
  required: ["recipient", "message"],
  properties: {
    sender: {
      ...addressSchema,
      description: "Return address (optional - will use saved return address if not provided)"
    },
    recipient: addressSchema,
    // An 11x6's message may run to 2,000 characters (#594); the 6x9's to 1,000.
    message: {
      type: "string",
      description: "Message for the back of the postcard. It must fit the back: 16 lines, about 500 characters of prose",
      maxLength: 2000
    },
    size: {
      type: "string",
      enum: ["6x9", "6x4", "6x11"],
      default: "6x9",
      description:
        "The postcard's size: 6x9 (the default), 6x4 for a 4 x 6 in postcard, or 6x11 for an 11 x 6 in one. " +
        "A 4x6 holds 11 lines on its back, about 350 characters of prose; an 11x6 16 lines, about 900. " +
        "Letter packs and gift letters pay only for a 6x9: a 4x6 or 11x6 is paid with Pay & Send."
    },
    // The front's layout (#594): withheld while layouts are not offered (withheldInputKeys).
    layout: {
      type: "string",
      enum: ["full_bleed", "border", "greetings"],
      default: "full_bleed",
      description:
        "The front's layout: full_bleed (the default), the photo across the whole front; border, the photo in a white border " +
        "with a caption under it; or greetings, \"Greetings from\" a place over the photo."
    },
    caption: {
      type: "string",
      description: "For the border layout only: one handwritten line under the photo, such as \"Cape Cod, August 2026\". Leave it out for none."
    },
    place: {
      type: "string",
      description: "For the greetings layout only, and needed there: the place it greets from, such as \"Asheville\", printed in capitals."
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
    },
    sendAsGift: {
      type: "boolean",
      description: "Set true only when the user asks to send this as their gift letter: it is free and adds a printed page with a card for the recipient. Leave it out otherwise; a gift letter is then used only if the balance cannot pay."
    },
    arriveBy: arriveBySchema
  }
};

export const quoteAndPreviewPostcardOutputSchema: JsonSchema = {
  type: "object",
  required: ["previewFrontHtml", "previewBackHtml", "lettersRequired", "canSendNow", "sendEligibility", "draftId", "draftExpiresAt"],
  properties: {
    giftCard: {
      type: "object",
      description: "Present on a gift send: the card its extra printed page carries",
      properties: {
        state: { type: "string", enum: ["funded", "unfunded"] },
        description: { type: "string" }
      }
    },
    giftLettersAvailable: { type: "integer", description: "Unsent gift letters on the account, when there are any" },
    schedule: previewScheduleSchema,
    arrivalWindow: arrivalWindowSchema,
    previewFrontHtml: { type: "string", description: "HTML preview of postcard front (image)" },
    previewBackHtml: { type: "string", description: "HTML preview of postcard back (message)" },
    previewHtml: { type: "string", description: "The postcard as it prints, front and back as SVG, when our renderer drew it (#534)" },
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
    confirm: { type: "boolean", description: "Must be true or request fails" },
    sendAnotherCopy: {
      type: "boolean",
      description: "Set true only after the user explicitly asks for another copy of mail that was already sent or paid for in the last 24 hours. Leave it out otherwise."
    }
  }
};

export const uploadPhotoChunkInputSchema: JsonSchema = {
  type: "object",
  required: ["uploadId", "index", "total", "data"],
  properties: {
    uploadId: { type: "string", description: "The card's id for this upload, a UUID" },
    index: { type: "integer", minimum: 0, description: "This chunk's place, from 0" },
    total: { type: "integer", minimum: 1, maximum: 24, description: "How many chunks the photo has" },
    data: { type: "string", maxLength: 524288, description: "This chunk of the photo, base64" },
    context: { type: "string", enum: ["postcard", "header_image", "inline_image"] }
  }
};

export const uploadPhotoChunkOutputSchema: JsonSchema = {
  type: "object",
  required: ["uploadId", "received", "total", "done"],
  properties: {
    uploadId: { type: "string" },
    received: { type: "integer" },
    total: { type: "integer" },
    done: { type: "boolean" },
    width: { type: "integer" },
    height: { type: "integer" }
  }
};

export const getDraftStatusInputSchema: JsonSchema = {
  type: "object",
  required: ["draftId"],
  properties: {
    draftId: { type: "string", description: "The draftId from a letter or postcard preview" }
  }
};

export const getDraftStatusOutputSchema: JsonSchema = {
  type: "object",
  required: ["draftId", "status"],
  properties: {
    draftId: { type: "string" },
    status: { type: "string", enum: ["ready", "sent", "expired", "not_found"] },
    orderId: { type: "string", description: "The order the draft became, once sent" },
    schedule: {
      type: "object",
      description: "Arrival dates, YYYY-MM-DD: a ready draft's, or a sent order's",
      properties: {
        arriveBy: { type: "string" },
        mailOn: { type: "string" }
      },
      required: ["arriveBy", "mailOn"]
    },
    deliveryEstimate: { type: "string", description: "A ready draft's delivery estimate, with its dates now" },
    orderStatus: {
      type: "string",
      enum: ["scheduled", "cancelled", "sent"],
      description: "Where a sent draft's order stands: scheduled while it waits for its mail date"
    },
    cancellable: { type: "boolean", description: "A sent draft's order: whether it can still be cancelled free" },
    pages: { type: "integer", minimum: 2, maximum: MAX_LETTER_PAGES, description: "A ready letter of more than one page: the pages it is laid out on now" },
    canSendNow: { type: "boolean", description: "A ready letter while room to write is offered, or a postcard while its sizes or layouts are: whether the balance or a gift letter pays for it now" },
    size: { type: "string", enum: ["6x9", "6x4", "6x11"], description: "A ready postcard our renderer drew, while its sizes or layouts are offered: its size now. Its page goes to the card" },
    layout: { type: "string", enum: ["full_bleed", "border", "greetings"], description: "With it, the postcard's front now" },
    caption: { type: "string", description: "The border's caption, when it has one" },
    place: { type: "string", description: "The place the greeting names" },
    bodyText: { type: "string", description: "A ready letter, while room to write is offered: its words now, for the card" },
    signOff: { type: "string" },
    wordsVersion: { type: "string", description: WORDS_VERSION_DESCRIPTION },
    reasonCannotSend: { type: "string" },
    sendEligibility: sendEligibilitySchema,
    stationery: {
      type: "object",
      description: "A ready letter's stationery now, while stationery is offered; its page goes to the card",
      properties: {
        theme: { type: "string", enum: [...STATIONERY_THEMES] },
        dateLine: { type: "string" },
        monogram: { type: "string" },
        headline: { type: "string" }
      },
      required: ["theme"]
    }
  }
};

export const requestSendInputSchema: JsonSchema = {
  type: "object",
  required: ["draftId"],
  properties: {
    draftId: { type: "string", description: "The draftId from a letter or postcard preview" }
  }
};

export const requestSendOutputSchema: JsonSchema = {
  type: "object",
  required: ["draftId", "mailType", "confirmationUrl", "expiresAtISO", "recipientSummary"],
  properties: {
    draftId: { type: "string" },
    mailType: { type: "string", enum: ["letter", "postcard"] },
    confirmationUrl: {
      type: "string",
      description: "Where the person checks the preview and sends it themselves"
    },
    expiresAtISO: { type: "string" },
    recipientSummary: {
      type: "object",
      required: ["name", "city", "state"],
      properties: {
        name: { type: "string" },
        city: { type: "string" },
        state: { type: "string" }
      }
    },
    schedule: {
      type: "object",
      description: "The preview's arrival dates, YYYY-MM-DD: once sent, it waits until its mail date",
      properties: {
        arriveBy: { type: "string" },
        mailOn: { type: "string" }
      },
      required: ["arriveBy", "mailOn"]
    },
    paidPerSend: {
      type: "boolean",
      const: true,
      description: "Present when the person pays for it with Pay & Send on that page: letter packs and gift letters pay only for one-page letters and 6x9 postcards"
    }
  }
};

/** Held mail cancelled before it goes to the printer (#535). */
export const cancelScheduledMailInputSchema: JsonSchema = {
  type: "object",
  required: ["orderId", "confirm"],
  properties: {
    orderId: { type: "string", description: "The orderId of the scheduled letter or postcard, from list_orders" },
    confirm: { type: "boolean", description: "Set true once the person has agreed: a cancelled order cannot be restored" }
  }
};

export const cancelScheduledMailOutputSchema: JsonSchema = {
  type: "object",
  required: ["orderId", "status", "alreadyCancelled", "returned", "message"],
  properties: {
    orderId: { type: "string" },
    status: { type: "string", enum: ["cancelled"] },
    alreadyCancelled: { type: "boolean", description: "True when it had already been cancelled: nothing changed now" },
    returned: {
      type: "object",
      description: "What went back to the account",
      required: ["kind", "count"],
      properties: {
        kind: { type: "string", enum: ["letters", "gift_letter"] },
        count: { type: "integer" }
      }
    },
    message: { type: "string" }
  }
};

/** A link asking someone for their address (#604). */
export const requestAddressInputSchema: JsonSchema = {
  type: "object",
  required: ["recipientName"],
  properties: {
    recipientName: { type: "string", description: ADDRESS_REQUEST_RECIPIENT_NAME_DESCRIPTION },
    senderFirstName: { type: "string", description: ADDRESS_REQUEST_SENDER_FIRST_NAME_DESCRIPTION }
  }
};

export const requestAddressOutputSchema: JsonSchema = {
  type: "object",
  required: ["requestId", "status", "url", "recipientName", "senderFirstName", "expiresAt", "message"],
  properties: {
    requestId: { type: "string", description: "Pass it to get_address_request and cancel_address_request" },
    status: { type: "string", enum: ["waiting"] },
    url: { type: "string", description: "The private link for the person to share with the recipient themselves. It is given only here" },
    recipientName: { type: "string" },
    senderFirstName: { type: "string", description: "All the page shows of the sender" },
    expiresAt: { type: "string", description: "When the link stops working, ISO 8601" },
    message: { type: "string" }
  }
};

const addressRequestIdInputSchema: JsonSchema = {
  type: "object",
  required: ["requestId"],
  properties: {
    requestId: { type: "string", description: ADDRESS_REQUEST_ID_DESCRIPTION }
  }
};

export const getAddressRequestInputSchema: JsonSchema = addressRequestIdInputSchema;

export const getAddressRequestOutputSchema: JsonSchema = {
  type: "object",
  required: ["requestId", "status", "recipientName", "expiresAt", "message"],
  properties: {
    requestId: { type: "string" },
    status: { type: "string", enum: [...ADDRESS_REQUEST_STATES], description: ADDRESS_REQUEST_STATUS_DESCRIPTION },
    recipientName: { type: "string" },
    expiresAt: { type: "string", description: "When the link stops, or stopped, working, ISO 8601" },
    recipient: { ...addressSchema, description: ADDRESS_REQUEST_RECIPIENT_DESCRIPTION },
    message: { type: "string" }
  }
};

export const cancelAddressRequestInputSchema: JsonSchema = addressRequestIdInputSchema;

export const cancelAddressRequestOutputSchema: JsonSchema = {
  type: "object",
  required: ["requestId", "status", "alreadyClosed", "message"],
  properties: {
    requestId: { type: "string" },
    status: { type: "string", enum: [...ADDRESS_REQUEST_STATES], description: ADDRESS_REQUEST_STATUS_DESCRIPTION },
    alreadyClosed: {
      type: "boolean",
      description: "True when it had already been answered, declined, cancelled or had expired: nothing changed"
    },
    message: { type: "string" }
  }
};

/** A preview's arrival date, changed without previewing again (#535). */
export const setArrivalDateInputSchema: JsonSchema = {
  type: "object",
  required: ["draftId"],
  properties: {
    draftId: { type: "string", description: "The draftId from a letter or postcard preview" },
    arriveBy: { type: "string", description: SET_ARRIVE_BY_DESCRIPTION }
  }
};

export const setArrivalDateOutputSchema: JsonSchema = {
  type: "object",
  required: ["draftId", "deliveryEstimate", "message"],
  properties: {
    draftId: { type: "string" },
    schedule: {
      ...previewScheduleSchema,
      description: "The draft's dates now; absent when it mails as soon as it is sent"
    },
    deliveryEstimate: { type: "string" },
    message: { type: "string" }
  }
};

export const setStationeryInputSchema: JsonSchema = {
  type: "object",
  required: ["draftId", "stationery"],
  properties: {
    draftId: { type: "string", description: "The draftId from a letter preview" },
    stationery: { type: "string", enum: [...STATIONERY_THEMES], description: SET_STATIONERY_DESCRIPTION },
    monogram: stationeryInputSchemas.monogram,
    headline: stationeryInputSchemas.headline
  }
};

export const setStationeryOutputSchema: JsonSchema = {
  type: "object",
  required: ["draftId", "stationery", "canSendNow", "sendEligibility", "message"],
  properties: {
    draftId: { type: "string" },
    stationery: { ...previewStationerySchema, description: SET_STATIONERY_OUTPUT_DESCRIPTION },
    pages: { type: "integer", minimum: 2, maximum: MAX_LETTER_PAGES, description: PREVIEW_PAGES_DESCRIPTION },
    canSendNow: {
      type: "boolean",
      description: "Whether the balance or a gift letter pays for the letter as it is now: a restyle can change its pages, and so its price"
    },
    reasonCannotSend: { type: "string" },
    sendEligibility: sendEligibilitySchema,
    message: { type: "string" }
  }
};

export const setLetterWordsInputSchema: JsonSchema = {
  type: "object",
  required: ["draftId", "bodyText", "signOff"],
  properties: {
    draftId: { type: "string", description: "The draftId from a letter preview" },
    bodyText: { type: "string", description: SET_LETTER_WORDS_BODY_DESCRIPTION },
    signOff: { type: "string", description: SET_LETTER_WORDS_SIGN_OFF_DESCRIPTION },
    wordsVersion: { type: "string", description: SET_LETTER_WORDS_VERSION_DESCRIPTION }
  }
};

export const setLetterWordsOutputSchema: JsonSchema = {
  type: "object",
  required: ["draftId", "canSendNow", "sendEligibility", "wordsVersion", "message"],
  properties: {
    draftId: { type: "string" },
    pages: { type: "integer", minimum: 2, maximum: MAX_LETTER_PAGES, description: PREVIEW_PAGES_DESCRIPTION },
    canSendNow: { type: "boolean", description: SET_LETTER_WORDS_CAN_SEND_DESCRIPTION },
    reasonCannotSend: { type: "string" },
    sendEligibility: sendEligibilitySchema,
    wordsVersion: { type: "string", description: "The version of the words now, for the next change of them" },
    message: { type: "string" }
  }
};

export const setPostcardStyleInputSchema: JsonSchema = {
  type: "object",
  required: ["draftId"],
  properties: {
    draftId: { type: "string", description: "The draftId from a postcard preview" },
    // Withheld while the sizes are not offered, and the front while the layouts are not (withheldInputKeys).
    size: { type: "string", enum: ["6x9", "6x4", "6x11"], description: SET_POSTCARD_SIZE_DESCRIPTION },
    layout: { type: "string", enum: ["full_bleed", "border", "greetings"], description: SET_POSTCARD_LAYOUT_DESCRIPTION },
    caption: { type: "string", description: POSTCARD_CAPTION_DESCRIPTION },
    place: { type: "string", description: POSTCARD_PLACE_DESCRIPTION }
  }
};

export const setPostcardStyleOutputSchema: JsonSchema = {
  type: "object",
  required: ["draftId", "size", "layout", "canSendNow", "sendEligibility", "message"],
  properties: {
    draftId: { type: "string" },
    size: { type: "string", enum: ["6x9", "6x4", "6x11"], description: SET_POSTCARD_STYLE_SIZE_OUTPUT_DESCRIPTION },
    layout: { type: "string", enum: ["full_bleed", "border", "greetings"], description: "The postcard's front now" },
    caption: { type: "string", description: "The border's caption, when it has one" },
    place: { type: "string", description: "The place the greeting names" },
    canSendNow: { type: "boolean", description: SET_POSTCARD_STYLE_CAN_SEND_DESCRIPTION },
    reasonCannotSend: { type: "string" },
    sendEligibility: sendEligibilitySchema,
    message: { type: "string" }
  }
};

export const sendPostcardOutputSchema: JsonSchema = {
  type: "object",
  required: ["orderId", "currentStatus", "statusTimeline", "recipientSummary", "lettersRemaining"],
  properties: {
    orderId: { type: "string" },
    currentStatus: { type: "string", enum: ["pending", "accepted", "printing", "in_transit", "delivered", "returned", "failed", "cancelled", "scheduled"] },
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
    schedule: {
      type: "object",
      description: "Sent with an arrival date: the date it aims to arrive by and the day it goes to the printer, YYYY-MM-DD. It waits until then.",
      properties: { arriveBy: { type: "string" }, mailOn: { type: "string" } },
      required: ["arriveBy", "mailOn"]
    },
    cancellable: { type: "boolean", description: "With an arrival date: whether it can still be cancelled free, before it goes to the printer" },
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
      description: "What the photo is for: 'postcard', 'header_image' or 'inline_image'."
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
      description: "What the photo is for, as the server read it: 'postcard', 'header_image', 'inline_image', or empty string"
    },
    debugEnabled: {
      type: "boolean",
      description: "True when server-side DEBUG flag enables widget diagnostic logging"
    },
    debugEndpoint: {
      type: "string",
      description: "Optional absolute URL for debug beacon ingestion"
    },
    cardUploadAvailable: {
      type: "boolean",
      description: "True when the card may send the photo itself, in an app with no file store (#474)"
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
      description: "What the photo is for: 'postcard', 'header_image' or 'inline_image'."
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

// The profile ChatGPT records for a connected account (#424). This copy feeds
// manifest.json only; the served one is getProfileOutputZ in zodSchemas.ts,
// which also carries the non-empty, non-whitespace rule on id.
export const getProfileInputSchema: JsonSchema = {
  type: "object",
  properties: {}
};

export const getProfileOutputSchema: JsonSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: {
      type: "string",
      description: "Stable, opaque account id. Unchanged across token refresh, reconnection and scope upgrades; never reassigned."
    },
    email: { type: "string", description: "The confirmed email address the account is opened on" }
  }
};
