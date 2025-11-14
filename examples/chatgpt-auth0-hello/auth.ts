/**
 * Auth0 OAuth token validation with comprehensive logging
 */

import http from 'node:http';
import * as jose from 'jose';
import { logger } from './logger.js';
import type { ServerConfig } from './config.js';

export interface AuthenticatedUser {
  userId: string;
  email?: string;
  claims: Record<string, any>;
  token: string;
}

export async function authenticateRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ServerConfig,
  requestId: string
): Promise<AuthenticatedUser | null> {
  logger.debug('auth', 'Starting authentication', {
    hasAuthHeader: !!req.headers.authorization,
    authHeaderPreview: req.headers.authorization?.substring(0, 20) + '...'
  }, requestId);

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    logger.warn('auth', 'No Authorization header present', undefined, requestId);
    send401Challenge(res, config, 'Missing Authorization header', requestId);
    return null;
  }

  if (!authHeader.startsWith('Bearer ')) {
    logger.warn('auth', 'Invalid Authorization header format (must be Bearer)', { authHeader }, requestId);
    send401Challenge(res, config, 'Invalid Authorization header format', requestId);
    return null;
  }

  const token = authHeader.substring(7);

  logger.debug('auth', 'Extracted bearer token', {
    tokenLength: token.length,
    tokenPreview: token.substring(0, 20) + '...' + token.substring(token.length - 20)
  }, requestId);

  try {
    const user = await validateToken(token, config, requestId);
    logger.info('auth', '✅ Authentication successful', {
      userId: user.userId,
      email: user.email,
      hasRequiredScopes: true
    }, requestId);
    return user;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('auth', '❌ Token validation failed', {
      error: errorMessage,
      errorType: error instanceof Error ? error.constructor.name : typeof error
    }, requestId);

    send401Challenge(res, config, `Token validation failed: ${errorMessage}`, requestId);
    return null;
  }
}

async function validateToken(
  token: string,
  config: ServerConfig,
  requestId: string
): Promise<AuthenticatedUser> {
  logger.debug('auth', 'Fetching JWKS from Auth0', { jwksUri: config.auth0.jwksUri }, requestId);

  // Create JWKS remote instance
  const JWKS = jose.createRemoteJWKSet(new URL(config.auth0.jwksUri));

  logger.debug('auth', 'Verifying JWT signature and claims', undefined, requestId);

  const { payload } = await jose.jwtVerify(token, JWKS, {
    issuer: config.auth0.issuer,
    audience: config.auth0.audience
  });

  logger.debug('auth', 'JWT verification successful', {
    issuer: payload.iss,
    subject: payload.sub,
    audience: payload.aud,
    expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : 'unknown',
    issuedAt: payload.iat ? new Date(payload.iat * 1000).toISOString() : 'unknown',
    scopes: payload.scope
  }, requestId);

  // Extract user info
  const userId = payload.sub || 'unknown';
  const email = typeof payload.email === 'string' ? payload.email : undefined;

  return {
    userId,
    email,
    claims: payload as Record<string, any>,
    token
  };
}

function send401Challenge(
  res: http.ServerResponse,
  config: ServerConfig,
  reason: string,
  requestId: string
) {
  logger.info('auth', `Sending 401 challenge: ${reason}`, undefined, requestId);

  // Build WWW-Authenticate header pointing to our protected resource metadata
  const protectedResourceUrl = `${config.baseUrl}/.well-known/oauth-protected-resource`;
  const authenticateHeader = `Bearer realm="${config.auth0.audience}", error="invalid_token", error_description="${reason}"`;

  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': authenticateHeader,
    'Link': `<${protectedResourceUrl}>; rel="oauth-protected-resource"`
  });

  const errorResponse = {
    error: 'unauthorized',
    message: reason,
    protectedResource: protectedResourceUrl,
    authorizationServer: `${config.baseUrl}/.well-known/oauth-authorization-server`
  };

  res.end(JSON.stringify(errorResponse, null, 2));

  logger.debug('auth', '401 response sent', { errorResponse }, requestId);
}
