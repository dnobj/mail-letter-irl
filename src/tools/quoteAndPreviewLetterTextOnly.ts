/**
 * Quote and Preview Letter (Text-Only)
 *
 * Creates a preview of a text-only physical letter without images.
 * For letters WITH images, use:
 * - quoteAndPreviewLetterWithHeaderImage (logo/letterhead at top)
 * - quoteAndPreviewLetterWithImage (image after signature)
 *
 * The steps are the letter-preview pipeline's (letterPreviewPipeline.ts, #689).
 */

import { McpToolDefinition } from "../contracts/types.js";
import { widgetTemplateUri } from "../mcp/widgetUris.js";
import { roomToWriteSentence, type LetterQuoteOutput } from "./letterHelpers.js";
import { certifiedMailSentence } from "./mailServiceInput.js";
import { previewSendStep } from "./previewSendStep.js";
import { previewLetter, type LetterPreviewInput } from "./letterPreviewPipeline.js";

type QuoteAndPreviewLetterTextOnlyInput = Omit<LetterPreviewInput, "image" | "imageUrl">;

const OUTPUT_TEMPLATE = widgetTemplateUri("LetterPreviewCard");

export const quoteAndPreviewLetterTextOnlyTool: McpToolDefinition<
  QuoteAndPreviewLetterTextOnlyInput,
  LetterQuoteOutput
> = {
  name: "quote_and_preview_letter",
  title: "Preview a letter",
  // The last sentence follows the send rule and the app (#516).
  description: (client) =>
    "Preview a text-only physical letter draft. Requires a real U.S. recipient mailing address and text that fits the text-only letter limit. Its answer says what sending it takes and when the mail usually arrives. " +
    roomToWriteSentence() +
    certifiedMailSentence() +
    previewSendStep("send_letter", client),
  // readOnly: false because this tool creates draft records in the database
  // See docs/learnings/tool-annotation-decision.md for rationale
  readOnly: false,
  meta: {
    "openai/outputTemplate": OUTPUT_TEMPLATE,
    "openai/widgetAccessible": true,
    // NO fileParams - text-only tool does not accept images
    "openai/toolInvocation/invoking": "Generating preview...",
    "openai/toolInvocation/invoked": "Preview ready"
    // Note: readOnlyHint is set by buildAnnotations() in registerTools.ts
  },
  // No image step: the pipeline reads no picture for a text-only letter.
  handler: (input, context) =>
    previewLetter(input, context, {
      events: "quote.letter.text_only",
      startMessage: "Processing quote_and_preview_letter (text-only)"
    })
};
