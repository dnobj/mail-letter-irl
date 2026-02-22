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
  checkGenerationLimit,
  recordGeneration
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

  // Check generation limit before calling OpenAI
  const limitCheck = await checkGenerationLimit(userId);
  if (!limitCheck.allowed) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "generate_image.limit_reached",
        used: limitCheck.used,
        allowance: limitCheck.allowance
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

    // Record the generation after successful API call
    await recordGeneration(userId);
    const generationsRemaining = limitCheck.remaining - 1;

    // Create tiny preview for widget display (~10-20KB via _meta)
    const previewBase64 = await createPreview(result.base64Data);

    // Store full image for later download by preview tools
    const token = storeImage(result.base64Data);
    const imageUrl = buildTempImageUrl(token);

    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "generate_image.success",
        fullBase64Length: result.base64Data.length,
        previewBase64Length: previewBase64.length,
        imageUrl,
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
  description: `Generate an image using AI for use in postcards or letters.

USE THIS TOOL WHEN:
- User wants a postcard or letter with an image but doesn't have their own photo
- User describes an image they'd like (e.g., "a sunset over mountains")
- User asks you to create, generate, or make an image for their mail
- User says "draw", "create", "design", or "generate" an image

DO NOT USE THIS TOOL WHEN:
- User has already provided their own image (file attachment or URL)
- User wants to upload an existing photo (use upload_image instead)
- The issue is "image not received" from ChatGPT upload (use upload_image fallback)
- User is referring to an existing uploaded photo ("this photo", "the one I uploaded")
  and wants that same photo used

CONTEXT PARAMETER:
- "postcard" — landscape image optimized for 6x9 postcard front
- "header_image" — wide image for letter header/letterhead
- "inline_image" — square image for inside a letter

AFTER GENERATION:
The user will see a preview in a widget and can choose to use the image.
Once they confirm, use the imageUrl with the appropriate preview tool.`,
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
