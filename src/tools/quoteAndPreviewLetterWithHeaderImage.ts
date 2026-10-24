/**
 * Quote and Preview Letter with Header Image
 *
 * Creates a preview of a physical letter WITH a header image at the top.
 * The image appears at the TOP of the letter, like custom letterhead or branding.
 *
 * REQUIRES: An image attachment or imageUrl parameter.
 *
 * The steps are the letter-preview pipeline's (letterPreviewPipeline.ts, #689).
 */

import { McpToolDefinition } from "../contracts/types.js";
import { widgetTemplateUri } from "../mcp/widgetUris.js";
import { roomToWriteSentence, type LetterQuoteOutput } from "./letterHelpers.js";
import { certifiedMailSentence } from "./mailServiceInput.js";
import { previewSendStep } from "./previewSendStep.js";
import { previewLetter, type LetterPreviewInput } from "./letterPreviewPipeline.js";

// Its own template name, so the card knows which tool to repeat when a call
// never reached the server (#411; see WIDGET_VARIANTS in registerTools.ts).
const OUTPUT_TEMPLATE = widgetTemplateUri("LetterHeaderImagePreviewCard");

export const quoteAndPreviewLetterWithHeaderImageTool: McpToolDefinition<
  LetterPreviewInput,
  LetterQuoteOutput
> = {
  name: "quote_and_preview_letter_with_header_image",
  title: "Preview a letter with a header image",
  // The last sentence follows the send rule and the app (#516).
  description: (client) =>
    "Preview a physical letter draft with a header image at the top. Requires a real U.S. recipient mailing address. Its answer gives the price and when the mail usually arrives. If the user refers to an image already generated, shown, or attached earlier in this conversation, call this tool first to reuse that image. Otherwise prefer a direct file attachment or explicit imageUrl. Use upload_image only after an actual failed handoff or upload problem. " +
    roomToWriteSentence() +
    certifiedMailSentence() +
    previewSendStep("send_letter", client),
  // readOnly: false because this tool creates draft records in the database
  // See docs/learnings/tool-annotation-decision.md for rationale
  readOnly: false,
  meta: {
    "openai/outputTemplate": OUTPUT_TEMPLATE,
    "openai/widgetAccessible": true,
    "openai/fileParams": ["image"],  // ENABLE IMAGE UPLOAD
    "openai/toolInvocation/invoking": "Processing letter with header image...",
    "openai/toolInvocation/invoked": "Preview ready"
    // Note: readOnlyHint is set by buildAnnotations() in registerTools.ts
  },
  handler: (input, context) =>
    previewLetter(input, context, {
      events: "quote.letter.header_image",
      startMessage: "Processing quote_and_preview_letter_with_header_image",
      image: { layoutType: "header_image", processAs: "header", noun: "header image" }
    })
};
