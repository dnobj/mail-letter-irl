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
  postcardSixByNineZ,
  sendPostcardInputZ,
  requestSendInputZ,
  getDraftStatusInputZ,
  setArrivalDateInputZ,
  setStationeryInputZ,
  setLetterWordsInputZ,
  setPostcardStyleInputZ,
  cancelScheduledMailInputZ,
  requestAddressInputZ,
  getAddressRequestInputZ,
  cancelAddressRequestInputZ,
  setSignatureInputZ,
  getSignatureInputZ,
  clearSignatureInputZ,
  setLetterSignatureInputZ,
  uploadPhotoChunkInputZ,
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
  getDraftStatusOutputZ,
  setArrivalDateOutputZ,
  setStationeryOutputZ,
  setLetterWordsOutputZ,
  setPostcardStyleOutputZ,
  cancelScheduledMailOutputZ,
  requestAddressOutputZ,
  getAddressRequestOutputZ,
  cancelAddressRequestOutputZ,
  setSignatureOutputZ,
  getSignatureOutputZ,
  clearSignatureOutputZ,
  setLetterSignatureOutputZ,
  uploadPhotoChunkOutputZ,
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
import {
  callingApp,
  clientProfileNamed,
  resolveClientProfile,
  type ClientProfile,
  type ClientProfileName
} from "../auth/clientProfiles.js";
import { inlineHostBridge } from "./widgetHost.js";
import { isSendConfirmationEnabled } from "../config/sendConfirmation.js";
import { isArriveByEnabled } from "../config/arriveBy.js";
import { isStationeryOffered } from "../config/stationery.js";
import { isSignaturesOffered } from "../config/signatures.js";
import { isPostcardSizesOffered } from "../config/postcardSizes.js";
import { isPostcardLayoutsOffered } from "../config/postcardLayouts.js";
import { ENVELOPE_REVEAL_META, isEnvelopeRevealEnabled } from "../config/envelope.js";
import { STUDIO_CARD_META, isStudioCardEnabled } from "../config/studioCard.js";
import { scheduleSentence } from "../tools/arriveByInput.js";
import { uploadsThroughCard } from "../config/cardUpload.js";
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
    'request_send',
    // The preview card's question about its draft (#474).
    'get_draft_status',
    // What became of an address request (#604).
    'get_address_request',
    // Whether a signature is saved (#608).
    'get_signature'
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
    'generate_image_for_mail', // Calls the OpenAI Images API when credits allow
    'set_signature'        // Fetches the picture from its link (#608)
  ];

  // Tools where repeated calls with same args have no additional effect
  // NOTE: Quote/preview tools are NOT idempotent - each call creates a new draft
  // See US-MCP-09 and docs/learnings/tool-annotation-decision.md
  const idempotentTools = [
    'send_letter',           // Draft consumption makes retries safe
    'send_postcard',         // Draft consumption makes retries safe
    'create_mail_checkout',  // Reuses the active checkout for a draft
    'redeem_promo_code',     // A spent code is refused, so repeats do nothing
    'upload_photo_chunk',    // A chunk sent again changes nothing (#474)
    'set_return_address',    // Setting same address twice = no change
    'clear_return_address',  // Clearing twice = no additional effect
    'confirm_uploaded_image', // Repeating the same relay overwrites with the same value
    'set_arrival_date',       // The same date twice changes nothing more (#535)
    'set_stationery',         // The same style twice changes nothing more (#563)
    'set_letter_words',       // The same words twice change nothing more (#586)
    'set_postcard_style',     // The same size and front twice change nothing more (#594)
    'cancel_scheduled_mail',  // A repeat answers as already cancelled (#535)
    'cancel_address_request', // A repeat answers as already closed (#604)
    'clear_signature',        // A repeat answers that none was saved (#608)
    'set_letter_signature'    // The same choice twice changes nothing more (#608)
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
  // only a pointer to the latest upload, so those stay non-destructive. So
  // does set_arrival_date (#535): it changes only a draft's dates, and a draft
  // sends nothing and expires on its own.
  // See docs/learnings/tool-annotation-decision.md (addendum, September 2026).
  const destructiveTools = [
    'send_letter',
    'send_postcard',
    'set_return_address',
    'create_mail_checkout',
    'create_pack_checkout',
    'clear_return_address',
    // A cancelled order cannot be restored: it must be sent again (#535).
    'cancel_scheduled_mail',
    // A cancelled address request's link cannot be restored (#604).
    'cancel_address_request',
    // A saved signature, replaced or removed, cannot be brought back (#608).
    'set_signature',
    'clear_signature'
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
      // reach getRequiredToolScopes: a personal access token carries product
      // scopes only (migration 037, #470), so a tool demanding one would deny
      // it permanently (tests/unit/auth/sessionScopes.test.ts pins that).
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
 * Send and Pay & Send buttons can call them, the model cannot.
 *
 * Pay & Send joined them for launch (#475). Codex also reaches Letter IRL
 * through ChatGPT's own connection, where the server sees ChatGPT but no card
 * shows the preview, so a checkout the model started there would take payment
 * for mail nobody saw. The server cannot tell the two apart, and every card
 * that offers Pay & Send calls it itself, so no model starts it.
 */
export const CARD_ONLY_SEND_TOOLS: ReadonlySet<string> = new Set([
  "send_letter",
  "send_postcard",
  "create_mail_checkout"
]);

/**
 * Pay & Send: the person pays for the previewed mail and payment sends it.
 * Card-only like the sends, and one step further: an app that may not take a
 * purchase gets the link instead, even from its card.
 */
export const PAY_AND_SEND_TOOL = "create_mail_checkout";

/**
 * Tools only a card asks, whatever the send rule: get_draft_status answers
 * the preview card about its own draft (#474), and upload_photo_chunk takes
 * the upload card's photo (#474, phase 3). The model has no use for either.
 * Unlike a send they need no person to press anything, so they are only
 * hidden from the model.
 */
export const APP_ONLY_TOOLS: ReadonlySet<string> = new Set(["get_draft_status", "upload_photo_chunk"]);

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
  const hidden = cardOnly || APP_ONLY_TOOLS.has(toolName);

  return {
    securitySchemes: buildToolSecuritySchemes(toolName, requireAuth),
    ...meta,
    ...(hidden ? { "openai/visibility": "private" } : {}),
    ...(cardOnly ? { "anthropic/requiresUserInteraction": true } : {}),
    ui: {
      ...existingUi,
      ...(outputTemplate ? { resourceUri: outputTemplate } : {}),
      ...(widgetAccessible !== undefined ? { widgetAccessible } : {}),
      ...(hidden ? { visibility: ["app"] } : {})
    }
  };
}

/**
 * A card's resource metadata, for the app that reads it. The card address
 * (`ui.domain`) is per app (#474): ChatGPT's is our API origin, and every
 * other app gets none, because Claude refuses to draw a card whose domain is
 * not its own hashed form.
 */
export function buildWidgetResourceMeta(
  description: string,
  client: ClientProfile = clientProfileNamed("chatgpt")
) {
  const withDomain = client.cardDomain === "origin";
  return {
    ui: {
      description,
      ...(withDomain ? { domain: WIDGET_DOMAIN } : {}),
      csp: WIDGET_CSP_CANONICAL,
      prefersBorder: true
    },
    "openai/widgetPrefersBorder": true,
    ...(withDomain ? { "openai/widgetDomain": WIDGET_DOMAIN } : {}),
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
async function readWidgetResource(
  name: string,
  uri: string,
  version: number | undefined,
  client: ClientProfile
) {
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
  const text = stampPreviewTool(inlineHostBridge(html, DEFAULT_WIDGET_DIR), previewToolFor(name, version));
  console.log(`🎨 Returning widget HTML (${text.length} bytes)`);

  return {
    contents: [{
      uri,
      mimeType: WIDGET_MIME_TYPE,
      text,
      _meta: buildWidgetResourceMeta(widget.description, client)
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
export async function registerWidgetResources(
  mcpServer: McpServer,
  client: ClientProfile = clientProfileNamed("chatgpt")
) {
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
          const result = await readWidgetResource(widget.name, uri, version, client);
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
        const result = await readWidgetResource(variant.name, uri, WIDGET_TEMPLATE_VERSION, client);
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
      const result = await readWidgetResource(String(name ?? ""), uri.toString(), version, client);
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
  get_draft_status: getDraftStatusInputZ,
  set_arrival_date: setArrivalDateInputZ,
  set_stationery: setStationeryInputZ,
  set_letter_words: setLetterWordsInputZ,
  set_postcard_style: setPostcardStyleInputZ,
  cancel_scheduled_mail: cancelScheduledMailInputZ,
  request_address: requestAddressInputZ,
  get_address_request: getAddressRequestInputZ,
  cancel_address_request: cancelAddressRequestInputZ,
  set_signature: setSignatureInputZ,
  get_signature: getSignatureInputZ,
  clear_signature: clearSignatureInputZ,
  set_letter_signature: setLetterSignatureInputZ,
  upload_photo_chunk: uploadPhotoChunkInputZ,
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
  get_draft_status: getDraftStatusOutputZ,
  set_arrival_date: setArrivalDateOutputZ,
  set_stationery: setStationeryOutputZ,
  set_letter_words: setLetterWordsOutputZ,
  set_postcard_style: setPostcardStyleOutputZ,
  cancel_scheduled_mail: cancelScheduledMailOutputZ,
  request_address: requestAddressOutputZ,
  get_address_request: getAddressRequestOutputZ,
  cancel_address_request: cancelAddressRequestOutputZ,
  set_signature: setSignatureOutputZ,
  get_signature: getSignatureOutputZ,
  clear_signature: clearSignatureOutputZ,
  set_letter_signature: setLetterSignatureOutputZ,
  upload_photo_chunk: uploadPhotoChunkOutputZ,
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

/**
 * A tool's input as this deployment serves it. The preview tools' `arriveBy`
 * (#535) is offered only while LETTER_IRL_ARRIVE_BY_ENABLED is on, and the
 * letter previews' stationery (#563) only while it is offered, so no model is
 * shown a field the preview would refuse; read at each registration, so
 * switching a flag needs a reconnect, not a deploy.
 *
 * Unoffered is not unaccepted: the SDK validates in strip mode and hands the
 * handler only declared fields, so a client still holding the schema from
 * while a flag was on (apps cache it until a refresh) would have its date
 * dropped and its mail sent at once, or its theme dropped and its letter
 * printed plain. While a field is withheld, its tool is served as an object
 * that passes unknown keys through, so the preview sees the field and
 * refuses it: its JSON Schema then reads `additionalProperties: true`, where
 * a raw shape's reads false (tests/unit/mcp/arriveByServed.test.ts,
 * stationeryServed.test.ts). Every other tool is served its raw shape, as
 * before, set_arrival_date included: its own arriveBy is offered with it,
 * only while the flag is on.
 *
 * The postcard preview's `size` and `message` are served narrowed rather
 * than withheld (servesPostcardSixByNineOnly): the 6x9 alone and its
 * message's room, as before the 4x6 and 11x6 (#594). A client holding the
 * wider schema has a 4x6 refused by validation, never printed as a 6x9.
 */
export function getServedInputSchema(name: string): z.ZodRawShape | z.AnyZodObject | undefined {
  const declared = getZodInputShape(name);
  const shape = declared && servesPostcardSixByNineOnly(name) ? { ...declared, ...postcardSixByNineZ } : declared;
  const withheld = withheldInputKeys(name);
  if (!shape || withheld.length === 0) return shape;
  const served = Object.fromEntries(Object.entries(shape).filter(([key]) => !withheld.includes(key))) as z.ZodRawShape;
  return z.object(served).passthrough();
}

/**
 * Whether this deployment serves the postcard preview as it was before the
 * 4x6 and 11x6 (#594): its `size` the 6x9 alone and its `message` described
 * by the 6x9's room (in /manifest.json its limit too), while those sizes are
 * not offered.
 */
export function servesPostcardSixByNineOnly(name: string): boolean {
  return name === "quote_and_preview_postcard" && !isPostcardSizesOffered();
}

/** The letter previews' stationery arguments (#563). */
export const STATIONERY_INPUT_KEYS: readonly string[] = ["stationery", "monogram", "headline"];

/** The postcard preview's front arguments (#594). */
export const POSTCARD_FRONT_INPUT_KEYS: readonly string[] = ["layout", "caption", "place"];

/**
 * The input fields a tool is served without, as this deployment stands: the
 * four previews' `arriveBy` while LETTER_IRL_ARRIVE_BY_ENABLED is off (#535),
 * the three letter previews' stationery while it is not offered (#563), and
 * the postcard preview's and set_postcard_style's front while the layouts
 * are not, and set_postcard_style's size while the sizes are not (#594).
 * tools/list (getServedInputSchema) and /manifest.json both ask this, so
 * they agree.
 */
export function withheldInputKeys(name: string): string[] {
  const withheld: string[] = [];
  if (PREVIEW_TOOLS.has(name) && !isArriveByEnabled()) withheld.push("arriveBy");
  if (LETTER_PREVIEW_TOOLS.has(name) && !isStationeryOffered()) withheld.push(...STATIONERY_INPUT_KEYS);
  // The letter previews' signature (#608), while signatures are not offered.
  if (LETTER_PREVIEW_TOOLS.has(name) && !isSignaturesOffered()) withheld.push("signature");
  if (name === "quote_and_preview_postcard" && !isPostcardLayoutsOffered()) withheld.push(...POSTCARD_FRONT_INPUT_KEYS);
  // set_postcard_style takes each only while it is offered (#594).
  if (name === "set_postcard_style" && !isPostcardSizesOffered()) withheld.push("size");
  if (name === "set_postcard_style" && !isPostcardLayoutsOffered()) withheld.push(...POSTCARD_FRONT_INPUT_KEYS);
  return withheld;
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
  meta: Record<string, unknown> = {},
  // Where the app is not proven to hand a card the result's _meta (#474), the
  // card's small copy also stays in structuredContent, or the card could have
  // nothing to show. Large previews are never duplicated.
  keepCardCopy = false
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
    // How full a letter's pages are (#586), for the card's fit line.
    pageFit,
    // A saved signature's picture (#608), for a card: the model reads its sentence.
    signatureImage,
    ...modelFacingData
  } = result;

  const cardCopy = keepCardCopy
    ? {
        ...(title !== undefined ? { title } : {}),
        ...(overview !== undefined ? { overview } : {}),
        ...(purchaseStep !== undefined ? { purchaseStep } : {}),
        ...(examplePrompts !== undefined ? { examplePrompts } : {})
      }
    : {};

  return {
    structuredContent: { ...modelFacingData, ...cardCopy },
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
      ...(pageFit !== undefined ? { pageFit } : {}),
      ...(signatureImage !== undefined ? { signatureImage } : {}),
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

  // The send rule (#470), decided once for this registration: which app is
  // calling (#473), and whether the rule is on.
  const sendRule = isSendConfirmationEnabled();
  const client = resolveClientProfile(authInfo);

  // The cards, served for this app: its card address, and the shared bridge
  // inlined (#474).
  await registerWidgetResources(mcpServer, client);

  // Each description in this app's words (#484).
  const toolDefs = appServer.listTools(client);
  for (const tool of toolDefs) {
    const inputShape = getServedInputSchema(tool.name);
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
    // page never shows the preview. So it runs only where the app takes
    // purchases AND shows our card, which is where the person saw the
    // preview; anywhere else the person pays and sends from the page.
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
        // The short label an app shows for the tool. It used to fall back to
        // the description, which Claude then showed where the name belongs
        // (#484); every tool has a title now.
        title: tool.title,
        description: tool.description,
        // A raw shape, or for the previews while arrive-by is off a passthrough
        // object (getServedInputSchema); the SDK normalizes either. Typed as
        // getZodInputShape's loose result, as it always was: the SDK's
        // generics cannot infer through the union (TS2589), and the handler
        // below takes its arguments loosely anyway.
        inputSchema: inputShape as ReturnType<typeof getZodInputShape>,
        outputSchema: outputShape,
        annotations,
        _meta: buildToolMeta(tool.name, tool.meta)
      },
      async (args: Record<string, unknown>, extra: any) => {
        try {
          authorizeTool(sendsByLinkOnly ? REQUEST_SEND_TOOL : tool.name, authInfo);
        } catch (error) {
          if (error instanceof InsufficientScopeError) {
            // A personal access token can never be granted more (#470), so an
            // OAuth challenge would point its agent at a dead end.
            if (authInfo?.authType === "pat") return buildTokenScopeToolResult(tool.name);
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
              userId,
              client
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
            isMobile,
            client
          });
        } catch (error) {
          // #412: a refusal the card acts on, so its details travel with it.
          if (isDuplicateMailError(error)) return buildDuplicateMailToolResult(error);
          // #579: mail no pack pays for, sent from our card in an app that
          // cannot open Pay & Send there. Answered as the send rule answers a
          // send it cannot run: with the page, which takes the payment.
          if (
            sendRule &&
            CARD_ONLY_SEND_TOOLS.has(tool.name) &&
            (error as { code?: unknown } | null)?.code === "PACK_CANNOT_PAY" &&
            !(client.inAppPurchases && client.rendersCards)
          ) {
            return buildSendByLinkToolResult(
              await appServer.execute<{ draftId: unknown }, RequestSendOutput>({
                toolName: REQUEST_SEND_TOOL,
                input: { draftId: args.draftId },
                userId,
                client
              }),
              client.name,
              "pack_cannot_pay"
            );
          }
          throw error;
        }
        const { result, meta } = executed;

        let summaryText = summarizeToolResult(tool.name, result as Record<string, unknown>, client);
        const draftId = (result as Record<string, unknown>).draftId;
        if (sendRule && PREVIEW_TOOLS.has(tool.name) && typeof draftId === "string") {
          summaryText += ` ${howToSendText(
            draftId,
            client,
            cardOffersPayAndSend(result as Record<string, unknown>),
            previewPayment(result as Record<string, unknown>)
          )}`;
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
          meta,
          !client.passesResultMetaToCards
        );
        Object.assign(_meta, cardSwitches(tool.name));

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
 * What a personal access token is told when a tool needs more than it carries
 * (#470): it reads and drafts, and no sign-in can widen it, so the answer says
 * what to do instead and carries no OAuth challenge.
 */
export const TOKEN_SCOPE_REFUSAL =
  "A personal access token can read your Letter IRL account and make previews, but it can't send, pay or buy. " +
  "To buy letters, use your Letter IRL dashboard at letterirl.com; to send, use an app signed in with your Letter IRL account.";

export function buildTokenScopeToolResult(toolName: string) {
  writeDiagnostic("info", "auth.pat_scope_refused", { toolName });
  return {
    isError: true,
    content: [{ type: "text" as const, text: TOKEN_SCOPE_REFUSAL }]
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
  // Mail no pack pays for is paid on that page, with Pay & Send (#579).
  if (result.paidPerSend === true) {
    return (
      `Ask the person to open ${result.confirmationUrl} to check the ${what}${to}, then pay for it with Pay & Send there, which sends it. ` +
      whenSentText(result) +
      `Letter packs and gift letters pay only for one-page letters and 6x9 postcards. ` +
      `Nothing is sent until they pay there. The link works until ${result.expiresAtISO}.`
    );
  }
  return (
    `Ask the person to open ${result.confirmationUrl} to check the ${what}${to} and send it themselves. ` +
    whenSentText(result) +
    `Nothing is sent until they press Send there. The link works until ${result.expiresAtISO}.`
  );
}

/** For a preview with an arrival date (#535): when, once sent, it goes to the printer. */
function whenSentText(result: RequestSendOutput): string {
  const schedule = result.schedule;
  if (typeof schedule?.arriveBy !== "string" || typeof schedule.mailOn !== "string") return "";
  const sentence = scheduleSentence({ arriveBy: schedule.arriveBy, mailOn: schedule.mailOn }, new Date());
  return `Once sent, it ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)} `;
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
  client: ClientProfileName,
  // Why the link and not a send: the send rule, or mail no pack pays for in
  // an app that cannot take its payment (#579).
  reason: "send_rule" | "pack_cannot_pay" = "send_rule"
) {
  writeDiagnostic("info", "send.link_instead", {
    client,
    mailType: executed.result.mailType,
    reason
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
 * card that did not appear; elsewhere the link is the only way. When the card
 * offers Pay & Send, it is named instead, because the model cannot start one
 * (#475).
 */
export function howToSendText(
  draftId: string,
  client: Pick<ClientProfile, "rendersCards" | "inAppPurchases">,
  cardOffersPayAndSend = false,
  pay: { packPays: boolean; payOnPage: boolean } = { packPays: true, payOnPage: false }
): string {
  if (!client.rendersCards) {
    // Mail no pack pays for (#579) is paid on that page, which sends it.
    return pay.packPays
      ? `Nothing has been sent. To send it, call request_send with draftId ${draftId} and give the person its link, ` +
          `where they check it and send it themselves.`
      : `Nothing has been sent. To send it, call request_send with draftId ${draftId} and give the person its link, ` +
          `where they check it and pay for it with Pay & Send, which sends it. ` +
          `Letter packs and gift letters pay only for one-page letters and 6x9 postcards.`;
  }
  const how =
    client.inAppPurchases && cardOffersPayAndSend
      ? "The person pays for it and sends it with Pay & Send on the preview card; point them to it when they ask you to send it or pay for it. "
      : pay.payOnPage
        ? "The person pays for it with Pay & Send on letterirl.com, which the preview card's button opens; point them to it when they ask you to send it or pay for it. "
        : pay.packPays
          ? "The person sends it with Send on the preview card; point them to it when they ask you to send. "
          : "It is paid with Pay & Send, which is not available for it right now. ";
  // Mail no pack pays for (#579): said, so the model does not offer a pack.
  const packRule = pay.packPays
    ? ""
    : "Letter packs and gift letters pay only for one-page letters and 6x9 postcards. ";
  return `Nothing has been sent. ${how}${packRule}Only if the card is not showing, call request_send with draftId ${draftId} and give them its link.`;
}

/**
 * How a preview's mail is paid, as its eligibility says (#579): whether a
 * pack pays for it, and whether the card's button opens the page that takes
 * a Pay & Send payment.
 */
export function previewPayment(result: Record<string, unknown>): { packPays: boolean; payOnPage: boolean } {
  const eligibility = result.sendEligibility as
    | { packPays?: unknown; payAndSend?: { pageUrl?: unknown } }
    | undefined;
  return {
    packPays: eligibility?.packPays !== false,
    payOnPage: typeof eligibility?.payAndSend?.pageUrl === "string"
  };
}

/**
 * Whether a preview's card shows Pay & Send: as the card decides it, only
 * when the server offers it and the balance cannot pay (widgets'
 * payAndSendAvailable). With letters in hand, for a gift, or with Pay & Send
 * switched off, the card shows no such button, so the text must not name one.
 */
export function cardOffersPayAndSend(result: Record<string, unknown>): boolean {
  const eligibility = result.sendEligibility as { payAndSend?: { available?: unknown } } | undefined;
  return eligibility?.payAndSend?.available === true && result.canSendNow !== true;
}

const PREVIEW_TOOLS: ReadonlySet<string> = new Set([
  "quote_and_preview_letter",
  "quote_and_preview_letter_with_header_image",
  "quote_and_preview_letter_with_image",
  "quote_and_preview_postcard"
]);

/** The previews that take stationery (#563): the letters. A postcard has none. */
const LETTER_PREVIEW_TOOLS: ReadonlySet<string> = new Set([
  "quote_and_preview_letter",
  "quote_and_preview_letter_with_header_image",
  "quote_and_preview_letter_with_image"
]);

/**
 * Card-only switches a tool's result carries in _meta, each while its flag is
 * on: the letter previews tell their card it may open the page from an
 * envelope (#576), and every preview tells its card it may lay itself out as
 * a studio (#580), the postcard's as a postcard maker. In _meta, never
 * structuredContent, so never the model's.
 */
export function cardSwitches(toolName: string): Record<string, unknown> {
  if (!PREVIEW_TOOLS.has(toolName)) return {};
  return {
    ...(LETTER_PREVIEW_TOOLS.has(toolName) && isEnvelopeRevealEnabled() ? { [ENVELOPE_REVEAL_META]: true } : {}),
    ...(isStudioCardEnabled() ? { [STUDIO_CARD_META]: true } : {})
  };
}

/**
 * A letter preview's stationery (#563), for the narration: the theme it was
 * drawn in, and a remembered one as such, so the person hears why. Nothing
 * for Classic by default, or while stationery is not offered.
 */
function stationerySentence(result: Record<string, unknown>): string {
  const stationery = result.stationery as { theme?: unknown; source?: unknown } | undefined;
  if (typeof stationery?.theme !== "string") return "";
  if (stationery.source === "remembered") {
    return ` Stationery: ${stationery.theme}, the account's last choice; stationery in the call or set_stationery changes it.`;
  }
  return stationery.source === "asked" ? ` Stationery: ${stationery.theme}.` : "";
}

/**
 * A letter preview's signature (#608 review round 1), for the narration:
 * whether the saved signature prints, and when the account's choice decided
 * it, so the person hears why and how to change it. Nothing while signatures
 * are not offered, with none saved, or for a call that said no signature.
 */
function signatureSentence(result: Record<string, unknown>): string {
  const signature = result.signature as { printed?: unknown; source?: unknown } | undefined;
  if (typeof signature?.printed !== "boolean") return "";
  if (signature.source === "remembered") {
    return signature.printed
      ? " Signed with the person's saved signature, the account's choice; signature: false in the call leaves it off."
      : " Not signed: the account's choice is no signature; signature: true in the call prints the saved one.";
  }
  return signature.source === "asked" && signature.printed ? " Signed with the person's saved signature." : "";
}

/**
 * What a preview costs, for the narration's lead: the letters it takes from
 * the balance, or Pay & Send for mail no pack pays for (#579), such as a
 * letter of more than one page (#586). Never "requires 1 letter" for mail no
 * number of letters pays for (#590 review round 1).
 */
function previewCost(result: Record<string, unknown>, lettersRequired: number | undefined): string {
  const eligibility = result.sendEligibility as { packPays?: unknown } | undefined;
  if (eligibility?.packPays === false) return "paid with Pay & Send";
  const letters = lettersRequired ?? 1;
  return `requires ${letters} ${letters === 1 ? 'letter' : 'letters'}`;
}

/**
 * A letter of more than one page (#586), for the narration: its pages and the
 * sheets they print on. Empty for one page.
 */
function pagesSentence(result: Record<string, unknown>): string {
  const pages = result.pages;
  if (pages !== 2 && pages !== 3) return "";
  return pages === 2
    ? " A two-page letter, printed on both sides of one sheet."
    : " A three-page letter, printed on both sides of two sheets.";
}

/**
 * A held preview's dates (#535), for the narration: the sentence the preview
 * built with its own clock (its deliveryEstimate), and what a send then does.
 * Empty for mail sent at once.
 */
function heldMailSentence(result: Record<string, unknown>): string {
  const schedule = result.schedule as { arriveBy?: unknown; mailOn?: unknown } | undefined;
  if (typeof schedule?.arriveBy !== "string" || typeof schedule.mailOn !== "string") return "";
  const sentence = typeof result.deliveryEstimate === "string" && result.deliveryEstimate.startsWith("Goes to the printer")
    ? result.deliveryEstimate
    : scheduleSentence({ arriveBy: schedule.arriveBy, mailOn: schedule.mailOn }, new Date());
  return ` Scheduled: ${sentence} If it is sent, it is held until then; USPS does not guarantee First-Class dates.`;
}

/**
 * The sentence for mail sent with an arrival date that still waits for its
 * mail date (#535), on a send or an order status: when it goes to the
 * printer, and that it can be cancelled until then. The cancel is named only
 * while cancel_scheduled_mail is listed (the flag); mail held before the flag
 * went off still goes on its date.
 */
function scheduledOrderSentence(result: Record<string, unknown>): string {
  const schedule = result.schedule as { arriveBy?: unknown; mailOn?: unknown } | undefined;
  const arriveBy = typeof schedule?.arriveBy === "string" ? schedule.arriveBy : result.arriveBy;
  const mailOn = typeof schedule?.mailOn === "string" ? schedule.mailOn : result.mailOn;
  if (typeof arriveBy !== "string" || typeof mailOn !== "string") return "";
  const cancel =
    result.cancellable === true && isArriveByEnabled()
      ? " It can be cancelled free until then with cancel_scheduled_mail."
      : "";
  return ` ${scheduleSentence({ arriveBy, mailOn }, new Date())}${cancel}`;
}

/** An address on one line, as get_address_request's text gives it (#604). */
function addressLine(address: Record<string, unknown>): string {
  const part = (key: string) => (typeof address[key] === "string" ? (address[key] as string).trim() : "");
  const street = [part("name"), part("addressLine1"), part("addressLine2")].filter(Boolean).join(", ");
  return `${street}, ${part("city")}, ${part("state")} ${part("postalCode")}`.trim();
}

export function summarizeToolResult(
  toolName: string,
  result: Record<string, unknown>,
  client: ClientProfile = callingApp(undefined)
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
      let summary = `Preview ready: ${previewCost(result, lettersRequired)}. The card shows whether it can be sent now and the options to proceed.`;
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
      summary += heldMailSentence(result);
      summary += stationerySentence(result);
      summary += signatureSentence(result);
      summary += pagesSentence(result);
      return summary;
    }
    case "request_send":
      return sendLinkText(result as unknown as RequestSendOutput);
    case "set_arrival_date":
      // The tool's own sentence, which also travels in structuredContent for
      // the apps whose model reads only that (Claude Code).
      return typeof result.message === "string" ? result.message : "The arrival date was updated.";
    case "set_stationery":
      // As for set_arrival_date: the tool's own sentence (#563).
      return typeof result.message === "string" ? result.message : "The stationery was changed.";
    case "set_letter_words":
      // As for set_stationery: the tool's own sentence, with any change in pages (#586).
      return typeof result.message === "string" ? result.message : "The letter's words were changed.";
    case "set_postcard_style":
      // As for set_stationery: the tool's own sentence, with how a new size is paid (#594).
      return typeof result.message === "string" ? result.message : "The postcard's size or layout was changed.";
    case "cancel_scheduled_mail":
      // As for set_arrival_date: the sentence saying what went back.
      return typeof result.message === "string" ? result.message : "The scheduled mail was cancelled.";
    case "upload_photo_chunk":
      // Card-only: a model sees this only in an app that shows card-only
      // tools to it.
      return result.done ? "The photo is uploaded." : "Part of the photo is uploaded.";
    case "get_draft_status": {
      // Card-only: a model sees this only in an app that shows card-only
      // tools to it, and then it is a plain fact.
      const orderId = typeof result.orderId === "string" ? ` as order ${result.orderId}` : "";
      switch (result.status) {
        case "sent":
          return `That preview has been sent${orderId}.`;
        case "expired":
          return "That preview has expired.";
        case "ready":
          return "That preview has not been sent and can still be sent.";
        default:
          return "That preview was not found.";
      }
    }
    case "send_letter": {
      const status = result.currentStatus ?? "unknown";
      const order = result.orderId ?? "(no id)";
      const note = result.saveReturnAddressNote as string | undefined;
      let summary =
        status === "scheduled"
          ? `Letter ${order} is scheduled.${scheduledOrderSentence(result)}`
          : `Letter ${order} queued with status ${status}.`;
      if (note) {
        summary += ` ${note}`;
      }
      return summary;
    }
    case "get_order_status": {
      const status = result.currentStatus ?? "unknown";
      return status === "scheduled"
        ? `Latest order status: scheduled.${scheduledOrderSentence(result)}`
        : `Latest order status: ${status}.`;
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
      let summary = `Postcard preview ready: ${previewCost(result, lettersRequired)}. The card shows whether it can be sent now and the options to proceed.`;
      if (usedSaved) {
        summary += " Using your saved return address.";
      }
      const warnings = result.addressWarnings as string[] | undefined;
      if (warnings?.length) {
        summary += ` Note: ${warnings.join(' ')}`;
      }
      summary += heldMailSentence(result);
      return summary;
    }
    case "send_postcard": {
      const status = result.currentStatus ?? "unknown";
      const order = result.orderId ?? "(no id)";
      const note = result.saveReturnAddressNote as string | undefined;
      let summary =
        status === "scheduled"
          ? `Postcard ${order} is scheduled.${scheduledOrderSentence(result)}`
          : `Postcard ${order} queued with status ${status}.`;
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
      if (!client.rendersCards) {
        // No card shows the guide in this app, so the text carries it; the
        // card-only wording below would have the model point at nothing
        // (#484).
        const examples = Array.isArray(result.examplePrompts) ? (result.examplePrompts as string[]) : [];
        return [
          result.overview,
          result.purchaseStep,
          examples.length ? `Things to try: ${examples.map((example) => `"${example}"`).join(", ")}.` : "",
          // Claude dropped the letter packs link when paraphrasing (#475).
          "Pass this on to the person in your own words, including any link."
        ]
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join(" ");
      }
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
      // Where the card sends the photo itself there is no imageUrl (#474).
      if (result.cardUploadAvailable === true && uploadsThroughCard(client)) {
        return (
          "The upload card is showing. Once the person has uploaded their photo, the card asks for the preview in " +
          "the conversation. Then call the preview tool with no image and no imageUrl: Letter IRL uses the photo " +
          "they just uploaded."
        );
      }
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
    case "request_address":
      // The sentence carries the link, which is given only here (#604).
      return typeof result.message === "string" ? result.message : "The address request is ready.";
    case "get_address_request": {
      // With the address once answered, for an app whose model reads only the text (#604).
      const message = typeof result.message === "string" ? result.message : "The address request was checked.";
      const recipient = result.recipient as Record<string, unknown> | undefined;
      return recipient ? `${message} Address: ${addressLine(recipient)}.` : message;
    }
    case "cancel_address_request":
      return typeof result.message === "string" ? result.message : "The address request was cancelled.";
    case "set_letter_signature":
      // As for set_stationery: the tool's own sentence, with any change in pages (#608).
      return typeof result.message === "string" ? result.message : "The letter's signature was changed.";
    case "set_signature":
    case "get_signature":
    case "clear_signature":
      // The sentence only: the picture is the card's, in _meta (#608).
      return typeof result.message === "string" ? result.message : "The signature was checked.";
    default:
      return JSON.stringify(result);
  }
}
