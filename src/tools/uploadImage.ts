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
  description: `Upload a photo for use in letters or postcards. Provides a direct file picker widget.

PREFER DIRECT FILE ATTACHMENT:
Users should first try attaching an image directly to their message (paperclip/attachment button).
If the image was received as a file attachment, pass it directly to the preview tool — no need for this widget.

USE THIS TOOL ONLY WHEN:
- User's direct file attachment was NOT received by the preview tool
- A previous preview tool call failed because no image was found
- User is on mobile and image attachment isn't working
- User explicitly asks to use the upload widget or photo picker

IMPORTANT BEHAVIOR:
- If this tool is needed, CALL IT IMMEDIATELY in the same turn.
- Do NOT only describe the widget; actually call the tool so the widget appears.

DO NOT USE THIS TOOL WHEN:
- The user has already provided a direct image URL
- The image was successfully received via file attachment
- The user hasn't tried attaching an image yet (let them try first)

The widget handles file selection, validation, and upload entirely client-side.
After the user selects a photo, the download URL is communicated back automatically.
Then re-call the appropriate preview tool (quote_and_preview_postcard, etc.) with the imageUrl parameter.`,
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
