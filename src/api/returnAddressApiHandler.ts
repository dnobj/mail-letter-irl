/**
 * Return Address API Request Handler
 *
 * Handles Return Address API routes for the raw Node.js HTTP server:
 * - GET /api/return-address - Get user's saved return address
 * - POST /api/return-address - Set/update return address (with validation)
 * - DELETE /api/return-address - Clear return address
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { readRequestBody, JSON_API_BODY_LIMIT_BYTES } from '../utils/requestBody.js';
import {
  getReturnAddress,
  setReturnAddress,
  clearReturnAddress
} from '../services/returnAddressService.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';
import { authenticateRestRequest, type RestAuthInfo as AuthInfo } from './middleware/restAuth.js';

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
    // A RequestBodyTooLargeError from above propagates with its own 413 rather
    // than being flattened into this parse error.
    throw new Error('Invalid JSON body');
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

  // Authenticate request
  const auth = await authenticateRestRequest(req);
  if (!auth.ok) {
    sendJson(res, 401, { error: 'Unauthorized', message: auth.message });
    return true;
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
    writeDiagnostic('error', 'address.api_failed', {
      errorClass: classifyDiagnosticError(error, 'database_error')
    });
    sendJson(res, 500, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
    return true;
  }
}
