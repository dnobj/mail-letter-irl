/**
 * Image Generation Service
 *
 * Calls the OpenAI Images API (gpt-image-1.5) to generate images server-side.
 * Returns base64 JPEG data that the widget uploads to OpenAI file storage
 * to get a persistent download URL.
 *
 * This bypasses the ChatGPT limitation where native GPT Image output
 * cannot be passed directly to MCP tools (GitHub #67).
 */

// ============================================================================
// Types
// ============================================================================

export type ImageContext = "postcard" | "header_image" | "inline_image";

export interface GenerateImageOptions {
  context?: ImageContext;
}

export interface GenerateImageResult {
  base64Data: string;
}

// ============================================================================
// Error Class
// ============================================================================

export class ImageGenerationError extends Error {
  constructor(
    public readonly code:
      | "MISSING_API_KEY"
      | "CONTENT_POLICY_VIOLATION"
      | "RATE_LIMITED"
      | "API_ERROR"
      | "INVALID_PROMPT",
    public readonly userMessage: string
  ) {
    super(userMessage);
    this.name = "ImageGenerationError";
  }
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Size mapping based on image context.
 * GPT Image models support: 1024x1024, 1024x1536, 1536x1024
 *
 * - postcard/header → landscape 1536x1024 (best for 6x9 postcards and wide headers)
 * - inline/default → square 1024x1024 (best for inline photos)
 */
const SIZE_MAP: Record<string, string> = {
  postcard: "1536x1024",
  header_image: "1536x1024",
  inline_image: "1024x1024"
};

const DEFAULT_SIZE = "1024x1024";

// ============================================================================
// Main Function
// ============================================================================

export async function generateImage(
  prompt: string,
  options: GenerateImageOptions = {}
): Promise<GenerateImageResult> {
  // Validate prompt
  if (!prompt || prompt.trim().length === 0) {
    throw new ImageGenerationError(
      "INVALID_PROMPT",
      "Please describe the image you'd like to generate."
    );
  }

  // Check API key
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ImageGenerationError(
      "MISSING_API_KEY",
      "Image generation is not configured. Please contact support."
    );
  }

  const model = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1.5";
  const quality = process.env.OPENAI_IMAGE_QUALITY ?? "medium";
  const size = SIZE_MAP[options.context ?? ""] ?? DEFAULT_SIZE;

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      prompt: prompt.trim(),
      n: 1,
      size,
      quality,
      output_format: "jpeg",
      output_compression: 85
    })
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const errorCode = (body as Record<string, unknown>)?.error
      ? ((body as Record<string, Record<string, unknown>>).error.code as string)
      : undefined;
    const errorMessage = (body as Record<string, unknown>)?.error
      ? ((body as Record<string, Record<string, unknown>>).error.message as string)
      : undefined;

    if (response.status === 400 && errorCode === "content_policy_violation") {
      throw new ImageGenerationError(
        "CONTENT_POLICY_VIOLATION",
        "The image request was declined due to content policy. Please try a different description."
      );
    }

    if (response.status === 429) {
      throw new ImageGenerationError(
        "RATE_LIMITED",
        "Image generation is temporarily busy. Please try again in a minute."
      );
    }

    throw new ImageGenerationError(
      "API_ERROR",
      errorMessage ?? "Image generation failed. Please try again."
    );
  }

  const data = (await response.json()) as {
    data: Array<{ b64_json: string }>;
  };

  const image = data.data[0];
  if (!image?.b64_json) {
    throw new ImageGenerationError(
      "API_ERROR",
      "Image generation returned no data. Please try again."
    );
  }

  return {
    base64Data: image.b64_json
  };
}
