import { createRemoteJWKSet, jwtVerify, JWTVerifyOptions } from "jose";
import {
  validateToken as validatePAT,
  updateLastUsed,
  TOKEN_PREFIX as PAT_PREFIX,
} from "../services/patService.js";

export interface AuthenticatedUser {
  userId: string;
  claims: Record<string, unknown>;
  token: string;
  authType: 'jwt' | 'pat';
}

const issuer = process.env.LETTER_IRL_OAUTH_ISSUER;
const jwksUri = process.env.LETTER_IRL_OAUTH_JWKS_URI;
const audienceEnv = process.env.LETTER_IRL_OAUTH_AUDIENCE;

if (!issuer || !jwksUri) {
  console.warn(
    "LETTER_IRL_OAUTH_ISSUER or LETTER_IRL_OAUTH_JWKS_URI not set. OAuth validation is disabled."
  );
}

const jwks = jwksUri ? createRemoteJWKSet(new URL(jwksUri)) : undefined;
const audiences = audienceEnv?.split(",").map((val) => val.trim()).filter(Boolean);

/**
 * Validate Authorization header and return authenticated user
 *
 * Supports two authentication methods:
 * 1. JWT tokens from Auth0 (OAuth flow for ChatGPT)
 * 2. Personal Access Tokens (PAT) for MCP clients
 *
 * PAT tokens are detected by their prefix: "lirl_pat_"
 */
export async function validateAuthorizationHeader(
  authorizationHeader?: string
): Promise<AuthenticatedUser> {
  if (!authorizationHeader) {
    throw new Error("Missing Authorization header");
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new Error("Authorization header must be a Bearer token");
  }

  const token = match[1];

  // Detect PAT by prefix and route to PAT validation
  if (token.startsWith(PAT_PREFIX)) {
    return await validatePATToken(token);
  }

  // Default to JWT validation
  return await validateJWTToken(token);
}

/**
 * Validate a Personal Access Token (US-MCP-03)
 */
async function validatePATToken(token: string): Promise<AuthenticatedUser> {
  const result = await validatePAT(token);

  if (!result.valid) {
    throw new Error(result.error || "Invalid token");
  }

  // Update last_used_at asynchronously (don't block response)
  if (result.tokenId) {
    updateLastUsed(result.tokenId).catch((err) =>
      console.error("🔑 Failed to update PAT last_used_at:", err)
    );
  }

  return {
    userId: result.userId!,
    claims: { authType: "pat", tokenId: result.tokenId },
    token,
    authType: "pat",
  };
}

/**
 * Validate a JWT token via Auth0 JWKS
 */
async function validateJWTToken(token: string): Promise<AuthenticatedUser> {
  if (!issuer || !jwks) {
    throw new Error("OAuth validation not configured");
  }

  const options: JWTVerifyOptions = {
    issuer,
  };

  if (audiences && audiences.length > 0) {
    options.audience = audiences.length === 1 ? audiences[0] : audiences;
  }

  const { payload } = await jwtVerify(token, jwks, options);
  const userId = (payload.sub as string) ?? (payload.user_id as string);
  if (!userId) {
    throw new Error("Token is missing subject (sub)");
  }

  return {
    userId,
    claims: payload,
    token,
    authType: "jwt",
  };
}
