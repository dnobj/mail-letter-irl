import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolAnnotations, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { LetterIrlServer } from "../server.js";
import { toolInputSchemas } from "./toolSchemas.js";
import { WIDGET_TEMPLATE_VERSION, widgetTemplateUri } from "./widgetUris.js";
import {
  DUPLICATE_MAIL_META_KEY,
  type DuplicateMailError,
  isDuplicateMailError
} from "../services/duplicateMailService.js";
import {
  quoteAndPreviewInputZ,
  quoteAndPreviewLetterWithHeaderImageInputZ,
  quoteAndPreviewLetterWithImageInputZ,
  sendLetterInputZ,
  createMailCheckoutInputZ,
  createPackCheckoutInputZ,
  listLetterPacksInputZ,
  redeemPromoCodeInputZ,
  getPurchaseStatusInputZ,
  getOrderStatusInputZ,
  getAccountBalanceInputZ,
  getProfileInputZ,
  listOrdersInputZ,
  setReturnAddressInputZ,
  getReturnAddressInputZ,
  clearReturnAddressInputZ,
  quoteAndPreviewPostcardInputZ,
  sendPostcardInputZ,
  requestSendInputZ,
  submitFeatureRequestInputZ,
  getStartedInputZ,
  uploadImageInputZ,
  generateImageForMailInputZ,
  confirmUploadedImageInputZ,
  quoteAndPreviewOutputZ,
  sendLetterOutputZ,
  createMailCheckoutOutputZ,
  createPackCheckoutOutputZ,
  listLetterPacksOutputZ,
  redeemPromoCodeOutputZ,
  getPurchaseStatusOutputZ,
  getOrderStatusOutputZ,
  getAccountBalanceOutputZ,
  getProfileOutputZ,
  listOrdersOutputZ,
  setReturnAddressOutputZ,
  getReturnAddressOutputZ,
  clearReturnAddressOutputZ,
  quoteAndPreviewPostcardOutputZ,
  sendPostcardOutputZ,
  requestSendOutputZ,
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
import { SESSION_SCOPES, IDENTITY_SCOPES } from "../auth/oauthConfig.js";
import { prepareAuthenticatedUser } from "../auth/identity.js";
import { AccountErasedError } from "../auth/accountErased.js";
import { VerifiedEmailRequiredError } from "../auth/verifiedEmail.js";
import { EmailAlreadyLinkedError } from "../services/userService.js";
import { widgetRedirectOrigins } from "../config/checkoutDomain.js";
import {
  classifyDiagnosticError,
  writeDiagnostic
} from "../utils/diagnosticLog.js";
import {
  buildInsufficientScopeToolResult,
  InsufficientScopeError
} from "../auth/oauthChallenge.js";
import { resolveClientProfile, type ClientProfileName } from "../auth/clientProfiles.js";
import { isSendConfirmationEnabled } from "../config/sendConfirmation.js";
import {
  REQUEST_SEND_TOOL,
  SendConfirmationRefusedError,
  type RequestSendOutput
} from "../tools/requestSend.js";

/** What every tool answers with, instead of running, when the caller has no usable account. */
type AccountRefusal = VerifiedEmailRequiredError | EmailAlreadyLinkedError | AccountErasedError;

/**
 * Build MCP tool annotations from tool definition.
 *
 * These annotations tell ChatGPT how to classify tools:
 * - readOnlyHint: true = Tool does NOT modify its environment (read operations)
 * - readOnlyHint: false = Tool modifies its environment (write operations)
 * - destructiveHint: true = Tool may delete or overwrite user data, or cause an
 *   irreversible outcome (mail that cannot be recalled, a payment)
 * - openWorldHint: true = Tool interacts with external entities (APIs, mail services)
 * - idempotentHint: true = Repeated calls with same args have no additional effect
 *
 * IMPORTANT: Quote/preview tools are NOT read-only because they create draft records
 * in the database. Per MCP specification: "readOnlyHint: true = tool does NOT modify
 * its environment". Creating database records IS modifying the environment.
 *
 * @see US-MCP-06: Tool Read/Write Annotations
 * @see docs/learnings/tool-annotation-decision.md
 * @see https://developers.openai.com/plugins/deploy/app-review (the destructive-annotation guidance quoted below)
 * @see https://developers.openai.com/apps-sdk/plan/tools/
 * @see https://modelcontextprotocol.io/legacy/concepts/tools
 */
export function buildAnnotations(tool: { name: string; readOnly: boolean }): ToolAnnotations {
  const name = tool.name;

  // Read-only tools: only retrieve data, no modifications
  const readOnlyTools = [
    'get_started',
    'get_account_balance',
    'get_profile',
    'list_orders',
    'get_order_status',
    'get_purchase_status',
    'get_return_address',
    'list_letter_packs',
    // Hands back a link; the person sends from the page it opens (#470).
    'request_send'
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
    'create_pack_checkout',
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
    'redeem_promo_code',     // A spent code is refused, so repeats do nothing
    'set_return_address',    // Setting same address twice = no change
    'clear_return_address',  // Clearing twice = no additional effect
    'confirm_uploaded_image' // Repeating the same relay overwrites with the same value
  ];

  // Destructive tools. OpenAI's app-review guidance asks for destructiveHint on
  // any tool that "can cause irreversible outcomes (deleting, overwriting,
  // sending messages or transactions you can't undo, revoking access, or
  // destructive admin actions), even in only select modes, through default
  // parameters, or through indirect side effects". Mail cannot be recalled
  // once printed, the saved address is overwritten in place, and a checkout
  // starts a payment the customer cannot undo alone (for Pay & Send it
  // authorises the mail itself). A spent promo code and a consumed image
  // generation are additive for the customer, and the upload relay overwrites
  // only a pointer to the latest upload, so those stay non-destructive.
  // See docs/learnings/tool-annotation-decision.md (addendum, September 2026).
  const destructiveTools = [
    'send_letter',
    'send_postcard',
    'set_return_address',
    'create_mail_checkout',
    'create_pack_checkout',
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
  { name: "PackCheckoutCard", description: "Shows a letter pack checkout with the pack, the price and the link that opens Stripe" },
];

/**
 * Template names that serve an existing widget's HTML for a different preview
 * tool (#411).
 *
 * A preview card offers to repeat a preview call that never reached the server
 * (ChatGPT web loses calls approved with "Allow once"), and to repeat it the
 * card must know which tool drew it. The header-image and inline-image letter
 * tools take identical input, so the card cannot tell them apart from
 * toolInput, and the host passes no tool name. Each preview tool therefore
 * points at its own template name, and readWidgetResource stamps that tool
 * into the page. A variant is the same widget file under another name, not a
 * new widget: WIDGET_DEFINITIONS stays the list of cards.
 */
export const WIDGET_VARIANTS = [
  {
    name: "LetterHeaderImagePreviewCard",
    file: "LetterPreviewCard",
    description: "Shows a header-image letter preview with cost, delivery info, and status"
  },
  {
    name: "LetterInlineImagePreviewCard",
    file: "LetterPreviewCard",
    description: "Shows an inline-image letter preview with cost, delivery info, and status"
  }
] as const;

/**
 * The preview tool each preview template serves, stamped into the page by
 * readWidgetResource as `<meta name="letter-irl-preview-tool">` (#411). Keep in
 * step with each preview tool's openai/outputTemplate;
 * tests/unit/mcp/widgetResources.test.ts checks both directions.
 */
export const PREVIEW_TOOL_BY_TEMPLATE: ReadonlyMap<string, string> = new Map([
  ["LetterPreviewCard", "quote_and_preview_letter"],
  ["LetterHeaderImagePreviewCard", "quote_and_preview_letter_with_header_image"],
  ["LetterInlineImagePreviewCard", "quote_and_preview_letter_with_image"],
  ["PostcardPreviewCard", "quote_and_preview_postcard"]
]);

export const PREVIEW_TOOL_META_NAME = "letter-irl-preview-tool";

/**
 * The first template version from which a template has meant only the tool in
 * PREVIEW_TOOL_BY_TEMPLATE (#411). Until v32 all three letter tools pointed at
 * LetterPreviewCard, so a client holding an older tool list can draw an image
 * letter from it. Stamping that page as the text-only tool would let the card
 * repeat an image letter without its image: an image call may carry no image
 * arguments at all and rely on the server's recent-upload fallback, which the
 * card cannot see. Older versions and the legacy unversioned URI are therefore
 * served unstamped, and the card offers only advice to ask in the chat.
 * PostcardPreviewCard has only ever served the postcard tool, and the
 * variants did not exist before v32, so neither needs a floor.
 */
const PREVIEW_TOOL_SINCE_VERSION: ReadonlyMap<string, number> = new Map([
  ["LetterPreviewCard", 32]
]);

/**
 * The preview tool to stamp into a template served at `version`, or undefined
 * when the page must go out unstamped. `version` is undefined for the legacy
 * unversioned URI.
 */
export function previewToolFor(name: string, version: number | undefined): string | undefined {
  const tool = PREVIEW_TOOL_BY_TEMPLATE.get(name);
  if (!tool) return undefined;
  const since = PREVIEW_TOOL_SINCE_VERSION.get(name);
  if (since === undefined) return tool;
  return version !== undefined && Number.isSafeInteger(version) && version >= since ? tool : undefined;
}

/**
 * Stamps a preview card's page with the tool that draws it (#411). A page
 * without a `<head>` is returned unchanged, and a card without the stamp
 * offers no retry, so a failure here degrades to today's behaviour.
 */
export function stampPreviewTool(html: string, tool: string | undefined): string {
  if (!tool || !/^[a-z_]+$/.test(tool)) return html;
  const tag = `<meta name="${PREVIEW_TOOL_META_NAME}" content="${tool}" />`;
  return html.replace(/<head(\s[^>]*)?>/i, (open) => `${open}\n    ${tag}`);
}


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
// The API origin is a redirect target too: the checkout card opens
// /purchase/start there through openExternal, and only for an allowlisted
// origin does ChatGPT skip the safe-link modal and append the redirectUrl
// that the start page keeps as the way back into the conversation (#372).
// The checkout hosts lead: checkout.stripe.com, and our custom checkout
// domain when STRIPE_CHECKOUT_DOMAIN names one (#373).
const WIDGET_REDIRECT_ORIGINS = widgetRedirectOrigins(WIDGET_PACKS_ORIGIN, WIDGET_API_ORIGIN);

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
      // Identity scopes ride along too (#425), but they are not what ChatGPT
      // needs to connect, and Auth0 never grants them to it: Auth0 registers
      // CIMD clients in strict third-party mode, which supports no OIDC
      // scopes and no ID token in its current release (#424).
      //
      // OBSERVED, development and production, from ChatGPT's multi-account
      // rollout on 2026-09-17 until 2026-09-22: Auth0 logged a successful
      // login and code exchange, this server was never called, and ChatGPT's
      // own callback answered 400 OAUTH_OWNER_PROFILE_ID_MISSING - shown as
      // "We couldn't connect this account". The cause was the connector's
      // "OIDC enabled" Advanced OAuth setting, which ChatGPT pre-ticks when
      // the authorization server publishes OpenID discovery: with it on,
      // ChatGPT wants an ID token inside its callback and gets none. With it
      // off, ChatGPT links, lists the tools and calls the profile tool
      // (src/tools/getProfile.ts) for the account's identity. Create
      // connectors with OIDC off.
      //
      // These stay because the advertised and requested sets must agree
      // (validated in validateOAuthConfig), because a client registered
      // outside strict mode can use them, and because they cost nothing:
      // tool calls work although Auth0 never grants them.
      //
      // Session and identity scopes go here and nowhere else. They must never
      // reach getRequiredToolScopes: PAT callers authorize with no scopes at
      // all, so a tool demanding one would deny them permanently
      // (tests/unit/auth/sessionScopes.test.ts pins that).
      //
      // Applied to every tool deliberately. A typed @-mention scopes the turn's
      // toolset, so a scope carried by only some tools would be requested only
      // sometimes.
      scopes: [...getRequiredToolScopes(toolName), ...SESSION_SCOPES, ...IDENTITY_SCOPES]
    }
  ];
}

/**
 * The tools that send, which the send rule (#470) makes card-only: the card's
 * Send button can call them, the model cannot.
 */
export const CARD_ONLY_SEND_TOOLS: ReadonlySet<string> = new Set(["send_letter", "send_postcard"]);

/**
 * Pay & Send: the person pays for the previewed mail and payment sends it. Not
 * card-only - in ChatGPT the model may start it, and the person sees the card
 * and pays - but an app that may not take a purchase gets the link instead.
 */
export const PAY_AND_SEND_TOOL = "create_mail_checkout";

export function buildToolMeta(
  toolName: string,
  meta: ToolMeta,
  requireAuth = process.env.LETTER_IRL_REQUIRE_AUTH !== "false",
  sendRule = isSendConfirmationEnabled()
): ToolMeta {
  const outputTemplate = meta["openai/outputTemplate"] as string | undefined;
  const widgetAccessible = meta["openai/widgetAccessible"] as boolean | undefined;
  const existingUi = (meta.ui as Record<string, unknown> | undefined) ?? {};
  // Hidden from the model and left callable by the card: MCP Apps'
  // ui.visibility ["app"], ChatGPT's own "private". An app that honours
  // neither shows the tool to its model, and the wrapper below answers that
  // app with a link instead of a send. Claude Code asks before every call of
  // a tool marked as needing the person.
  const cardOnly = sendRule && CARD_ONLY_SEND_TOOLS.has(toolName);

  return {
    securitySchemes: buildToolSecuritySchemes(toolName, requireAuth),
    ...meta,
    ...(cardOnly
      ? { "openai/visibility": "private", "anthropic/requiresUserInteraction": true }
      : {}),
    ui: {
      ...existingUi,
      ...(outputTemplate ? { resourceUri: outputTemplate } : {}),
      ...(widgetAccessible !== undefined ? { widgetAccessible } : {}),
      ...(cardOnly ? { visibility: ["app"] } : {})
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
 * Template names indexed to the widget file they serve and the description
 * they publish, for resolving a client-supplied template variable. Covers the
 * cards and their preview-tool variants (#411).
 */
const WIDGET_BY_NAME = new Map<string, { file: string; description: string }>([
  ...WIDGET_DEFINITIONS.map(
    (widget) => [widget.name, { file: widget.name, description: widget.description }] as const
  ),
  ...WIDGET_VARIANTS.map(
    (variant) => [variant.name, { file: variant.file, description: variant.description }] as const
  )
]);

/**
 * Read one widget's HTML as an MCP resource payload, or null if `name` is not
 * a widget we serve.
 *
 * SECURITY: `name` reaches this function from a client-supplied URI template
 * variable (see the version template in registerWidgetResources), so it is
 * resolved against WIDGET_BY_NAME (the cards plus their preview-tool variants)
 * *before* any filesystem access, and the file name from that table - never
 * the caller's string - is what reaches path.join. Without that lookup this
 * function is a path-traversal sink:
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
async function readWidgetResource(name: string, uri: string, version: number | undefined) {
  const widget = WIDGET_BY_NAME.get(name);

  if (!widget) {
    console.warn(`🎨 Widget resource requested but not served: ${uri}`);
    return null;
  }

  console.log(`🎨 Widget resource requested: ${uri}`);
  const html = await fs.readFile(
    path.join(DEFAULT_WIDGET_DIR, `${widget.file}.html`),
    "utf-8"
  );
  // `name` has been resolved against WIDGET_BY_NAME above, so it is one of our
  // own template names by the time it indexes the preview-tool map.
  const text = stampPreviewTool(html, previewToolFor(name, version));
  console.log(`🎨 Returning widget HTML (${text.length} bytes)`);

  return {
    contents: [{
      uri,
      mimeType: WIDGET_MIME_TYPE,
      text,
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
    const registrations: Array<[string, string, number | undefined]> = [
      [widget.name, versionedUri, WIDGET_TEMPLATE_VERSION],
      [`${widget.name}-legacy`, legacyUri, undefined]
    ];

    for (const [registrationName, uri, version] of registrations) {
      // Register widget resource with canonical ui.* metadata and
      // legacy openai/* aliases for compatibility.
      mcpServer.registerResource(
        registrationName,
        uri,
        {},  // Empty options per docs
        async () => {
          const result = await readWidgetResource(widget.name, uri, version);
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

  // The preview-tool variants (#411): the same file under their own versioned
  // URI, registered exactly for the same reason as the cards above. No legacy
  // unversioned alias: no client has ever held one of these names.
  for (const variant of WIDGET_VARIANTS) {
    try {
      await fs.access(path.join(DEFAULT_WIDGET_DIR, `${variant.file}.html`));
    } catch {
      console.warn(`⚠️  Widget file not found for ${variant.name}: ${variant.file}.html`);
      continue;
    }
    const uri = widgetTemplateUri(variant.name);
    mcpServer.registerResource(
      variant.name,
      uri,
      {},
      async () => {
        const result = await readWidgetResource(variant.name, uri, WIDGET_TEMPLATE_VERSION);
        if (!result) {
          throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} not found`);
        }
        return result;
      }
    );
    console.log(`📦 Registered widget resource: ${uri}`);
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
      const rawVersion = Array.isArray(variables.version) ? variables.version[0] : variables.version;
      const version = /^\d{1,6}$/.test(String(rawVersion ?? "")) ? Number(rawVersion) : undefined;
      const result = await readWidgetResource(String(name ?? ""), uri.toString(), version);
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

/**
 * The subject every tool in one registration acts for.
 *
 * The fallback exists so `npm run dev` works with no identity provider at
 * all. It must never be reachable on a server that requires authentication:
 * there, a null authInfo would mean a request was admitted with no subject,
 * and serving it under a shared id would merge one caller's letters, balance,
 * drafts and purchases with everyone else's.
 *
 * The deployment validator now refuses LETTER_IRL_REQUIRE_AUTH=false in
 * production (auth.enforcement_disabled_in_production). This is the second
 * lock, on the code path rather than the configuration, so that a future
 * caller that forgets to authenticate fails loudly instead of quietly
 * becoming the shared account.
 */
function resolveToolUserId(authInfo: AuthenticatedUser | null): string {
  if (authInfo) return authInfo.userId;
  if (process.env.LETTER_IRL_REQUIRE_AUTH !== "false") {
    throw new Error(
      "Refusing to register tools without an authenticated subject while authentication is required"
    );
  }
  return DEFAULT_USER_ID;
}

const zodInputSchemas: Record<ToolName, z.ZodObject<any>> = {
  // Letter tools - three separate tools for different layouts
  quote_and_preview_letter: quoteAndPreviewInputZ,
  quote_and_preview_letter_with_header_image: quoteAndPreviewLetterWithHeaderImageInputZ,
  quote_and_preview_letter_with_image: quoteAndPreviewLetterWithImageInputZ,
  send_letter: sendLetterInputZ,
  create_mail_checkout: createMailCheckoutInputZ,
  create_pack_checkout: createPackCheckoutInputZ,
  list_letter_packs: listLetterPacksInputZ,
  redeem_promo_code: redeemPromoCodeInputZ,
  get_purchase_status: getPurchaseStatusInputZ,
  // Account and order management tools
  get_order_status: getOrderStatusInputZ,
  get_account_balance: getAccountBalanceInputZ,
  get_profile: getProfileInputZ,
  list_orders: listOrdersInputZ,
  set_return_address: setReturnAddressInputZ,
  get_return_address: getReturnAddressInputZ,
  clear_return_address: clearReturnAddressInputZ,
  // Postcard tools
  quote_and_preview_postcard: quoteAndPreviewPostcardInputZ,
  send_postcard: sendPostcardInputZ,
  request_send: requestSendInputZ,
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
  create_pack_checkout: createPackCheckoutOutputZ,
  list_letter_packs: listLetterPacksOutputZ,
  redeem_promo_code: redeemPromoCodeOutputZ,
  get_purchase_status: getPurchaseStatusOutputZ,
  // Account and order management tools
  get_order_status: getOrderStatusOutputZ,
  get_account_balance: getAccountBalanceOutputZ,
  get_profile: getProfileOutputZ,
  list_orders: listOrdersOutputZ,
  set_return_address: setReturnAddressOutputZ,
  get_return_address: getReturnAddressOutputZ,
  clear_return_address: clearReturnAddressOutputZ,
  // Postcard tools
  quote_and_preview_postcard: quoteAndPreviewPostcardOutputZ,
  send_postcard: sendPostcardOutputZ,
  request_send: requestSendOutputZ,
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

/**
 * What an account check found: an account to act on, a refusal, or no answer
 * because reading the account failed.
 *
 * A refusal is held rather than thrown: the session is fine, and every tool in
 * it answers with one sentence the customer can act on. Throwing would fail
 * registration, which reaches ChatGPT as "this connector is broken", and
 * swallowing it (what this did until 2026-09-19) left every tool to fail
 * separately on a foreign key naming whichever table it reached first.
 */
type AccountCheck =
  | { status: "ok" }
  | { status: "refused"; refusal: AccountRefusal }
  | { status: "unavailable" };

async function checkAccount(authInfo: AuthenticatedUser): Promise<AccountCheck> {
  try {
    await prepareAuthenticatedUser(authInfo);
    return { status: "ok" };
  } catch (error) {
    if (
      error instanceof VerifiedEmailRequiredError ||
      error instanceof EmailAlreadyLinkedError ||
      error instanceof AccountErasedError
    ) {
      // Already reported, by name, where it was decided. Logging it again
      // here would classify it as `database_error` - it carries no pg code -
      // and make a refused customer look like a database outage on every
      // request they make.
      return { status: "refused", refusal: error };
    }
    writeDiagnostic("error", "auth.user_preparation_failed", {
      errorClass: classifyDiagnosticError(error, "database_error")
    });
    return { status: "unavailable" };
  }
}

/** Fixed text: nothing from the request or the failure reaches it. */
export const ACCOUNT_UNAVAILABLE_MESSAGE = "Letter IRL could not read your account just now. Please try again.";

export interface RegisterToolsOptions {
  /**
   * Decide the account on every tool call, from that call alone. For the
   * legacy SSE transport, where one server serves the whole stream: without it
   * an account erased mid-session (#289) kept every tool until the connection
   * closed. A call whose check cannot read the account is refused rather than
   * run, since a tombstone is exactly what it may be about to write to (#446
   * review). The streamable HTTP transport builds a server per request, so it
   * decides per call already.
   */
  recheckAccountPerCall?: boolean;
}

export async function registerLetterTools(
  mcpServer: McpServer,
  appServer: LetterIrlServer,
  authInfo: AuthenticatedUser | null = null,
  options: RegisterToolsOptions = {}
) {
  const userId = resolveToolUserId(authInfo);
  writeDiagnostic("info", "mcp.tools_registering", {
    authType: authInfo?.authType ?? "disabled"
  });

  // A caller with no account, and no confirmed address to open one from. When
  // the account cannot be read the tools still register - failing
  // registration reads as a broken connector - but a call answers "try again"
  // rather than run against an account nobody could check (#446 review).
  const initialCheck: AccountCheck = authInfo ? await checkAccount(authInfo) : { status: "ok" };
  const accountRefusal: AccountRefusal | null = initialCheck.status === "refused" ? initialCheck.refusal : null;

  // Register widget resources for ChatGPT UI rendering
  await registerWidgetResources(mcpServer);

  // The send rule (#470), decided once for this registration: which app is
  // calling (#473), and whether the rule is on.
  const sendRule = isSendConfirmationEnabled();
  const client = resolveClientProfile(authInfo);

  const toolDefs = appServer.listTools();
  for (const tool of toolDefs) {
    const inputShape = getZodInputShape(tool.name);
    const outputShape = getZodOutputShape(tool.name);
    if (!inputShape || !outputShape) {
      continue;
    }

    // From an app that cannot be trusted to keep a card-only tool away from
    // its model, a send tool is the model asking to send - so it gets the
    // link the person sends from, and is authorized as request_send is. A
    // token that can preview but not send gets the link rather than a scope
    // error, which is the point of read-and-draft tokens.
    //
    // Pay & Send too (round 1 of #480): payment sends the mail, and Stripe's
    // page never shows the preview. So the model may start it only where the
    // app takes purchases AND shows our card, which is where the person saw
    // the preview; anywhere else the person pays and sends from the page.
    const sendsByLinkOnly =
      sendRule &&
      ((CARD_ONLY_SEND_TOOLS.has(tool.name) && !client.honorsCardOnlyTools) ||
        (tool.name === PAY_AND_SEND_TOOL && !(client.inAppPurchases && client.rendersCards)));

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
          authorizeTool(sendsByLinkOnly ? REQUEST_SEND_TOOL : tool.name, authInfo);
        } catch (error) {
          if (error instanceof InsufficientScopeError) {
            return buildInsufficientScopeToolResult(error);
          }
          throw error;
        }
        if (options.recheckAccountPerCall && authInfo) {
          // This call's own answer, not the one from when the stream opened.
          const now = await checkAccount(authInfo);
          if (now.status === "refused") return buildAccountRefusalToolResult(now.refusal);
          if (now.status === "unavailable") return buildAccountUnavailableToolResult();
        } else if (accountRefusal) {
          return buildAccountRefusalToolResult(accountRefusal);
        } else if (initialCheck.status === "unavailable") {
          return buildAccountUnavailableToolResult();
        }
        if (sendsByLinkOnly) {
          return buildSendByLinkToolResult(
            await appServer.execute<{ draftId: unknown }, RequestSendOutput>({
              toolName: REQUEST_SEND_TOOL,
              input: { draftId: args.draftId },
              userId
            }),
            client.name
          );
        }
        // Extract userAgent from request metadata (US-POSTCARD-04: Mobile Image Graceful Degradation)
        const argsMeta = (args as Record<string, unknown>)._meta as Record<string, unknown> | undefined;
        const extraMeta = extra._meta as Record<string, unknown> | undefined;
        const userAgent = extractUserAgent(argsMeta, extraMeta);
        const isMobile = userAgent ? isMobileClient(userAgent) : undefined;

        console.log(`Tool request ${tool.name} (mobile: ${isMobile ?? 'unknown'})`);

        let executed;
        try {
          executed = await appServer.execute({
            toolName: tool.name,
            input: args,
            userId,
            isMobile
          });
        } catch (error) {
          // #412: a refusal the card acts on, so its details travel with it.
          if (isDuplicateMailError(error)) return buildDuplicateMailToolResult(error);
          throw error;
        }
        const { result, meta } = executed;

        let summaryText = summarizeToolResult(tool.name, result as Record<string, unknown>);
        const draftId = (result as Record<string, unknown>).draftId;
        if (sendRule && PREVIEW_TOOLS.has(tool.name) && typeof draftId === "string") {
          summaryText += ` ${howToSendText(draftId, client.rendersCards)}`;
        }

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

/**
 * The refusal of a caller who has no account and cannot be given one.
 *
 * An error result, so the model reads it as "nothing happened" and repeats the
 * sentence rather than narrating a success. Nothing from the request reaches
 * the text - both messages are fixed constants - so it is safe to hand back
 * whole, the way BETA_ACCESS_MESSAGE is.
 */
/** A call refused because its account could not be read (recheck mode only). */
export function buildAccountUnavailableToolResult() {
  return {
    isError: true,
    content: [{ type: "text" as const, text: ACCOUNT_UNAVAILABLE_MESSAGE }]
  };
}

export function buildAccountRefusalToolResult(error: AccountRefusal) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: error.message }]
  };
}

/**
 * The refusal of a send or checkout for mail that went out recently (#412).
 * An error result, so the model reads it as "nothing happened", with the
 * details the card needs in _meta. Error results skip output-schema
 * validation, so nothing here has to match a tool's output schema.
 */
export function buildDuplicateMailToolResult(error: DuplicateMailError) {
  const { kind, mailType, recipientName, ageSeconds } = error.duplicate;
  return {
    isError: true,
    content: [{ type: "text" as const, text: error.message }],
    _meta: {
      [DUPLICATE_MAIL_META_KEY]: {
        kind,
        mailType,
        recipientName,
        ageMinutes: Math.floor(Math.max(0, ageSeconds) / 60)
      }
    }
  };
}

/**
 * The link, in words the model can pass on (#470). Nothing is sent until the
 * person presses Send on the page, and the text says so, so a model cannot
 * report the mail as sent.
 */
export function sendLinkText(result: RequestSendOutput): string {
  const what = result.mailType === "postcard" ? "postcard" : "letter";
  const to = result.recipientSummary?.name ? ` to ${result.recipientSummary.name}` : "";
  return (
    `Ask the person to open ${result.confirmationUrl} to check the ${what}${to} and send it themselves. ` +
    `Nothing is sent until they press Send there. The link works until ${result.expiresAtISO}.`
  );
}

/**
 * A send tool's answer to an app that cannot show our card (#470): not sent,
 * and the link where the person sends it. An error result, because nothing
 * was sent and the tool's output schema describes a sent order - and because
 * a client then puts this text in front of the model rather than treating the
 * call as done.
 */
export function buildSendByLinkToolResult(
  executed: { result: RequestSendOutput },
  client: ClientProfileName
) {
  writeDiagnostic("info", "send.link_instead", {
    client,
    mailType: executed.result.mailType
  });
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `Not sent: Letter IRL sends mail only when the person sends it. ${sendLinkText(executed.result)}`
      }
    ]
  };
}

/**
 * Appended to a preview's narration while the send rule is on (#470). It
 * carries the draft id for an app that shows the model only the text. Where
 * our card shows, the card's Send button is the way, and the link is for a
 * card that did not appear; elsewhere the link is the only way.
 */
export function howToSendText(draftId: string, rendersCards: boolean): string {
  return rendersCards
    ? `Nothing has been sent. The person sends it with Send on the preview card; point them to it when they ask you to send. ` +
        `Only if the card is not showing, call request_send with draftId ${draftId} and give them its link.`
    : `Nothing has been sent. To send it, call request_send with draftId ${draftId} and give the person its link, ` +
        `where they check it and send it themselves.`;
}

const PREVIEW_TOOLS: ReadonlySet<string> = new Set([
  "quote_and_preview_letter",
  "quote_and_preview_letter_with_header_image",
  "quote_and_preview_letter_with_image",
  "quote_and_preview_postcard"
]);

export function summarizeToolResult(
  toolName: string,
  result: Record<string, unknown>
): string {
  switch (toolName) {
    case "get_profile": {
      // Model-facing narration only; the id travels in structuredContent for
      // ChatGPT, and the model has no use for it.
      const email = result.email as string | undefined;
      return email ? `Account: ${email}` : "Account identified.";
    }
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
      const usedSaved = result.usedSavedReturnAddress as boolean | undefined;
      const layoutType = result.layoutType as string | undefined;
      // Says what the tool DID, not what the account currently is. The old
      // form carried "(cannot send)", which the model rendered as "your
      // balance isn't sufficient" - true when written, false minutes later
      // once a pack landed, and permanent in a transcript beside a card
      // reading "Ready to send". canSendNow and reasonCannotSend are still in
      // structuredContent, so the model can still offer to help buy.
      let summary = `Preview ready: requires ${lettersRequired ?? 1} ${lettersRequired === 1 ? 'letter' : 'letters'}. The card shows whether it can be sent now and the options to proceed.`;
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
    case "request_send":
      return sendLinkText(result as unknown as RequestSendOutput);
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
      const usedSaved = result.usedSavedReturnAddress as boolean | undefined;
      // Same reasoning as the letter branch: no expiring claim about balance.
      let summary = `Postcard preview ready: requires ${lettersRequired ?? 1} ${lettersRequired === 1 ? 'letter' : 'letters'}. The card shows whether it can be sent now and the options to proceed.`;
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
