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
  userId: string
): Promise<void> {
  try {
    await releaseGenerationReservation(userId);
  } catch (releaseError) {
    context.logger.error(
      {
        correlationId: context.correlationId,
        event: "generate_image.reservation_release_failed",
        errorMessage:
          releaseError instanceof Error ? releaseError.message : "Unknown error"
      },
      "Failed to release image generation reservation"
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
      "You've used all your image generations. Purchase more letters to get additional generations (5 per letter)."
    );
  }

  try {
    const result = await generateImage(input.prompt, {
      context: input.context
    });

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
    await releaseReservedGeneration(context, userId);

    if (error instanceof ImageGenerationError) {
      context.logger.warn(
        {
          correlationId: context.correlationId,
          event: "generate_image.failed",
          errorCode: error.code,
          errorMessage: error.userMessage
        },
        "Image generation failed"
      );
      throw new Error(error.userMessage);
    }

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    context.logger.error(
      {
        correlationId: context.correlationId,
        event: "generate_image.error",
        errorMessage
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
