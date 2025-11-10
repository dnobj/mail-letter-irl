import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LetterIrlServer } from "../server.js";
import { registerLetterTools } from "./registerTools.js";
import { getOpenIdConfiguration, getProtectedResourceMetadata } from "../auth/metadata.js";
import {
  AuthenticatedUser,
  validateAuthorizationHeader
} from "../auth/tokenValidator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_WIDGET_DIR = path.resolve(__dirname, "..", "..", "widgets");
const DEFAULT_HOST = process.env.LETTER_IRL_HTTP_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number(process.env.LETTER_IRL_HTTP_PORT ?? "8090");
const MCP_PATH = process.env.LETTER_IRL_MCP_PATH ?? "/mcp";
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
const AUTH0_REGISTRATION_ENDPOINT = process.env.LETTER_IRL_OAUTH_REGISTRATION_ENDPOINT;

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

export async function startHttpServer() {
  const letterServer = new LetterIrlServer();
  const mcpServer = new McpServer({
    name: "letter-irl",
    version: "0.1.0"
  });

  registerLetterTools(mcpServer, letterServer);

  const transport = new StreamableHTTPServerTransport({
    endpointPath: MCP_PATH,
    allowedHosts: getAllowedHosts(),
    allowedOrigins: getAllowedOrigins(),
    enableDnsRebindingProtection: true,
    enableJsonResponse: true
  });

  await mcpServer.connect(transport);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${DEFAULT_HOST}:${DEFAULT_PORT}`}`);

    if (url.pathname === "/healthz") {
      res.statusCode = 200;
      res.end("ok");
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

    if (url.pathname === MCP_PATH) {
      if (!req.headers.origin) {
        req.headers.origin = FALLBACK_ORIGIN;
      }

      const authInfo = await authenticateRequest(req, res);
      if (authInfo === null) {
        return;
      }
      if (authInfo) {
        (req as any).auth = authInfo;
      }

      console.log(
        `MCP request ${new Date().toISOString()} method=${req.method} host=${req.headers.host} origin=${req.headers.origin}`
      );

      try {
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error("MCP request failed", error);
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
      console.log(`  Widget assets: http://${DEFAULT_HOST}:${DEFAULT_PORT}${WIDGET_PATH}/<name>.html`);
      resolve();
    });
  });

  const close = () => {
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

async function handleRegistrationRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  if (!STATIC_CLIENT_ID) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "static_client_unavailable",
        error_description: "LETTER_IRL_OAUTH_CLIENT_ID not configured"
      })
    );
    return;
  }

  if (req.method !== "POST" && req.method !== "GET") {
    res.writeHead(405, { Allow: "POST, GET" });
    res.end();
    return;
  }

  const body = {
    client_id: STATIC_CLIENT_ID,
    client_secret: STATIC_CLIENT_SECRET,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: "client_secret_post",
    grant_types: ["authorization_code"],
    response_types: ["code"],
    redirect_uris: ["https://chat.openai.com/aip/auth/callback"],
    scope: process.env.LETTER_IRL_OAUTH_SCOPES ?? "openid email profile"
  };

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
