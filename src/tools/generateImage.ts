/**
 * Generate Image Tool
 *
 * Generates images via the OpenAI Images API (gpt-image-1.5) server-side.
 * Creates a tiny preview (~15KB) for the widget to display via _meta,
 * and stores the full image server-side for later download via temp URL.
 *
 * Flow:
 * 1. Server calls OpenAI API → full base64 image
 * 2. Server creates tiny preview via Sharp (~400px, quality 60)
 * 3. Server stores full image in temp store → gets token
 * 4. Returns preview (→ _meta for widget) + URL (→ structuredContent)
 * 5. Widget shows preview, user clicks "Use This Image"
 * 6. Widget posts the temp URL back via ui/message
 * 7. ChatGPT calls preview tool with imageUrl = our temp URL
 * 8. Preview tool downloads full image from our server
 */

import sharp from "sharp";
import { McpToolDefinition, ToolContext } from "../contracts/types.js";
import {
  generateImageInputSchema,
  generateImageOutputSchema
} from "../schemas.js";
import {
  generateImage,
  ImageGenerationError,
  type ImageContext
} from "../services/imageGenerationService.js";
import {
  commitGenerationReservation,
  markGenerationDispatched,
  markGenerationReservationAmbiguous,
  releaseGenerationReservation,
  reserveGeneration
} from "../services/imageGenerationLimitService.js";
import { storeImage } from "../services/tempImageStore.js";

// ============================================================================
// Types
// ============================================================================

interface GenerateImageInput {
  prompt: string;
  context?: ImageContext;
}

interface GenerateImageOutput {
  message: string;
  suggestedNextStep: string;
  generatedImagePreview: string;
  generatedImageUrl: string;
  generationsRemaining: number;
}

// ============================================================================
// Constants
// ============================================================================

function buildNextStep(context: string | undefined, imageUrl: string): string {
  switch (context) {
    case "postcard":
      return `IMPORTANT: Now call quote_and_preview_postcard and set imageUrl to "${imageUrl}"`;
    case "header_image":
      return `IMPORTANT: Now call quote_and_preview_letter_with_header_image and set imageUrl to "${imageUrl}"`;
    case "inline_image":
      return `IMPORTANT: Now call quote_and_preview_letter_with_image and set imageUrl to "${imageUrl}"`;
    default:
      return `IMPORTANT: Pass imageUrl "${imageUrl}" to quote_and_preview_postcard or a letter preview tool.`;
  }
}

/** Preview config matching the postcard preview pattern */
const PREVIEW_CONFIG = {
  maxWidth: 400,
  jpegQuality: 60
} as const;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a tiny preview from full-resolution base64 image data.
 * Uses the same Sharp + quality settings as postcard previews (~10-20KB).
 */
async function createPreview(base64Data: string): Promise<string> {
  const buffer = Buffer.from(base64Data, "base64");
  const preview = await sharp(buffer)
    .resize(PREVIEW_CONFIG.maxWidth, undefined, {
      fit: "inside",
      withoutEnlargement: true
    })
    .jpeg({ quality: PREVIEW_CONFIG.jpegQuality })
    .toBuffer();
  return preview.toString("base64");
}

async function releaseReservedGeneration(
  context: ToolContext,
  userId: string,
  reservationId: string | undefined,
  reason: string,
  providerRequestId?: string
): Promise<void> {
  if (!reservationId) {
    return;
  }
  try {
    await releaseGenerationReservation(userId, reservationId, reason);
  } catch (releaseError) {
    context.logger.error(
      {
        correlationId: context.correlationId,
        event: "generate_image.reservation_release_failed",
        errorType: releaseError instanceof Error ? releaseError.name : "UnknownError"
      },
      "Failed to release image generation reservation"
    );
  }
}

async function preserveAmbiguousGeneration(
  context: ToolContext,
  userId: string,
  reservationId: string | undefined,
  reason: string,
  providerRequestId?: string
): Promise<void> {
  if (!reservationId) return;
  try {
    await markGenerationReservationAmbiguous(
      userId,
      reservationId,
      reason,
      providerRequestId
    );
  } catch (reconciliationError) {
    context.logger.error(
      {
        correlationId: context.correlationId,
        event: "generate_image.reservation_reconciliation_failed",
        errorType:
          reconciliationError instanceof Error ? reconciliationError.name : "UnknownError"
      },
      "Image generation reservation requires maintenance reconciliation"
    );
  }
}

/**
 * Build the temp image URL for the stored image.
 */
function buildTempImageUrl(token: string): string {
  const baseUrl =
    process.env.LETTER_IRL_API_URL ||
    process.env.LETTER_IRL_PUBLIC_BASE_URL ||
    "https://api.letterirl.com";
  return `${baseUrl}/api/temp-image/${token}`;
}

// ============================================================================
// Handler
// ============================================================================

async function handler(
  input: GenerateImageInput,
  context: ToolContext
): Promise<GenerateImageOutput> {
  const userId = context.user.userId || "default-user";

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "generate_image.start",
      promptLength: input.prompt.length,
      imageContext: input.context ?? "none"
    },
    "Generating image via OpenAI API"
  );

  // Reserve quota atomically before calling OpenAI so concurrent requests cannot overspend.
  const reservation = await reserveGeneration(userId);
  if (!reservation.reserved) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "generate_image.limit_reached",
        used: reservation.used,
        allowance: reservation.allowance
      },
      "Image generation limit reached"
    );
    throw new Error(
      "You've used all your Letter IRL image generations. Complete a qualifying physical-mail purchase to receive another entitlement, or reuse an uploaded or conversation-generated image."
    );
  }

  let providerDispatched = false;
  let providerSucceeded = false;
  try {
    const result = await generateImage(input.prompt, {
      context: input.context,
      beforeDispatch: async () => {
        if (!reservation.reservationId) {
          throw new Error("Image generation reservation is missing");
        }
        const dispatched = await markGenerationDispatched(
          userId,
          reservation.reservationId
        );
        if (!dispatched) {
          throw new Error("Image generation reservation expired before provider dispatch");
        }
        providerDispatched = true;
      }
    });
    providerSucceeded = true;

    // Provider usage is billable once generation succeeds, even if local
    // previewing or temporary storage later fails. Consume the reservation
    // immediately so those downstream failures cannot be retried for free.
    if (reservation.reservationId) {
      const committed = result.providerRequestId
        ? await commitGenerationReservation(
            reservation.reservationId,
            result.providerRequestId
          )
        : await commitGenerationReservation(reservation.reservationId);
      if (!committed) {
        throw new Error("Image generation outcome could not be persisted");
      }
    }

    const generationsRemaining = reservation.remaining;

    // Create tiny preview for widget display (~10-20KB via _meta)
    const previewBase64 = await createPreview(result.base64Data);

    // Store full image for later download by preview tools
    const token = await storeImage(result.base64Data);
    const imageUrl = buildTempImageUrl(token);

    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "generate_image.success",
        fullBase64Length: result.base64Data.length,
        previewBase64Length: previewBase64.length,
        imageTokenSuffix: token.slice(-6),
        generationsRemaining
      },
      "Image generated successfully"
    );

    const suggestedNextStep = buildNextStep(input.context, imageUrl);

    return {
      message: `Image generated! ${suggestedNextStep}`,
      suggestedNextStep,
      generatedImagePreview: previewBase64,
      generatedImageUrl: imageUrl,
      generationsRemaining
    };
  } catch (error) {
    const ambiguousProviderOutcome =
      providerSucceeded ||
      (providerDispatched &&
        (!(error instanceof ImageGenerationError) || error.outcome === "ambiguous"));
    if (ambiguousProviderOutcome) {
      await preserveAmbiguousGeneration(
        context,
        userId,
        reservation.reservationId,
        providerSucceeded ? "provider_succeeded_persistence_unknown" : "provider_outcome_unknown",
        error instanceof ImageGenerationError ? error.providerRequestId : undefined
      );
    } else {
      await releaseReservedGeneration(
        context,
        userId,
        reservation.reservationId,
        providerDispatched ? "provider_definite_failure" : "pre_dispatch_failure"
      );
    }

    if (error instanceof ImageGenerationError) {
      context.logger.warn(
        {
          correlationId: context.correlationId,
          event: "generate_image.failed",
          errorCode: error.code,
          providerOutcome: error.outcome
        },
        "Image generation failed"
      );
      throw new Error(error.userMessage);
    }

    context.logger.error(
      {
        correlationId: context.correlationId,
        event: "generate_image.error",
        errorType: error instanceof Error ? error.name : "UnknownError"
      },
      "Unexpected image generation error"
    );
    throw new Error("Image generation failed. Please try again.");
  }
}

// ============================================================================
// Tool Definition
// ============================================================================

export const generateImageTool: McpToolDefinition<
  GenerateImageInput,
  GenerateImageOutput
> = {
  name: "generate_image",
  description: "Generate a new image through Letter IRL when this app is selected and the user asks to create artwork, an illustration, or an image, especially when native ChatGPT image generation is unavailable or blocked. Use this even if the user has not yet asked to mail it; after generation, offer to use the image for a postcard or letter. Returns a preview widget and an imageUrl to pass to a preview tool. If the user already has an uploaded, attached, or previously generated image in this conversation, reuse that existing image instead of calling this tool again. Context may be postcard, header_image, or inline_image.",
  readOnly: false,
  inputSchema: generateImageInputSchema,
  outputSchema: generateImageOutputSchema,
  meta: {
    "openai/outputTemplate": "ui://widgets/GenerateImageCard.html",
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": "Generating image...",
    "openai/toolInvocation/invoked": "Image generated",
    readOnlyHint: false,
    idempotentHint: false
  },
  handler
};
