/**
 * Quote and Preview Letter (Text-Only)
 *
 * Creates a preview of a text-only physical letter without images.
 * For letters WITH images, use:
 * - quoteAndPreviewLetterWithHeaderImage (logo/letterhead at top)
 * - quoteAndPreviewLetterWithImage (image after signature)
 */

import { Address, McpToolDefinition, ToolContext } from "../contracts/types.js";
import { widgetTemplateUri } from "../mcp/widgetUris.js";
import { printRenderer } from "../config/printRenderer.js";
import {
  quoteAndPreviewLetterTextOnlyInputSchema,
  quoteAndPreviewOutputSchema
} from "../schemas.js";
import {
  prepareSender,
  validateAddresses,
  validateAddressesWithProvider,
  validateCharacterLimitForLayout,
  validatePrintableLetter,
  layoutLetterForPreview,
  letterGiftChoice,
  createLetterDraftAndBuildOutput,
  type LetterQuoteOutput
} from "./letterHelpers.js";
import { previewSchedule } from "./arriveByInput.js";
import { previewSendStep } from "./previewSendStep.js";

// ============================================================================
// Types
// ============================================================================

interface QuoteAndPreviewLetterTextOnlyInput {
  sender?: Address;
  recipient: Address;
  bodyText: string;
  signOff: string;
  /** Send as the account's gift letter (docs/gift-letters.md). */
  sendAsGift?: boolean;
  /** The date it should arrive by, YYYY-MM-DD (#535); served only while the flag is on. */
  arriveBy?: string;
}

// ============================================================================
// Constants
// ============================================================================

const OUTPUT_TEMPLATE = widgetTemplateUri("LetterPreviewCard");

// ============================================================================
// Handler
// ============================================================================

async function handler(
  input: QuoteAndPreviewLetterTextOnlyInput,
  context: ToolContext
): Promise<LetterQuoteOutput> {
  const layoutType = 'text_only';

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.letter.text_only.start"
    },
    "Processing quote_and_preview_letter (text-only)"
  );

  // Arrive-by (#535): checked first, so a date that cannot be met is refused
  // before any picture is fetched or address validated.
  const schedule = previewSchedule(input.arriveBy, context);

  // Prepare sender (use saved return address if not provided)
  const { sender, usedSavedReturnAddress, savedReturnAddressNote } = await prepareSender(input, context);

  // Validate addresses
  validateAddresses(sender, input.recipient, context);

  // Decided first: a gift send's card page draws the sender's name, which
  // must print and fit (#534). The renderer is read once, so every check agrees.
  const gift = await letterGiftChoice(input, context);
  const renderer = printRenderer();

  // Validate character limit
  validateCharacterLimitForLayout(input.bodyText, input.signOff, layoutType, context, renderer);

  // Refuse characters the print shows as boxes (#526)
  validatePrintableLetter(
    { sender, recipient: input.recipient, bodyText: input.bodyText, signOff: input.signOff, senderIsSaved: usedSavedReturnAddress },
    context,
    renderer,
    gift.card
  );

  // Our renderer measures the page itself (#534)
  const printLayout = layoutLetterForPreview(
    { bodyText: input.bodyText, signOff: input.signOff, layoutType },
    context,
    renderer
  );

  // Validate with PostGrid provider
  const { senderValidation, recipientValidation, addressWarnings } = await validateAddressesWithProvider(
    sender,
    input.recipient,
    context
  );

  // Create draft and build output
  return createLetterDraftAndBuildOutput({
    sender,
    recipient: input.recipient,
    bodyText: input.bodyText,
    signOff: input.signOff,
    layoutType,
    usedSavedReturnAddress,
    savedReturnAddressNote,
    senderValidation,
    recipientValidation,
    addressWarnings,
    gift,
    printLayout,
    schedule,
    context
  });
}

// ============================================================================
// Tool Definition
// ============================================================================

export const quoteAndPreviewLetterTextOnlyTool: McpToolDefinition<
  QuoteAndPreviewLetterTextOnlyInput,
  LetterQuoteOutput
> = {
  name: "quote_and_preview_letter",
  title: "Preview a letter",
  // The last sentence follows the send rule and the app (#516).
  description: (client) =>
    "Preview a text-only physical letter draft. This does not send mail. Requires a real U.S. recipient mailing address and text that fits the text-only letter limit. " +
    previewSendStep("send_letter", client),
  // readOnly: false because this tool creates draft records in the database
  // See docs/learnings/tool-annotation-decision.md for rationale
  readOnly: false,
  inputSchema: quoteAndPreviewLetterTextOnlyInputSchema,
  outputSchema: quoteAndPreviewOutputSchema,
  meta: {
    "openai/outputTemplate": OUTPUT_TEMPLATE,
    "openai/widgetAccessible": true,
    // NO fileParams - text-only tool does not accept images
    "openai/toolInvocation/invoking": "Generating preview...",
    "openai/toolInvocation/invoked": "Preview ready"
    // Note: readOnlyHint is set by buildAnnotations() in registerTools.ts
  },
  handler
};
