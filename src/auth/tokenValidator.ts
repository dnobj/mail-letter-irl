import {
  createRemoteJWKSet,
  jwtVerify,
  JWTVerifyGetKey,
  JWTVerifyOptions
} from "jose";
import {
  validateToken as validatePAT,
  updateLastUsed,
  TOKEN_PREFIX as PAT_PREFIX
} from "../services/patService.js";
import { getOAuthConfig } from "./oauthConfig.js";
import {
  classifyDiagnosticError,
  writeDiagnostic
} from "../utils/diagnosticLog.js";
import { InsufficientScopeError } from "./oauthChallenge.js";

export interface AuthenticatedUser {
  userId: string;
  claims: Record<string, unknown>;
  token: string;
  authType: "jwt" | "pat";
  scopes: string[];
}

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function getRemoteKeySet(jwksUri: string): JWTVerifyGetKey {
  const existing = remoteKeySets.get(jwksUri);
  if (existing) {
    return existing;
  }
  const created = createRemoteJWKSet(new URL(jwksUri));
  remoteKeySets.set(jwksUri, created);
  return created;
}

export function parseTokenScopes(claims: Record<string, unknown>): string[] {
  const raw = claims.scope ?? claims.scp;
  if (Array.isArray(raw)) {
    return raw.filter((scope): scope is string => typeof scope === "string");
  }
  if (typeof raw === "string") {
    return raw.split(/\s+/).filter(Boolean);
  }
  return [];
}

export function requireScopes(
  user: AuthenticatedUser,
  requiredScopes: readonly string[]
): void {
  if (user.authType === "pat") {
    return;
  }
  const missing = requiredScopes.filter((scope) => !user.scopes.includes(scope));
  if (missing.length > 0) {
    throw new InsufficientScopeError(missing);
  }
}

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
  if (token.startsWith(PAT_PREFIX)) {
    return validatePATToken(token);
  }
  return validateJWTToken(token);
}

async function validatePATToken(token: string): Promise<AuthenticatedUser> {
  const result = await validatePAT(token);
  if (!result.valid) {
    throw new Error(result.error || "Invalid token");
  }

  if (result.tokenId) {
    updateLastUsed(result.tokenId).catch((error) => {
      writeDiagnostic("error", "auth.pat_last_used_update_failed", {
        errorClass: classifyDiagnosticError(error, "pat_persistence_failed")
      });
    });
  }

  return {
    userId: result.userId!,
    claims: { authType: "pat", tokenId: result.tokenId },
    token,
    authType: "pat",
    scopes: []
  };
}

export async function validateJWTToken(
  token: string,
  keySet?: JWTVerifyGetKey,
  requiredScopes: readonly string[] = []
): Promise<AuthenticatedUser> {
  const config = getOAuthConfig();
  if (!config.issuer || !config.jwksUri || config.audience.length === 0) {
    throw new Error("OAuth validation not configured");
  }

  const options: JWTVerifyOptions = {
    issuer: config.issuer,
    audience: config.audience.length === 1 ? config.audience[0] : config.audience,
    algorithms: config.algorithms
  };

  try {
    const { payload } = await jwtVerify(
      token,
      keySet ?? getRemoteKeySet(config.jwksUri),
      options
    );
    const userId =
      typeof payload.sub === "string"
        ? payload.sub.trim()
        : typeof payload.user_id === "string"
          ? payload.user_id.trim()
          : "";
    if (!userId) {
      throw new Error("Token is missing a valid subject (sub)");
    }

    const user: AuthenticatedUser = {
      userId,
      claims: payload,
      token,
      authType: "jwt",
      scopes: parseTokenScopes(payload)
    };
    requireScopes(user, requiredScopes);
    return user;
  } catch (error) {
    writeDiagnostic("warn", "auth.jwt_rejected", {
      errorClass: classifyDiagnosticError(error, "auth_validation_failed")
    });
    throw error;
  }
}
