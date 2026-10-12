/**
 * Return Address API Request Handler
 *
 * Handles Return Address API routes for the raw Node.js HTTP server:
 * - GET /api/return-address - Get user's saved return address
 * - POST /api/return-address - Set/update return address (with validation)
 * - DELETE /api/return-address - Clear return address
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { readRequestBody, JSON_API_BODY_LIMIT_BYTES, RequestBodyTooLargeError } from '../utils/requestBody.js';
import {
  getReturnAddress,
  setReturnAddress,
  clearReturnAddress
} from '../services/returnAddressService.js';
import {
  authenticateRestRequest,
  sendRestAuthFailure,
  type RestAuthInfo as AuthInfo
} from './middleware/restAuth.js';
import { rateLimitAccount } from './middleware/rateLimit.js';
import { sendInternalError } from './internalError.js';
import { requiredRestScopes } from '../auth/restScopes.js';

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
  // Bounded. This previously accumulated without a cap, which on a public
  // route is a memory-exhaustion denial of service (#157). readRequestBody
  // also decodes once at the end, so a multi-byte character split across two
  // chunks is no longer corrupted into replacement characters.
  const body = await readRequestBody(req, { limitBytes: JSON_API_BODY_LIMIT_BYTES });
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    // A RequestBodyTooLargeError from above is answered 413 by the handler,
    // not flattened into this parse error.
    throw new InvalidJsonBodyError();
  }
}

/** A body that is not JSON: the caller's to fix, answered 400 (#682). */
class InvalidJsonBodyError extends Error {
  constructor() {
    super('Invalid JSON body');
  }
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

  // Authenticate, including the route's scope (src/auth/restScopes.ts). The
  // status comes from the auth layer: 401 rejected, 403 not admitted or
  // missing a scope, 503 server not configured. Hardcoding 401 told a refused
  // beta user to authenticate again, which succeeds and is refused again.
  const auth = await authenticateRestRequest(req, requiredRestScopes(req.method, pathname));
  if (!auth.ok) {
    sendRestAuthFailure(res, auth);
    return true;
  }
  if (await rateLimitAccount(req, res, auth.user.userId, 'api_account')) {
    return true; // Rate limited
  }
  const authInfo = auth.user;

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
    if (error instanceof InvalidJsonBodyError) {
      sendJson(res, 400, { error: 'Bad request', message: 'The request body is not valid JSON' });
      return true;
    }
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(res, 413, { error: 'Payload too large', message: 'The request body is too large' });
      return true;
    }
    sendInternalError(res, 'address.api_failed', error, 'Unable to complete return address request');
    return true;
  }
}
