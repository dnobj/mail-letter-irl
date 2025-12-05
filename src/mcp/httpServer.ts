import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { LetterIrlServer } from "../server.js";
import { registerLetterTools } from "./registerTools.js";
import { getOpenIdConfiguration, getProtectedResourceMetadata } from "../auth/metadata.js";
import {
  AuthenticatedUser,
  validateAuthorizationHeader
} from "../auth/tokenValidator.js";
import { handleCreditApiRequest } from "../api/creditApiHandler.js";
import { handleAdminApiRequest } from "../api/adminApiHandler.js";
import { isAdminEnabled } from "../api/middleware/adminAuth.js";
import { handleLetterApiRequest } from "../api/letterApiHandler.js";
import { handleReturnAddressApiRequest } from "../api/returnAddressApiHandler.js";
import {
  handleCreateCheckoutSession,
  handleStripeWebhook
} from "../api/dashboardApiHandler.js";
import { validatePromoCodePublic } from "../services/promoService.js";
import { initializeJobQueue, stopJobQueue } from "../services/jobQueue.js";
import { startLetterWorker } from "../workers/letterWorker.js";
import { startCreditExpirationWorker } from "../workers/creditExpirationWorker.js";
import { startStatusSyncWorker, stopStatusSyncWorker } from "../workers/statusSyncWorker.js";
import { rateLimitMiddlewareWithTier } from "../api/middleware/rateLimit.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_WIDGET_DIR = path.resolve(__dirname, "..", "..", "widgets");
const DASHBOARD_DIR = path.resolve(__dirname, "..", "..", "public", "dashboard");
const DEFAULT_HOST = process.env.LETTER_IRL_HTTP_HOST ?? "0.0.0.0";
// Railway sets PORT env var; fall back to LETTER_IRL_HTTP_PORT for local dev
const DEFAULT_PORT = Number(process.env.PORT ?? process.env.LETTER_IRL_HTTP_PORT ?? "8090");
const MCP_PATH = process.env.LETTER_IRL_MCP_PATH ?? "/mcp";
const SSE_PATH = process.env.LETTER_IRL_SSE_PATH ?? "/mcp/sse";
const SSE_MESSAGES_PATH =
  process.env.LETTER_IRL_SSE_MESSAGES_PATH ?? "/mcp/sse/messages";
const WIDGET_PATH = process.env.LETTER_IRL_WIDGET_PATH ?? "/widgets";
const MANIFEST_ROUTE = process.env.LETTER_IRL_MANIFEST_ROUTE ?? "/manifest.json";
const MANIFEST_FILE_PATH =
  process.env.LETTER_IRL_MANIFEST_FILE ??
  path.resolve(__dirname, "..", "..", "manifest.json");
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

// Environment variable validation
const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'LETTER_IRL_OAUTH_JWKS_URI',
  'LETTER_IRL_OAUTH_ISSUER',
  'LETTER_IRL_OAUTH_AUDIENCE',
];

// Only require these in production (not for local admin mode)
const PRODUCTION_ENV_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
];

function validateEnvironment() {
  const missing: string[] = [];

  for (const envVar of REQUIRED_ENV_VARS) {
    if (!process.env[envVar]) {
      missing.push(envVar);
    }
  }

  // Check production vars unless ADMIN_ENABLED is true (local admin mode)
  if (process.env.ADMIN_ENABLED !== 'true') {
    for (const envVar of PRODUCTION_ENV_VARS) {
      if (!process.env[envVar]) {
        missing.push(envVar);
      }
    }
  }

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(v => console.error(`   - ${v}`));
    process.exit(1);
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

/**
 * Serve dashboard static files
 */
async function serveDashboardFile(
  requestPath: string,
  res: http.ServerResponse
): Promise<boolean> {
  try {
    // Remove /dashboard prefix
    const relativePath = requestPath.replace(/^\/dashboard\/?/, '');

    // Default to index.html for /dashboard and /dashboard/
    const filePath = relativePath === ''
      ? path.join(DASHBOARD_DIR, 'index.html')
      : path.join(DASHBOARD_DIR, relativePath);

    // Security check: ensure file is within DASHBOARD_DIR
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(DASHBOARD_DIR)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return true;
    }

    const file = await fs.readFile(resolvedPath);

    // Determine content type
    const ext = path.extname(resolvedPath).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    };

    res.statusCode = 200;
    res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
    res.end(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    console.error('Error serving dashboard file:', error);
    res.statusCode = 500;
    res.end('Internal Server Error');
    return true;
  }
}

async function createMcpServer(letterServer: LetterIrlServer, authInfo: AuthenticatedUser | null) {
  const mcpServer = new McpServer({
    name: "letter-irl",
    version: "0.1.0"
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

    const authInfo = await authenticateRequest(req, res);
    if (authInfo === null) {
      return;
    }

    const sessionServer = await createMcpServer(letterServer, authInfo);

    const sseTransport = new SSEServerTransport(SSE_MESSAGES_PATH, res, {
      allowedHosts,
      allowedOrigins,
      enableDnsRebindingProtection: true
    });

    const validationError = sseTransport.validateRequestHeaders(req);
    if (validationError) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: validationError
        })
      );
      return;
    }

    sseTransport.onclose = async () => {
      sseSessions.delete(sseTransport.sessionId);
      await sessionServer.close();
    };
    sseTransport.onerror = (error) => {
      console.error("SSE transport error", error);
    };

    try {
      await sessionServer.connect(sseTransport);
      sseSessions.set(sseTransport.sessionId, {
        server: sessionServer,
        transport: sseTransport,
        authInfo
      });
      console.log(
        `SSE session established id=${sseTransport.sessionId} user=${authInfo?.userId ?? "anonymous"}`
      );
    } catch (error) {
      console.error("Failed to start SSE session", error);
      try {
        await sessionServer.close();
      } catch (closeError) {
        console.warn("Failed to close SSE session server", closeError);
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
      console.error("Failed to process SSE message", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Failed to process message");
      }
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${DEFAULT_HOST}:${DEFAULT_PORT}`}`);

    if (url.pathname === "/healthz") {
      res.statusCode = 200;
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
        const file = await fs.readFile(MANIFEST_FILE_PATH, "utf-8");
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(file);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        res.statusCode = code === "ENOENT" ? 404 : 500;
        res.end(code === "ENOENT" ? "Manifest not found" : "Manifest read error");
      }
      return;
    }

    if (url.pathname === "/") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok", service: "letter-irl" }));
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

    // Dashboard routes
    if (url.pathname.startsWith("/dashboard")) {
      const served = await serveDashboardFile(url.pathname, res);
      if (!served) {
        res.statusCode = 404;
        res.end("Dashboard file not found");
      }
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
        console.error('Error parsing checkout request body:', error);
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
        console.error('Error parsing Stripe webhook body:', error);
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
        console.error('Error validating promo code:', error);
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

    // Handle CORS preflight for admin API routes
    if (url.pathname.startsWith('/api/admin/') && req.method === 'OPTIONS') {
      respondToCorsPreflight(res, resolveCorsOrigin(req.headers.origin));
      return;
    }

    if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png" || url.pathname === "/favicon.svg") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (matchesWellKnownRoute(url.pathname, OPENID_CONFIG_ROUTE)) {
      const payload = getOpenIdConfiguration(PUBLIC_BASE_URL);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
      return;
    }

    if (matchesWellKnownRoute(url.pathname, PROTECTED_RESOURCE_ROUTE)) {
      const payload = getProtectedResourceMetadata(PUBLIC_BASE_URL);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
      return;
    }

    if (matchesWellKnownRoute(url.pathname, AUTHORIZATION_SERVER_ROUTE)) {
      const payload = getOpenIdConfiguration(PUBLIC_BASE_URL);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
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

      const authInfo = await authenticateRequest(req, res);
      if (authInfo === null) {
        return;
      }

      console.log(
        `MCP request ${new Date().toISOString()} method=${req.method} host=${req.headers.host} origin=${req.headers.origin} user=${authInfo?.userId ?? "anonymous"}`
      );

      // Create transport first (passes res directly to constructor)
      const sessionTransport = new StreamableHTTPServerTransport(res, {
        allowedHosts,
        allowedOrigins,
        enableDnsRebindingProtection: true
      });

      // Create per-session MCP server with auth context
      const sessionServer = await createMcpServer(letterServer, authInfo);

      // Clean up when response closes
      res.on('close', async () => {
        console.log(`Streamable HTTP connection closed, session=${sessionTransport.sessionId}`);
        await sessionServer.close();
      });

      try {
        // Connect the MCP server to the transport
        console.log('Connecting MCP server to Streamable HTTP transport...');
        await sessionServer.connect(sessionTransport);
        console.log(`MCP server connected, session=${sessionTransport.sessionId}`);

        // For Streamable HTTP POST, parse body and handle request with timeout
        const body = await parseRequestBody(req);

        console.log(`Received POST body: ${body.substring(0, 200)}`);
        const parsedBody = body ? JSON.parse(body) : undefined;
        console.log(`Parsed request: method=${parsedBody?.method || 'unknown'}`);

        await sessionTransport.handleRequest(req, res, parsedBody);
        console.log(`Request handled successfully`);
      } catch (error) {
        console.error("MCP request failed", error);
        console.error("Error stack:", error instanceof Error ? error.stack : 'no stack');
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

  // Initialize job queue and start workers (unless DISABLE_WORKERS is set)
  if (process.env.DISABLE_WORKERS === 'true') {
    console.log('');
    console.log('⚠️  Workers disabled (DISABLE_WORKERS=true)');
    console.log('   Admin-only mode - no job processing');
    console.log('');
  } else {
    try {
      console.log('');
      await initializeJobQueue();
      await startLetterWorker();
      await startCreditExpirationWorker();
      await startStatusSyncWorker();
      console.log('');
    } catch (error) {
      console.error('❌ Failed to initialize job queue:', error);
      console.error('⚠️  Server will continue without background job processing');
    }
  }

  const close = async () => {
    console.log('\n🛑 Shutting down gracefully...');
    try {
      stopStatusSyncWorker();
      await stopJobQueue();
    } catch (error) {
      console.error('Error stopping workers:', error);
    }
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startHttpServer().catch((error) => {
    console.error("Failed to start HTTP MCP server", error);
    process.exit(1);
  });
}

async function authenticateRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<AuthenticatedUser | null> {
  if (!REQUIRE_AUTH) {
    if (!req.headers.authorization) {
      return null;
    }
    try {
      return await validateAuthorizationHeader(req.headers.authorization);
    } catch (error) {
      console.warn("Optional auth validation failed", error);
      return null;
    }
  }

  try {
    return await validateAuthorizationHeader(req.headers.authorization);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const body = {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message
      },
      id: null
    };
    res.writeHead(401, {
      "WWW-Authenticate": `Bearer realm="Letter IRL", error="invalid_token", error_description="${message}"`,
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify(body));
    return null;
  }
}
