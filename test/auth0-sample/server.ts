import http from "node:http";

type Body = string | undefined;

const PORT = Number(process.env.SAMPLE_PORT ?? "8092");
const HOST = process.env.SAMPLE_HOST ?? "0.0.0.0";
const BASE = process.env.SAMPLE_PUBLIC_BASE ?? `http://${HOST}:${PORT}`;
const ISSUER = process.env.SAMPLE_ISSUER ?? "https://dev-ky21dxn3qmi71hjl.us.auth0.com/";
const AUTH = process.env.SAMPLE_AUTH ?? `${ISSUER}authorize`;
const TOKEN = process.env.SAMPLE_TOKEN ?? `${ISSUER}oauth/token`;
const JWKS = process.env.SAMPLE_JWKS ?? `${ISSUER}.well-known/jwks.json`;
const REGISTRATION = process.env.SAMPLE_REGISTRATION ?? `${ISSUER}oauth/register`;

const manifest = JSON.stringify({
  name: "Sample Auth0 MCP",
  version: "0.1.0",
  description: "Baseline sample to compare with OpenAI examples",
  tools: [
    {
      name: "sample_tool",
      description: "Returns a message",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" }
        }
      }
    }
  ]
});

const openidConfig = JSON.stringify({
  issuer: ISSUER,
  authorization_endpoint: AUTH,
  token_endpoint: TOKEN,
  jwks_uri: JWKS,
  registration_endpoint: REGISTRATION,
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
  issuer: ISSUER,
  jwks_uri: JWKS,
  resource_documentation: `${BASE}/manifest.json`
});

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  const send = (body?: Body, status = 200) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(body ?? "{}");
  };

  if (url === "/" || url === "/healthz") {
    send(JSON.stringify({ status: "ok" }));
    return;
  }

  if (url === "/manifest.json" || url === "/manifest") {
    send(manifest);
    return;
  }

  if (url.startsWith("/.well-known/openid-configuration")) {
    send(openidConfig);
    return;
  }

  if (url.startsWith("/.well-known/oauth-authorization-server")) {
    send(openidConfig);
    return;
  }

  if (url.startsWith("/.well-known/oauth-protected-resource")) {
    send(protectedResource);
    return;
  }

  if (url === "/favicon.ico" || url === "/favicon.png" || url === "/favicon.svg") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (url === "/mcp") {
    send(JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Auth disabled in sample" },
      id: null
    }));
    return;
  }

  send(JSON.stringify({ error: "not-found" }), 404);
});

server.listen(PORT, HOST, () => {
  console.log(`Sample Auth0 MCP listening on http://${HOST}:${PORT}`);
});
