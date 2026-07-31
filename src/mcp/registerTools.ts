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
  submitFeatureRequestInputZ,
  getStartedInputZ,
  uploadImageInputZ,
  generateImageInputZ,
  confirmUploadedImageInputZ,
  quoteAndPreviewOutputZ,
  sendLetterOutputZ,
  getOrderStatusOutputZ,
  getAccountBalanceOutputZ,
  listOrdersOutputZ,
  setReturnAddressOutputZ,
  getReturnAddressOutputZ,
  clearReturnAddressOutputZ,
  quoteAndPreviewPostcardOutputZ,
  sendPostcardOutputZ,
  submitFeatureRequestOutputZ,
  getStartedOutputZ,
  uploadImageOutputZ,
  generateImageOutputZ,
  confirmUploadedImageOutputZ
} from "../zodSchemas.js";
import { AuthenticatedUser } from "../auth/tokenValidator.js";
import { extractUserAgent, isMobileClient } from "../utils/mobileDetection.js";
import { ToolMeta } from "../contracts/types.js";
import { authorizeTool, getRequiredToolScopes } from "../auth/toolScopes.js";
import { prepareAuthenticatedUser } from "../auth/identity.js";
import {
  classifyDiagnosticError,
  writeDiagnostic
} from "../utils/diagnosticLog.js";
import {
  buildInsufficientScopeToolResult,
  InsufficientScopeError
} from "../auth/oauthChallenge.js";

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
export function buildAnnotations(tool: { name: string; readOnly: boolean }): ToolAnnotations {
  const name = tool.name;

  // Read-only tools: only retrieve data, no modifications
  const readOnlyTools = [
    'get_started',
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
    'set_return_address',  // Validates address via PostGrid
    'generate_image'       // Calls OpenAI Images API
  ];

  // Tools where repeated calls with same args have no additional effect
  // NOTE: Quote/preview tools are NOT idempotent - each call creates a new draft
  // See US-MCP-09 and docs/learnings/tool-annotation-decision.md
  const idempotentTools = [
    'send_letter',           // Draft consumption makes retries safe
    'send_postcard',         // Draft consumption makes retries safe
    'set_return_address',    // Setting same address twice = no change
    'clear_return_address',  // Clearing twice = no additional effect
    'confirm_uploaded_image' // Repeating the same relay overwrites with the same value
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
export const WIDGET_DEFINITIONS = [
  { name: "LetterPreviewCard", description: "Shows letter preview with cost, delivery info, and status" },
  { name: "PostcardPreviewCard", description: "Shows postcard front/back preview with cost, delivery info, and status" },
  { name: "ImageUploadCard", description: "File picker widget for uploading photos to use in letters or postcards" },
  { name: "GenerateImageCard", description: "Preview widget for AI-generated images with upload to use in letters or postcards" },
  { name: "GetStartedCard", description: "Getting-started guide for new users with setup steps and example prompts" },
];

/**
 * Widget domain for CSP isolation.
 * Per OpenAI examples, this should be https://chatgpt.com for widgets
 * running in the ChatGPT environment.
 * Required for app submission.
 *
 * @see https://developers.openai.com/apps-sdk/build/chatgpt-ui/
 */
const WIDGET_DOMAIN = process.env.LETTER_IRL_WIDGET_DOMAIN ?? "https://api.letterirl.com";

/**
 * Backend API URL for widget CSP.
 * Widgets may need to communicate with our backend API via callTool.
 *
 * @see US-MCP-07: Widget Resources
 */
const WIDGET_API_URL =
  process.env.LETTER_IRL_API_URL ??
  process.env.LETTER_IRL_PUBLIC_BASE_URL ??
  "https://api.letterirl.com";
export const WIDGET_MIME_TYPE = "text/html;profile=mcp-app";

export function normalizeHttpsOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      throw new Error("Widget API URL must use HTTPS");
    }
    return url.origin;
  } catch {
    return "https://api.letterirl.com";
  }
}

const WIDGET_API_ORIGIN = normalizeHttpsOrigin(WIDGET_API_URL);

/**
 * Content Security Policy for widgets.
 * Our widgets use window.openai.callTool which communicates with ChatGPT.
 * We include chatgpt.com to allow this internal communication.
 * We also include our backend API URL for widget → server calls.
 *
 * @see https://developers.openai.com/apps-sdk/build/chatgpt-ui/
 * @see US-MCP-07: Widget Resources
 */
export const WIDGET_CSP_CANONICAL = {
  connectDomains: ["https://chatgpt.com", WIDGET_API_ORIGIN],
  resourceDomains: ["https://*.oaistatic.com", WIDGET_API_ORIGIN]
};

export const WIDGET_CSP_LEGACY = {
  connect_domains: ["https://chatgpt.com", WIDGET_API_ORIGIN],
  resource_domains: ["https://*.oaistatic.com", WIDGET_API_ORIGIN],
  // frame_domains not included - we don't use iframes
  // redirect_domains not included - we don't use openExternal
};

// Resolve widget directory relative to this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_WIDGET_DIR = process.env.LETTER_IRL_WIDGET_DIR ?? path.resolve(__dirname, "../../widgets");

export function buildToolSecuritySchemes(
  toolName: string,
  requireAuth = process.env.LETTER_IRL_REQUIRE_AUTH !== "false"
) {
  if (!requireAuth) {
    return [{ type: "noauth" }];
  }

  return [
    {
      type: "oauth2",
      scopes: getRequiredToolScopes(toolName)
    }
  ];
}

export function buildToolMeta(
  toolName: string,
  meta: ToolMeta,
  requireAuth = process.env.LETTER_IRL_REQUIRE_AUTH !== "false"
): ToolMeta {
  const outputTemplate = meta["openai/outputTemplate"] as string | undefined;
  const widgetAccessible = meta["openai/widgetAccessible"] as boolean | undefined;
  const existingUi = (meta.ui as Record<string, unknown> | undefined) ?? {};

  return {
    securitySchemes: buildToolSecuritySchemes(toolName, requireAuth),
    ...meta,
    ui: {
      ...existingUi,
      ...(outputTemplate ? { resourceUri: outputTemplate } : {}),
      ...(widgetAccessible !== undefined ? { widgetAccessible } : {})
    }
  };
}

export function buildWidgetResourceMeta(description: string) {
  return {
    ui: {
      description,
      domain: WIDGET_DOMAIN,
      csp: WIDGET_CSP_CANONICAL,
      prefersBorder: true
    },
    "openai/widgetPrefersBorder": true,
    "openai/widgetDomain": WIDGET_DOMAIN,
    "openai/widgetCSP": WIDGET_CSP_LEGACY,
    "openai/widgetDescription": description
  };
}

/**
 * Register widget HTML files as MCP resources.
 *
 * Current Apps SDK-style widgets are:
 * 1. Registered as MCP resources with ui:// protocol URIs
 * 2. Served with text/html;profile=mcp-app
 * 3. Exposed with canonical ui.* metadata plus legacy openai/* aliases
 *
 * The widget HTML profile signals the client to inject the runtime bridge.
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

    // Register widget resource with canonical ui.* metadata and
    // legacy openai/* aliases for compatibility.
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
            mimeType: WIDGET_MIME_TYPE,
            text: html,
            _meta: buildWidgetResourceMeta(widget.description)
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
  submit_feature_request: submitFeatureRequestInputZ,
  get_started: getStartedInputZ,
  // Image upload tool
  upload_image: uploadImageInputZ,
  // Image generation tool
  generate_image: generateImageInputZ,
  // Confirm uploaded image tool (widget relay)
  confirm_uploaded_image: confirmUploadedImageInputZ
};

const zodOutputSchemas: Record<ToolName, z.ZodObject<any>> = {
  // Letter tools - three separate tools for different layouts
  quote_and_preview_letter: quoteAndPreviewOutputZ,
  quote_and_preview_letter_with_header_image: quoteAndPreviewOutputZ,
  quote_and_preview_letter_with_image: quoteAndPreviewOutputZ,
  send_letter: sendLetterOutputZ,
  // Account and order management tools
  get_order_status: getOrderStatusOutputZ,
  get_account_balance: getAccountBalanceOutputZ,
  list_orders: listOrdersOutputZ,
  set_return_address: setReturnAddressOutputZ,
  get_return_address: getReturnAddressOutputZ,
  clear_return_address: clearReturnAddressOutputZ,
  // Postcard tools
  quote_and_preview_postcard: quoteAndPreviewPostcardOutputZ,
  send_postcard: sendPostcardOutputZ,
  // Feedback tools
  submit_feature_request: submitFeatureRequestOutputZ,
  get_started: getStartedOutputZ,
  // Image upload tool
  upload_image: uploadImageOutputZ,
  // Image generation tool
  generate_image: generateImageOutputZ,
  // Confirm uploaded image tool (widget relay)
  confirm_uploaded_image: confirmUploadedImageOutputZ
};

export function getZodInputShape(name: string) {
  const schema = zodInputSchemas[name as ToolName];
  return schema?.shape;
}

export function getZodOutputShape(name: string) {
  const schema = zodOutputSchemas[name as ToolName];
  return schema?.shape;
}

type PartitionedToolResult = {
  structuredContent: Record<string, unknown>;
  _meta: Record<string, unknown>;
};

/** Keep widget-only previews out of model context while retaining chainable URLs. */
export function partitionToolResult(
  result: Record<string, unknown>,
  meta: Record<string, unknown> = {}
): PartitionedToolResult {
  const {
    previewHtml,
    previewFrontHtml,
    previewBackHtml,
    inlineImageData,
    headerImageData,
    frontImageData,
    generatedImagePreview,
    ...modelFacingData
  } = result;

  return {
    structuredContent: modelFacingData,
    _meta: {
      ...meta,
      ...(previewHtml !== undefined ? { previewHtml } : {}),
      ...(previewFrontHtml !== undefined ? { previewFrontHtml } : {}),
      ...(previewBackHtml !== undefined ? { previewBackHtml } : {}),
      ...(generatedImagePreview !== undefined ? { generatedImagePreview } : {}),
      ...(modelFacingData.generatedImageUrl !== undefined
        ? { generatedImageUrl: modelFacingData.generatedImageUrl }
        : {})
    }
  };
}

export async function registerLetterTools(
  mcpServer: McpServer,
  appServer: LetterIrlServer,
  authInfo: AuthenticatedUser | null = null
) {
  const userId = authInfo?.userId ?? DEFAULT_USER_ID;
  writeDiagnostic("info", "mcp.tools_registering", {
    authType: authInfo?.authType ?? "disabled"
  });

  if (authInfo) {
    try {
      await prepareAuthenticatedUser(authInfo);
    } catch (error) {
      writeDiagnostic("error", "auth.user_preparation_failed", {
        errorClass: classifyDiagnosticError(error, "identity_persistence_failed")
      });
    }
  }

  // Register widget resources for ChatGPT UI rendering
  await registerWidgetResources(mcpServer);

  const toolDefs = appServer.listTools();
  for (const tool of toolDefs) {
    const inputShape = getZodInputShape(tool.name);
    const outputShape = getZodOutputShape(tool.name);
    if (!inputShape || !outputShape) {
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
        inputSchema: inputShape,
        outputSchema: outputShape,
        annotations,
        _meta: buildToolMeta(tool.name, tool.meta)
      },
      async (args: Record<string, unknown>, extra: any) => {
        try {
          authorizeTool(tool.name, authInfo);
        } catch (error) {
          if (error instanceof InsufficientScopeError) {
            return buildInsufficientScopeToolResult(error);
          }
          throw error;
        }
        // Extract userAgent from request metadata (US-POSTCARD-04: Mobile Image Graceful Degradation)
        const argsMeta = (args as Record<string, unknown>)._meta as Record<string, unknown> | undefined;
        const extraMeta = extra._meta as Record<string, unknown> | undefined;
        const userAgent = extractUserAgent(argsMeta, extraMeta);
        const isMobile = userAgent ? isMobileClient(userAgent) : undefined;

        console.log(`Tool request ${tool.name} (mobile: ${isMobile ?? 'unknown'})`);

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
        const { structuredContent, _meta } = partitionToolResult(
          result as Record<string, unknown>,
          meta
        );

        if (tool.name === "generate_image") {
          generateImageOutputZ.parse(structuredContent);
        }

        const response = {
          structuredContent,
          content: [
            {
              type: "text" as const,
              text: summaryText
            }
          ],
          _meta
        };

        console.log(`📤 Tool response ${tool.name}:`);
        console.log(`   structuredContent keys: ${Object.keys(structuredContent).join(", ")}`);

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
    case "get_started": {
      const overview = result.overview as string | undefined;
      return overview || "Letter IRL getting-started guide ready.";
    }
    case "upload_image": {
      const message = result.message as string;
      return message || "Photo picker ready. Waiting for user to select a photo.";
    }
    case "generate_image": {
      const message = result.message as string;
      return message || "Image generated. Use the imageUrl with a preview tool.";
    }
    case "confirm_uploaded_image": {
      const suggestedNextStep = result.suggestedNextStep as string;
      return suggestedNextStep || "Photo uploaded. Use the imageUrl with a preview tool.";
    }
    default:
      return JSON.stringify(result);
  }
}
