import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

const numberFromEnv = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const listFromEnv = (name: string, fallback: string[]): string[] => {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

export const config = {
  host: process.env.SERVER_HOST ?? "0.0.0.0",
  port: numberFromEnv("SERVER_PORT", 8733),
  baseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:8733",
  ssePath: process.env.MCP_SSE_PATH ?? "/mcp/sse",
  sseMessagesPath: process.env.MCP_SSE_MESSAGES_PATH ?? "/mcp/sse/messages",
  allowedOrigins: listFromEnv("ALLOWED_ORIGINS", [
    "https://chat.openai.com",
    "https://chatgpt.com",
    "http://localhost:4173"
  ]),
  allowedHosts: listFromEnv("ALLOWED_HOSTS", [
    "localhost:8733",
    "localhost",
    "127.0.0.1"
  ]),
  auth0: {
    issuer: requireEnv("AUTH0_ISSUER"),
    authorizationEndpoint: requireEnv("AUTH0_AUTHORIZATION_ENDPOINT"),
    tokenEndpoint: requireEnv("AUTH0_TOKEN_ENDPOINT"),
    jwksUri: requireEnv("AUTH0_JWKS_URI"),
    registrationEndpoint: process.env.AUTH0_REGISTRATION_ENDPOINT ?? "",
    audience: requireEnv("AUTH0_AUDIENCE"),
    scopes: listFromEnv("AUTH0_SCOPES", ["openid", "email", "profile"])
  }
};
