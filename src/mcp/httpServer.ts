import dotenv from "dotenv";
// Load .env but don't override existing env vars (allows .env.local via dotenv-cli)
dotenv.config({ override: false });
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { LetterIrlServer } from "../server.js";
import { registerLetterTools } from "./registerTools.js";
import { LETTER_IRL_SERVER_INSTRUCTIONS } from "./serverInstructions.js";
import { getOpenIdConfiguration, getProtectedResourceMetadata } from "../auth/metadata.js";
import { stringifyManifest } from "./manifest.js";
import {
  AuthenticatedUser,
  validateAuthorizationHeader
} from "../auth/tokenValidator.js";
import { handleCreditApiRequest } from "../api/creditApiHandler.js";
import { handlePATApiRequest } from "../api/patApiHandler.js";
import { handleAdminApiRequest } from "../api/adminApiHandler.js";
import { isAdminEnabled } from "../api/middleware/adminAuth.js";
import { handleLetterApiRequest } from "../api/letterApiHandler.js";
import { handleReturnAddressApiRequest } from "../api/returnAddressApiHandler.js";
import { handleTempImageRequest } from "../api/tempImageHandler.js";
import {
  handleCreateCheckoutSession,
  handleStripeWebhook
} from "../api/dashboardApiHandler.js";
import { validatePromoCodePublic } from "../services/promoService.js";
import { closePool } from "../db/index.js";
import { rateLimitMiddlewareWithTier, rateLimitMiddlewareWithGlobal } from "../api/middleware/rateLimit.js";
import { isDebugEnabled } from "../utils/debug.js";
import {
  assertValidOAuthConfig,
  getOAuthConfig,
  isCimdEnforcementEnabled
} from "../auth/oauthConfig.js";
import { classifyOAuthRoute } from "../auth/oauthRoutes.js";
import {
  classifyDiagnosticError,
  writeDiagnostic
} from "../utils/diagnosticLog.js";
import { buildWwwAuthenticateChallenge } from "../auth/oauthChallenge.js";
import {
  findCoupledFeatureFlagWarnings,
  validatePublicServerAdminConfiguration
} from "../admin/config.js";
import { assertValidDeploymentConfig } from "../config/deploymentConfig.js";
import { denyLegacyPublicAdminRoute } from "./legacyAdminRoutes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_WIDGET_DIR = path.resolve(__dirname, "..", "..", "widgets");
const DEFAULT_HOST = process.env.LETTER_IRL_HTTP_HOST ?? "0.0.0.0";
// Railway sets PORT env var; fall back to LETTER_IRL_HTTP_PORT for local dev
const DEFAULT_PORT = Number(process.env.PORT ?? process.env.LETTER_IRL_HTTP_PORT ?? "8090");
const MCP_PATH = process.env.LETTER_IRL_MCP_PATH ?? "/mcp";
const SSE_PATH = process.env.LETTER_IRL_SSE_PATH ?? "/mcp/sse";
const SSE_MESSAGES_PATH =
  process.env.LETTER_IRL_SSE_MESSAGES_PATH ?? "/mcp/sse/messages";
const WIDGET_PATH = process.env.LETTER_IRL_WIDGET_PATH ?? "/widgets";
const MANIFEST_ROUTE = process.env.LETTER_IRL_MANIFEST_ROUTE ?? "/manifest.json";
const OPENID_CONFIG_ROUTE =
  process.env.LETTER_IRL_OPENID_ROUTE ?? "/.well-known/openid-configuration";
const PROTECTED_RESOURCE_ROUTE =
  process.env.LETTER_IRL_PROTECTED_RESOURCE_ROUTE ??
  "/.well-known/oauth-protected-resource";
const AUTHORIZATION_SERVER_ROUTE =
  process.env.LETTER_IRL_AUTH_SERVER_ROUTE ?? "/.well-known/oauth-authorization-server";
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

export function validateEnvironment() {
  validatePublicServerAdminConfiguration(process.env);

  // Warn, never throw. The operator recovery routes these flags depend on are
  // denied by the legacy admin guard, but failing startup on a flag combination
  // would boot-loop a running deployment.
  for (const flag of findCoupledFeatureFlagWarnings(process.env)) {
    console.warn(
      `[admin] ${flag}=true while public /api/admin* routes are denied; issue #69 operator recovery is unreachable. See docs/deployment.md#operator-recovery-interaction`
    );
  }

  // Fail closed on invalid deployment configuration (issue #155). Throws with
  // every problem named at once; the entrypoint's catch turns that into a
  // non-zero exit, so a misconfigured deploy never serves traffic. Warnings
  // are printed except under test, where the pinned boot-validation contract
  // counts warn lines exactly (tests/unit/mcp/legacyAdminRoutes.test.ts).
  const deployment = assertValidDeploymentConfig(process.env, 'server');
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

type SseSession = {
  server: McpServer;
  transport: SSEServerTransport;
  authInfo: AuthenticatedUser | null;
};

/**
 * Parse request body with timeout and error handling
 */
function parseRequestBody(req: http.IncomingMessage, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    const timeout = setTimeout(() => {
      reject(new Error('Request body timeout'));
    }, timeoutMs);

    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => { clearTimeout(timeout); resolve(body); });
    req.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
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

function matchesWellKnownRoute(pathname: string, baseRoute: string) {
  return pathname === baseRoute || pathname === `${baseRoute}${MCP_PATH}`;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim();
}

export function getPublicBaseUrl(req: Pick<http.IncomingMessage, "headers">): string {
  const host = firstHeaderValue(req.headers["x-forwarded-host"]) ?? firstHeaderValue(req.headers.host);
  if (!host) {
    return PUBLIC_BASE_URL;
  }

  const proto =
    firstHeaderValue(req.headers["x-forwarded-proto"]) ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");

  return `${proto}://${host}`;
}

async function serveWidget(
  widgetName: string,
  res: http.ServerResponse
): Promise<boolean> {
  const safeName = path.basename(widgetName);
  const filePath = path.join(DEFAULT_WIDGET_DIR, safeName);
  try {
    const file = await fs.readFile(filePath, "utf-8");
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
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

async function createMcpServer(letterServer: LetterIrlServer, authInfo: AuthenticatedUser | null) {
  const mcpServer = new McpServer({
    name: "letter-irl",
    version: "0.1.0"
  }, {
    instructions: LETTER_IRL_SERVER_INSTRUCTIONS
  });
  await registerLetterTools(mcpServer, letterServer, authInfo);
  return mcpServer;
}

export async function startHttpServer() {
  // Validate environment variables before starting server
  validateEnvironment();

  const letterServer = new LetterIrlServer();
  const sseSessions = new Map<string, SseSession>();
  const allowedHosts = getAllowedHosts();
  const allowedOrigins = getAllowedOrigins();

  const resolveCorsOrigin = (incoming?: string | string[]) => {
    if (Array.isArray(incoming)) {
      incoming = incoming[0];
    }
    if (!incoming) {
      return FALLBACK_ORIGIN;
    }
    // Allow "null" origin for file:// protocol (admin panel opened as local file)
    if (incoming === "null") {
      return "*";
    }
    return allowedOrigins.includes(incoming) ? incoming : FALLBACK_ORIGIN;
  };

  const respondToCorsPreflight = (
    res: http.ServerResponse,
    origin: string
  ) => {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, DELETE, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id"
    });
    res.end();
  };

  const handleSseStreamRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => {
    const origin = resolveCorsOrigin(req.headers.origin);
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    const acceptHeader = req.headers.accept ?? "";
    if (!acceptHeader.includes("text/event-stream")) {
      res.writeHead(406, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Not Acceptable: Client must accept text/event-stream"
        })
      );
      return;
    }

    const authInfo = await authenticateRequest(req, res, getPublicBaseUrl(req));
    if (authInfo === null) {
      return;
    }

    const sessionServer = await createMcpServer(letterServer, authInfo);

    const sseTransport = new SSEServerTransport(SSE_MESSAGES_PATH, res, {
      allowedHosts,
      allowedOrigins,
      enableDnsRebindingProtection: true
    });

    sseTransport.onclose = async () => {
      sseSessions.delete(sseTransport.sessionId);
      await sessionServer.close();
    };
    sseTransport.onerror = (error) => {
      writeDiagnostic("error", "mcp.sse_transport_error", {
        errorClass: classifyDiagnosticError(error, "transport_error")
      });
    };

    try {
      await sessionServer.connect(sseTransport);
      sseSessions.set(sseTransport.sessionId, {
        server: sessionServer,
        transport: sseTransport,
        authInfo
      });
      writeDiagnostic("info", "mcp.sse_session_established", {
        authType: authInfo?.authType ?? "disabled"
      });
    } catch (error) {
      writeDiagnostic("error", "mcp.sse_session_start_failed", {
        errorClass: classifyDiagnosticError(error, "transport_error")
      });
      try {
        await sessionServer.close();
      } catch (closeError) {
        writeDiagnostic("warn", "mcp.sse_session_close_failed", {
          errorClass: classifyDiagnosticError(closeError, "transport_error")
        });
      }
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to establish SSE connection" }));
      }
    }
  };

  const handleSsePostRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ) => {
    const origin = resolveCorsOrigin(req.headers.origin);
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader(
      "Access-Control-Allow-Headers",
      "authorization, content-type, mcp-session-id"
    );

    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      res.writeHead(400).end("Missing sessionId query parameter");
      return;
    }

    const session = sseSessions.get(sessionId);
    if (!session) {
      res.writeHead(404).end("Unknown session");
      return;
    }

    (req as any).auth = session.authInfo ?? undefined;

    try {
      await session.transport.handlePostMessage(req, res);
    } catch (error) {
      writeDiagnostic("error", "mcp.sse_message_failed", {
        errorClass: classifyDiagnosticError(error, "transport_error")
      });
      if (!res.headersSent) {
        res.writeHead(500).end("Failed to process message");
      }
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${DEFAULT_HOST}:${DEFAULT_PORT}`}`);

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

    if (
      req.method === "OPTIONS" &&
      (url.pathname === SSE_PATH || url.pathname === SSE_MESSAGES_PATH)
    ) {
      respondToCorsPreflight(res, resolveCorsOrigin(req.headers.origin));
      return;
    }

    if (req.method === "GET" && url.pathname === SSE_PATH) {
      // Rate limit SSE connection attempts
      if (await rateLimitMiddlewareWithTier(req, res, 'mcp')) {
        return; // Rate limited
      }
      await handleSseStreamRequest(req, res);
      return;
    }

    if (url.pathname === SSE_MESSAGES_PATH) {
      if (req.method === "POST") {
        await handleSsePostRequest(req, res, url);
        return;
      }
      res.writeHead(405, { Allow: "POST, OPTIONS" });
      res.end();
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
        const body = await parseRequestBody(req);
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

    // Serve admin panel (requires ADMIN_ENABLED=true, localhost only)
    if (url.pathname === "/admin" || url.pathname === "/admin.html" || url.pathname === "/admin-panel.html") {
      // Check if admin is enabled (disabled by default)
      if (!isAdminEnabled()) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      // Restrict to localhost only - block ngrok and other proxies
      const remoteAddress = req.socket.remoteAddress;
      const isLocalhost = remoteAddress === '127.0.0.1' ||
                          remoteAddress === '::1' ||
                          remoteAddress === '::ffff:127.0.0.1';

      // Also block if coming through ngrok or other proxies
      const isProxied = req.headers['x-forwarded-for'] ||
                        req.headers['x-real-ip'] ||
                        req.headers['ngrok-agent-ips'];

      if (!isLocalhost || isProxied) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const fs = await import("fs/promises");
      const path = await import("path");
      const filePath = path.join(process.cwd(), "admin-panel.html");
      try {
        const content = await fs.readFile(filePath, "utf-8");
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html");
        res.end(content);
      } catch (err: any) {
        res.statusCode = 404;
        res.end("Admin panel not found");
      }
      return;
    }

    // Server-controlled Stripe return page. It intentionally shows no order
    // details; authenticated status is available only through get_purchase_status.
    if (url.pathname === '/purchase/return' && req.method === 'GET') {
      const cancelled = url.searchParams.get('outcome') === 'cancelled';
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Letter IRL</title></head><body style="font-family:system-ui;max-width:36rem;margin:4rem auto;padding:1rem"><h1>${cancelled ? 'Checkout cancelled' : 'Payment received'}</h1><p>${cancelled ? 'Your draft was not sent. Return to ChatGPT to retry or choose a letter pack.' : 'Return to ChatGPT. Letter IRL will update the purchase status as soon as Stripe confirms payment.'}</p></body></html>`
      );
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
        const body = await parseRequestBody(req);
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
        const body = await parseRequestBody(req);
        (req as any).body = body; // Raw string for Stripe signature verification
        await handleStripeWebhook(req as any, res as any);
      } catch (error) {
        console.error('Error parsing Stripe webhook body');
        res.statusCode = 408;
        res.end('Request timeout or error');
      }
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

    // Handle CORS preflight for public promo endpoint
    if (url.pathname.startsWith('/api/public/promo/') && req.method === 'OPTIONS') {
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
        grant_types: ["authorization_code", "refresh_token"],
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

    // Admin API routes (check first - more specific path)
    if (url.pathname.startsWith('/api/admin')) {
      if (await rateLimitMiddlewareWithTier(req, res, 'admin')) {
        return; // Rate limited
      }
    }
    const adminApiHandled = await handleAdminApiRequest(req, res, url.pathname);
    if (adminApiHandled) {
      return;
    }

    // Credit API routes
    if (url.pathname.startsWith('/api/credits')) {
      if (await rateLimitMiddlewareWithTier(req, res, 'api')) {
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

    if (url.pathname === MCP_PATH) {
      // Rate limit MCP tool calls
      if (await rateLimitMiddlewareWithTier(req, res, 'mcp')) {
        return; // Rate limited
      }

      if (!req.headers.origin) {
        req.headers.origin = FALLBACK_ORIGIN;
      }

      const authInfo = await authenticateRequest(req, res, getPublicBaseUrl(req));
      if (authInfo === null) {
        return;
      }

      writeDiagnostic("info", "mcp.request_received", {
        method: req.method ?? "unknown",
        authType: authInfo?.authType ?? "disabled"
      });

      const sessionTransport = new StreamableHTTPServerTransport({
        allowedHosts,
        allowedOrigins,
        enableDnsRebindingProtection: true
      });

      // Create per-session MCP server with auth context
      const sessionServer = await createMcpServer(letterServer, authInfo);

      // Clean up when response closes
      res.on('close', async () => {
        writeDiagnostic("info", "mcp.connection_closed");
        await sessionServer.close();
      });

      try {
        // Connect the MCP server to the transport
        console.log('Connecting MCP server to Streamable HTTP transport...');
        await sessionServer.connect(sessionTransport);
        writeDiagnostic("info", "mcp.server_connected");

        // For Streamable HTTP POST, parse body and handle request with timeout
        const body = await parseRequestBody(req);

        const parsedBody = body ? JSON.parse(body) : undefined;
        writeDiagnostic("info", "mcp.request_parsed");

        await sessionTransport.handleRequest(req, res, parsedBody);
        console.log(`Request handled successfully`);
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
  });

  await new Promise<void>((resolve) => {
    server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
      console.log(`Letter IRL MCP HTTP server listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
      console.log(`  MCP endpoint: http://${DEFAULT_HOST}:${DEFAULT_PORT}${MCP_PATH}`);
      console.log(`  SSE stream: http://${DEFAULT_HOST}:${DEFAULT_PORT}${SSE_PATH}`);
      console.log(
        `  SSE messages: http://${DEFAULT_HOST}:${DEFAULT_PORT}${SSE_MESSAGES_PATH}?sessionId=...`
      );
      console.log(`  Widget assets: http://${DEFAULT_HOST}:${DEFAULT_PORT}${WIDGET_PATH}/<name>.html`);
      resolve();
    });
  });

  console.log('Background maintenance is disabled in the API process; use npm run maintenance.');

  const close = async () => {
    console.log('\n🛑 Shutting down gracefully...');
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
      writeDiagnostic("warn", "auth.optional_validation_failed", {
        errorClass: classifyDiagnosticError(error, "authorization_error")
      });
      return null;
    }
  }

  try {
    return await validateAuthorizationHeader(req.headers.authorization);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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

export { buildWwwAuthenticateChallenge };
