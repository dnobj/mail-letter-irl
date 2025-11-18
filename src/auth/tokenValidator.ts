import { createRemoteJWKSet, jwtVerify, JWTVerifyOptions } from "jose";

export interface AuthenticatedUser {
  userId: string;
  claims: Record<string, unknown>;
  token: string;
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

export async function validateAuthorizationHeader(
  authorizationHeader?: string
): Promise<AuthenticatedUser> {
  if (!issuer || !jwks) {
    throw new Error("OAuth validation not configured");
  }

  if (!authorizationHeader) {
    throw new Error("Missing Authorization header");
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new Error("Authorization header must be a Bearer token");
  }

  const token = match[1];

  // TEMPORARY: Log JWT for admin API testing
  console.log('\n🔐 ========================================');
  console.log('🔐 JWT TOKEN (for admin API testing):');
  console.log('🔐', token);
  console.log('🔐 ========================================\n');

  const options: JWTVerifyOptions = {
    issuer
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
    token
  };
}
