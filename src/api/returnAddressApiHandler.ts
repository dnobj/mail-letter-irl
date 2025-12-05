/**
 * Return Address API Request Handler
 *
 * Handles Return Address API routes for the raw Node.js HTTP server:
 * - GET /api/return-address - Get user's saved return address
 * - POST /api/return-address - Set/update return address (with validation)
 * - DELETE /api/return-address - Clear return address
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import {
  getReturnAddress,
  setReturnAddress,
  clearReturnAddress
} from '../services/returnAddressService.js';

// Create JWKS client for Auth0
const JWKS = createRemoteJWKSet(
  new URL(process.env.LETTER_IRL_OAUTH_JWKS_URI!)
);

interface AuthInfo {
  userId: string;
  email?: string;
}

/**
 * Authenticate request and extract user info from JWT
 */
async function authenticateRequest(req: IncomingMessage): Promise<AuthInfo | null> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: process.env.LETTER_IRL_OAUTH_ISSUER,
      audience: process.env.LETTER_IRL_OAUTH_AUDIENCE
    });

    return {
      userId: payload.sub!,
      email: payload.email as string | undefined
    };
  } catch (error) {
    console.error('JWT validation failed:', error);
    return null;
  }
}

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, statusCode: number, data: any) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

/**
 * Parse request body as JSON
 */
async function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Handle Return Address API requests
 * Returns true if request was handled, false if should continue to next handler
 */
export async function handleReturnAddressApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  // Check if this is a return address API route
  if (!pathname.startsWith('/api/return-address')) {
    return false; // Not a return address API route, continue to next handler
  }

  // Authenticate request
  const authInfo = await authenticateRequest(req);
  if (!authInfo) {
    sendJson(res, 401, {
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header'
    });
    return true;
  }

  const userId = authInfo.userId;

  // Route handlers
  try {
    // GET /api/return-address - Get user's saved return address
    if (req.method === 'GET' && pathname === '/api/return-address') {
      const address = await getReturnAddress(userId);

      if (address) {
        sendJson(res, 200, {
          hasAddress: true,
          address
        });
      } else {
        sendJson(res, 200, {
          hasAddress: false,
          address: null
        });
      }
      return true;
    }

    // POST /api/return-address - Set/update return address with validation
    if (req.method === 'POST' && pathname === '/api/return-address') {
      const body = await parseBody(req);

      // Validate required fields
      const requiredFields = ['name', 'addressLine1', 'city', 'state', 'postalCode'];
      const missingFields = requiredFields.filter(field => !body[field]);

      if (missingFields.length > 0) {
        sendJson(res, 400, {
          error: 'Missing required fields',
          missingFields
        });
        return true;
      }

      // Set the return address (validation happens in the service)
      const result = await setReturnAddress(userId, {
        name: body.name,
        addressLine1: body.addressLine1,
        addressLine2: body.addressLine2 || undefined,
        city: body.city,
        state: body.state,
        postalCode: body.postalCode,
        country: body.country || 'US'
      });

      if (result.success) {
        sendJson(res, 200, {
          success: true,
          address: result.address,
          validationStatus: result.validationStatus,
          wasAutoCorrected: result.wasAutoCorrected,
          correctionDetails: result.correctionDetails,
          message: result.wasAutoCorrected
            ? `Address saved with corrections: ${result.correctionDetails}`
            : 'Return address saved successfully'
        });
      } else {
        sendJson(res, 400, {
          success: false,
          validationStatus: result.validationStatus,
          errors: result.errors,
          message: result.errors?.join('; ') || 'Address validation failed'
        });
      }
      return true;
    }

    // DELETE /api/return-address - Clear return address
    if (req.method === 'DELETE' && pathname === '/api/return-address') {
      await clearReturnAddress(userId);

      sendJson(res, 200, {
        success: true,
        message: 'Return address cleared'
      });
      return true;
    }

    // Unknown route under /api/return-address
    sendJson(res, 404, {
      error: 'Not found',
      message: `Unknown endpoint: ${req.method} ${pathname}`
    });
    return true;

  } catch (error) {
    console.error('Return address API error:', error);
    sendJson(res, 500, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
    return true;
  }
}
