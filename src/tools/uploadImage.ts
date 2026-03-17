/**
 * Upload Image Tool
 *
 * Provides a widget-based file picker for uploading images.
 * Bypasses ChatGPT's unreliable file attachment pipeline by using
 * the OpenAI Apps SDK widget sandbox (window.openai.uploadFile).
 *
 * The tool handler is minimal — it returns static context data.
 * All real work happens client-side in the ImageUploadCard widget.
 *
 * User Story: US-POSTCARD-04 (Mobile Image Graceful Degradation)
 */

import { McpToolDefinition, ToolContext } from "../contracts/types.js";
import {
  uploadImageInputSchema,
  uploadImageOutputSchema
} from "../schemas.js";
import { isDebugEnabled } from "../utils/debug.js";

interface UploadImageInput {
  context?: string;
}

interface UploadImageOutput {
  status: string;
  message: string;
  acceptedFormats: string;
  maxSizeMB: number;
  context: string;
  debugEnabled: boolean;
  debugEndpoint?: string;
}

const ACCEPTED_FORMATS = "JPEG, PNG, WebP";
const MAX_SIZE_MB = 10;

const CONTEXT_MESSAGES: Record<string, string> = {
  postcard: "Select a photo for the front of your postcard.",
  header_image: "Select a header image for the top of your letter.",
  inline_image: "Select a photo to include in your letter."
};

function buildDebugEndpoint(): string {
  const baseUrl =
    process.env.LETTER_IRL_API_URL ||
    process.env.LETTER_IRL_PUBLIC_BASE_URL ||
    "https://api.letterirl.com";
  return `${baseUrl}/api/widget-diagnostic`;
}

async function handler(
  input: UploadImageInput,
  context: ToolContext
): Promise<UploadImageOutput> {
  const hint = input.context || "";
  const guidanceMessage =
    CONTEXT_MESSAGES[hint] ||
    "Select a photo to use in your letter or postcard.";

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "upload_image.invoked",
      imageContext: hint || "none"
    },
    "Upload image tool invoked"
  );

  return {
    status: "awaiting_upload",
    message: guidanceMessage,
    acceptedFormats: ACCEPTED_FORMATS,
    maxSizeMB: MAX_SIZE_MB,
    context: hint,
    debugEnabled: isDebugEnabled(),
    debugEndpoint: buildDebugEndpoint()
  };
}

export const uploadImageTool: McpToolDefinition<
  UploadImageInput,
  UploadImageOutput
> = {
  name: "upload_image",
  description: "Open the image upload widget for letters or postcards when a direct file attachment is unavailable or was not passed through to a preview tool. The widget uploads the file and returns an imageUrl to use in the next preview call.",
  readOnly: false,
  inputSchema: uploadImageInputSchema,
  outputSchema: uploadImageOutputSchema,
  meta: {
    "openai/outputTemplate": "ui://widgets/ImageUploadCard.html",
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": "Opening photo picker...",
    "openai/toolInvocation/invoked": "Photo picker ready",
    readOnlyHint: false,
    idempotentHint: false
  },
  handler
};
