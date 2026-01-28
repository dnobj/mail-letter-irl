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
  quoteAndPreviewLetterWithHeaderImageInputZ,
  quoteAndPreviewLetterWithImageInputZ,
  sendLetterInputZ,
  getOrderStatusInputZ,
  getAccountBalanceInputZ,
  listOrdersInputZ,
  setReturnAddressInputZ,
  getReturnAddressInputZ,
  clearReturnAddressInputZ,
  quoteAndPreviewPostcardInputZ,
  sendPostcardInputZ,
  submitFeatureRequestInputZ
} from "../zodSchemas.js";
import { AuthenticatedUser } from "../auth/tokenValidator.js";
import { getOrCreateUser } from "../services/userService.js";
import { extractUserAgent, isMobileClient } from "../utils/mobileDetection.js";

/**
 * Build MCP tool annotations from tool definition.
 *
 * These annotations tell ChatGPT how to classify tools:
 * - readOnlyHint: true = Tool does NOT modify its environment (read operations)
 * - readOnlyHint: false = Tool modifies its environment (write operations)
 * - destructiveHint: true = Tool may delete or overwrite user data
 * - openWorldHint: true = Tool interacts with external entities (APIs, mail services)
 * - idempotentHint: true = Repeated calls with same args have no additional effect
 *
 * IMPORTANT: Quote/preview tools are NOT read-only because they create draft records
 * in the database. Per MCP specification: "readOnlyHint: true = tool does NOT modify
 * its environment". Creating database records IS modifying the environment.
 *
 * @see US-MCP-06: Tool Read/Write Annotations
 * @see docs/learnings/tool-annotation-decision.md
 * @see https://developers.openai.com/apps-sdk/plan/tools/
 * @see https://modelcontextprotocol.io/legacy/concepts/tools
 */
function buildAnnotations(tool: { name: string; readOnly: boolean }): ToolAnnotations {
  const name = tool.name;

  // Read-only tools: only retrieve data, no modifications
  const readOnlyTools = [
    'get_account_balance',
    'list_orders',
    'get_order_status',
    'get_return_address'
  ];

  // Tools that call external APIs (PostGrid for validation or mail fulfillment)
  const openWorldTools = [
    'quote_and_preview_letter',
    'quote_and_preview_letter_with_header_image',
    'quote_and_preview_letter_with_image',
    'quote_and_preview_postcard',
    'send_letter',
    'send_postcard',
    'set_return_address'  // Validates address via PostGrid
  ];

  // Tools where repeated calls with same args have no additional effect
  // NOTE: Quote/preview tools are NOT idempotent - each call creates a new draft
  // See US-MCP-09 and docs/learnings/tool-annotation-decision.md
  const idempotentTools = [
    'send_letter',           // Draft consumption makes retries safe
    'send_postcard',         // Draft consumption makes retries safe
    'set_return_address',    // Setting same address twice = no change
    'clear_return_address'   // Clearing twice = no additional effect
  ];

  // Destructive tools that delete or overwrite user data
  const destructiveTools = [
    'clear_return_address'
  ];

  return {
    readOnlyHint: readOnlyTools.includes(name),
    destructiveHint: destructiveTools.includes(name),
    openWorldHint: openWorldTools.includes(name),
    idempotentHint: idempotentTools.includes(name)
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
  { name: "LetterPreviewCard", description: "Shows letter preview with cost, delivery info, and status" },
  { name: "PostcardPreviewCard", description: "Shows postcard front/back preview with cost, delivery info, and status" },
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
 * Backend API URL for widget CSP.
 * Widgets may need to communicate with our backend API via callTool.
 *
 * @see US-MCP-07: Widget Resources
 */
const WIDGET_API_URL = process.env.LETTER_IRL_API_URL ?? "https://api.letterirl.com";

/**
 * Content Security Policy for widgets.
 * Our widgets use window.openai.callTool which communicates with ChatGPT.
 * We include chatgpt.com to allow this internal communication.
 * We also include our backend API URL for widget → server calls.
 *
 * @see https://developers.openai.com/apps-sdk/build/chatgpt-ui/
 * @see US-MCP-07: Widget Resources
 */
const WIDGET_CSP = {
  connect_domains: ["https://chatgpt.com", WIDGET_API_URL],
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

    // Register widget resource per OpenAI docs:
    // - Empty {} for options (NOT { mimeType: ... })
    // - _meta on the content item with CSP, domain, and widgetPrefersBorder
    mcpServer.registerResource(
      widget.name,
      uri,
      {},  // Empty options per docs
      async () => {
        console.log(`🎨 Widget resource requested: ${uri}`);
        const html = await fs.readFile(filePath, "utf-8");
        console.log(`🎨 Returning widget HTML (${html.length} bytes)`);
        return {
          contents: [{
            uri,
            mimeType: "text/html+skybridge",
            text: html,
            _meta: {
              "openai/widgetPrefersBorder": true,
              "openai/widgetDomain": WIDGET_DOMAIN,
              "openai/widgetCSP": WIDGET_CSP,
              "openai/widgetDescription": widget.description
            }
          }]
        };
      }
    );

    console.log(`📦 Registered widget resource: ${uri}`);
  }
}

type ToolName = keyof typeof toolInputSchemas;

const DEFAULT_USER_ID = process.env.LETTER_IRL_DEFAULT_USER_ID ?? "mcp-user";

const zodInputSchemas: Record<ToolName, z.ZodObject<any>> = {
  // Letter tools - three separate tools for different layouts
  quote_and_preview_letter: quoteAndPreviewInputZ,
  quote_and_preview_letter_with_header_image: quoteAndPreviewLetterWithHeaderImageInputZ,
  quote_and_preview_letter_with_image: quoteAndPreviewLetterWithImageInputZ,
  send_letter: sendLetterInputZ,
  // Account and order management tools
  get_order_status: getOrderStatusInputZ,
  get_account_balance: getAccountBalanceInputZ,
  list_orders: listOrdersInputZ,
  set_return_address: setReturnAddressInputZ,
  get_return_address: getReturnAddressInputZ,
  clear_return_address: clearReturnAddressInputZ,
  // Postcard tools
  quote_and_preview_postcard: quoteAndPreviewPostcardInputZ,
  send_postcard: sendPostcardInputZ,
  // Feedback tools
  submit_feature_request: submitFeatureRequestInputZ
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

    // Register tool per OpenAI docs format:
    // - title field for human-readable name
    // - _meta with openai/outputTemplate pointing to ui:// resource
    mcpServer.registerTool(
      tool.name,
      {
        title: tool.description,  // Use description as title
        description: tool.description,
        inputSchema: shape,
        annotations,
        _meta: tool.meta  // Contains openai/outputTemplate, widgetAccessible, etc.
      },
      async (args, extra) => {
        // Extract userAgent from request metadata (US-POSTCARD-04: Mobile Image Graceful Degradation)
        const argsMeta = (args as Record<string, unknown>)._meta as Record<string, unknown> | undefined;
        const extraMeta = extra._meta as Record<string, unknown> | undefined;
        const userAgent = extractUserAgent(argsMeta, extraMeta);
        const isMobile = userAgent ? isMobileClient(userAgent) : undefined;

        console.log(
          `Tool request ${tool.name} payload: ${JSON.stringify(args)} for user: ${userId} (mobile: ${isMobile ?? 'unknown'})`
        );

        const { result, meta } = await appServer.execute({
          toolName: tool.name,
          input: args,
          userId,
          isMobile
        });

        const summaryText = summarizeToolResult(tool.name, result as Record<string, unknown>);

        // Per OpenAI docs, response has three sibling payloads:
        // - structuredContent: data for model + widget (→ window.openai.toolOutput)
        // - content: narration for model
        // - _meta: widget-only data (→ window.openai.toolResponseMetadata)
        //
        // US-MCP-07: Separate heavy data (previewHtml) into _meta to reduce model context bloat.
        // The model doesn't need raw HTML; it gets the summaryText narration instead.
        const resultObj = result as Record<string, unknown>;
        // Extract heavy data that the model doesn't need - only the widget uses it
        // Letters have previewHtml, postcards have previewFrontHtml/previewBackHtml
        // Image data (base64) should ONLY go to the widget, not to the model
        // This prevents 60K+ token responses from confusing ChatGPT
        const {
          previewHtml,
          previewFrontHtml,
          previewBackHtml,
          inlineImageData,      // Letter inline image (base64)
          headerImageData,      // Letter header image (base64)
          frontImageData,       // Postcard front image (base64)
          ...modelFacingData
        } = resultObj;

        const response = {
          structuredContent: modelFacingData,  // Lean data for model (no HTML)
          content: [
            {
              type: "text" as const,
              text: summaryText
            }
          ],
          _meta: {
            ...meta,
            // Heavy data for widget only (→ window.openai.toolResponseMetadata)
            // Widget reads this via window.openai.toolResponseMetadata.previewHtml
            ...(previewHtml !== undefined ? { previewHtml } : {}),
            // Postcard-specific preview fields
            ...(previewFrontHtml !== undefined ? { previewFrontHtml } : {}),
            ...(previewBackHtml !== undefined ? { previewBackHtml } : {})
          }
        };

        console.log(`📤 Tool response ${tool.name}:`);
        console.log(`   structuredContent: ${JSON.stringify(modelFacingData)}`);
        if (previewHtml) {
          console.log(`   _meta.previewHtml: [${(previewHtml as string).length} bytes]`);
        }

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
      // Now returns lettersRemaining directly
      const letters = result.lettersRemaining as number | undefined;
      return message || `Letter Balance: ${letters ?? "unknown"} letters`;
    }
    case "quote_and_preview_letter":
    case "quote_and_preview_letter_with_header_image":
    case "quote_and_preview_letter_with_image": {
      // Now returns lettersRequired directly (always 1 for standard letter)
      const lettersRequired = result.lettersRequired as number | undefined;
      const canSend = result.canSendNow ? "can send now" : "cannot send";
      const usedSaved = result.usedSavedReturnAddress as boolean | undefined;
      const layoutType = result.layoutType as string | undefined;
      let summary = `Preview ready: requires ${lettersRequired ?? 1} ${lettersRequired === 1 ? 'letter' : 'letters'} from balance (${canSend}).`;
      if (layoutType && layoutType !== 'text_only') {
        summary += ` Layout: ${layoutType.replace('_', ' ')}.`;
      }
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
    case "quote_and_preview_postcard": {
      const lettersRequired = result.lettersRequired as number | undefined;
      const canSend = result.canSendNow ? "can send now" : "cannot send";
      const usedSaved = result.usedSavedReturnAddress as boolean | undefined;
      let summary = `Postcard preview ready: requires ${lettersRequired ?? 1} ${lettersRequired === 1 ? 'letter' : 'letters'} from balance (${canSend}).`;
      if (usedSaved) {
        summary += " Using your saved return address.";
      }
      return summary;
    }
    case "send_postcard": {
      const status = result.currentStatus ?? "unknown";
      const order = result.orderId ?? "(no id)";
      const note = result.saveReturnAddressNote as string | undefined;
      let summary = `Postcard ${order} queued with status ${status}.`;
      if (note) {
        summary += ` ${note}`;
      }
      return summary;
    }
    case "submit_feature_request": {
      const message = result.message as string;
      return message || "Feature request submitted.";
    }
    default:
      return JSON.stringify(result);
  }
}
