import dotenv from "dotenv";
// Load .env but don't override existing env vars (allows .env.local via dotenv-cli)
dotenv.config({ override: false });
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import { McpServer, createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { LetterIrlServer } from "../server.js";
import { registerLetterTools, servedWidgetFile, type RegisterToolsOptions } from "./registerTools.js";
import { logMcpClientRequests } from "./clientRequestLog.js";
import { hostOrOriginRefusal, PARSE_ERROR_BODY, toSdkAuthInfo, userFromSdkAuthInfo } from "./mcpEndpoint.js";
import { buildServerInstructions } from "./serverInstructions.js";
import { isSendConfirmationEnabled } from "../config/sendConfirmation.js";
import { getOpenIdConfiguration, getProtectedResourceMetadata } from "../auth/metadata.js";
import { stringifyManifest } from "./manifest.js";
import { inlineHostBridge } from "./widgetHost.js";
import {
  AuthenticatedUser,
  validateAuthorizationHeader
} from "../auth/tokenValidator.js";
import { BetaAccessDeniedError, BETA_ACCESS_MESSAGE } from "../auth/betaAccess.js";
import { handleCreditApiRequest } from "../api/creditApiHandler.js";
import { handlePATApiRequest } from "../api/patApiHandler.js";
import { handleLetterApiRequest } from "../api/letterApiHandler.js";
import { handleReturnAddressApiRequest } from "../api/returnAddressApiHandler.js";
import { handleSignatureApiRequest, SIGNATURE_API_PATH } from "../api/signatureApiHandler.js";
import { handleSendConfirmationApiRequest } from "../api/sendConfirmationApiHandler.js";
import { ADDRESS_REQUEST_API_PREFIX, handleAddressRequestApiRequest } from "../api/addressRequestApi.js";
import { handleTempImageRequest } from "../api/tempImageHandler.js";
import {
  handleCreateCheckoutSession,
  handleStripeWebhook
} from "../api/dashboardApiHandler.js";
import { validatePromoCodePublic } from "../services/promoService.js";
import { lookupGiftCodePublic } from "../services/giftLetterService.js";
import { giftCodeFromPath } from "../services/giftCodes.js";
import { ourCheckoutUrl } from "../services/commerceService.js";
import { closePool } from "../db/index.js";
import { rateLimitMiddlewareWithTier, rateLimitMiddlewareWithGlobal } from "../api/middleware/rateLimit.js";
import {
  resolvePurchaseStart,
  purchaseReturnDiagnostics,
  purchaseStartDiagnostics,
  readReturnCookie,
  renderPurchaseReturnPage
} from "./purchaseReturnPage.js";
import {
  readRequestBody,
  MCP_BODY_LIMIT_BYTES,
  WEBHOOK_BODY_LIMIT_BYTES,
  JSON_API_BODY_LIMIT_BYTES
} from '../utils/requestBody.js';
import { isDebugEnabled } from "../utils/debug.js";
import {
  assertValidOAuthConfig,
  getOAuthConfig,
  isCimdEnforcementEnabled,
  SUPPORTED_GRANT_TYPES
} from "../auth/oauthConfig.js";
import { classifyOAuthRoute } from "../auth/oauthRoutes.js";
import {
  classifyDiagnosticError,
  writeDiagnostic
} from "../utils/diagnosticLog.js";
import { buildWwwAuthenticateChallenge, InsufficientScopeError } from "../auth/oauthChallenge.js";
import { validatePublicServerAdminConfiguration } from "../admin/config.js";
import { assertValidDeploymentConfig } from "../config/deploymentConfig.js";
import { getReadiness } from "./readiness.js";
import { kickPriceCatalog } from "../services/priceCatalog.js";
import { reportDailyLimitDefaults } from "../services/dailyLimits.js";
import { settleOperatorNotices } from "../services/operatorNotify.js";
import { denyLegacyPublicAdminRoute } from "./legacyAdminRoutes.js";
import { resolveCorsOriginFor } from "./corsOrigin.js";
import { installProcessGuards, withRequestBoundary } from "./requestBoundary.js";
import { APPS_CHALLENGE_PATH, appsChallengeResponse } from "./appsChallenge.js";
import { logRestRequestOnFinish } from "../api/restRequestLog.js";
import { CAPABILITIES_PATH, handleCapabilitiesRequest } from "../api/capabilitiesApi.js";
import { OAUTH_NOT_CONFIGURED } from "../auth/oauthErrors.js";
import { clientLogFields, resolveClientProfile } from "../auth/clientProfiles.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_WIDGET_DIR = path.resolve(__dirname, "..", "..", "widgets");
const DEFAULT_HOST = process.env.LETTER_IRL_HTTP_HOST ?? "0.0.0.0";
// Railway sets PORT env var; fall back to LETTER_IRL_HTTP_PORT for local dev
const DEFAULT_PORT = Number(process.env.PORT ?? process.env.LETTER_IRL_HTTP_PORT ?? "8090");
const MCP_PATH = process.env.LETTER_IRL_MCP_PATH ?? "/mcp";
/**
 * The legacy SSE transport's paths, retired (#730). Its message POSTs carried
 * no credential, only the session id in the query string, and a stream ran on
 * the token it opened with until it closed. Every client Letter IRL supports
 * speaks streamable HTTP at MCP_PATH; these answer 410 and say so. Both
 * deployments ran it at GET /mcp with its messages at /messages
 * (set by two SSE path variables this code no longer reads); the
 * defaults were /mcp/sse and /mcp/sse/messages.
 */
const RETIRED_SSE_PATHS: ReadonlySet<string> = new Set(["/mcp/sse", "/mcp/sse/messages", "/messages"]);
const WIDGET_PATH = process.env.LETTER_IRL_WIDGET_PATH ?? "/widgets";
const MANIFEST_ROUTE = process.env.LETTER_IRL_MANIFEST_ROUTE ?? "/manifest.json";
const FALLBACK_ORIGIN =
  process.env.LETTER_IRL_DEFAULT_ORIGIN ?? `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const PUBLIC_BASE_URL =
  process.env.LETTER_IRL_PUBLIC_BASE_URL ?? `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const REQUIRE_AUTH = process.env.LETTER_IRL_REQUIRE_AUTH !== "false";
const DEBUG_ENABLED = isDebugEnabled();

// Environment validation lives in src/config/deploymentConfig.ts (issue #155):
// one validator, shared with the maintenance entrypoint, that fails a
// misconfigured production boot instead of letting it serve /healthz and fake
// its way through fulfillment.

/**
 * Build identity, for verifying which revision is actually serving.
 *
 * Railway injects these at build time; they are absent when running locally,
 * where "unknown" is the honest answer rather than a fabricated value.
 *
 * Exposed as response headers on /healthz rather than in the body, because the
 * body is asserted to be exactly "ok" by docs/manual-tests.md and is consumed by
 * the Railway healthcheck. A header is additive and breaks neither.
 */
export const BUILD_COMMIT = process.env.RAILWAY_GIT_COMMIT_SHA ?? "unknown";
export const BUILD_BRANCH = process.env.RAILWAY_GIT_BRANCH ?? "unknown";

/**
 * Every path handleCreditApiRequest answers on. Kept as one list so the
 * limiter and the handler cannot drift apart again (src/api/creditApiHandler.ts).
 */
const CREDIT_API_PREFIXES = ['/api/credits', '/api/promo', '/api/users/me'] as const;

/**
 * Every REST route family, for the request log. Checkout is REST in all but
 * the file it lives in.
 */
const REST_API_PREFIXES = [
  ...CREDIT_API_PREFIXES,
  '/api/tokens',
  '/api/letters',
  '/api/return-address',
  '/api/stripe/create-checkout-session'
] as const;

export function validateEnvironment() {
  validatePublicServerAdminConfiguration(process.env);

  // Fail closed on invalid deployment configuration (issue #155). Throws with
  // every problem named at once; the entrypoint's catch turns that into a
  // non-zero exit, so a misconfigured deploy never serves traffic. Warnings
  // are printed except under test, where the pinned boot-validation contract
  // counts warn lines exactly (tests/unit/mcp/legacyAdminRoutes.test.ts).
  let deployment;
  try {
    deployment = assertValidDeploymentConfig(process.env, 'server');
  } catch (error) {
    // Print the validator's message HERE, where the failure is known to be
    // configuration and the message is value-free by construction (it names
    // variables, never values). The entrypoint's catch deliberately logs only
    // an error class - correct for arbitrary runtime errors, which may carry
    // sensitive detail, but it would leave the operator with one word and no
    // variable names for a config failure (review round 1).
    console.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
  if (deployment.mode !== 'test') {
    for (const warning of deployment.warnings) {
      console.warn(`[config] ${warning}`);
    }
  }

  if (REQUIRE_AUTH && isCimdEnforcementEnabled()) {
    assertValidOAuthConfig();
  } else if (REQUIRE_AUTH) {
    console.warn(
      "[auth] Strict CIMD startup enforcement is disabled; enable LETTER_IRL_OAUTH_CIMD_ENFORCEMENT only at the coordinated cutover"
    );
  }
}

/**
 * Parse request body with timeout and error handling
 */
function parseRequestBody(
  req: http.IncomingMessage,
  limitBytes: number,
  timeoutMs = 30000
): Promise<string> {
  // limitBytes is REQUIRED and deliberately has no default. This function had a
  // 30-second timeout and no size cap, so the bound was bandwidth x 30s - and
  // /webhooks/stripe reaches it before authentication, because Stripe signs the
  // body and the signature cannot be checked until it is read (#157). A default
  // would let the next route added here inherit the same hole silently.
  return readRequestBody(req, { limitBytes, timeoutMs });
}

/** 413, 408, or 400 - so a refused body is not reported as a parse failure. */
function bodyErrorStatus(error: unknown): number {
  const status = (error as { statusCode?: unknown } | undefined)?.statusCode;
  return typeof status === 'number' ? status : 400;
}

function getAllowedHosts(): string[] {
  const raw = process.env.LETTER_IRL_ALLOWED_HOSTS;
  if (!raw) {
    return [
      `${DEFAULT_HOST}:${DEFAULT_PORT}`,
      DEFAULT_HOST,
      "localhost",
      "localhost:8090"
    ];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getAllowedOrigins(): string[] {
  const raw = process.env.LETTER_IRL_ALLOWED_ORIGINS;
  if (!raw) {
    return [
      "https://chatgpt.com",
      "https://chat.openai.com",
      "http://localhost:4173",
      `http://${DEFAULT_HOST}:${DEFAULT_PORT}`,
      "http://127.0.0.1:8090",
      "http://localhost:8090"
    ];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim();
}

/**
 * The origin the manifest, the OAuth metadata and the 401 challenge name.
 * Pinned to LETTER_IRL_PUBLIC_BASE_URL wherever it is set (#730): taken from a
 * request's forwarded headers, a caller could name another host in the URLs
 * those documents hand to clients. Both deployments set it; a local run or a
 * test without it still reads the request.
 */
export function getPublicBaseUrl(req: Pick<http.IncomingMessage, "headers">): string {
  const configured = process.env.LETTER_IRL_PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const host = firstHeaderValue(req.headers["x-forwarded-host"]) ?? firstHeaderValue(req.headers.host);
  if (!host) {
    return PUBLIC_BASE_URL;
  }

  const proto =
    firstHeaderValue(req.headers["x-forwarded-proto"]) ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");

  return `${proto}://${host}`;
}

export async function serveWidget(
  widgetName: string,
  res: http.ServerResponse
): Promise<boolean> {
  // Only a card the app serves, by its own file name (#730): the directory
  // also holds notes and shared parts, and a card while its flag is off.
  const file = servedWidgetFile(widgetName.replace(/\.html$/, ""));
  if (!file) return false;
  const filePath = path.join(DEFAULT_WIDGET_DIR, `${file}.html`);
  try {
    // With the shared bridge inlined (#474), as resources/read serves it.
    const file = inlineHostBridge(await fs.readFile(filePath, "utf-8"), DEFAULT_WIDGET_DIR);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // No page may frame a card from here (#684): hosts load cards through
    // resources/read, never this URL. Opened directly, a card runs as an
    // opaque origin with no network, so it is a picture of itself (#730).
    res.setHeader("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    res.end(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    res.statusCode = 500;
    res.end("Internal Server Error");
    return true;
  }
}

/** One MCP server for one request or stream, in the calling app's words (#484). */
export async function createMcpServer(
  letterServer: LetterIrlServer,
  authInfo: AuthenticatedUser | null,
  options: RegisterToolsOptions = {}
) {
  const mcpServer = new McpServer({
    name: "letter-irl",
    version: "0.1.0"
  }, {
    // In the calling app's words (#484), as its tool descriptions are. SDK v2 also answers server/discover with
    // them, so a 2026-07-28 client reads its own app's instructions too.
    instructions: buildServerInstructions(isSendConfirmationEnabled(), resolveClientProfile(authInfo)),
    cacheHints: MCP_CACHE_HINTS
  });
  await registerLetterTools(mcpServer, letterServer, authInfo, options);
  return mcpServer;
}

/**
 * How long a 2026-07-28 client may keep each list or read, and who may share it (#477): not at all, and only the
 * caller. The tools, their descriptions, the instructions and the cards all differ by app and by flag, so a list
 * cached as public could be handed to another token's app. These are the SDK's defaults today, said here so a
 * change of default cannot change them (tests/unit/mcp/mcpEndpoint.test.ts).
 */
export const MCP_CACHE_HINTS = Object.fromEntries(
  ["tools/list", "prompts/list", "resources/list", "resources/templates/list", "resources/read", "server/discover"].map(method => [
    method,
    { ttlMs: 0, cacheScope: "private" as const }
  ])
);

/**
 * The /mcp handler (#477): SDK v2 serves 2026-07-28 requests and, statelessly, 2025-era ones, from one factory, so
 * the two eras are served the same tools. One server per request, as before, for the caller we signed in, which
 * reaches the factory as the request's authInfo. A 2026-07-28 request is answered in JSON (responseMode): nothing
 * here streams. A 2025 one is answered as SDK v1 answered it, one event on an SSE response, which the SDK's
 * stateless leg does whatever responseMode says.
 * No subscriptions/listen streams either: we publish no change events, and the SDK's cap on open streams is one count
 * for the whole process, so one client holding streams open could refuse every other client's.
 */
export function createLetterMcpHandler(letterServer: LetterIrlServer): McpHttpHandler {
  return createMcpHandler(async ({ authInfo }) => createMcpServer(letterServer, userFromSdkAuthInfo(authInfo)), {
    legacy: "stateless",
    responseMode: "json",
    maxSubscriptions: 0,
    onerror: (error) => {
      writeDiagnostic("warn", "mcp.handler_error", { errorClass: classifyDiagnosticError(error, "transport_error") });
    }
  });
}

export async function startHttpServer() {
  // Validate environment variables before starting server
  validateEnvironment();

  const letterServer = new LetterIrlServer();
  let cachedToolNames: Set<string> | null = null;
  const allowedHosts = getAllowedHosts();
  const allowedOrigins = getAllowedOrigins();
  const mcpHandler = createLetterMcpHandler(letterServer);
  const serveMcp = toNodeHandler(mcpHandler, {
    onerror: (error) => {
      writeDiagnostic("error", "mcp.request_failed", { errorClass: classifyDiagnosticError(error, "transport_error") });
    }
  });

  // Allowlist or fallback, never a wildcard: see corsOrigin.ts for the
  // "null" origin case this used to special-case.
  const resolveCorsOrigin = (incoming?: string | string[]) =>
    resolveCorsOriginFor(incoming, allowedOrigins, FALLBACK_ORIGIN);

  const respondToCorsPreflight = (
    res: http.ServerResponse,
    origin: string
  ) => {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, DELETE, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name"
    });
    res.end();
  };

  // Every route runs inside one exception boundary (src/mcp/requestBoundary.ts):
  // an error that escapes a handler becomes a diagnostic and a 500, never an
  // unhandled rejection that ends the process.
  const server = http.createServer(withRequestBoundary(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${DEFAULT_HOST}:${DEFAULT_PORT}`}`);
    if (REST_API_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) {
      logRestRequestOnFinish(req, res, url.pathname);
    }

    if (denyLegacyPublicAdminRoute(url.pathname, res)) {
      return;
    }

    if (url.pathname === "/healthz") {
      res.statusCode = 200;
      // Deploy verification: a status code alone cannot distinguish a new build
      // from an old one still serving after a failed deploy.
      res.setHeader("X-Build-Commit", BUILD_COMMIT);
      res.setHeader("X-Build-Branch", BUILD_BRANCH);
      res.setHeader("Cache-Control", "no-store");
      res.end("ok");
      return;
    }

    if (url.pathname === APPS_CHALLENGE_PATH) {
      // The plugin portal's domain verification (src/mcp/appsChallenge.ts).
      const answer = appsChallengeResponse(req.method);
      res.writeHead(answer.status, answer.headers);
      res.end(answer.body);
      return;
    }

    if (url.pathname === "/readyz") {
      // Readiness as distinct from liveness (issue #155): configured, database
      // reachable, mail routing pointed at real providers. /healthz stays a
      // pure process probe - its body is contractually pinned to "ok".
      const readiness = await getReadiness();
      res.statusCode = readiness.statusCode;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("X-Build-Commit", BUILD_COMMIT);
      res.setHeader("X-Build-Branch", BUILD_BRANCH);
      res.setHeader("Cache-Control", "no-store");
      res.end(readiness.body);
      return;
    }

    if (RETIRED_SSE_PATHS.has(url.pathname)) {
      res.writeHead(410, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        error: "gone",
        message: `The SSE transport is retired. Connect with streamable HTTP at ${MCP_PATH}.`
      }));
      return;
    }

    // What Letter IRL does and costs, for agents and the website (#630).
    if (url.pathname === CAPABILITIES_PATH) {
      handleCapabilitiesRequest(req, res, { mcpServer: `${getPublicBaseUrl(req)}${MCP_PATH}` });
      return;
    }

    if (url.pathname === MANIFEST_ROUTE) {
      try {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(stringifyManifest(getPublicBaseUrl(req)));
      } catch (error) {
        writeDiagnostic("error", "mcp.manifest_generation_failed", {
          errorClass: classifyDiagnosticError(error, "configuration_error")
        });
        res.statusCode = 500;
        res.end("Manifest generation error");
      }
      return;
    }

    if (url.pathname === "/") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok", service: "letter-irl" }));
      return;
    }

    // Debug endpoint to check widget registration (no auth required)
    if (url.pathname === "/debug/widgets") {
      if (!DEBUG_ENABLED) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      const fs = await import("fs/promises");
      const pathMod = await import("path");
      const { fileURLToPath } = await import("url");
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = pathMod.dirname(__filename);
      const widgetDir = process.env.LETTER_IRL_WIDGET_DIR ?? pathMod.resolve(__dirname, "../../widgets");
      const status: Record<string, any> = { widgetDir, cwd: process.cwd(), widgets: {} };

      // Dynamically read widget files from directory
      try {
        const files = await fs.readdir(widgetDir);
        const widgetFiles = files.filter(f => f.endsWith('.html'));
        for (const file of widgetFiles) {
          const widgetName = file.replace('.html', '');
          const filePath = pathMod.join(widgetDir, file);
          const stat = await fs.stat(filePath);
          status.widgets[widgetName] = { exists: true, path: filePath, size: stat.size };
        }
      } catch (e: any) {
        status.error = `Failed to read widget directory: ${e.message}`;
      }

      res.end(JSON.stringify(status, null, 2));
      return;
    }

    // Debug endpoint for widget diagnostic beacons (no auth required, DEBUG gated)
    if (url.pathname === "/api/widget-diagnostic") {
      if (!DEBUG_ENABLED) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const origin = resolveCorsOrigin(req.headers.origin);
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Content-Type", "application/json");

      if (req.method === "OPTIONS") {
        respondToCorsPreflight(res, origin);
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST, OPTIONS" });
        res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
        return;
      }

      try {
        const body = await parseRequestBody(req, JSON_API_BODY_LIMIT_BYTES);
        if (body) {
          JSON.parse(body);
        }
        writeDiagnostic("info", "widget.diagnostic_received");
        res.statusCode = 204;
        res.end();
      } catch (error: any) {
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            ok: false,
            error: "Invalid diagnostic payload",
            message: error?.message ?? "Unknown error"
          })
        );
      }
      return;
    }

    // Checkout start page (#372): the card opens this through openExternal so
    // ChatGPT can append the way back into the conversation; the page keeps it
    // in a same-site cookie and forwards to Stripe. It forwards only to the
    // checkout address one of our orders recorded for the link's session
    // (#730), looked up by the session's indexed id, and only to a ChatGPT
    // origin as the return, so it is not an open redirect.
    if (url.pathname === '/purchase/start' && req.method === 'GET') {
      // Its own limits, per address and in all: it reads the database
      // without a sign-in (#730).
      if (rateLimitMiddlewareWithGlobal(req, res, 'purchase_start')) return;
      let decision: Awaited<ReturnType<typeof resolvePurchaseStart>>;
      try {
        decision = await resolvePurchaseStart(
          { to: url.searchParams.get('to'), redirectUrl: url.searchParams.get('redirectUrl') },
          ourCheckoutUrl
        );
      } catch (error) {
        writeDiagnostic('error', 'purchase.start_lookup_failed', {
          errorClass: classifyDiagnosticError(error, 'database_error')
        });
        res.statusCode = 503;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Retry-After', '5');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Checkout could not be opened just now. Try again in a moment.');
        return;
      }
      // Presence, hosts and outcome only: the return link names a
      // conversation and the target is a live checkout session.
      writeDiagnostic("info", "purchase.start", purchaseStartDiagnostics({
        query: url.searchParams,
        referer: req.headers.referer,
        userAgent: req.headers['user-agent'],
        decision
      }));
      res.setHeader('Cache-Control', 'no-store');
      if (decision.status === 400) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(decision.body);
        return;
      }
      if (decision.cookie) res.setHeader('Set-Cookie', decision.cookie);
      res.statusCode = 302;
      res.setHeader('Location', decision.location);
      res.end();
      return;
    }

    // Server-controlled Stripe return page. It intentionally shows no order
    // details; authenticated status is available only through get_purchase_status.
    // The page's one job is the way back into ChatGPT (src/mcp/purchaseReturnPage.ts).
    if (url.pathname === '/purchase/return' && req.method === 'GET') {
      const cancelled = url.searchParams.get('outcome') === 'cancelled';
      const userAgentHeader = req.headers['user-agent'];
      const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;
      const conversationUrl = readReturnCookie(req.headers.cookie);
      writeDiagnostic("info", "purchase.return", purchaseReturnDiagnostics({
        cookieHeader: req.headers.cookie,
        cancelled,
        userAgent,
        conversationUrl
      }));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(renderPurchaseReturnPage({ cancelled, userAgent, conversationUrl }));
      return;
    }

    // Stripe Checkout API
    if (url.pathname === "/api/stripe/create-checkout-session" && req.method === "POST") {
      // Rate limit checkout attempts
      if (await rateLimitMiddlewareWithTier(req, res, 'checkout')) {
        return; // Rate limited
      }
      // Parse JSON body with timeout
      try {
        const body = await parseRequestBody(req, JSON_API_BODY_LIMIT_BYTES);
        (req as any).body = body ? JSON.parse(body) : {};
        await handleCreateCheckoutSession(req as any, res as any);
      } catch (error) {
        console.error('Error parsing checkout request body');
        res.statusCode = 408;
        res.end('Request timeout or error');
      }
      return;
    }

    // Stripe webhook
    if (url.pathname === "/webhooks/stripe" && req.method === "POST") {
      // Keep raw body for signature verification with timeout
      try {
        const body = await parseRequestBody(req, WEBHOOK_BODY_LIMIT_BYTES);
        (req as any).body = body; // Raw string for Stripe signature verification
        await handleStripeWebhook(req as any, res as any);
      } catch (error) {
        // A refused body is 413, not 408. Stripe retries on both, but the
        // status is the only signal telling an operator which happened.
        console.error('Error parsing Stripe webhook body');
        res.statusCode = bodyErrorStatus(error);
        res.end(res.statusCode === 413 ? 'Payload too large' : 'Request timeout or error');
      }
      return;
    }

    // The address request page's API (#604): public, signed out, the token
    // in the body. Its own rate limits, and 404 while address requests are off.
    if (url.pathname.startsWith(ADDRESS_REQUEST_API_PREFIX)) {
      const origin = resolveCorsOrigin(req.headers.origin);
      if (req.method === 'OPTIONS') {
        respondToCorsPreflight(res, origin);
        return;
      }
      await handleAddressRequestApiRequest(req, res, url.pathname, origin);
      return;
    }

    // Public promo validation endpoint (no auth required - for preview access)
    if (url.pathname.startsWith('/api/public/promo/validate/') && req.method === 'GET') {
      const origin = resolveCorsOrigin(req.headers.origin);
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Content-Type', 'application/json');

      // Rate limit check (per-IP + global) - prevents brute force code enumeration
      if (rateLimitMiddlewareWithGlobal(req, res, 'promo_public')) return;

      const code = url.pathname.replace('/api/public/promo/validate/', '');
      if (!code) {
        res.statusCode = 400;
        res.end(JSON.stringify({ valid: false, reason: 'No promo code provided' }));
        return;
      }

      try {
        const result = await validatePromoCodePublic(decodeURIComponent(code));
        res.statusCode = 200;
        // Don't expose full campaign details publicly - just validity and credits amount
        res.end(JSON.stringify({
          valid: result.valid,
          reason: result.reason,
          creditsAmount: result.campaign?.credits_amount,
          campaignName: result.campaign?.name,
        }));
      } catch (error) {
        console.error('Error validating promo code');
        res.statusCode = 500;
        res.end(JSON.stringify({ valid: false, reason: 'Internal error' }));
      }
      return;
    }

    // Public gift code lookup (docs/gift-letters.md): what the claim page may
    // know before sign-in. Validity, kind and a redeem-by date; never who sent
    // it. Shares the promo_public budget, since both answer "is this a code".
    if (url.pathname.startsWith('/api/public/gift/') && req.method === 'GET') {
      const origin = resolveCorsOrigin(req.headers.origin);
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Content-Type', 'application/json');
      if (rateLimitMiddlewareWithGlobal(req, res, 'promo_public')) return;

      // Empty, or a malformed percent-encoding: a bad request, not a fault.
      const code = giftCodeFromPath(url.pathname);
      if (!code) {
        res.statusCode = 400;
        res.end(JSON.stringify({ valid: false, reason: 'not_found' }));
        return;
      }
      try {
        const result = await lookupGiftCodePublic(code);
        res.statusCode = 200;
        res.end(JSON.stringify(result));
      } catch (error) {
        writeDiagnostic('error', 'gift.public_lookup_failed', {
          errorClass: classifyDiagnosticError(error, 'database_error')
        });
        res.statusCode = 500;
        res.end(JSON.stringify({ valid: false, reason: 'unavailable' }));
      }
      return;
    }

    // Handle CORS preflight for public promo and gift endpoints
    if (
      (url.pathname.startsWith('/api/public/promo/') || url.pathname.startsWith('/api/public/gift/')) &&
      req.method === 'OPTIONS'
    ) {
      respondToCorsPreflight(res, resolveCorsOrigin(req.headers.origin));
      return;
    }

    if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png" || url.pathname === "/favicon.svg") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (
      classifyOAuthRoute(url.pathname, req.method ?? "GET") ===
      "authorization-server-proxy"
    ) {
      const payload = getOpenIdConfiguration(getPublicBaseUrl(req));
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
      return;
    }

    if (
      classifyOAuthRoute(url.pathname, req.method ?? "GET") ===
      "protected-resource"
    ) {
      const payload = getProtectedResourceMetadata(getPublicBaseUrl(req));
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
      return;
    }

    // OAuth Dynamic Client Registration endpoint (static client approach)
    // Returns a pre-provisioned client_id instead of creating new clients
    // Aligned with MCP Nov 2025 spec direction (CIMD replacing DCR)
    // GitHub Issue: #20
    if (url.pathname === "/oauth/register" && req.method === "POST") {
      const oauthConfig = getOAuthConfig();
      const staticClientId = oauthConfig.staticClientId;

      if (
        classifyOAuthRoute(url.pathname, req.method) !== "static-registration" ||
        !staticClientId
      ) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          error: "not_found"
        }));
        return;
      }

      // RFC 7591 compliant response with static client
      const response = {
        client_id: staticClientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: "none",
        grant_types: [...SUPPORTED_GRANT_TYPES],
        response_types: ["code"],
        redirect_uris: oauthConfig.staticRedirectUris
      };

      writeDiagnostic("info", "auth.static_registration_returned");
      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(response));
      return;
    }

    if (url.pathname.startsWith(WIDGET_PATH)) {
      const widgetName = url.pathname.replace(`${WIDGET_PATH}/`, "");
      if (!widgetName) {
        res.statusCode = 404;
        res.end("Widget not specified");
        return;
      }
      const served = await serveWidget(widgetName, res);
      if (!served) {
        res.statusCode = 404;
        res.end("Widget not found");
      }
      return;
    }

    // Temp image serving (no auth - token is the capability)
    if (url.pathname.startsWith('/api/temp-image/')) {
      const tempImageHandled = await handleTempImageRequest(req, res, url.pathname);
      if (tempImageHandled) return;
    }

    // Credit API routes. The prefix test used to name only /api/credits while
    // the handler also owns /api/promo/* and /api/users/me, so those two ran
    // with no per-identifier and no global limit: promo codes are
    // operator-chosen words, and this was the one route where they could be
    // guessed at line rate. Promo paths additionally take the tighter limit
    // the public validator has always had.
    if (CREDIT_API_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) {
      if (await rateLimitMiddlewareWithTier(req, res, 'api')) {
        return; // Rate limited
      }
      if (
        url.pathname.startsWith('/api/promo') &&
        (await rateLimitMiddlewareWithTier(req, res, 'promo_authenticated'))
      ) {
        return; // Rate limited
      }
    }
    const creditApiHandled = await handleCreditApiRequest(req, res, url.pathname);
    if (creditApiHandled) {
      return;
    }

    // PAT (Personal Access Token) API routes
    if (url.pathname.startsWith('/api/tokens')) {
      if (await rateLimitMiddlewareWithTier(req, res, 'api')) {
        return; // Rate limited
      }
    }
    const patApiHandled = await handlePATApiRequest(req, res, url.pathname);
    if (patApiHandled) {
      return;
    }

    // Letter API routes
    if (url.pathname.startsWith('/api/letters')) {
      if (await rateLimitMiddlewareWithTier(req, res, 'api')) {
        return; // Rate limited
      }
    }
    const letterApiHandled = await handleLetterApiRequest(req, res, url.pathname);
    if (letterApiHandled) {
      return;
    }

    // Return Address API routes
    if (url.pathname.startsWith('/api/return-address')) {
      if (await rateLimitMiddlewareWithTier(req, res, 'api')) {
        return; // Rate limited
      }
    }
    const returnAddressApiHandled = await handleReturnAddressApiRequest(req, res, url.pathname);
    if (returnAddressApiHandled) {
      return;
    }

    // The saved signature (#608), for the website's signature page.
    if (url.pathname === SIGNATURE_API_PATH) {
      if (await rateLimitMiddlewareWithTier(req, res, 'api')) {
        return; // Rate limited
      }
    }
    if (await handleSignatureApiRequest(req, res, url.pathname)) {
      return;
    }

    // The confirmation page's API (#470): where the person sends a preview.
    if (url.pathname.startsWith('/api/sends')) {
      if (await rateLimitMiddlewareWithTier(req, res, 'api')) {
        return; // Rate limited
      }
    }
    const sendsApiHandled = await handleSendConfirmationApiRequest(req, res, url.pathname);
    if (sendsApiHandled) {
      return;
    }

    if (url.pathname === MCP_PATH && req.method === "OPTIONS") {
      // A browser's preflight carries no credential: answered before the
      // limiter and sign-in, as the SSE route answered it until #730. Every
      // client today is a server-side one; /mcp's POST sets no CORS origin.
      respondToCorsPreflight(res, resolveCorsOrigin(req.headers.origin));
      return;
    }

    if (url.pathname === MCP_PATH && req.method === "GET") {
      // No server-initiated stream (#730): every request builds its own
      // server and transport, so a GET stream would carry nothing and only
      // hold a connection open. The MCP spec allows 405 here.
      res.writeHead(405, { Allow: "POST, OPTIONS", "Cache-Control": "no-store" });
      res.end();
      return;
    }

    if (url.pathname === MCP_PATH) {
      // Rate limit MCP tool calls
      if (await rateLimitMiddlewareWithTier(req, res, 'mcp')) {
        return; // Rate limited
      }

      // Cached once: the registry is static for the process lifetime. Every
      // tool, not one app's list, or a checkout call logs as "other" (#520).
      cachedToolNames ??= new Set(letterServer.toolNames());

      // No Origin header means a non-browser client, which is what every MCP
      // backend is. The transport's DNS-rebinding check only validates an Origin
      // that is present, so the right thing to do with an absent one is leave
      // it absent. Until 2026-09-09 this handler wrote FALLBACK_ORIGIN into the
      // request instead, a leftover from the first prototype; with no
      // LETTER_IRL_DEFAULT_ORIGIN configured that was http://0.0.0.0:8788, never
      // on the allowlist, so every request from ChatGPT's backend that carried
      // no Origin, including the tool-list refresh a fresh link depends on, was
      // refused with 403 "Invalid Origin header". Tool calls happened to carry
      // an Origin and passed, which is how it stayed hidden.

      const authInfo = await authenticateRequest(req, res, getPublicBaseUrl(req));
      if (authInfo === null) {
        return;
      }

      // The limiter above ran before authentication and could only key on the
      // source address, which every ChatGPT user shares. Now that the subject
      // is known, bound the account itself; publishing it on the request is
      // also what lets the tier multipliers apply at all.
      (req as any).auth = authInfo;
      if (await rateLimitMiddlewareWithTier(req, res, 'mcp_account')) {
        return;
      }

      // Which app is calling (#473), so a tool call can be traced to ChatGPT,
      // Claude, Codex or a personal access token from the log alone.
      const clientFields = clientLogFields(authInfo);
      writeDiagnostic("info", "mcp.request_received", {
        method: req.method ?? "unknown",
        authType: authInfo?.authType ?? "disabled",
        ...clientFields
      });

      // SDK v1's transport checked these; v2's handler checks nothing (#477), so they are checked here, at the same
      // point: after the sign-in and the limiters, before any server is made.
      const refused = hostOrOriginRefusal(req.headers, allowedHosts, allowedOrigins);
      if (refused) {
        writeDiagnostic("warn", "mcp.request_refused", { reason: refused.reason });
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify(refused.body));
        return;
      }

      try {
        // Read under our own limit: the SDK's applies only to a body it reads itself.
        const body = await parseRequestBody(req, MCP_BODY_LIMIT_BYTES);
        let parsedBody: unknown;
        try {
          parsedBody = body ? JSON.parse(body) : undefined;
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(PARSE_ERROR_BODY));
          return;
        }
        writeDiagnostic("info", "mcp.request_parsed");

        // Issue #235 observability: which client class asked for what, and
        // which metadata revisions a tools/list response served; and which
        // protocol revision it spoke (#477).
        logMcpClientRequests(
          parsedBody,
          req.headers["user-agent"],
          cachedToolNames ?? new Set(),
          clientFields.client,
          firstHeaderValue(req.headers["mcp-protocol-version"])
        );

        // The adapter hands the request's auth to the handler as its authInfo: our caller, in the SDK's words.
        const forwarded: NodeIncomingMessageLike = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          auth: authInfo ? toSdkAuthInfo(authInfo) : undefined,
          [Symbol.asyncIterator]: () => req[Symbol.asyncIterator]()
        };
        await serveMcp(forwarded, res, parsedBody);
      } catch (error) {
        writeDiagnostic("error", "mcp.request_failed", {
          errorClass: classifyDiagnosticError(error, "transport_error")
        });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end("Internal Server Error");
        }
      }
      return;
    }

    res.statusCode = 404;
    res.end("Not found");
  }));

  installProcessGuards();

  await new Promise<void>((resolve) => {
    server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
      console.log(`Letter IRL MCP HTTP server listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
      // A Railway service variable sets it (#730, #745); this line is how a deploy shows it took.
      writeDiagnostic("info", "boot.thread_pool", { size: Number(process.env.UV_THREADPOOL_SIZE) || 4 });
      // Price warmup AFTER the port binds, fire-and-forget (#275 stage A). An
      // earlier revision awaited this above, ~650 lines before listen, which
      // meant a Stripe outage held the socket closed - a probe against a
      // closed port cannot report "unready", so the comment promising /healthz
      // would answer was false (#278 review). Resolution is lazy at every
      // consuming path anyway; this only saves the first request the latency.
      kickPriceCatalog(undefined, "http_listen");
      // The daily limits this process runs with, for the admin panel, which
      // has its own environment (migration 038). Never throws.
      void reportDailyLimitDefaults();
      console.log(`  MCP endpoint: http://${DEFAULT_HOST}:${DEFAULT_PORT}${MCP_PATH}`);
      console.log(`  Widget assets: http://${DEFAULT_HOST}:${DEFAULT_PORT}${WIDGET_PATH}/<name>.html`);
      resolve();
    });
  });

  console.log('Background maintenance is disabled in the API process; use npm run maintenance.');

  const close = async () => {
    console.log('\n🛑 Shutting down gracefully...');
    // Notices to the operator started without waiting (#699) are posted
    // before the process ends, for at most three seconds: Railway's teardown
    // is short, and the alert row in the database is what lasts.
    await Promise.race([settleOperatorNotices(), new Promise(resolve => setTimeout(resolve, 3000).unref())]);
    try {
      await closePool();
    } catch (error) {
      writeDiagnostic("error", "server.shutdown_failed", {
        errorClass: classifyDiagnosticError(error, "database_error")
      });
    }
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startHttpServer().catch((error) => {
    writeDiagnostic("error", "server.start_failed", {
      errorClass: classifyDiagnosticError(error, "configuration_error")
    });
    process.exit(1);
  });
}

/**
 * 403 with NO WWW-Authenticate header. The absent challenge is the point: it
 * distinguishes "authenticated fine, not permitted" from "authenticate
 * again", and only the latter should send a client back through Auth0.
 * The body carries BETA_ACCESS_MESSAGE, a fixed server-authored string that
 * no request data can reach.
 */
function writeBetaRefusal(res: http.ServerResponse): void {
  const body = {
    jsonrpc: "2.0",
    error: {
      code: -32003,
      message: BETA_ACCESS_MESSAGE
    },
    id: null
  };
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * What a 401 says, in the body and in the challenge's error_description: a
 * fixed sentence, never the error's own text (#730). A database fault in the
 * personal-token lookup carried the driver's message, and the token
 * validator's "revoked" or "expired" told a guesser that a token with that
 * suffix exists. A missing header and a scope the token lacks keep their own
 * words: the client acts on them, and they are this server's.
 */
export function publicAuthFailureMessage(error: unknown): string {
  if (error instanceof InsufficientScopeError) return error.message;
  if (error instanceof Error && error.message === "Missing Authorization header") return error.message;
  return "The access token is not valid. Sign in again, or make a new access token.";
}

/**
 * Why a token was refused, for the log alone, from a fixed set (#730): the
 * answer no longer says, so support reads it here. Never the error's text.
 */
export function authFailureLogFields(error: unknown, authorization: string | undefined): {
  authType: "none" | "pat" | "jwt";
  reason: "header" | "revoked" | "expired" | "not_found" | "format" | "other";
} {
  const header = authorization ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? "";
  const authType = !token ? "none" : token.startsWith("lirl_pat_") ? "pat" : "jwt";
  const text = (error instanceof Error ? error.message : "").toLowerCase();
  const reason = !token
    ? "header"
    : text.includes("revoked")
      ? "revoked"
      : text.includes("expired") || text.includes('"exp"')
        ? "expired"
        : text.includes("not found")
          ? "not_found"
          : text.includes("format") || text.includes("invalid compact") || text.includes("malformed")
            ? "format"
            : "other";
  return { authType, reason };
}

async function authenticateRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  publicBaseUrl = PUBLIC_BASE_URL
): Promise<AuthenticatedUser | null> {
  if (!REQUIRE_AUTH) {
    if (!req.headers.authorization) {
      return null;
    }
    try {
      return await validateAuthorizationHeader(req.headers.authorization);
    } catch (error) {
      // Even here, where authentication is optional, a beta refusal is a
      // refusal - not a downgrade to anonymous. Returning null would let the
      // request proceed unauthenticated.
      if (error instanceof BetaAccessDeniedError) {
        writeBetaRefusal(res);
        return null;
      }
      writeDiagnostic("warn", "auth.optional_validation_failed", {
        errorClass: classifyDiagnosticError(error, "authorization_error")
      });
      return null;
    }
  }

  try {
    return await validateAuthorizationHeader(req.headers.authorization);
  } catch (error) {
    // BEFORE the challenge is built. Every other failure here means "your
    // credentials are bad, authorize again", and the WWW-Authenticate header
    // is what tells an MCP client to do that. A refused beta account would
    // re-authorize successfully, be refused again, and loop forever - and the
    // raw error message would ride along in error_description.
    if (error instanceof BetaAccessDeniedError) {
      writeBetaRefusal(res);
      return null;
    }
    // Also before the challenge, for the same reason. The server cannot validate
    // any token (no issuer or JWKS URL, or more than one configured audience), so
    // authorizing again cannot help: 503, as the REST routes answer, with no
    // challenge and a line in the log (#179).
    if (error instanceof Error && error.message === OAUTH_NOT_CONFIGURED) {
      writeDiagnostic("error", "auth.validation_not_configured");
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Authentication is not configured on this server" },
        id: null
      }));
      return null;
    }
    writeDiagnostic("warn", "auth.mcp_rejected", authFailureLogFields(error, req.headers.authorization));
    const message = publicAuthFailureMessage(error);
    const challenge = buildWwwAuthenticateChallenge(message, publicBaseUrl);
    const body = {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message,
        data: {
          _meta: {
            "mcp/www_authenticate": [challenge]
          }
        }
      },
      id: null
    };
    res.writeHead(401, {
      "WWW-Authenticate": challenge,
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify(body));
    return null;
  }
}

// Exported for tests, alongside buildWwwAuthenticateChallenge and for the same
// reason. writeBetaRefusal on its own would only prove the response shape;
// authenticateRequest is what proves the beta branch is REACHED, before the
// challenge is built. A branch that works but sits below an earlier return is
// the failure mode #278 round 14 found in a test just like this one.
export { buildWwwAuthenticateChallenge, writeBetaRefusal, authenticateRequest };
