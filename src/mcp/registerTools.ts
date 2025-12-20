import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { LetterIrlServer } from "../server.js";
import { toolInputSchemas } from "./toolSchemas.js";
import {
  quoteAndPreviewInputZ,
  sendLetterInputZ,
  getOrderStatusInputZ,
  getAccountBalanceInputZ,
  listOrdersInputZ,
  setReturnAddressInputZ,
  getReturnAddressInputZ,
  clearReturnAddressInputZ
} from "../zodSchemas.js";
import { AuthenticatedUser } from "../auth/tokenValidator.js";
import { getOrCreateUser } from "../services/userService.js";

/**
 * Build MCP tool annotations from tool definition.
 *
 * These annotations tell ChatGPT how to classify tools:
 * - readOnlyHint: true = READ (no user confirmation needed)
 * - readOnlyHint: false = WRITE (requires user confirmation)
 * - destructiveHint: true = Shows deletion warning
 *
 * @see US-MCP-06: Tool Read/Write Annotations
 * @see https://developers.openai.com/apps-sdk/plan/tools/
 */
function buildAnnotations(tool: { name: string; readOnly: boolean }): ToolAnnotations {
  return {
    readOnlyHint: tool.readOnly,
    destructiveHint: tool.name === 'clear_return_address',
  };
}

/**
 * Widget definitions for OpenAI Apps SDK.
 * Each widget is registered as an MCP resource with ui:// URI.
 *
 * @see US-MCP-07: Widget Resources
 * @see https://developers.openai.com/apps-sdk/build/chatgpt-ui/
 */
const WIDGET_DEFINITIONS = [
  { name: "BalanceCard", description: "Displays account credit balance and send affordability" },
  { name: "LetterPreviewCard", description: "Shows letter preview with send action button" },
  { name: "LetterConfirmationCard", description: "Confirms letter has been queued for sending" },
  { name: "LetterStatusCard", description: "Shows order status timeline and delivery tracking" },
];

/**
 * Widget domain for CSP isolation.
 * Per OpenAI examples, this should be https://chatgpt.com for widgets
 * running in the ChatGPT environment.
 * Required for app submission.
 *
 * @see https://developers.openai.com/apps-sdk/build/chatgpt-ui/
 */
const WIDGET_DOMAIN = process.env.LETTER_IRL_WIDGET_DOMAIN ?? "https://chatgpt.com";

/**
 * Content Security Policy for widgets.
 * Our widgets use window.openai.callTool which communicates with ChatGPT.
 * We include chatgpt.com to allow this internal communication.
 *
 * @see https://developers.openai.com/apps-sdk/build/chatgpt-ui/
 */
const WIDGET_CSP = {
  connect_domains: ["https://chatgpt.com"],
  resource_domains: ["https://*.oaistatic.com"],
  // frame_domains not included - we don't use iframes
  // redirect_domains not included - we don't use openExternal
};

// Resolve widget directory relative to this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_WIDGET_DIR = process.env.LETTER_IRL_WIDGET_DIR ?? path.resolve(__dirname, "../../widgets");

/**
 * Register widget HTML files as MCP resources.
 *
 * ChatGPT requires widgets to be:
 * 1. Registered as MCP resources with ui:// protocol URIs
 * 2. Served with text/html+skybridge MIME type
 * 3. Referenced in tool _meta.openai/outputTemplate
 *
 * The skybridge MIME type signals ChatGPT to inject window.openai runtime.
 */
async function registerWidgetResources(mcpServer: McpServer) {
  for (const widget of WIDGET_DEFINITIONS) {
    const uri = `ui://widgets/${widget.name}.html`;
    const filePath = path.join(DEFAULT_WIDGET_DIR, `${widget.name}.html`);

    // Check if widget file exists before registering
    try {
      await fs.access(filePath);
    } catch {
      console.warn(`⚠️  Widget file not found: ${filePath}`);
      continue;
    }

    // Widget-specific _meta for CSP, domain, and description
    // Per OpenAI example: https://developers.openai.com/apps-sdk/build/chatgpt-ui/
    const widgetMeta = {
      "openai/widgetCSP": WIDGET_CSP,
      "openai/widgetDomain": WIDGET_DOMAIN,
      "openai/widgetDescription": widget.description,
      "openai/widgetAccessible": true,  // Enable window.openai.callTool
    };

    // Use registerResource to match OpenAI example format
    // The _meta goes on the content item in the response
    mcpServer.registerResource(
      widget.name,
      uri,
      { mimeType: "text/html+skybridge", description: widget.description },
      async () => {
        console.log(`🎨 Widget resource requested: ${uri}`);
        const html = await fs.readFile(filePath, "utf-8");
        console.log(`🎨 Returning widget HTML (${html.length} bytes): ${uri}`);
        console.log(`🎨 Widget _meta: ${JSON.stringify(widgetMeta)}`);
        return {
          contents: [{
            uri,
            mimeType: "text/html+skybridge",
            text: html,
            _meta: widgetMeta
          }]
        };
      }
    );

    console.log(`📦 Registered widget resource: ${uri} (CSP: ${JSON.stringify(WIDGET_CSP)}, domain: ${WIDGET_DOMAIN})`);
  }
}

type ToolName = keyof typeof toolInputSchemas;

const DEFAULT_USER_ID = process.env.LETTER_IRL_DEFAULT_USER_ID ?? "mcp-user";

const zodInputSchemas: Record<ToolName, z.ZodObject<any>> = {
  quote_and_preview_letter: quoteAndPreviewInputZ,
  send_letter: sendLetterInputZ,
  get_order_status: getOrderStatusInputZ,
  get_account_balance: getAccountBalanceInputZ,
  list_orders: listOrdersInputZ,
  set_return_address: setReturnAddressInputZ,
  get_return_address: getReturnAddressInputZ,
  clear_return_address: clearReturnAddressInputZ
};

function getZodShape(name: string) {
  const schema = zodInputSchemas[name as ToolName];
  return schema?.shape;
}

export async function registerLetterTools(
  mcpServer: McpServer,
  appServer: LetterIrlServer,
  authInfo: AuthenticatedUser | null = null
) {
  const userId = authInfo?.userId ?? DEFAULT_USER_ID;
  console.log(`Registering Letter IRL tools for user: ${userId}`);

  // Auto-create user if they don't exist (with email from Auth0 userinfo endpoint)
  if (authInfo) {
    let email = (authInfo.claims.email as string) || null;

    // If email not in JWT claims, fetch it from Auth0 userinfo endpoint
    if (!email) {
      try {
        const issuer = process.env.LETTER_IRL_OAUTH_ISSUER;
        if (issuer) {
          const userinfoUrl = `${issuer}userinfo`;
          console.log(`🔍 Fetching user info from: ${userinfoUrl}`);

          const response = await fetch(userinfoUrl, {
            headers: {
              'Authorization': `Bearer ${authInfo.token}`
            }
          });

          if (response.ok) {
            const userInfo = await response.json();
            email = userInfo.email || userInfo.sub || 'unknown@example.com';
            console.log(`✅ Retrieved email from userinfo: ${email}`);
          } else {
            console.warn(`⚠️  Failed to fetch userinfo: ${response.status} ${response.statusText}`);
            email = 'unknown@example.com';
          }
        } else {
          email = 'unknown@example.com';
        }
      } catch (error) {
        console.error(`⚠️  Error fetching userinfo:`, error);
        email = 'unknown@example.com';
      }
    }

    try {
      await getOrCreateUser(userId, email);
      console.log(`✅ User ready: ${userId} (${email})`);
    } catch (error) {
      console.error(`⚠️  Failed to create user ${userId}:`, error);
    }
  }

  // Register widget resources for ChatGPT UI rendering
  await registerWidgetResources(mcpServer);

  const toolDefs = appServer.listTools();
  for (const tool of toolDefs) {
    const shape = getZodShape(tool.name);
    if (!shape) {
      continue;
    }

    // Build annotations for ChatGPT to classify tools as READ or WRITE
    const annotations = buildAnnotations(tool);

    // Use registerTool to pass _meta with openai/outputTemplate for widget rendering
    // The _meta in tool registration tells ChatGPT which widget to render
    mcpServer.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: shape,  // ZodRawShape, not wrapped in z.object()
        annotations,
        _meta: tool.meta  // Contains openai/outputTemplate for widget discovery
      },
      async (args, extra) => {
        console.log(
          `Tool request ${tool.name} payload: ${JSON.stringify(args)} for user: ${userId}`
        );
        const { result, meta } = await appServer.execute({
          toolName: tool.name,
          input: args,
          userId
        });

        const summaryText = summarizeToolResult(tool.name, result as Record<string, unknown>);

        // Per OpenAI examples, response should have structuredContent and content
        // The _meta with openai/outputTemplate goes in tool REGISTRATION only,
        // not in the response. ChatGPT reads the template from tool definition.
        const response = {
          content: [
            {
              type: "text" as const,
              text: summaryText
            }
          ],
          structuredContent: result
        };

        console.log(`📤 Tool response ${tool.name}:`);
        console.log(`   structuredContent keys: ${Object.keys(result as object).join(', ')}`);

        return response;
      }
    );
  }

}

function summarizeToolResult(
  toolName: string,
  result: Record<string, unknown>
): string {
  switch (toolName) {
    case "get_account_balance": {
      const message = result.message as string;
      return message || `Balance: ${result.creditsRemaining ?? "unknown"} credits`;
    }
    case "quote_and_preview_letter": {
      const required = result.requiredCredits ?? "?";
      const canSend = result.canSendNow ? "can send now" : "cannot send";
      const usedSaved = result.usedSavedReturnAddress as boolean | undefined;
      let summary = `Preview ready: requires ${required} credits (${canSend}).`;
      if (usedSaved) {
        summary += " Using your saved return address.";
      }
      return summary;
    }
    case "send_letter": {
      const status = result.currentStatus ?? "unknown";
      const order = result.orderId ?? "(no id)";
      const note = result.saveReturnAddressNote as string | undefined;
      let summary = `Letter ${order} queued with status ${status}.`;
      if (note) {
        summary += ` ${note}`;
      }
      return summary;
    }
    case "get_order_status": {
      const status = result.currentStatus ?? "unknown";
      return `Latest order status: ${status}.`;
    }
    case "list_orders": {
      const orders = result.orders as any[];
      const total = result.total ?? 0;
      return `Found ${orders?.length ?? 0} recent orders (${total} total).`;
    }
    case "set_return_address": {
      const message = result.message as string;
      return message || (result.success ? "Return address saved." : "Failed to save return address.");
    }
    case "get_return_address": {
      const message = result.message as string;
      return message || (result.hasAddress ? "Return address retrieved." : "No return address saved.");
    }
    case "clear_return_address": {
      const message = result.message as string;
      return message || "Return address cleared.";
    }
    default:
      return JSON.stringify(result);
  }
}
