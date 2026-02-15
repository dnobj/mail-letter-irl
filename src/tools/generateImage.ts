/**
 * Generate Image Tool
 *
 * Generates images via the OpenAI Images API (gpt-image-1.5) server-side.
 * Returns base64 data that the GenerateImageCard widget displays as a preview.
 * When the user confirms, the widget uploads to OpenAI file storage and posts
 * the download URL back via ui/message for use with preview tools.
 *
 * This bypasses the ChatGPT limitation where GPT Image output
 * cannot be passed directly to MCP tools (GitHub #67).
 */

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
  generatedImageBase64: string;
}

// ============================================================================
// Constants
// ============================================================================

const NEXT_STEP_MAP: Record<string, string> = {
  postcard:
    "Now call quote_and_preview_postcard with this imageUrl to preview the postcard.",
  header_image:
    "Now call quote_and_preview_letter_with_header_image with this imageUrl to preview the letter.",
  inline_image:
    "Now call quote_and_preview_letter_with_image with this imageUrl to preview the letter."
};

const DEFAULT_NEXT_STEP =
  "Pass this imageUrl to quote_and_preview_postcard or a letter preview tool.";

// ============================================================================
// Handler
// ============================================================================

async function handler(
  input: GenerateImageInput,
  context: ToolContext
): Promise<GenerateImageOutput> {
  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "generate_image.start",
      promptLength: input.prompt.length,
      imageContext: input.context ?? "none"
    },
    "Generating image via OpenAI API"
  );

  try {
    const result = await generateImage(input.prompt, {
      context: input.context
    });

    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "generate_image.success",
        base64Length: result.base64Data.length
      },
      "Image generated successfully"
    );

    const suggestedNextStep =
      NEXT_STEP_MAP[input.context ?? ""] ?? DEFAULT_NEXT_STEP;

    return {
      message: `Image generated! ${suggestedNextStep}`,
      suggestedNextStep,
      generatedImageBase64: result.base64Data
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
