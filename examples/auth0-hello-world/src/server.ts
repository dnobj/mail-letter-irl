import http from "node:http";
import { URL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { config } from "./config.js";
import { authenticateRequest, AuthenticatedUser } from "./auth.js";

const MANIFEST_PATH = "/manifest.json";
const HEALTH_PATH = "/healthz";
const AUTHORIZATION_METADATA_PATH = "/.well-known/oauth-authorization-server";
const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

type SessionRecord = {
  server: McpServer;
  transport: SSEServerTransport;
  authInfo: AuthenticatedUser;
};

const sessions = new Map<string, SessionRecord>();

function createHelloWorldServer() {
  const server = new McpServer({
    name: "auth0-hello-world",
    version: "0.1.0"
  });

  server.tool(
    "hello_world",
    {
      name: {
        type: "string",
        description: "Optional name to greet"
      }
    },
    async (args: { name?: string } | undefined, extra) => {
      const auth = (extra?.authInfo as AuthenticatedUser | undefined) ?? null;
      const greetName = typeof args?.name === "string" && args.name.length > 0 ? args.name : "friend";
      const userLine = auth ? ` Authenticated as ${auth.userId}.` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `Hello, ${greetName}!${userLine}`
          }
        ]
      };
    }
  );

  return server;
}

function sendJson(res: http.ServerResponse, payload: unknown) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload, null, 2));
}

function manifestPayload() {
  const base = config.baseUrl.replace(/\/$/, "");
  const stream = `${base}${config.ssePath}`;
  const messages = `${base}${config.sseMessagesPath}`;
  return {
    name: "Auth0 Hello World",
    version: "0.1.0",
    description: "Minimal MCP server secured with Auth0 OAuth",
    contactEmail: "dev@example.com",
    tools: [
      {
        name: "hello_world",
        description: "Greet the authenticated user or a provided name.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" }
          }
        }
      }
    ],
    servers: [
      {
        type: "mcp",
        name: "auth0-hello-world-sse",
        url: stream,
        healthUrl: `${base}${HEALTH_PATH}`,
        transport: {
          type: "sse",
          stream,
          messages
        },
        auth: {
          type: "oauth",
          scopes: config.auth0.scopes,
          authorizationServer: `${base}${AUTHORIZATION_METADATA_PATH}`
        }
      }
    ]
  };
}

function authorizationMetadata() {
  return {
    issuer: config.auth0.issuer,
    authorization_endpoint: config.auth0.authorizationEndpoint,
    token_endpoint: config.auth0.tokenEndpoint,
    jwks_uri: config.auth0.jwksUri,
    registration_endpoint: config.auth0.registrationEndpoint || undefined,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: config.auth0.scopes,
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    redirect_uris_supported: ["https://chat.openai.com/aip/auth/callback"],
    claims_supported: ["aud", "exp", "iat", "iss", "sub", "email", "email_verified"],
    service_documentation: `${config.baseUrl}${MANIFEST_PATH}`
  };
}

function protectedResourceMetadata() {
  return {
    issuer: config.auth0.issuer,
    jwks_uri: config.auth0.jwksUri,
    resource_documentation: `${config.baseUrl}${MANIFEST_PATH}`
  };
}

async function handleSseStream(req: http.IncomingMessage, res: http.ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

  if (!(req.headers.accept ?? "").includes("text/event-stream")) {
    res.writeHead(406, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Client must accept text/event-stream" }));
    return;
  }

  const authInfo = await authenticateRequest(req, res);
  if (!authInfo) {
    return;
  }

  const sessionServer = createHelloWorldServer();
  const transport = new SSEServerTransport(config.sseMessagesPath, res, {
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
    enableDnsRebindingProtection: true
  });

  transport.onclose = async () => {
    sessions.delete(transport.sessionId);
    await sessionServer.close();
  };

  try {
    await sessionServer.connect(transport);
    sessions.set(transport.sessionId, {
      server: sessionServer,
      transport,
      authInfo
    });
    console.log(`SSE session established for ${authInfo.userId}`);
  } catch (error) {
    console.error("Failed to establish SSE session", error);
    if (!res.headersSent) {
      res.writeHead(500).end("Failed to start SSE session");
    }
  }
}

async function handleSseMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader(
    "Access-Control-Allow-Headers",
    "authorization, content-type, mcp-session-id"
  );

  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    res.writeHead(400).end("Missing sessionId");
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    res.writeHead(404).end("Unknown session");
    return;
  }

  (req as any).auth = session.authInfo;

  try {
    await session.transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("Failed to handle SSE message", error);
    if (!res.headersSent) {
      res.writeHead(500).end("Failed to process message");
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && (url.pathname === config.ssePath || url.pathname === config.sseMessagesPath)) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": req.headers.origin || "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id"
    });
    res.end();
    return;
  }

  if (url.pathname === HEALTH_PATH) {
    res.statusCode = 200;
    res.end("ok");
    return;
  }

  if (url.pathname === MANIFEST_PATH) {
    return sendJson(res, manifestPayload());
  }

  if (url.pathname === "/") {
    return sendJson(res, { status: "ok", service: "auth0-hello-world" });
  }

  if (url.pathname === AUTHORIZATION_METADATA_PATH) {
    return sendJson(res, authorizationMetadata());
  }

  if (url.pathname === PROTECTED_RESOURCE_PATH) {
    return sendJson(res, protectedResourceMetadata());
  }

  if (req.method === "GET" && url.pathname === config.ssePath) {
    return handleSseStream(req, res);
  }

  if (req.method === "POST" && url.pathname === config.sseMessagesPath) {
    return handleSseMessage(req, res, url);
  }

  res.statusCode = 404;
  res.end("Not found");
});

server.listen(config.port, config.host, () => {
  console.log(`Auth0 Hello World MCP server listening on http://${config.host}:${config.port}`);
  console.log(`  Manifest: ${config.baseUrl}${MANIFEST_PATH}`);
  console.log(`  SSE stream: ${config.baseUrl}${config.ssePath}`);
  console.log(`  SSE messages: ${config.baseUrl}${config.sseMessagesPath}?sessionId=...`);
});
