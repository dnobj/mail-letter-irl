import { McpToolDefinition } from "../contracts/types.js";
import { widgetTemplateUri } from "../mcp/widgetUris.js";

/**
 * Intent trampoline for image-generation requests addressed to Letter IRL
 * (issue #227 papercut; decision record:
 * docs/learnings/generate-image-removal-decision.md).
 *
 * Letter IRL does not generate images - ChatGPT's built-in image_gen does,
 * and its images attach to previews directly. But on the native mobile app a
 * conversation opened with "@Letter IRL generate an image of X" routes to the
 * app, and with no matching tool the model narrated the capability gap
 * instead of falling through (server instructions r5 could not override
 * this; log-proven). This tool exploits that same routing pull: it matches
 * generate-intent by name, costs nothing (no OpenAI call, no quota, no
 * widget, no PII so no consent dialog), and its response redirects the model
 * to generate natively IN THE SAME TURN via suggestedNextStep - the
 * strongest steering channel we have observed.
 */

interface GenerateImageForMailInput {
  prompt?: string;
  context?: string;
}

interface GenerateImageForMailOutput {
  status: string;
  message: string;
  suggestedNextStep: string;
  prompt?: string;
}

export const generateImageForMailTool: McpToolDefinition<
  GenerateImageForMailInput,
  GenerateImageForMailOutput
> = {
  name: "generate_image_for_mail",
  title: "Route an image request to built-in generation",
  description:
    "Call this whenever the user asks Letter IRL to generate, create, draw, or make an image. Letter IRL does not generate images itself; this tool returns the correct next step (generate with ChatGPT's built-in image generation, then attach the result to a postcard or letter preview). Free, instant, and safe to call for any image-generation request.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The image the user asked for, in their words."
      },
      context: {
        type: "string",
        description: "Optional mail context: postcard, header_image, or inline_image."
      }
    },
    required: []
  },
  outputSchema: {
    type: "object",
    required: ["status", "message", "suggestedNextStep"],
    properties: {
      status: { type: "string" },
      message: { type: "string" },
      suggestedNextStep: { type: "string" },
      prompt: { type: "string" }
    }
  },
  meta: {
    "openai/outputTemplate": widgetTemplateUri("ImageRoutingCard"),
    "openai/toolInvocation/invoking": "Routing image request...",
    "openai/toolInvocation/invoked": "Image request routed",
    readOnlyHint: true
  },
  async handler(input) {
    const promptClause = input?.prompt
      ? ` for: "${input.prompt}"`
      : " the user described";
    const mailNoun =
      input?.context === "postcard"
        ? "postcard"
        : input?.context === "header_image" || input?.context === "inline_image"
          ? "letter"
          : "postcard or letter";
    return {
      prompt: input?.prompt,
      status: "use_builtin_generation",
      message:
        "Letter IRL does not generate images. ChatGPT's built-in image generation handles this, and the result attaches to Letter IRL mail directly.",
      suggestedNextStep:
        `IMPORTANT: Now generate the image${promptClause} yourself in this same turn using ChatGPT's built-in image generation (image_gen). Do not explain this routing to the user or ask permission - just generate the image, then offer to use it for a ${mailNoun}.`
    };
  }
};
