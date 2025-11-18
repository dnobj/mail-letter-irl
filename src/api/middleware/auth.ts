/**
 * Auth Middleware
 *
 * JWT validation middleware for Express routes
 * Validates Auth0 JWT tokens and attaches user info to request
 */

import { Request, Response, NextFunction } from 'express';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { AuthenticatedUser } from '../../services/types.js';

// Extend Express Request type to include authInfo
declare global {
  namespace Express {
    interface Request {
      authInfo?: AuthenticatedUser;
    }
  }
}

// Create JWKS client for Auth0
const JWKS = createRemoteJWKSet(
  new URL(process.env.LETTER_IRL_OAUTH_JWKS_URI!)
);

/**
 * Auth middleware - validates JWT and attaches user info to request
 *
 * Usage:
 *   router.get('/api/credits/balance', authMiddleware, async (req, res) => {
 *     const userId = req.authInfo.userId;
 *     ...
 *   });
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Get Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }

    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Invalid Authorization header format. Expected: Bearer <token>' });
      return;
    }

    // Extract token
    const token = authHeader.substring(7);

    // Verify JWT with Auth0
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: process.env.LETTER_IRL_OAUTH_ISSUER,
      audience: process.env.LETTER_IRL_OAUTH_AUDIENCE
    });

    // Attach auth info to request
    req.authInfo = {
      userId: payload.sub!,
      email: payload.email as string | undefined
    };

    // Continue to next middleware/route handler
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);

    if (error.code === 'ERR_JWT_EXPIRED') {
      res.status(401).json({ error: 'Token expired' });
      return;
    }

    if (error.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
      res.status(401).json({ error: 'Invalid token signature' });
      return;
    }

    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Optional auth middleware - continues even if no token provided
 * Useful for endpoints that work with or without authentication
 *
 * If token is provided and valid, sets req.authInfo
 * If token is missing or invalid, continues without req.authInfo
 */
export async function optionalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // No token provided, continue without auth
      next();
      return;
    }

    const token = authHeader.substring(7);

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: process.env.LETTER_IRL_OAUTH_ISSUER,
      audience: process.env.LETTER_IRL_OAUTH_AUDIENCE
    });

    req.authInfo = {
      userId: payload.sub!,
      email: payload.email as string | undefined
    };

    next();
  } catch (error) {
    // Invalid token, but optional, so continue anyway
    console.warn('Optional auth failed:', error.message);
    next();
  }
}
