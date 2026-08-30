import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolAnnotations, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { LetterIrlServer } from "../server.js";
import { toolInputSchemas } from "./toolSchemas.js";
import { widgetTemplateUri } from "./widgetUris.js";
import {
  quoteAndPreviewInputZ,
  quoteAndPreviewLetterWithHeaderImageInputZ,
  quoteAndPreviewLetterWithImageInputZ,
  sendLetterInputZ,
  createMailCheckoutInputZ,
  getPurchaseStatusInputZ,
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
  generateImageForMailInputZ,
  confirmUploadedImageInputZ,
  quoteAndPreviewOutputZ,
  sendLetterOutputZ,
  createMailCheckoutOutputZ,
  getPurchaseStatusOutputZ,
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
  generateImageForMailOutputZ,
  confirmUploadedImageOutputZ
} from "../zodSchemas.js";
import { AuthenticatedUser } from "../auth/tokenValidator.js";
import { extractUserAgent, isMobileClient } from "../utils/mobileDetection.js";
import { ToolMeta } from "../contracts/types.js";
import { authorizeTool, getRequiredToolScopes } from "../auth/toolScopes.js";
import { SESSION_SCOPES } from "../auth/oauthConfig.js";
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
    'get_purchase_status',
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
    'create_mail_checkout',
    'set_return_address',  // Validates address via PostGrid
    'generate_image_for_mail' // Calls the OpenAI Images API when credits allow
  ];

  // Tools where repeated calls with same args have no additional effect
  // NOTE: Quote/preview tools are NOT idempotent - each call creates a new draft
  // See US-MCP-09 and docs/learnings/tool-annotation-decision.md
  const idempotentTools = [
    'send_letter',           // Draft consumption makes retries safe
    'send_postcard',         // Draft consumption makes retries safe
    'create_mail_checkout',  // Reuses the active checkout for a draft
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
  { name: "GetStartedCard", description: "Getting-started guide for new users with setup steps and example prompts" },
  { name: "ImageRoutingCard", description: "Shows a generated image with its credit line, or image-routing guidance with a copy-ready prompt" },
];


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

export function normalizeHttpsOrigin(
  value: string,
  fallback = "https://api.letterirl.com"
): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      throw new Error("Widget API URL must use HTTPS");
    }
    return url.origin;
  } catch {
    return fallback;
  }
}

const WIDGET_API_ORIGIN = normalizeHttpsOrigin(WIDGET_API_URL);

/**
 * Widget domain, published as `ui.domain` and `openai/widgetDomain`.
 * Required for app submission.
 *
 * Defined below WIDGET_API_ORIGIN so it can default to the same origin the
 * CSP lists. It used to hardcode api.letterirl.com, which made dev
 * self-contradictory: the connector panel showed `domain:
 * "https://api.letterirl.com"` beside CSP entries that were all the Railway
 * dev host. An explicit LETTER_IRL_WIDGET_DOMAIN still overrides.
 *
 * The previous comment here claimed this "should be https://chatgpt.com per
 * OpenAI examples". Not acted on: ChatGPT demonstrably accepts the current
 * value - the connector panel renders our `ui` block, CSP and all - so
 * changing a submission-relevant field on the strength of an old comment
 * would be a guess with a regression attached (issue #228).
 *
 * @see https://developers.openai.com/apps-sdk/build/chatgpt-ui/
 */
const WIDGET_DOMAIN = process.env.LETTER_IRL_WIDGET_DOMAIN ?? WIDGET_API_ORIGIN;
const WIDGET_PACKS_ORIGIN = normalizeHttpsOrigin(
  process.env.LETTER_IRL_PACKS_URL ??
    process.env.LETTER_IRL_PUBLIC_BASE_URL ??
    "https://letterirl.com",
  "https://letterirl.com"
);
const WIDGET_REDIRECT_ORIGINS = Array.from(
  new Set(["https://checkout.stripe.com", WIDGET_PACKS_ORIGIN])
);

/**
 * Content Security Policy for widgets.
 * Our widgets use window.openai.callTool which communicates with ChatGPT.
 * We include chatgpt.com to allow this internal communication.
 * We also include our backend API URL for widget → server calls.
 *
 * @see https://developers.openai.com/apps-sdk/build/chatgpt-ui/
 * @see US-MCP-07: Widget Resources
 */
// *.oaiusercontent.com covers ChatGPT file-attachment download URLs
// (getFileDownloadUrl / fileParams), which ImageUploadCard renders as the
// preview for Library picks.
export const WIDGET_CSP_CANONICAL = {
  connectDomains: ["https://chatgpt.com", WIDGET_API_ORIGIN],
  resourceDomains: ["https://*.oaistatic.com", "https://*.oaiusercontent.com", WIDGET_API_ORIGIN],
  redirectDomains: WIDGET_REDIRECT_ORIGINS
};

export const WIDGET_CSP_LEGACY = {
  connect_domains: ["https://chatgpt.com", WIDGET_API_ORIGIN],
  resource_domains: ["https://*.oaistatic.com", "https://*.oaiusercontent.com", WIDGET_API_ORIGIN],
  // frame_domains not included - we don't use iframes
  redirect_domains: WIDGET_REDIRECT_ORIGINS
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
      // Two different questions, and they must not be conflated:
      //
      //   getRequiredToolScopes  - what this tool ENFORCES on every call
      //   this list              - what the client ASKS THE USER TO GRANT
      //
      // ChatGPT builds its authorization request from the union of these
      // per-tool lists, not from scopes_supported. That was the whole of the
      // #160 refresh-token bug: offline_access was advertised in the
      // protected-resource metadata, in openid-configuration, and in the 401
      // challenge, and requested from none of them - because it appeared in no
      // tool's securitySchemes. Every grant recorded exactly
      // "mail:draft mail:read mail:send", the union of the enforced scopes.
      //
      // Session scopes go here and nowhere else. They must never reach
      // getRequiredToolScopes: PAT callers authorize with no scopes at all, so
      // a tool demanding one would deny them permanently
      // (tests/unit/auth/sessionScopes.test.ts pins that).
      //
      // Applied to every tool deliberately. A typed @-mention scopes the turn's
      // toolset, so a session scope carried by only some tools would be
      // requested only sometimes.
      scopes: [...getRequiredToolScopes(toolName), ...SESSION_SCOPES]
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
 * Widgets indexed by name, for resolving a client-supplied template variable.
 */
const WIDGET_BY_NAME = new Map(
  WIDGET_DEFINITIONS.map((widget) => [widget.name, widget] as const)
);

/**
 * Read one widget's HTML as an MCP resource payload, or null if `name` is not
 * a widget we serve.
 *
 * SECURITY: `name` reaches this function from a client-supplied URI template
 * variable (see the version template in registerWidgetResources), so it is
 * resolved against WIDGET_DEFINITIONS *before* any filesystem access, and the
 * canonical name from that table - never the caller's string - is what reaches
 * path.join. Without that lookup this function is a path-traversal sink:
 * UriTemplate.match does not percent-decode, so a read of
 * `ui://widgets/..%2F..%2Fsecret.html@v1` arrives here as the literal name
 * `..%2F..%2Fsecret`. Returning early on an unknown name is what makes the
 * template safe to register at all.
 *
 * Logging here is the #235 diagnostic: it records the URI a client actually
 * asked for, which distinguishes "the client never requested the template"
 * from "the client requested a version/name we do not serve". Those two look
 * identical from the outside and the difference is the whole question. Only
 * the URI is logged - no tokens, no user identifiers.
 *
 * Note on coverage: every URI shape we have ever advertised as an
 * outputTemplate is either registered exactly or matches the version template,
 * so any read from a client using our own tool list reaches this function and
 * is logged. A URI matching neither is rejected inside the SDK's resources/read
 * handler before our code runs and is NOT logged here - so silence in this log
 * means "no read arrived", not "no read was attempted".
 */
async function readWidgetResource(name: string, uri: string) {
  const widget = WIDGET_BY_NAME.get(name);

  if (!widget) {
    console.warn(`🎨 Widget resource requested but not served: ${uri}`);
    return null;
  }

  console.log(`🎨 Widget resource requested: ${uri}`);
  const html = await fs.readFile(
    path.join(DEFAULT_WIDGET_DIR, `${widget.name}.html`),
    "utf-8"
  );
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
export async function registerWidgetResources(mcpServer: McpServer) {
  for (const widget of WIDGET_DEFINITIONS) {
    const filePath = path.join(DEFAULT_WIDGET_DIR, `${widget.name}.html`);

    // Check if widget file exists before registering
    try {
      await fs.access(filePath);
    } catch {
      console.warn(`⚠️  Widget file not found: ${filePath}`);
      continue;
    }

    // Register the versioned URI plus the legacy unversioned URI as a
    // transition alias: native mobile clients hold cached tool lists whose
    // outputTemplate still points at the unversioned form, and resources/read
    // is an exact-string lookup - without the alias those clients would get
    // ResourceNotFound (no widget at all) instead of a stale widget. The
    // unversioned form does not match the version template below, so this
    // alias is still load-bearing. Remove it once cached tool lists have aged
    // out (issue #235).
    const versionedUri = widgetTemplateUri(widget.name);
    const legacyUri = `ui://widgets/${widget.name}.html`;
    const registrations: Array<[string, string]> = [
      [widget.name, versionedUri],
      [`${widget.name}-legacy`, legacyUri]
    ];

    for (const [registrationName, uri] of registrations) {
      // Register widget resource with canonical ui.* metadata and
      // legacy openai/* aliases for compatibility.
      mcpServer.registerResource(
        registrationName,
        uri,
        {},  // Empty options per docs
        async () => {
          const result = await readWidgetResource(widget.name, uri);
          // Unreachable: the name comes from WIDGET_DEFINITIONS itself.
          if (!result) {
            throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} not found`);
          }
          return result;
        }
      );

      console.log(`📦 Registered widget resource: ${uri}`);
    }
  }

  // Serve ANY version of a widget URI, not just the current one.
  //
  // WHY: resources/read is an exact-string lookup, and the exact registrations
  // above cover exactly one version - WIDGET_TEMPLATE_VERSION. A client holding
  // a tool list cached from before the last bump asks for a URI registered
  // nowhere, so the read fails inside the SDK before any of our code runs and
  // the widget renders as "Error loading app - Failed to fetch template". That
  // is what a beta invitee sees, and pressing Refresh is not something they
  // will know to do. Observed against deployed development on 2026-08-29.
  //
  // A template matches every version at once, so no future bump can strand a
  // client either. The exact @vCURRENT registration above is deliberately KEPT
  // rather than replaced: templates are advertised separately from exact
  // resources, and if the host validates a tool's outputTemplate against the
  // exact resource list, a template-only registration would break rendering
  // for everyone. Do not "simplify" the two into one.
  //
  // Registered last because the SDK checks exact resources first and then walks
  // templates in insertion order, so this only ever handles what the exact
  // registrations did not. `list: undefined` keeps it out of resources/list,
  // where the exact URIs are the ones clients should discover.
  mcpServer.registerResource(
    "widget-any-version",
    new ResourceTemplate("ui://widgets/{name}.html@v{version}", { list: undefined }),
    {},
    async (uri, variables) => {
      const raw = variables.name;
      const name = Array.isArray(raw) ? raw[0] : raw;
      const result = await readWidgetResource(String(name ?? ""), uri.toString());
      if (!result) {
        // Same error the SDK raises for an unregistered URI, so an unknown
        // widget name is indistinguishable to the client from one we never
        // advertised - it just gets logged on our side now.
        throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} not found`);
      }
      return result;
    }
  );

  console.log(`📦 Registered widget resource template: ui://widgets/{name}.html@v{version}`);
}

type ToolName = keyof typeof toolInputSchemas;

const DEFAULT_USER_ID = process.env.LETTER_IRL_DEFAULT_USER_ID ?? "mcp-user";

const zodInputSchemas: Record<ToolName, z.ZodObject<any>> = {
  // Letter tools - three separate tools for different layouts
  quote_and_preview_letter: quoteAndPreviewInputZ,
  quote_and_preview_letter_with_header_image: quoteAndPreviewLetterWithHeaderImageInputZ,
  quote_and_preview_letter_with_image: quoteAndPreviewLetterWithImageInputZ,
  send_letter: sendLetterInputZ,
  create_mail_checkout: createMailCheckoutInputZ,
  get_purchase_status: getPurchaseStatusInputZ,
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
  generate_image_for_mail: generateImageForMailInputZ,
  // Confirm uploaded image tool (widget relay)
  confirm_uploaded_image: confirmUploadedImageInputZ
};

const zodOutputSchemas: Record<ToolName, z.ZodObject<any>> = {
  // Letter tools - three separate tools for different layouts
  quote_and_preview_letter: quoteAndPreviewOutputZ,
  quote_and_preview_letter_with_header_image: quoteAndPreviewOutputZ,
  quote_and_preview_letter_with_image: quoteAndPreviewOutputZ,
  send_letter: sendLetterOutputZ,
  create_mail_checkout: createMailCheckoutOutputZ,
  get_purchase_status: getPurchaseStatusOutputZ,
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
  generate_image_for_mail: generateImageForMailOutputZ,
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
    headerImagePreview,
    inlineImagePreview,
    // get_started's card copy. Display-only: the model does not act on any of
    // it, and when it could see it, it restated the whole card in prose
    // directly beneath a card already showing it. Same reasoning as the
    // preview HTML above - a widget needs it, the model does not.
    title,
    overview,
    purchaseStep,
    examplePrompts,
    ...modelFacingData
  } = result;

  return {
    structuredContent: modelFacingData,
    _meta: {
      ...meta,
      ...(previewHtml !== undefined ? { previewHtml } : {}),
      ...(previewFrontHtml !== undefined ? { previewFrontHtml } : {}),
      ...(previewBackHtml !== undefined ? { previewBackHtml } : {}),
      // The letter card's images. Small by construction - the builder
      // compresses them to roughly 3KB for exactly this trip - so unlike the
      // *ImageData fields above they are forwarded rather than dropped. They
      // travel here rather than in structuredContent for the same reason as
      // everything else in this list: a widget needs them, the model does not.
      //
      // Before this they were in neither channel. The output schema does not
      // declare them, so ChatGPT dropped them when it filtered
      // structuredContent against the published schema, and nothing put them
      // in _meta - a letter with a header or inline image rendered its card
      // without one, silently. (The filtering is client-side: at SDK 1.29.0
      // the server validates the result and ships it unstripped. Issue #257.)
      ...(title !== undefined ? { title } : {}),
      ...(overview !== undefined ? { overview } : {}),
      ...(purchaseStep !== undefined ? { purchaseStep } : {}),
      ...(examplePrompts !== undefined ? { examplePrompts } : {}),
      ...(headerImagePreview !== undefined ? { headerImagePreview } : {}),
      ...(inlineImagePreview !== undefined ? { inlineImagePreview } : {}),
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
        errorClass: classifyDiagnosticError(error, "database_error")
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
        title: tool.title ?? tool.description,  // Short label when provided; description otherwise
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

export function summarizeToolResult(
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
      const warnings = result.addressWarnings as string[] | undefined;
      if (warnings?.length) {
        summary += ` Note: ${warnings.join(' ')}`;
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
      const warnings = result.addressWarnings as string[] | undefined;
      if (warnings?.length) {
        summary += ` Note: ${warnings.join(' ')}`;
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
      // The summary used to be the card's own `overview` sentence, so the
      // model received the card's copy as its account of what happened and
      // dutifully restated it - overview, purchase step, and all three example
      // prompts, immediately below a card already showing them. Same fix as
      // the image routing card: the card is the single voice, and the model
      // adds at most one sentence.
      return (
        "The getting-started card is displayed above and already shows the overview, " +
        "the pre-pay step, and example prompts. Add at most ONE short sentence of your " +
        "own, or nothing at all. Never restate the card's contents or re-list the examples."
      );
    }
    case "upload_image": {
      const message = result.message as string;
      return message || "Photo picker ready. Waiting for user to select a photo.";
    }
    case "generate_image_for_mail": {
      // Generated mode narrates the credit-spend message (which embeds the
      // IMPORTANT chain-to-preview directive); redirect mode rides
      // suggestedNextStep - the strongest steering channel either way.
      if (result.mode === "generated") {
        const message = result.message as string;
        return message || "Image generated. Use the imageUrl with a preview tool.";
      }
      const suggestedNextStep = result.suggestedNextStep as string;
      return suggestedNextStep || "Guide the user to resend the prompt without mentioning Letter IRL.";
    }
    case "confirm_uploaded_image": {
      const suggestedNextStep = result.suggestedNextStep as string;
      return suggestedNextStep || "Photo uploaded. Use the imageUrl with a preview tool.";
    }
    default:
      return JSON.stringify(result);
  }
}
