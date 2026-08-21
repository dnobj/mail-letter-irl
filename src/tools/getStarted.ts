import { McpToolDefinition } from "../contracts/types.js";
import { widgetTemplateUri } from "../mcp/widgetUris.js";

const OUTPUT_TEMPLATE = widgetTemplateUri("GetStartedCard");

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
    "Show a short getting-started guide for new Letter IRL users, including what the app can do, how to buy pre-paid letter sends on letterirl.com, and example prompts to try next.",
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
      purchaseStep:
        "Before sending mail, buy pre-paid letter sends on letterirl.com. Then tell me who the mail is for and what you want to say.",
      examplePrompts: [
        "Draft a letter to my grandmother",
        "Create a postcard for my friend in Seattle",
        "Check my letter balance"
      ]
    };
  }
};
