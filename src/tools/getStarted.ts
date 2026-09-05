import { McpToolDefinition } from "../contracts/types.js";
import { widgetTemplateUri } from "../mcp/widgetUris.js";
import { isJitPurchaseEnabled } from "../config/products.js";

const OUTPUT_TEMPLATE = widgetTemplateUri("GetStartedCard");

/**
 * How to pay, described accurately for the deployment reading it (#229).
 *
 * This was a single static string claiming pre-payment is the only route. Pay &
 * Send has been supported in code since #69 and dark in every deployed
 * environment since, so the copy was true - and would have become a lie the
 * moment JIT_PURCHASE_ENABLED flipped, with nothing to catch it. Static copy
 * about a flagged feature silently misleads exactly when the feature ships.
 *
 * Read per call rather than captured at module load, so a restart is enough to
 * change it and a test can vary it without re-importing.
 */
function purchaseStep(): string {
  // Both branches now buy IN the conversation. Only Pay & Send is conditional:
  // packs are gated on beta access and price configuration, never on
  // JIT_PURCHASE_ENABLED - so the flag-off branch changed most. It used to
  // offer nothing but a link to letterirl.com, which is also currently
  // unreachable with LETTER_IRL_PACKS_URL unset.
  if (isJitPurchaseEnabled()) {
    return (
      "You can either buy a pack of prepaid letters right here, or pay for a single " +
      "letter at the moment you send it - no pre-purchase needed. Tell me who the mail " +
      "is for and what you want to say, and I'll walk you through whichever you prefer."
    );
  }
  return (
    "Before sending mail, buy a pack of prepaid letters - I can show you the sizes and " +
    "prices right here. Then tell me who the mail is for and what you want to say."
  );
}

interface GetStartedInput {}

interface GetStartedOutput {
  title: string;
  overview: string;
  purchaseStep: string;
  examplePrompts: string[];
}

export const getStartedTool: McpToolDefinition<GetStartedInput, GetStartedOutput> = {
  name: "get_started",
  description:
    "Show a short getting-started guide for new Letter IRL users, including what the app can do, how to buy prepaid letters without leaving the conversation, and example prompts to try next.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  },
  outputSchema: {
    type: "object",
    required: ["title", "overview", "purchaseStep", "examplePrompts"],
    properties: {
      title: { type: "string" },
      overview: { type: "string" },
      purchaseStep: { type: "string" },
      examplePrompts: {
        type: "array",
        items: { type: "string" }
      }
    }
  },
  meta: {
    "openai/outputTemplate": OUTPUT_TEMPLATE,
    "openai/toolInvocation/invoking": "Opening getting-started guide...",
    "openai/toolInvocation/invoked": "Getting-started guide ready",
    readOnlyHint: true
  },
  async handler() {
    return {
      title: "Get Started with Letter IRL",
      overview:
        "Letter IRL can draft, preview, and mail real physical letters and postcards in the U.S.",
      purchaseStep: purchaseStep(),
      examplePrompts: [
        "Draft a letter to my grandmother",
        "Create a postcard for my friend in Seattle",
        "Check my letter balance"
      ]
    };
  }
};
