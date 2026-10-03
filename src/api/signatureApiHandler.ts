/**
 * The saved signature's REST routes (#608), for the website's signature page:
 * - GET /api/signature: whether one is saved, with the cleaned picture
 * - POST /api/signature: save one from a picture, `{ image: <data URI> }`
 * - DELETE /api/signature: remove it
 *
 * The same service as set_signature, get_signature and clear_signature, and
 * the same scopes (src/auth/restScopes.ts). While signatures are not offered,
 * every route answers 404, as the tools are not listed.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { readRequestBody, RequestBodyTooLargeError, RequestBodyTimeoutError } from '../utils/requestBody.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';
import { authenticateRestRequest, sendRestAuthFailure } from './middleware/restAuth.js';
import { rateLimitAccount } from './middleware/rateLimit.js';
import { requiredRestScopes } from '../auth/restScopes.js';
import { isSignaturesOffered } from '../config/signatures.js';
import { ImageProcessingError } from '../services/imageService.js';
import { cleanSignatureImage, SignatureImageError } from '../services/signatureImage.js';
import { clearSignature, getSignature, saveSignature } from '../services/signatureService.js';
import { signatureImageUri } from '../tools/signatureShared.js';

export const SIGNATURE_API_PATH = '/api/signature';

/**
 * A picture arrives as a data URI in JSON. The page shrinks a photo to 2000
 * px before sending it, so 4 MB of body (about 3 MB of picture) is generous;
 * the JSON routes' own limit is for small objects.
 */
export const SIGNATURE_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

const DATA_URI = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

/** The picture's bytes from the body's data URI, or null for anything else. */
export function pictureFromBody(body: string): Buffer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const image = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).image : undefined;
  if (typeof image !== 'string') return null;
  const match = DATA_URI.exec(image);
  return match ? Buffer.from(match[1], 'base64') : null;
}

/** Handles /api/signature. True when the request was this module's. */
export async function handleSignatureApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (pathname !== SIGNATURE_API_PATH) return false;
  if (!isSignaturesOffered()) {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }

  const auth = await authenticateRestRequest(req, requiredRestScopes(req.method, pathname));
  if (!auth.ok) {
    sendRestAuthFailure(res, auth);
    return true;
  }
  if (await rateLimitAccount(req, res, auth.user.userId, 'api_account')) return true;
  const userId = auth.user.userId;

  try {
    if (req.method === 'GET') {
      const signature = await getSignature(userId);
      sendJson(
        res,
        200,
        signature
          ? {
              saved: true,
              width: signature.width,
              height: signature.height,
              savedAt: signature.updatedAt,
              image: signatureImageUri(signature.png)
            }
          : { saved: false }
      );
      return true;
    }

    if (req.method === 'POST') {
      const picture = pictureFromBody(await readRequestBody(req, { limitBytes: SIGNATURE_BODY_LIMIT_BYTES }));
      if (!picture) {
        sendJson(res, 400, { reason: 'invalid', message: 'Send the picture as a PNG, JPEG or WebP data URI in "image".' });
        return true;
      }
      const cleaned = await cleanSignatureImage(picture, userId);
      const saved = await saveSignature(userId, cleaned);
      if (!saved.ok) {
        sendJson(res, 403, { reason: 'account_closed' });
        return true;
      }
      writeDiagnostic('info', 'signature.saved', { route: 'rest', replaced: saved.replaced });
      sendJson(res, 200, {
        saved: true,
        replaced: saved.replaced,
        width: cleaned.width,
        height: cleaned.height,
        savedAt: saved.signature.updatedAt,
        image: signatureImageUri(cleaned.png)
      });
      return true;
    }

    if (req.method === 'DELETE') {
      const removed = await clearSignature(userId);
      writeDiagnostic('info', 'signature.cleared', { route: 'rest', removed });
      sendJson(res, 200, { removed });
      return true;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(res, 413, { reason: 'too_large', message: 'That picture is too large. Please use one under 3MB.' });
      return true;
    }
    if (error instanceof RequestBodyTimeoutError) {
      sendJson(res, 408, { reason: 'timeout' });
      return true;
    }
    // A picture that holds no signature, or one that cannot be opened: the
    // person's to fix, in their words.
    if (error instanceof SignatureImageError) {
      sendJson(res, 422, { reason: error.code, message: error.message });
      return true;
    }
    if (error instanceof ImageProcessingError) {
      sendJson(res, error.code === 'SERVICE_BUSY' ? 503 : 422, { reason: error.code, message: error.userMessage });
      return true;
    }
    writeDiagnostic('error', 'signature.api_failed', {
      errorClass: classifyDiagnosticError(error, 'database_error')
    });
    sendJson(res, 500, { error: 'Internal server error' });
    return true;
  }
}
