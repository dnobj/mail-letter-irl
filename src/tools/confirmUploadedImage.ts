/**
 * Confirm Uploaded Image Tool
 *
 * Lightweight relay tool called by the ImageUploadCard widget via
 * window.openai.callTool() after a successful client-side upload.
 *
 * This solves a critical communication gap: when a user uploads an image
 * through the widget, the download URL only exists client-side. The widget
 * calls this tool to put the URL into a server-side tool response that
 * ChatGPT can see and act on (with explicit next-step instructions).
 *
 * This mirrors the generate_image pattern where suggestedNextStep tells
 * ChatGPT exactly which preview tool to call with the imageUrl.
 */

import { McpToolDefinition, ToolContext } from "../contracts/types.js";
import {
  confirmUploadedImageInputSchema,
  confirmUploadedImageOutputSchema
} from "../schemas.js";
import { setRecentUploadedImage } from "../services/recentUploadStore.js";

interface ConfirmUploadedImageInput {
  imageUrl: string;
  context?: string;
}

interface ConfirmUploadedImageOutput {
  status: string;
  imageUrl: string;
  suggestedNextStep: string;
}

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

async function handler(
  input: ConfirmUploadedImageInput,
  context: ToolContext
): Promise<ConfirmUploadedImageOutput> {
  const hint = input.context || "";
  setRecentUploadedImage(context.user.userId, input.imageUrl, input.context);

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "confirm_uploaded_image.invoked",
      imageUrl: input.imageUrl,
      imageContext: hint || "none"
    },
    "Confirm uploaded image invoked"
  );

  const suggestedNextStep = buildNextStep(input.context, input.imageUrl);

  return {
    status: "ready",
    imageUrl: input.imageUrl,
    suggestedNextStep
  };
}

export const confirmUploadedImageTool: McpToolDefinition<
  ConfirmUploadedImageInput,
  ConfirmUploadedImageOutput
> = {
  name: "confirm_uploaded_image",
  description: `Confirms a photo was uploaded via the upload widget and provides the download URL.

THIS TOOL IS CALLED AUTOMATICALLY by the ImageUploadCard widget after a successful upload.
DO NOT call this tool directly — it is for internal widget-to-assistant communication only.

After this tool returns, follow the suggestedNextStep instructions to call the appropriate preview tool with the imageUrl.`,
  readOnly: true,
  inputSchema: confirmUploadedImageInputSchema,
  outputSchema: confirmUploadedImageOutputSchema,
  meta: {
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": "Processing uploaded photo...",
    "openai/toolInvocation/invoked": "Photo ready",
    readOnlyHint: true,
    idempotentHint: true
  },
  handler
};
