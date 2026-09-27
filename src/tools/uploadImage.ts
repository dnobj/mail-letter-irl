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
import { widgetTemplateUri } from "../mcp/widgetUris.js";
import {
  uploadImageInputSchema,
  uploadImageOutputSchema
} from "../schemas.js";
import { isDebugEnabled } from "../utils/debug.js";
import { isCardUploadEnabled, uploadsThroughCard } from "../config/cardUpload.js";

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
  /**
   * Whether the card may send the photo itself (upload_photo_chunk), which it
   * does only in an app with no file store for it, such as Claude (#474).
   */
  cardUploadAvailable: boolean;
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
    debugEndpoint: buildDebugEndpoint(),
    cardUploadAvailable: isCardUploadEnabled()
  };
}

const WHEN_TO_UPLOAD =
  "Open the image upload widget for letters or postcards only as a fallback when a direct file attachment is unavailable or was not passed through to a preview tool. Do not use this when a generated imageUrl, hosted imageUrl, or working file attachment is already available. Do not use this just because the user referenced an image generated earlier in the same conversation. Reuse that existing conversation image first. Only open this widget after an actual failed handoff or when the user explicitly needs upload help.";

export const uploadImageTool: McpToolDefinition<
  UploadImageInput,
  UploadImageOutput
> = {
  name: "upload_image",
  title: "Upload an image",
  // Where the card sends the photo itself there is no imageUrl (#474).
  description: (client) =>
    WHEN_TO_UPLOAD +
    (uploadsThroughCard(client)
      ? " The widget sends the photo to Letter IRL and then asks for the preview in the conversation: call the preview tool with no image and no imageUrl, and Letter IRL uses the photo just uploaded."
      : " The widget uploads the file and returns an imageUrl to use in the next preview call."),
  readOnly: false,
  inputSchema: uploadImageInputSchema,
  outputSchema: uploadImageOutputSchema,
  meta: {
    "openai/outputTemplate": widgetTemplateUri("ImageUploadCard"),
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": "Opening photo picker...",
    "openai/toolInvocation/invoked": "Photo picker ready",
    readOnlyHint: false,
    idempotentHint: false
  },
  handler
};
