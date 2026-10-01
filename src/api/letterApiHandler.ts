/**
 * Letter API Request Handler
 *
 * Handles Letter/Order REST API routes for the raw Node.js HTTP server
 * Provides endpoints for users to view their letter history
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { query } from '../db/index.js';
import {
  authenticateRestRequest,
  sendRestAuthFailure,
  type RestAuthInfo as AuthInfo
} from './middleware/restAuth.js';
import { rateLimitAccount } from './middleware/rateLimit.js';
import { requiredRestScopes } from '../auth/restScopes.js';
import { cancelScheduledMail, type ScheduledMailRefusal } from '../services/scheduledMailService.js';
import { cancelledMessage } from '../tools/cancelScheduledMail.js';

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, statusCode: number, data: any) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

/**
 * Handle Letter API requests
 * Returns true if request was handled, false if should continue to next handler
 */
export async function handleLetterApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  // Check if this is a letter API route
  if (!pathname.startsWith('/api/letters')) {
    return false; // Not a letter API route, continue to next handler
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

  // Route handlers
  try {
    // GET /api/letters - List letters for user
    if (pathname === '/api/letters' && req.method === 'GET') {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      await handleListLetters(res, authInfo, url.searchParams);
      return true;
    }

    // POST /api/letters/:letterId/cancel - Cancel held mail (#535)
    const cancelMatch = pathname.match(/^\/api\/letters\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      await handleCancelLetter(res, authInfo, decodeURIComponent(cancelMatch[1]));
      return true;
    }

    // GET /api/letters/:letterId - Get specific letter details
    const letterMatch = pathname.match(/^\/api\/letters\/([^/]+)$/);
    if (letterMatch && req.method === 'GET') {
      const letterId = decodeURIComponent(letterMatch[1]);
      await handleGetLetter(res, authInfo, letterId);
      return true;
    }

    // Route not found
    sendJson(res, 404, {
      error: 'Not found',
      message: `Route not found: ${req.method} ${pathname}`
    });
    return true;

  } catch (error: any) {
    console.error('Letter API request failed');
    sendJson(res, 500, {
      error: 'Internal server error',
      message: error.message
    });
    return true;
  }
}

/**
 * A refusal in the website's words: cancel_scheduled_mail's name the tools a
 * model can call next, which a page has no use for.
 */
export const CANCEL_REFUSAL_WORDS: Record<ScheduledMailRefusal, string> = {
  not_found: "That letter wasn't found.",
  not_scheduled: 'Only mail scheduled to arrive by a date can be cancelled. This letter goes to the printer as soon as it can.',
  pay_and_send:
    "A Pay & Send order can't be cancelled here. Email support@letterirl.com from the email on your account, " +
    'quoting the order id; refunds are decided by a person.',
  too_late: "This letter has gone to the printer, or did not go out, so it can't be cancelled.",
  busy: "This letter is going to the printer right now, so it can't be cancelled."
};

/**
 * POST /api/letters/:letterId/cancel - held mail cancelled (#535), the
 * website's cancel_scheduled_mail through the same service. 200 with what
 * went back, a repeat included; 404 for a letter that is not the caller's;
 * 409 for any other refusal, with its reason and words.
 */
async function handleCancelLetter(res: ServerResponse, authInfo: AuthInfo, letterId: string) {
  const result = await cancelScheduledMail({ letterId, userId: authInfo.userId });
  if (!result.ok) {
    sendJson(res, result.refusal === 'not_found' ? 404 : 409, {
      error: result.refusal,
      message: CANCEL_REFUSAL_WORDS[result.refusal]
    });
    return;
  }
  const { cancelled } = result;
  sendJson(res, 200, {
    orderId: cancelled.letterId,
    status: 'cancelled',
    alreadyCancelled: cancelled.alreadyCancelled,
    returned: cancelled.returned,
    // What of its cost did not come back usable, for the page to show as it
    // likes; the message says it in words.
    shortfall: cancelled.shortfall,
    arriveBy: cancelled.arriveBy,
    mailOn: cancelled.mailOn,
    message: cancelledMessage(cancelled)
  });
}

/**
 * Letter record from database
 */
interface LetterRow {
  letter_id: string;
  user_id: string;
  content: any;
  recipient: any;
  credits_cost: number;
  status: string;
  /** Selected by the single-letter route only. */
  preview_html?: string | null;
  tracking_id: string | null;
  created_at: Date;
  sent_at: Date | null;
  provider: string | null;
}

/**
 * GET /api/letters - List user's letters
 */
async function handleListLetters(
  res: ServerResponse,
  authInfo: AuthInfo,
  queryParams: URLSearchParams
) {
  let limit = parseInt(queryParams.get('limit') || '20', 10);
  let offset = parseInt(queryParams.get('offset') || '0', 10);
  const status = queryParams.get('status');

  // Validate limits
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;
  if (offset < 0) offset = 0;

  // Validate status if provided
  const validStatuses = ['draft', 'queued', 'processing', 'sent', 'failed', 'cancelled'];
  if (status && !validStatuses.includes(status)) {
    sendJson(res, 400, {
      error: 'Invalid status',
      message: `Status must be one of: ${validStatuses.join(', ')}`
    });
    return;
  }

  // Build query. preview_html stays on the single-letter route: a page our
  // renderer drew is about 95 KB (#534), and the list never shows it.
  let sql = `
    SELECT
      letter_id, user_id, content, recipient, credits_cost, status,
      tracking_id, created_at, sent_at, provider
    FROM letters
    WHERE user_id = $1
  `;
  const params: any[] = [authInfo.userId];

  if (status) {
    params.push(status);
    sql += ` AND status = $${params.length}`;
  }

  sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  // Get letters
  const result = await query<LetterRow>(sql, params);
  const letters = result.rows.map((row: LetterRow) => formatLetterResponse(row));

  // Get total count
  let countSql = `SELECT COUNT(*) FROM letters WHERE user_id = $1`;
  const countParams: any[] = [authInfo.userId];
  if (status) {
    countParams.push(status);
    countSql += ` AND status = $${countParams.length}`;
  }
  const countResult = await query(countSql, countParams);
  const total = parseInt(countResult.rows[0].count, 10);

  sendJson(res, 200, {
    letters,
    total,
    limit,
    offset
  });
}

/**
 * GET /api/letters/:letterId - Get specific letter details
 */
async function handleGetLetter(
  res: ServerResponse,
  authInfo: AuthInfo,
  letterId: string
) {
  const result = await query<LetterRow>(`
    SELECT
      letter_id, user_id, content, recipient, credits_cost, status,
      preview_html, tracking_id, created_at, sent_at, provider
    FROM letters
    WHERE letter_id = $1 AND user_id = $2
  `, [letterId, authInfo.userId]);

  if (result.rows.length === 0) {
    sendJson(res, 404, {
      error: 'Not found',
      message: 'Letter not found or you do not have access to it'
    });
    return;
  }

  const letter = formatLetterResponse(result.rows[0]);

  // Also fetch the job status if available
  const jobResult = await query(`
    SELECT
      job_id, status as job_status, attempts, max_attempts,
      error_message, scheduled_at, started_at, completed_at
    FROM letter_jobs
    WHERE letter_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [letterId]);

  if (jobResult.rows.length > 0) {
    const job = jobResult.rows[0];
    letter.job = {
      jobId: job.job_id,
      status: job.job_status,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
      errorMessage: job.error_message,
      scheduledAt: job.scheduled_at?.toISOString(),
      startedAt: job.started_at?.toISOString(),
      completedAt: job.completed_at?.toISOString()
    };
  }

  sendJson(res, 200, letter);
}

/**
 * Format a letter database row into API response format
 */
function formatLetterResponse(row: LetterRow): any {
  // Extract recipient info from JSONB
  const recipient = row.recipient || {};
  const content = row.content || {};

  return {
    letterId: row.letter_id,
    status: row.status,
    creditsCost: row.credits_cost,
    createdAt: row.created_at?.toISOString(),
    sentAt: row.sent_at?.toISOString(),
    trackingNumber: row.tracking_id,

    // Recipient summary
    recipient: {
      name: recipient.name,
      addressLine1: recipient.addressLine1 || recipient.address1,
      addressLine2: recipient.addressLine2 || recipient.address2,
      city: recipient.city,
      state: recipient.state,
      postalCode: recipient.postalCode || recipient.zip,
      country: recipient.country || 'US'
    },

    // Sender info if available
    sender: content.sender ? {
      name: content.sender.name,
      addressLine1: content.sender.addressLine1 || content.sender.address1,
      city: content.sender.city,
      state: content.sender.state
    } : null,

    // Content preview (truncated for list view)
    contentPreview: content.bodyText
      ? content.bodyText.substring(0, 200) + (content.bodyText.length > 200 ? '...' : '')
      : null,

    // Full content only when fetching single letter
    content: content.bodyText ? {
      body: content.bodyText,
      signOff: content.signOff
    } : null,

    // Provider info
    provider: row.provider,

    // Preview HTML (only for single letter fetch)
    previewHtml: row.preview_html
  };
}
