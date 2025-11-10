import http from "node:http";

const PORT = Number(process.env.MINIMAL_MCP_PORT ?? "8090");
const HOST = process.env.MINIMAL_MCP_HOST ?? "0.0.0.0";
const BASE = process.env.MINIMAL_PUBLIC_BASE ?? `http://${HOST}:${PORT}`;

const issuer = process.env.MINIMAL_OAUTH_ISSUER ?? "https://example.com/";
const authEndpoint = process.env.MINIMAL_OAUTH_AUTH ?? `${issuer}authorize`;
const tokenEndpoint = process.env.MINIMAL_OAUTH_TOKEN ?? `${issuer}oauth/token`;
const jwks = process.env.MINIMAL_OAUTH_JWKS ?? `${issuer}.well-known/jwks.json`;
const registrationEndpoint =
  process.env.MINIMAL_OAUTH_REGISTRATION ?? `${issuer}oauth/register`;

const openidConfig = JSON.stringify({
  issuer,
  authorization_endpoint: authEndpoint,
  token_endpoint: tokenEndpoint,
  jwks_uri: jwks,
  registration_endpoint: registrationEndpoint,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["openid", "email", "profile"],
  token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
  redirect_uris_supported: ["https://chat.openai.com/aip/auth/callback"],
  claims_supported: ["sub", "email"],
  service_documentation: `${BASE}/manifest.json`
});

const protectedResource = JSON.stringify({
  issuer,
  jwks_uri: jwks,
  resource_documentation: `${BASE}/manifest.json`
});

const manifest = JSON.stringify({
  name: "Minimal MCP",
  version: "0.0.1",
  description: "Test server to debug OAuth/discovery",
  tools: [
    {
      name: "ping",
      description: "Dummy tool used to verify manifest shape",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" }
        }
      }
    }
  ]
});

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  const respond = (body: string) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(body);
  };

  if (url === "/manifest.json") {
    respond(manifest);
    return;
  }

  if (url === "/") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", version: "minimal" }));
    return;
  }

  if (url === "/favicon.ico" || url === "/favicon.png" || url === "/favicon.svg") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (url.startsWith("/.well-known/openid-configuration")) {
    respond(openidConfig);
    return;
  }

  if (url.startsWith("/.well-known/oauth-authorization-server")) {
    respond(openidConfig);
    return;
  }

  if (url.startsWith("/.well-known/oauth-protected-resource")) {
    respond(protectedResource);
    return;
  }

  if (url === "/mcp") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Auth disabled in minimal server" },
        id: null
      })
    );
    return;
  }

  res.statusCode = 404;
  res.end("Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`Minimal MCP listening on http://${HOST}:${PORT}`);
});
