import { createRemoteJWKSet, jwtVerify, JWTPayload } from "jose";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";

const jwks = createRemoteJWKSet(new URL(config.auth0.jwksUri));

export interface AuthenticatedUser {
  userId: string;
  claims: JWTPayload;
}

export async function validateAuthorizationHeader(
  header: string | undefined
): Promise<AuthenticatedUser> {
  if (!header || !header.startsWith("Bearer ")) {
    throw new Error("Missing Authorization header");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    throw new Error("Bearer token empty");
  }

  const { payload } = await jwtVerify(token, jwks, {
    issuer: config.auth0.issuer,
    audience: config.auth0.audience
  });

  const subject = payload.sub;
  if (!subject) {
    throw new Error("Token missing subject");
  }

  return {
    userId: subject,
    claims: payload
  };
}

export function respondUnauthorized(res: ServerResponse, message: string) {
  const body = {
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message
    },
    id: null
  };
  res.writeHead(401, {
    "WWW-Authenticate": `Bearer realm="MCP Server", error="invalid_token", error_description="${message}"`,
    "Content-Type": "application/json"
  });
  res.end(JSON.stringify(body));
}

export async function authenticateRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<AuthenticatedUser | null> {
  try {
    const authInfo = await validateAuthorizationHeader(req.headers.authorization);
    (req as any).auth = authInfo;
    return authInfo;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid token";
    respondUnauthorized(res, message);
    return null;
  }
}
