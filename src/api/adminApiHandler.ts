/**
 * Admin API Request Handler
 *
 * Handles admin-only API routes:
 * - POST /api/admin/credits/adjust - Manually adjust user credits
 * - GET /api/admin/users/:userId - Get user details
 * - GET /api/admin/stats - Get system statistics
 * - GET /api/admin/ratelimit/stats - Get rate limiting statistics
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createHash } from 'node:crypto';
import { authenticateAdmin, validateAdminRequestBoundary } from './middleware/adminAuth.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';
import { adjustCredits } from '../services/creditService.js';
import { getUser, getAllUsers } from '../services/userService.js';
import {
  AdminJobRetryError,
  AdminMailResolutionError,
  getAllJobs,
  getJobById,
  getJobsByUserId,
  resolveAmbiguousLetterJobAsAdmin,
  retryLetterJobAsAdmin
} from '../services/letterJobService.js';
import { query, transaction } from '../db/index.js';
import {
  createCampaign,
  getCampaignById,
  listCampaigns,
  updateCampaignStatus,
  getCampaignRedemptions,
  deleteCampaign,
} from '../services/promoService.js';
import type { PromoCampaignStatus } from '../services/types.js';
import {
  reconcileStripePayments,
  autoFixMissingCredits,
} from '../services/stripeReconciliationService.js';
import {
  syncLetterStatuses,
  getStuckLetters,
} from '../services/statusSyncService.js';
import { getTokenStats } from '../services/patService.js';
import { getRateLimitStats, getBlockedRequestCounts, RATE_LIMITS } from './middleware/rateLimit.js';
import {
  getGenerationQuota,
  ImageGenerationResolutionError,
  listAmbiguousGenerationReservations,
  resolveAmbiguousGenerationReservation
} from '../services/imageGenerationLimitService.js';
import type {
  AmbiguousGenerationDecision,
  AmbiguousGenerationResolution
} from '../services/imageGenerationLimitService.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATOR_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, statusCode: number, data: any) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

/**
 * Parse JSON body from request
 */
async function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Handle Admin API requests
 * Returns true if request was handled, false if should continue to next handler
 */
export async function handleAdminApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  // Check if this is an admin API route
  if (!pathname.startsWith('/api/admin')) {
    return false; // Not an admin route, continue to next handler
  }

  if (!validateAdminRequestBoundary(req, res)) return true;

  // Authenticate and verify admin status
  const adminInfo = await authenticateAdmin(req, res);
  if (!adminInfo) {
    return true; // Auth failed, response already sent
  }

  // Route handlers
  try {
    writeDiagnostic('info', 'admin.request_started', {
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '')
        ? req.method || 'UNKNOWN'
        : 'UNKNOWN'
    });

    // POST /api/admin/credits/adjust
    if (pathname === '/api/admin/credits/adjust' && req.method === 'POST') {
      await handleAdjustCredits(req, res, adminInfo);
      return true;
    }

    // GET /api/admin/users/:userId
    if (pathname.startsWith('/api/admin/users/') && req.method === 'GET') {
      const userId = pathname.split('/').pop();
      console.log('🔍 Extracted account identifier from pathname');
      if (userId) {
        // Decode the userId (pathname is not auto-decoded in our setup)
        const decodedUserId = decodeURIComponent(userId);
        console.log('🔍 Decoded account identifier');
        await handleGetUser(res, decodedUserId);
        return true;
      }
    }

    // GET /api/admin/stats
    if (pathname === '/api/admin/stats' && req.method === 'GET') {
      await handleGetStats(res);
      return true;
    }

    // GET /api/admin/dashboard - Comprehensive dashboard data
    if (pathname === '/api/admin/dashboard' && req.method === 'GET') {
      await handleGetDashboard(res);
      return true;
    }

    // GET /api/admin/alerts - Active alerts (failed jobs, expiring credits, etc.)
    if (pathname === '/api/admin/alerts' && req.method === 'GET') {
      await handleGetAlerts(res);
      return true;
    }

    if (pathname.match(/^\/api\/admin\/commerce-alerts\/[^/]+$/) && req.method === 'PATCH') {
      await handleTransitionCommerceAlert(
        req, res, decodeURIComponent(pathname.split('/').pop() || ''), adminInfo
      );
      return true;
    }

    // GET /api/admin/image-generation/ambiguous - Inspect quarantined outcomes
    if (pathname === '/api/admin/image-generation/ambiguous' && req.method === 'GET') {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      await handleListAmbiguousImageReservations(res, url.searchParams);
      return true;
    }

    // POST /api/admin/image-generation/ambiguous/:reservationId/resolve
    if (
      pathname.match(/^\/api\/admin\/image-generation\/ambiguous\/[^/]+\/resolve$/) &&
      req.method === 'POST'
    ) {
      const parts = pathname.split('/');
      const reservationId = decodeURIComponent(parts[parts.length - 2] || '');
      await handleResolveAmbiguousImageReservation(req, res, reservationId, adminInfo);
      return true;
    }

    // GET /api/admin/users/search - Search users by email or ID
    if (pathname === '/api/admin/users/search' && req.method === 'GET') {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      await handleSearchUsers(res, url.searchParams);
      return true;
    }

    // GET /api/admin/users (list all users)
    if (pathname === '/api/admin/users' && req.method === 'GET') {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      await handleGetAllUsers(res, url.searchParams);
      return true;
    }

    // GET /api/admin/jobs - List all jobs
    if (pathname === '/api/admin/jobs' && req.method === 'GET') {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      await handleGetJobs(res, url.searchParams);
      return true;
    }

    // GET /api/admin/jobs/:jobId - Get specific job
    if (pathname.startsWith('/api/admin/jobs/') && req.method === 'GET' && !pathname.includes('/user/')) {
      const jobId = pathname.split('/').pop();
      if (jobId) {
        await handleGetJobById(res, decodeURIComponent(jobId));
        return true;
      }
    }

    // GET /api/admin/jobs/user/:userId - Get jobs by user
    if (pathname.match(/^\/api\/admin\/jobs\/user\/[^/]+$/) && req.method === 'GET') {
      const userId = pathname.split('/').pop();
      const url = new URL(req.url!, `http://${req.headers.host}`);
      if (userId) {
        await handleGetJobsByUser(res, decodeURIComponent(userId), url.searchParams);
        return true;
      }
    }

    // GET /api/admin/outbox/jobs - View durable mail outbox jobs
    // Keep the old path as a temporary admin-only compatibility alias.
    if (
      (pathname === '/api/admin/outbox/jobs' || pathname === '/api/admin/pgboss/jobs') &&
      req.method === 'GET'
    ) {
      await handleGetOutboxJobs(res);
      return true;
    }

    // GET /api/admin/letters - List letters with filters
    if (pathname === '/api/admin/letters' && req.method === 'GET') {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      await handleGetLetters(res, url.searchParams);
      return true;
    }

    // GET /api/admin/letters/search - Search letters
    if (pathname === '/api/admin/letters/search' && req.method === 'GET') {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      await handleSearchLetters(res, url.searchParams);
      return true;
    }

    // GET /api/admin/letters/:letterId - Get letter details with job history
    if (pathname.match(/^\/api\/admin\/letters\/[^/]+$/) && req.method === 'GET' && !pathname.includes('/search')) {
      const letterId = pathname.split('/').pop();
      if (letterId) {
        await handleGetLetterById(res, decodeURIComponent(letterId));
        return true;
      }
    }

    // POST /api/admin/jobs/:jobId/resolve-ambiguous - Finish a provider hold without resending
    if (pathname.match(/^\/api\/admin\/jobs\/[^/]+\/resolve-ambiguous$/) && req.method === 'POST') {
      const parts = pathname.split('/');
      const jobId = parts[parts.length - 2];
      if (jobId) {
        await handleResolveAmbiguousJob(req, res, decodeURIComponent(jobId), adminInfo);
        return true;
      }
    }

    // POST /api/admin/jobs/:jobId/retry - Retry a failed job
    if (pathname.match(/^\/api\/admin\/jobs\/[^/]+\/retry$/) && req.method === 'POST') {
      const parts = pathname.split('/');
      const jobId = parts[parts.length - 2];
      if (jobId) {
        await handleRetryJob(req, res, decodeURIComponent(jobId), adminInfo);
        return true;
      }
    }

    // =========================================================================
    // Promo Campaign Routes
    // =========================================================================

    // POST /api/admin/promo/campaigns - Create new promo campaign
    if (pathname === '/api/admin/promo/campaigns' && req.method === 'POST') {
      await handleCreateCampaign(req, res, adminInfo);
      return true;
    }

    // GET /api/admin/promo/campaigns - List all campaigns
    if (pathname === '/api/admin/promo/campaigns' && req.method === 'GET') {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      await handleListCampaigns(res, url.searchParams);
      return true;
    }

    // GET /api/admin/promo/campaigns/:campaignId - Get campaign details
    if (pathname.match(/^\/api\/admin\/promo\/campaigns\/[^/]+$/) && req.method === 'GET') {
      const campaignId = pathname.split('/').pop();
      if (campaignId) {
        await handleGetCampaign(res, decodeURIComponent(campaignId));
        return true;
      }
    }

    // DELETE /api/admin/promo/campaigns/:campaignId - Delete a campaign
    if (pathname.match(/^\/api\/admin\/promo\/campaigns\/[^/]+$/) && req.method === 'DELETE') {
      const campaignId = pathname.split('/').pop();
      if (campaignId) {
        await handleDeleteCampaign(res, decodeURIComponent(campaignId));
        return true;
      }
    }

    // PATCH /api/admin/promo/campaigns/:campaignId/status - Update campaign status
    if (pathname.match(/^\/api\/admin\/promo\/campaigns\/[^/]+\/status$/) && req.method === 'PATCH') {
      const parts = pathname.split('/');
      const campaignId = parts[parts.length - 2];
      if (campaignId) {
        await handleUpdateCampaignStatus(req, res, decodeURIComponent(campaignId));
        return true;
      }
    }

    // GET /api/admin/promo/campaigns/:campaignId/redemptions - Get campaign redemptions
    if (pathname.match(/^\/api\/admin\/promo\/campaigns\/[^/]+\/redemptions$/) && req.method === 'GET') {
      const parts = pathname.split('/');
      const campaignId = parts[parts.length - 2];
      const url = new URL(req.url!, `http://${req.headers.host}`);
      if (campaignId) {
        await handleGetCampaignRedemptions(res, decodeURIComponent(campaignId), url.searchParams);
        return true;
      }
    }

    // =========================================================================
    // Stripe Reconciliation Routes
    // =========================================================================

    // GET /api/admin/stripe/reconcile - Run Stripe reconciliation
    if (pathname === '/api/admin/stripe/reconcile' && req.method === 'GET') {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      await handleStripeReconcile(res, url.searchParams);
      return true;
    }

    // POST /api/admin/stripe/reconcile/fix - Auto-fix missing credits
    if (pathname === '/api/admin/stripe/reconcile/fix' && req.method === 'POST') {
      const body = await parseBody(req);
      await handleStripeReconcileFix(res, body, adminInfo);
      return true;
    }

    // =========================================================================
    // Status Sync Routes
    // =========================================================================

    // GET /api/admin/sync/statuses - Run status sync (dry run by default)
    if (pathname === '/api/admin/sync/statuses' && req.method === 'GET') {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      await handleStatusSyncDryRun(res, url.searchParams);
      return true;
    }

    // POST /api/admin/sync/statuses - Run actual status sync
    if (pathname === '/api/admin/sync/statuses' && req.method === 'POST') {
      await handleStatusSync(res);
      return true;
    }

    // GET /api/admin/sync/stuck - Get stuck letters
    if (pathname === '/api/admin/sync/stuck' && req.method === 'GET') {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      await handleGetStuckLetters(res, url.searchParams);
      return true;
    }

    // =========================================================================
    // Personal Access Token (PAT) Stats Routes
    // =========================================================================

    // GET /api/admin/tokens/stats - Get PAT usage statistics
    if (pathname === '/api/admin/tokens/stats' && req.method === 'GET') {
      await handleGetTokenStats(res);
      return true;
    }

    // =========================================================================
    // Rate Limiting Stats Routes
    // =========================================================================

    // GET /api/admin/ratelimit/stats - Get rate limiting statistics
    if (pathname === '/api/admin/ratelimit/stats' && req.method === 'GET') {
      await handleGetRateLimitStats(res);
      return true;
    }

    // =========================================================================
    // Provider Routing Routes
    // =========================================================================

    // GET /api/admin/routing - List all routing rules
    if (pathname === '/api/admin/routing' && req.method === 'GET') {
      await handleGetRouting(res);
      return true;
    }

    // PUT /api/admin/routing/:mailType - Update routing for a mail type
    if (pathname.match(/^\/api\/admin\/routing\/[^/]+$/) && req.method === 'PUT') {
      const mailType = pathname.split('/').pop();
      if (mailType) {
        await handleUpdateRouting(req, res, decodeURIComponent(mailType), adminInfo);
        return true;
      }
    }

    // GET /api/admin/providers - List available providers with status
    if (pathname === '/api/admin/providers' && req.method === 'GET') {
      await handleGetProviders(res);
      return true;
    }

    // Route not found
    sendJson(res, 404, {
      error: 'Not found',
      message: `Admin route not found: ${req.method} ${pathname}`
    });
    return true;

  } catch (error) {
    console.error('Admin API request failed');
    sendJson(res, 500, {
      error: 'Internal server error',
      message: 'Unable to complete admin request'
    });
    return true;
  }
}

async function handleListAmbiguousImageReservations(
  res: ServerResponse,
  searchParams: URLSearchParams
): Promise<void> {
  const requestedLimit = Number.parseInt(searchParams.get('limit') || '50', 10);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    sendJson(res, 400, {
      error: 'Invalid request',
      message: 'limit must be an integer from 1 to 100'
    });
    return;
  }

  const reservations = await listAmbiguousGenerationReservations(requestedLimit);
  writeDiagnostic('info', 'admin.image_resolution_inspection_completed', {
    resultCount: reservations.length
  });
  sendJson(res, 200, { reservations });
}

function validResolutionPair(
  decision: unknown,
  resolution: unknown
): decision is AmbiguousGenerationDecision {
  return decision === 'consume'
    ? resolution === 'provider_confirmed_succeeded'
    : decision === 'release' &&
        (resolution === 'provider_confirmed_failed' || resolution === 'customer_compensation');
}

async function handleResolveAmbiguousImageReservation(
  req: IncomingMessage,
  res: ServerResponse,
  reservationId: string,
  adminInfo: { userId: string }
): Promise<void> {
  const body = await parseBody(req);
  const expectedUserId = typeof body.userId === 'string' ? body.userId : '';
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  const decision = body.decision as unknown;
  const resolution = body.resolution as unknown;

  if (
    !UUID_PATTERN.test(reservationId) ||
    !expectedUserId ||
    expectedUserId.length > 255 ||
    !OPERATOR_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey) ||
    !validResolutionPair(decision, resolution)
  ) {
    sendJson(res, 400, {
      error: 'Invalid request',
      message: 'A bound account, valid idempotency key, and matching decision evidence are required'
    });
    return;
  }

  try {
    const result = await resolveAmbiguousGenerationReservation({
      reservationId,
      expectedUserId,
      actorId: adminInfo.userId,
      idempotencyKey,
      decision,
      resolution: resolution as AmbiguousGenerationResolution
    });
    writeDiagnostic('info', 'admin.image_resolution_completed', {
      decision: result.decision,
      resultingStatus: result.resultingStatus,
      replayed: result.replayed
    });
    sendJson(res, 200, result);
  } catch (error) {
    if (error instanceof ImageGenerationResolutionError) {
      writeDiagnostic('warn', 'admin.image_resolution_rejected', {
        errorClass: error.code
      });
      if (error.code === 'not_found') {
        sendJson(res, 404, {
          error: 'Not found',
          message: 'No matching ambiguous reservation exists for that account'
        });
        return;
      }
      if (error.code === 'invalid_resolution' || error.code === 'invalid_request') {
        sendJson(res, 400, {
          error: 'Invalid request',
          message: 'The decision does not match the supplied evidence classification'
        });
        return;
      }
      sendJson(res, 409, {
        error: 'Conflict',
        message: 'The reservation or idempotency key no longer matches this decision'
      });
      return;
    }
    throw error;
  }
}

/**
 * POST /api/admin/credits/adjust
 * Manually adjust user credits (add or remove)
 */
async function handleAdjustCredits(
  req: IncomingMessage,
  res: ServerResponse,
  adminInfo: { userId: string; email?: string }
) {
  const body = await parseBody(req);

  // Validate input
  if (!body.userId) {
    sendJson(res, 400, {
      error: 'Missing required field: userId'
    });
    return;
  }

  if (typeof body.amount !== 'number' || body.amount === 0) {
    sendJson(res, 400, {
      error: 'Invalid amount',
      message: 'Amount must be a non-zero number'
    });
    return;
  }

  if (!body.reason) {
    sendJson(res, 400, {
      error: 'Missing required field: reason'
    });
    return;
  }

  // Adjust credits
  const result = await adjustCredits(
    body.userId,
    body.amount,
    `[Admin: ${adminInfo.email || adminInfo.userId}] ${body.reason}`
  );

  console.log(`🔧 Admin adjusted ${body.amount} credits`);

  sendJson(res, 200, {
    success: true,
    userId: result.user.user_id,
    amountAdjusted: body.amount,
    newBalance: result.user.credits,
    transaction: {
      transactionId: result.transaction.transaction_id,
      amount: result.transaction.amount,
      balanceAfter: result.transaction.balance_after,
      description: result.transaction.description,
      createdAt: result.transaction.created_at
    }
  });
}

/**
 * GET /api/admin/users/:userId
 * Get detailed user information
 */
async function handleGetUser(res: ServerResponse, userId: string) {
  try {
    const user = await getUser(userId);

    // Get recent transactions
    const txResult = await query(
      `SELECT * FROM credit_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [userId]
    );

    // Get letter count
    const letterResult = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM letters WHERE user_id = $1',
      [userId]
    );

    const imageQuota = await getGenerationQuota(userId);

    sendJson(res, 200, {
      user: {
        userId: user.user_id,
        email: user.email,
        credits: user.credits,
        creditsPurchased: user.credits_purchased,
        creditsUsed: user.credits_used,
        imageGenerationsUsed: imageQuota.used,
        imageGenerationsAllowance: imageQuota.allowance,
        imageGenerationsRemaining: imageQuota.remaining,
        createdAt: user.created_at,
        updatedAt: user.updated_at
      },
      stats: {
        totalLetters: parseInt(letterResult.rows[0].count, 10),
        recentTransactions: txResult.rows
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('User not found')) {
      sendJson(res, 404, {
        error: 'User not found',
        userId
      });
    } else {
      throw error;
    }
  }
}

/**
 * GET /api/admin/users
 * List all users with pagination
 */
async function handleGetAllUsers(res: ServerResponse, queryParams: URLSearchParams) {
  const limit = parseInt(queryParams.get('limit') || '50', 10);
  const offset = parseInt(queryParams.get('offset') || '0', 10);

  const result = await getAllUsers(limit, offset);

  sendJson(res, 200, {
    users: result.users.map(u => ({
      userId: u.user_id,
      email: u.email,
      credits: u.credits,
      creditsPurchased: u.credits_purchased,
      creditsUsed: u.credits_used,
      imageGenerationsUsed: u.image_generations_used,
      createdAt: u.created_at
    })),
    total: result.total,
    limit,
    offset
  });
}

/**
 * GET /api/admin/stats
 * Get system-wide statistics
 */
async function handleGetStats(res: ServerResponse) {
  // Get user stats
  const userStats = await query<{ count: string; total_credits: string }>(
    'SELECT COUNT(*) as count, SUM(credits) as total_credits FROM users'
  );

  // Get transaction stats
  const txStats = await query<{ total_purchased: string; total_used: string }>(
    `SELECT
       SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as total_purchased,
       SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as total_used
     FROM credit_transactions`
  );

  // Get order stats
  const orderStats = await query<{
    count: string;
    total_revenue: string;
    completed_count: string;
  }>(
    `SELECT
       COUNT(*) as count,
       SUM(CASE
         WHEN amount_known AND paid_at IS NOT NULL AND status NOT IN ('refunded', 'cancelled', 'payment_failed')
           THEN amount_cents
         ELSE 0
       END) as total_revenue,
       SUM(CASE WHEN status = 'fulfilled' THEN 1 ELSE 0 END) as completed_count
     FROM orders`
  );

  // Get letter stats
  const letterStats = await query<{ count: string; sent_count: string }>(
    `SELECT
       COUNT(*) as count,
       SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent_count
     FROM letters`
  );

  sendJson(res, 200, {
    users: {
      total: parseInt(userStats.rows[0].count, 10),
      totalCreditsHeld: parseInt(userStats.rows[0].total_credits || '0', 10)
    },
    transactions: {
      totalCreditsPurchased: parseInt(txStats.rows[0].total_purchased || '0', 10),
      totalCreditsUsed: parseInt(txStats.rows[0].total_used || '0', 10)
    },
    orders: {
      total: parseInt(orderStats.rows[0].count || '0', 10),
      completed: parseInt(orderStats.rows[0].completed_count || '0', 10),
      totalRevenueCents: parseInt(orderStats.rows[0].total_revenue || '0', 10)
    },
    letters: {
      total: parseInt(letterStats.rows[0].count || '0', 10),
      sent: parseInt(letterStats.rows[0].sent_count || '0', 10)
    }
  });
}

/**
 * GET /api/admin/jobs
 * List all jobs with pagination and filtering
 */
async function handleGetJobs(res: ServerResponse, queryParams: URLSearchParams) {
  const limit = parseInt(queryParams.get('limit') || '50', 10);
  const offset = parseInt(queryParams.get('offset') || '0', 10);
  const status = queryParams.get('status') || undefined;

  const result = await getAllJobs(limit, offset, status);

  sendJson(res, 200, {
    jobs: result.jobs.map(j => ({
      jobId: j.job_id,
      letterId: j.letter_id,
      status: j.status,
      attempts: j.attempts,
      maxAttempts: j.max_attempts,
      errorMessage: j.error_message,
      scheduledAt: j.scheduled_at,
      startedAt: j.started_at,
      completedAt: j.completed_at,
      createdAt: j.created_at,
      metadata: j.metadata
    })),
    total: result.total,
    limit,
    offset
  });
}

/**
 * GET /api/admin/jobs/:jobId
 * Get specific job details
 */
async function handleGetJobById(res: ServerResponse, jobId: string) {
  const job = await getJobById(jobId);

  if (!job) {
    sendJson(res, 404, {
      error: 'Job not found',
      jobId
    });
    return;
  }

  // Get associated letter
  const letterResult = await query(
    'SELECT * FROM letters WHERE letter_id = $1',
    [job.letter_id]
  );

  sendJson(res, 200, {
    job: {
      jobId: job.job_id,
      letterId: job.letter_id,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
      errorMessage: job.error_message,
      scheduledAt: job.scheduled_at,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      createdAt: job.created_at,
      metadata: job.metadata
    },
    letter: letterResult.rows[0] || null
  });
}

/**
 * GET /api/admin/jobs/user/:userId
 * Get jobs for a specific user
 */
async function handleGetJobsByUser(
  res: ServerResponse,
  userId: string,
  queryParams: URLSearchParams
) {
  const limit = parseInt(queryParams.get('limit') || '50', 10);
  const offset = parseInt(queryParams.get('offset') || '0', 10);

  const result = await getJobsByUserId(userId, limit, offset);

  sendJson(res, 200, {
    userId,
    jobs: result.jobs.map(j => ({
      jobId: j.job_id,
      letterId: j.letter_id,
      status: j.status,
      attempts: j.attempts,
      maxAttempts: j.max_attempts,
      errorMessage: j.error_message,
      scheduledAt: j.scheduled_at,
      startedAt: j.started_at,
      completedAt: j.completed_at,
      createdAt: j.created_at
    })),
    total: result.total,
    limit,
    offset
  });
}

/**
 * GET /api/admin/outbox/jobs
 * View transactional outbox jobs directly (for debugging)
 */
async function handleGetOutboxJobs(res: ServerResponse) {
  const result = await query(`
    SELECT job_id, letter_id, status, attempts, max_attempts,
           next_attempt_at, locked_at, provider_order_id,
           last_error, created_at, updated_at, completed_at
    FROM letter_jobs
    ORDER BY created_at DESC
    LIMIT 50
  `);

  const countResult = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM letter_jobs'
  );

  sendJson(res, 200, {
    jobs: result.rows,
    total: parseInt(countResult.rows[0].count, 10)
  });
}

// =========================================================================
// Promo Campaign Handlers
// =========================================================================

/**
 * POST /api/admin/promo/campaigns
 * Create a new promo campaign
 */
async function handleCreateCampaign(
  req: IncomingMessage,
  res: ServerResponse,
  adminInfo: { userId: string; email?: string }
) {
  const body = await parseBody(req);

  // Validate required fields
  if (!body.code) {
    sendJson(res, 400, { error: 'Missing required field: code' });
    return;
  }
  if (!body.name) {
    sendJson(res, 400, { error: 'Missing required field: name' });
    return;
  }
  if (body.creditsAmount === undefined || typeof body.creditsAmount !== 'number' || body.creditsAmount < 0) {
    sendJson(res, 400, { error: 'creditsAmount must be a non-negative number' });
    return;
  }

  try {
    const campaign = await createCampaign({
      code: body.code,
      name: body.name,
      description: body.description,
      creditsAmount: body.creditsAmount,
      expirationPolicy: body.expirationPolicy,
      expirationDays: body.expirationDays,
      fixedExpirationDate: body.fixedExpirationDate ? new Date(body.fixedExpirationDate) : undefined,
      maxTotalRedemptions: body.maxTotalRedemptions,
      maxPerUser: body.maxPerUser,
      startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
      endsAt: body.endsAt ? new Date(body.endsAt) : undefined,
      requiresNewUser: body.requiresNewUser,
      createdBy: adminInfo.email || adminInfo.userId,
    });

    console.log('📢 Admin created promo campaign');

    sendJson(res, 201, {
      success: true,
      campaign: {
        campaignId: campaign.campaign_id,
        code: campaign.code,
        name: campaign.name,
        description: campaign.description,
        creditsAmount: campaign.credits_amount,
        expirationPolicy: campaign.expiration_policy,
        expirationDays: campaign.expiration_days,
        fixedExpirationDate: campaign.fixed_expiration_date,
        maxTotalRedemptions: campaign.max_total_redemptions,
        maxPerUser: campaign.max_per_user,
        currentRedemptions: campaign.current_redemptions,
        startsAt: campaign.starts_at,
        endsAt: campaign.ends_at,
        requiresNewUser: campaign.requires_new_user,
        status: campaign.status,
        createdBy: campaign.created_by,
        createdAt: campaign.created_at,
      },
    });
  } catch (error: any) {
    if (error.message.includes('duplicate key') || error.message.includes('unique constraint')) {
      sendJson(res, 409, { error: 'A campaign with this code already exists' });
    } else {
      throw error;
    }
  }
}

/**
 * GET /api/admin/promo/campaigns
 * List all campaigns with pagination
 */
async function handleListCampaigns(res: ServerResponse, queryParams: URLSearchParams) {
  const limit = parseInt(queryParams.get('limit') || '50', 10);
  const offset = parseInt(queryParams.get('offset') || '0', 10);
  const statusParam = queryParams.get('status');

  const status = statusParam
    ? (statusParam.split(',') as PromoCampaignStatus[])
    : undefined;

  const result = await listCampaigns({ status, limit, offset });

  sendJson(res, 200, {
    campaigns: result.campaigns.map((c) => ({
      campaignId: c.campaign_id,
      code: c.code,
      name: c.name,
      creditsAmount: c.credits_amount,
      expirationPolicy: c.expiration_policy,
      expirationDays: c.expiration_days,
      maxTotalRedemptions: c.max_total_redemptions,
      maxPerUser: c.max_per_user,
      currentRedemptions: c.current_redemptions,
      startsAt: c.starts_at,
      endsAt: c.ends_at,
      requiresNewUser: c.requires_new_user,
      status: c.status,
      createdAt: c.created_at,
    })),
    total: result.total,
    limit,
    offset,
  });
}

/**
 * GET /api/admin/promo/campaigns/:campaignId
 * Get detailed campaign information
 */
async function handleGetCampaign(res: ServerResponse, campaignId: string) {
  const campaign = await getCampaignById(campaignId);

  if (!campaign) {
    sendJson(res, 404, { error: 'Campaign not found', campaignId });
    return;
  }

  sendJson(res, 200, {
    campaign: {
      campaignId: campaign.campaign_id,
      code: campaign.code,
      name: campaign.name,
      description: campaign.description,
      creditsAmount: campaign.credits_amount,
      expirationPolicy: campaign.expiration_policy,
      expirationDays: campaign.expiration_days,
      fixedExpirationDate: campaign.fixed_expiration_date,
      maxTotalRedemptions: campaign.max_total_redemptions,
      maxPerUser: campaign.max_per_user,
      currentRedemptions: campaign.current_redemptions,
      startsAt: campaign.starts_at,
      endsAt: campaign.ends_at,
      requiresNewUser: campaign.requires_new_user,
      status: campaign.status,
      createdBy: campaign.created_by,
      createdAt: campaign.created_at,
      updatedAt: campaign.updated_at,
    },
  });
}

/**
 * DELETE /api/admin/promo/campaigns/:campaignId
 * Delete a promo campaign (only if no redemptions)
 */
async function handleDeleteCampaign(res: ServerResponse, campaignId: string) {
  const result = await deleteCampaign(campaignId);

  if (!result.success) {
    sendJson(res, 400, { error: result.error });
    return;
  }

  sendJson(res, 200, { success: true, message: 'Campaign deleted' });
}

/**
 * PATCH /api/admin/promo/campaigns/:campaignId/status
 * Update campaign status (draft, active, paused, ended)
 */
async function handleUpdateCampaignStatus(
  req: IncomingMessage,
  res: ServerResponse,
  campaignId: string
) {
  const body = await parseBody(req);

  if (!body.status) {
    sendJson(res, 400, { error: 'Missing required field: status' });
    return;
  }

  const validStatuses: PromoCampaignStatus[] = ['draft', 'active', 'paused', 'ended', 'expired'];
  if (!validStatuses.includes(body.status)) {
    sendJson(res, 400, {
      error: 'Invalid status',
      message: `Status must be one of: ${validStatuses.join(', ')}`,
    });
    return;
  }

  try {
    const campaign = await updateCampaignStatus(campaignId, body.status);

    sendJson(res, 200, {
      success: true,
      campaign: {
        campaignId: campaign.campaign_id,
        code: campaign.code,
        status: campaign.status,
        updatedAt: campaign.updated_at,
      },
    });
  } catch (error: any) {
    if (error.message.includes('Campaign not found')) {
      sendJson(res, 404, { error: 'Campaign not found', campaignId });
    } else {
      throw error;
    }
  }
}

/**
 * GET /api/admin/promo/campaigns/:campaignId/redemptions
 * Get redemptions for a campaign
 */
async function handleGetCampaignRedemptions(
  res: ServerResponse,
  campaignId: string,
  queryParams: URLSearchParams
) {
  const limit = parseInt(queryParams.get('limit') || '50', 10);
  const offset = parseInt(queryParams.get('offset') || '0', 10);

  // Verify campaign exists
  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    sendJson(res, 404, { error: 'Campaign not found', campaignId });
    return;
  }

  const result = await getCampaignRedemptions(campaignId, limit, offset);

  sendJson(res, 200, {
    campaignId,
    campaignCode: campaign.code,
    redemptions: result.redemptions.map((r) => ({
      redemptionId: r.redemption_id,
      userId: r.user_id,
      ledgerId: r.ledger_id,
      redeemedAt: r.redeemed_at,
    })),
    total: result.total,
    limit,
    offset,
  });
}

// =========================================================================
// Stripe Reconciliation Handlers
// =========================================================================

/**
 * GET /api/admin/stripe/reconcile
 * Run Stripe reconciliation to find discrepancies
 *
 * Query params:
 * - days: Number of days to look back (default 30, max 90)
 */
async function handleStripeReconcile(
  res: ServerResponse,
  queryParams: URLSearchParams
) {
  const days = Math.min(parseInt(queryParams.get('days') || '30', 10), 90);

  console.log(`📊 Running Stripe reconciliation for last ${days} days...`);

  try {
    const result = await reconcileStripePayments(days);

    sendJson(res, 200, {
      period: {
        start: result.period.start.toISOString(),
        end: result.period.end.toISOString(),
        days,
      },
      summary: result.summary,
      discrepancies: result.discrepancies.map(d => ({
        type: d.type,
        severity: d.severity,
        expectedCredits: d.expectedCredits,
        actualCredits: d.actualCredits,
        message: d.message,
        suggestedAction: d.suggestedAction,
        // Sensitive operator-only references. This route is admin-authenticated;
        // these values are returned for investigation and must never be logged.
        operatorReference: {
          accountId: d.userId,
          paymentSessionId: d.stripeSessionId,
          ledgerId: d.ledgerId,
        },
      })),
      recommendations: result.recommendations,
    });
  } catch (error: unknown) {
    writeDiagnostic('error', 'credits.reconciliation_failed', {
      errorClass: classifyDiagnosticError(error, 'provider_error')
    });
    sendJson(res, 500, {
      error: 'Reconciliation failed',
      message: 'Unable to reconcile payments',
    });
  }
}

/**
 * POST /api/admin/stripe/reconcile/fix
 * Auto-fix missing credits from Stripe payments
 *
 * Body params:
 * - dryRun: If true (default), only report what would be fixed
 */
async function handleStripeReconcileFix(
  res: ServerResponse,
  body: { dryRun?: boolean },
  adminInfo: { userId: string; email?: string }
) {
  const dryRun = body.dryRun !== false; // Default to dry run for safety

  console.log(`🔧 Admin triggered Stripe reconciliation fix (dryRun=${dryRun})`);

  try {
    const result = await autoFixMissingCredits(dryRun);

    if (dryRun) {
      sendJson(res, 200, {
        mode: 'dry_run',
        message: `Would fix ${result.wouldFix} missing credit entries. Re-run with dryRun: false to apply.`,
        wouldFix: result.wouldFix,
      });
    } else {
      sendJson(res, 200, {
        mode: 'applied',
        message: `Fixed ${result.fixed} of ${result.wouldFix} missing credit entries.`,
        fixed: result.fixed,
        wouldFix: result.wouldFix,
        errors: result.errors,
      });
    }
  } catch (error: unknown) {
    writeDiagnostic('error', 'credits.reconciliation_fix_failed', {
      errorClass: classifyDiagnosticError(error, 'provider_error')
    });
    sendJson(res, 500, {
      error: 'Fix failed',
      message: 'Unable to apply reconciliation fixes',
    });
  }
}

// =========================================================================
// Dashboard & Alerts Handlers
// =========================================================================

/**
 * GET /api/admin/dashboard
 * Comprehensive dashboard data - all metrics in one call
 */
async function handleGetDashboard(res: ServerResponse) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Run all queries in parallel for performance
  const [
    totalUsers,
    newUsersToday,
    newUsers7d,
    newUsers30d,
    creditStats,
    letterStats,
    lettersToday,
    letters7d,
    letters30d,
    revenueStats,
    revenueToday,
    revenue7d,
    revenue30d,
    jobStats,
  ] = await Promise.all([
    // Total users
    query<{ count: string }>('SELECT COUNT(*) as count FROM users'),
    // New users today
    query<{ count: string }>('SELECT COUNT(*) as count FROM users WHERE created_at >= $1', [today]),
    // New users 7d
    query<{ count: string }>('SELECT COUNT(*) as count FROM users WHERE created_at >= $1', [sevenDaysAgo]),
    // New users 30d
    query<{ count: string }>('SELECT COUNT(*) as count FROM users WHERE created_at >= $1', [thirtyDaysAgo]),
    // Credit stats
    query<{ total_held: string; total_purchased: string; total_used: string }>(
      `SELECT
        COALESCE(SUM(credits), 0) as total_held,
        COALESCE(SUM(credits_purchased), 0) as total_purchased,
        COALESCE(SUM(credits_used), 0) as total_used
      FROM users`
    ),
    // Letter stats (total and sent)
    query<{ total: string; sent: string }>(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent
      FROM letters`
    ),
    // Letters today
    query<{ count: string }>('SELECT COUNT(*) as count FROM letters WHERE created_at >= $1', [today]),
    // Letters 7d
    query<{ count: string }>('SELECT COUNT(*) as count FROM letters WHERE created_at >= $1', [sevenDaysAgo]),
    // Letters 30d
    query<{ count: string }>('SELECT COUNT(*) as count FROM letters WHERE created_at >= $1', [thirtyDaysAgo]),
    // Revenue stats (total)
    query<{ total_cents: string; total_orders: string }>(
      `SELECT
        COALESCE(SUM(amount_cents), 0) as total_cents,
        COUNT(*) as total_orders
      FROM orders
      WHERE amount_known AND paid_at IS NOT NULL AND status NOT IN ('refunded', 'cancelled', 'payment_failed')`
    ),
    // Revenue today
    query<{ total_cents: string }>("SELECT COALESCE(SUM(amount_cents), 0) as total_cents FROM orders WHERE amount_known AND paid_at >= $1 AND status NOT IN ('refunded', 'cancelled', 'payment_failed')", [today]),
    // Revenue 7d
    query<{ total_cents: string }>("SELECT COALESCE(SUM(amount_cents), 0) as total_cents FROM orders WHERE amount_known AND paid_at >= $1 AND status NOT IN ('refunded', 'cancelled', 'payment_failed')", [sevenDaysAgo]),
    // Revenue 30d
    query<{ total_cents: string }>("SELECT COALESCE(SUM(amount_cents), 0) as total_cents FROM orders WHERE amount_known AND paid_at >= $1 AND status NOT IN ('refunded', 'cancelled', 'payment_failed')", [thirtyDaysAgo]),
    // Job stats
    query<{ status: string; count: string }>(
      `SELECT status, COUNT(*) as count FROM letter_jobs GROUP BY status`
    ),
  ]);

  // Parse job stats
  const jobStatsByStatus: Record<string, number> = {};
  for (const row of jobStats.rows) {
    jobStatsByStatus[row.status] = parseInt(row.count, 10);
  }

  sendJson(res, 200, {
    generatedAt: now.toISOString(),
    users: {
      total: parseInt(totalUsers.rows[0].count, 10),
      newToday: parseInt(newUsersToday.rows[0].count, 10),
      new7d: parseInt(newUsers7d.rows[0].count, 10),
      new30d: parseInt(newUsers30d.rows[0].count, 10),
    },
    credits: {
      totalHeld: parseInt(creditStats.rows[0].total_held || '0', 10),
      totalPurchased: parseInt(creditStats.rows[0].total_purchased || '0', 10),
      totalUsed: parseInt(creditStats.rows[0].total_used || '0', 10),
    },
    letters: {
      total: parseInt(letterStats.rows[0].total || '0', 10),
      sent: parseInt(letterStats.rows[0].sent || '0', 10),
      today: parseInt(lettersToday.rows[0].count, 10),
      last7d: parseInt(letters7d.rows[0].count, 10),
      last30d: parseInt(letters30d.rows[0].count, 10),
    },
    revenue: {
      totalCents: parseInt(revenueStats.rows[0].total_cents || '0', 10),
      totalOrders: parseInt(revenueStats.rows[0].total_orders || '0', 10),
      todayCents: parseInt(revenueToday.rows[0].total_cents || '0', 10),
      last7dCents: parseInt(revenue7d.rows[0].total_cents || '0', 10),
      last30dCents: parseInt(revenue30d.rows[0].total_cents || '0', 10),
    },
    jobs: {
      pending: jobStatsByStatus['pending'] || 0,
      processing: jobStatsByStatus['processing'] || 0,
      completed: jobStatsByStatus['completed'] || 0,
      failed: jobStatsByStatus['failed'] || 0,
      cancelled: jobStatsByStatus['cancelled'] || 0,
    },
  });
}

/**
 * GET /api/admin/alerts
 * Active alerts requiring attention
 */
async function handleGetAlerts(res: ServerResponse) {
  const alerts: Array<{
    type: string;
    severity: 'critical' | 'warning' | 'info';
    title: string;
    message: string;
    data?: any;
  }> = [];

  // Failed jobs
  const failedJobs = await query<{ job_id: string; letter_id: string; error_message: string; attempts: number }>(
    `SELECT job_id, letter_id, error_message, attempts
     FROM letter_jobs
     WHERE status = 'failed'
     ORDER BY created_at DESC
     LIMIT 10`
  );

  if (failedJobs.rows.length > 0) {
    alerts.push({
      type: 'failed_jobs',
      severity: 'critical',
      title: 'Failed Letter Jobs',
      message: `${failedJobs.rows.length} letter job(s) have failed and need attention.`,
      data: failedJobs.rows,
    });
  }

  // Expiring credits (next 7 days)
  const expiringCredits = await query<{ user_id: string; total_expiring: string; earliest_expiry: Date }>(
    `SELECT
      user_id,
      SUM(remaining_amount) as total_expiring,
      MIN(expires_at) as earliest_expiry
     FROM credit_ledger
     WHERE status = 'active'
       AND expires_at IS NOT NULL
       AND expires_at < NOW() + INTERVAL '7 days'
       AND remaining_amount > 0
     GROUP BY user_id
     ORDER BY earliest_expiry ASC
     LIMIT 10`
  );

  if (expiringCredits.rows.length > 0) {
    alerts.push({
      type: 'expiring_credits',
      severity: 'warning',
      title: 'Credits Expiring Soon',
      message: `${expiringCredits.rows.length} user(s) have credits expiring in the next 7 days.`,
      data: expiringCredits.rows,
    });
  }

  // Stuck jobs (processing for > 10 minutes)
  const stuckJobs = await query<{ job_id: string; letter_id: string; started_at: Date }>(
    `SELECT job_id, letter_id, started_at
     FROM letter_jobs
     WHERE status = 'processing'
       AND started_at < NOW() - INTERVAL '10 minutes'
     ORDER BY started_at ASC
     LIMIT 10`
  );

  if (stuckJobs.rows.length > 0) {
    alerts.push({
      type: 'stuck_jobs',
      severity: 'warning',
      title: 'Stuck Jobs',
      message: `${stuckJobs.rows.length} job(s) have been processing for over 10 minutes.`,
      data: stuckJobs.rows,
    });
  }

  const operational = await query<{
    alert_id: string; order_id: string | null; alert_type: string;
    severity: 'critical' | 'warning' | 'info'; status: string;
    details: Record<string, unknown>; created_at: Date;
  }>(
    `SELECT alert_id, order_id, alert_type, severity, status, details, created_at
     FROM commerce_operational_alerts WHERE status <> 'resolved'
     ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
              created_at ASC LIMIT 50`
  );
  if (operational.rows.length > 0) {
    alerts.push({
      type: 'commerce_operations',
      severity: operational.rows.some(row => row.severity === 'critical') ? 'critical' : 'warning',
      title: 'Commerce operational work',
      message: `${operational.rows.length} durable commerce alert(s) require review.`,
      data: operational.rows,
    });
  }

  sendJson(res, 200, {
    generatedAt: new Date().toISOString(),
    alertCount: alerts.length,
    alerts,
  });
}

/**
 * GET /api/admin/users/search
 * Search users by email or ID
 */
async function handleSearchUsers(res: ServerResponse, queryParams: URLSearchParams) {
  const q = queryParams.get('q') || '';
  const limit = Math.min(parseInt(queryParams.get('limit') || '20', 10), 100);

  if (!q || q.length < 2) {
    sendJson(res, 400, { error: 'Search query must be at least 2 characters' });
    return;
  }

  const result = await query<{
    user_id: string;
    email: string;
    credits: number;
    credits_purchased: number;
    credits_used: number;
    image_generations_used: number;
    tier: string;
    created_at: Date;
  }>(
    `SELECT user_id, email, credits, credits_purchased, credits_used, image_generations_used, tier, created_at
     FROM users
     WHERE user_id ILIKE $1 OR email ILIKE $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [`%${q}%`, limit]
  );

  sendJson(res, 200, {
    query: q,
    count: result.rows.length,
    users: result.rows.map(u => ({
      userId: u.user_id,
      email: u.email,
      credits: u.credits,
      creditsPurchased: u.credits_purchased,
      creditsUsed: u.credits_used,
      imageGenerationsUsed: u.image_generations_used,
      tier: u.tier,
      createdAt: u.created_at,
    })),
  });
}

/**
 * GET /api/admin/letters
 * List letters with filters
 */
async function handleGetLetters(res: ServerResponse, queryParams: URLSearchParams) {
  const limit = Math.min(parseInt(queryParams.get('limit') || '50', 10), 100);
  const offset = parseInt(queryParams.get('offset') || '0', 10);
  const status = queryParams.get('status');
  const userId = queryParams.get('userId');

  let whereClause = 'WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;

  if (status) {
    whereClause += ` AND status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }

  if (userId) {
    whereClause += ` AND user_id = $${paramIndex}`;
    params.push(userId);
    paramIndex++;
  }

  const [lettersResult, countResult] = await Promise.all([
    query(
      `SELECT letter_id, user_id, recipient, credits_cost, status, tracking_id, provider, created_at, sent_at
       FROM letters
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM letters ${whereClause}`,
      params
    ),
  ]);

  sendJson(res, 200, {
    letters: lettersResult.rows.map((l: any) => ({
      letterId: l.letter_id,
      userId: l.user_id,
      recipient: l.recipient,
      creditsCost: l.credits_cost,
      status: l.status,
      trackingId: l.tracking_id,
      provider: l.provider,
      createdAt: l.created_at,
      sentAt: l.sent_at,
    })),
    total: parseInt(countResult.rows[0].count, 10),
    limit,
    offset,
  });
}

/**
 * GET /api/admin/letters/search
 * Search letters by ID or recipient
 */
async function handleSearchLetters(res: ServerResponse, queryParams: URLSearchParams) {
  const q = queryParams.get('q') || '';
  const limit = Math.min(parseInt(queryParams.get('limit') || '20', 10), 100);

  if (!q || q.length < 2) {
    sendJson(res, 400, { error: 'Search query must be at least 2 characters' });
    return;
  }

  const result = await query(
    `SELECT letter_id, user_id, recipient, credits_cost, status, tracking_id, provider, created_at, sent_at
     FROM letters
     WHERE letter_id ILIKE $1
       OR user_id ILIKE $1
       OR recipient::text ILIKE $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [`%${q}%`, limit]
  );

  sendJson(res, 200, {
    query: q,
    count: result.rows.length,
    letters: result.rows.map((l: any) => ({
      letterId: l.letter_id,
      userId: l.user_id,
      recipient: l.recipient,
      creditsCost: l.credits_cost,
      status: l.status,
      trackingId: l.tracking_id,
      provider: l.provider,
      createdAt: l.created_at,
      sentAt: l.sent_at,
    })),
  });
}

/**
 * GET /api/admin/letters/:letterId
 * Get letter details with job history and status history
 */
async function handleGetLetterById(res: ServerResponse, letterId: string) {
  const [letterResult, jobsResult, statusHistoryResult] = await Promise.all([
    query(
      `SELECT * FROM letters WHERE letter_id = $1`,
      [letterId]
    ),
    query(
      `SELECT * FROM letter_jobs WHERE letter_id = $1 ORDER BY created_at DESC`,
      [letterId]
    ),
    query(
      `SELECT old_status, new_status, provider_raw_status, source, changed_at
       FROM letter_status_history
       WHERE letter_id = $1
       ORDER BY changed_at ASC`,
      [letterId]
    ),
  ]);

  if (letterResult.rows.length === 0) {
    sendJson(res, 404, { error: 'Letter not found', letterId });
    return;
  }

  const letter = letterResult.rows[0] as any;

  sendJson(res, 200, {
    letter: {
      letterId: letter.letter_id,
      userId: letter.user_id,
      sender: letter.sender,
      recipient: letter.recipient,
      bodyText: letter.body_text,
      signOff: letter.sign_off,
      creditsCost: letter.credits_cost,
      status: letter.status,
      statusUpdatedAt: letter.status_updated_at,
      providerRawStatus: letter.provider_raw_status,
      previewHtml: letter.preview_html,
      trackingId: letter.tracking_id,
      provider: letter.provider,
      providerLetterId: letter.provider_letter_id,
      expectedDelivery: letter.expected_delivery,
      createdAt: letter.created_at,
      sentAt: letter.sent_at,
      updatedAt: letter.updated_at,
    },
    jobs: jobsResult.rows.map((j: any) => ({
      jobId: j.job_id,
      status: j.status,
      attempts: j.attempts,
      maxAttempts: j.max_attempts,
      errorMessage: j.error_message,
      scheduledAt: j.scheduled_at,
      startedAt: j.started_at,
      completedAt: j.completed_at,
      createdAt: j.created_at,
      metadata: j.metadata,
    })),
    statusHistory: statusHistoryResult.rows.map((h: any) => ({
      oldStatus: h.old_status,
      newStatus: h.new_status,
      providerRawStatus: h.provider_raw_status,
      source: h.source,
      changedAt: h.changed_at,
    })),
  });
}

/**
 * POST /api/admin/jobs/:jobId/retry
 * Retry a failed job
 */
async function handleRetryJob(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  adminInfo: { userId: string; email?: string }
) {
  const body = await parseBody(req);
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  const expectedUserId = typeof body.userId === 'string' ? body.userId : '';
  if (!expectedUserId || reason.length < 8 || reason.length > 500 || !OPERATOR_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    sendJson(res, 400, { error: 'A reason and valid idempotency key are required' });
    return;
  }
  try {
    const result = await retryLetterJobAsAdmin({
      jobId, expectedUserId, actorId: adminInfo.userId, reason, idempotencyKey
    });
    sendJson(res, 200, { success: true, ...result });
  } catch (error) {
    if (error instanceof AdminJobRetryError) {
      sendJson(res, error.code === 'not_found' ? 404 : 409, { error: error.code });
      return;
    }
    throw error;
  }
}

async function handleResolveAmbiguousJob(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  adminInfo: { userId: string }
) {
  const body = await parseBody(req);
  const expectedUserId = typeof body.userId === 'string' ? body.userId : '';
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  const decision = body.decision === 'accepted' || body.decision === 'retry' ||
    body.decision === 'rejected'
    ? body.decision
    : null;
  const resolution = body.resolution === 'provider_confirmed_accepted' ||
    body.resolution === 'provider_confirmed_rejected_retry' ||
    body.resolution === 'provider_confirmed_rejected_refund' ? body.resolution : null;
  const providerName = body.providerName === 'postgrid' || body.providerName === 'dummy' ||
    body.providerName === 'diy' ? body.providerName : null;
  const providerTrackingId = typeof body.providerTrackingId === 'string'
    ? body.providerTrackingId
    : undefined;
  if (!UUID_PATTERN.test(jobId) || !expectedUserId || expectedUserId.length > 255 ||
      !OPERATOR_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey) || !decision || !resolution ||
      !providerName) {
    sendJson(res, 400, { error: 'Invalid ambiguous mail resolution request' });
    return;
  }
  try {
    const result = await resolveAmbiguousLetterJobAsAdmin({
      jobId,
      expectedUserId,
      actorId: adminInfo.userId,
      idempotencyKey,
      decision,
      resolution,
      providerName,
      providerTrackingId
    });
    sendJson(res, 200, { success: true, ...result });
  } catch (error) {
    if (error instanceof AdminMailResolutionError) {
      const statusCode = error.code === 'not_found' ? 404 : error.code === 'invalid_request' ? 400 : 409;
      sendJson(res, statusCode, { error: error.code });
      return;
    }
    throw error;
  }
}

export interface CommerceAlertTransition {
  alertId: string;
  status: 'acknowledged' | 'resolved';
  /** Required when resolving; ignored on acknowledge. */
  resolutionCode?: string;
  idempotencyKey: string;
  actorId: string;
}

/**
 * Move one commerce alert to acknowledged or resolved.
 *
 * Separated from the HTTP handler so the transition can be exercised without a
 * request. The handler above it owns parsing, validation and status codes; this
 * owns the state machine and the audit trail. Issue #189: the statement below
 * was rejected by PostgreSQL on every call, and nothing could reach it to
 * notice - the admin surface is local-only and 404s everywhere else, so no test
 * and no deployed environment ever executed it.
 *
 * Throws Error('not_found' | 'invalid_state' | 'idempotency_conflict'), which
 * the handler maps to status codes.
 */
export async function transitionCommerceAlert(
  params: CommerceAlertTransition
): Promise<{ replayed: boolean }> {
  const { alertId, status, idempotencyKey, actorId } = params;
  const resolutionCode = params.resolutionCode || '';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  return transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [idempotencyKey]);
      const replay = await client.query<{
        operation: string; target_type: string; target_reference_hash: string;
        actor_subject_hash: string; reason_code: string; requested_status: string;
      }>(
        `SELECT operation, target_type, target_reference_hash, actor_subject_hash,
                reason_code, after_state->>'status' AS requested_status
         FROM commerce_operator_audit_events
         WHERE idempotency_key_hash = $1`, [hash(idempotencyKey)]
      );
      if (replay.rows[0]) {
        const existing = replay.rows[0];
        if (existing.operation !== 'commerce_alert_transition' ||
            existing.target_type !== 'commerce_alert' ||
            existing.target_reference_hash !== hash(alertId) ||
            existing.actor_subject_hash !== hash(actorId) ||
            existing.reason_code !== (resolutionCode || 'operator_acknowledged') ||
            existing.requested_status !== status) {
          throw new Error('idempotency_conflict');
        }
        return { replayed: true };
      }
      const locked = await client.query<{ status: string; severity: string; alert_type: string }>(
        `SELECT status, severity, alert_type FROM commerce_operational_alerts
         WHERE alert_id = $1 FOR UPDATE`, [alertId]
      );
      const current = locked.rows[0];
      if (!current) throw new Error('not_found');
      if (current.status === 'resolved' || (status === 'acknowledged' && current.status !== 'open')) {
        throw new Error('invalid_state');
      }
      // Every use of $2 is cast. Assigning it to status (a VARCHAR column)
      // deduces varchar while comparing it to an untyped literal deduces text,
      // and PostgreSQL rejects the statement outright with "inconsistent types
      // deduced for parameter $2" - so this threw on EVERY acknowledge and
      // EVERY resolve, and the audit insert below it never ran either.
      //
      // The resolved_* branches keep their ELSE NULL, which reads odd next to
      // the acknowledged_* branches but is what the table requires:
      // valid_commerce_alert_resolution permits an acknowledged row only while
      // resolved_at IS NULL. Preserving those columns on an acknowledge would
      // put the row in a state the CHECK rejects.
      await client.query(
        `UPDATE commerce_operational_alerts SET status = $2::varchar,
           acknowledged_at = CASE WHEN $2::varchar = 'acknowledged' THEN NOW() ELSE acknowledged_at END,
           acknowledged_by_actor_hash = CASE WHEN $2::varchar = 'acknowledged' THEN $3 ELSE acknowledged_by_actor_hash END,
           resolved_at = CASE WHEN $2::varchar = 'resolved' THEN NOW() ELSE NULL END,
           resolved_by_actor_hash = CASE WHEN $2::varchar = 'resolved' THEN $3 ELSE NULL END,
           resolution_code = CASE WHEN $2::varchar = 'resolved' THEN $4 ELSE NULL END,
           updated_at = NOW() WHERE alert_id = $1`,
        [alertId, status, hash(actorId), resolutionCode || null]
      );
      await client.query(
        `INSERT INTO commerce_operator_audit_events
           (idempotency_key_hash, actor_subject_hash, operation, target_type,
            target_reference_hash, reason_code, before_state, after_state)
         VALUES ($1, $2, 'commerce_alert_transition', 'commerce_alert', $3, $4, $5, $6)`,
        [hash(idempotencyKey), hash(actorId), hash(alertId),
          resolutionCode || 'operator_acknowledged',
          JSON.stringify({ status: current.status, severity: current.severity, type: current.alert_type }),
          JSON.stringify({ status, severity: current.severity, type: current.alert_type })]
      );
      return { replayed: false };
  });
}

async function handleTransitionCommerceAlert(
  req: IncomingMessage,
  res: ServerResponse,
  alertId: string,
  adminInfo: { userId: string }
) {
  const body = await parseBody(req);
  const status = body.status === 'acknowledged' || body.status === 'resolved' ? body.status : null;
  const resolutionCode = typeof body.resolutionCode === 'string' ? body.resolutionCode : '';
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  if (!UUID_PATTERN.test(alertId) || !status || !OPERATOR_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey) ||
      (status === 'resolved' && !/^[a-z][a-z0-9_]{2,79}$/.test(resolutionCode))) {
    sendJson(res, 400, { error: 'Invalid alert transition request' });
    return;
  }
  try {
    const result = await transitionCommerceAlert({
      alertId,
      status,
      resolutionCode,
      idempotencyKey,
      actorId: adminInfo.userId
    });
    sendJson(res, 200, { success: true, status, ...result });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'transition_failed';
    sendJson(res, code === 'not_found' ? 404 : 409, { error: code });
  }
}

// =========================================================================
// Status Sync Handlers
// =========================================================================

/**
 * GET /api/admin/sync/statuses
 * Run status sync in dry run mode (show what would be updated)
 */
async function handleStatusSyncDryRun(
  res: ServerResponse,
  queryParams: URLSearchParams
) {
  const maxAge = parseInt(queryParams.get('maxAge') || '30', 10);

  console.log(`📊 Running status sync dry run (maxAge: ${maxAge} days)...`);

  try {
    const result = await syncLetterStatuses(true, maxAge);

    sendJson(res, 200, {
      mode: 'dry_run',
      message: `Would update ${result.updated} of ${result.checked} letters. Use POST to apply changes.`,
      checked: result.checked,
      wouldUpdate: result.updated,
      errors: result.errors,
      details: result.details,
    });
  } catch (error: any) {
    console.error('Status sync dry run failed');
    sendJson(res, 500, {
      error: 'Sync dry run failed',
      message: 'Unable to run status sync preview',
    });
  }
}

/**
 * POST /api/admin/sync/statuses
 * Run actual status sync
 */
async function handleStatusSync(res: ServerResponse) {
  console.log(`📊 Running status sync...`);

  try {
    const result = await syncLetterStatuses(false, 30);

    sendJson(res, 200, {
      mode: 'applied',
      message: `Updated ${result.updated} of ${result.checked} letters.`,
      checked: result.checked,
      updated: result.updated,
      errors: result.errors,
      details: result.details,
    });
  } catch (error: any) {
    console.error('Status sync failed');
    sendJson(res, 500, {
      error: 'Sync failed',
      message: 'Unable to run status sync',
    });
  }
}

/**
 * GET /api/admin/sync/stuck
 * Get letters stuck in non-terminal status
 */
async function handleGetStuckLetters(
  res: ServerResponse,
  queryParams: URLSearchParams
) {
  const maxDays = parseInt(queryParams.get('maxDays') || '14', 10);

  try {
    const stuckLetters = await getStuckLetters(maxDays);

    sendJson(res, 200, {
      maxDaysInNonTerminal: maxDays,
      count: stuckLetters.length,
      letters: stuckLetters.map(l => ({
        letterId: l.letter_id,
        trackingId: l.tracking_id,
        status: l.status,
        createdAt: l.created_at,
        daysInStatus: l.days_in_status,
      })),
    });
  } catch (error: any) {
    console.error('Get stuck letters failed');
    sendJson(res, 500, {
      error: 'Failed to get stuck letters',
      message: 'Unable to retrieve stuck letters',
    });
  }
}

// =========================================================================
// PAT Stats Handlers
// =========================================================================

/**
 * GET /api/admin/tokens/stats
 * Get Personal Access Token usage statistics
 */
async function handleGetTokenStats(res: ServerResponse) {
  try {
    const stats = await getTokenStats();

    sendJson(res, 200, {
      generatedAt: new Date().toISOString(),
      tokens: {
        total: stats.total,
        active: stats.active,
        revoked: stats.revoked,
      },
      usage: {
        usedToday: stats.usedToday,
        usedLast7Days: stats.usedLast7Days,
      },
    });
  } catch (error: any) {
    writeDiagnostic('error', 'auth.pat_stats_failed', {
      errorClass: classifyDiagnosticError(error, 'database_error')
    });
    sendJson(res, 500, {
      error: 'Failed to get token stats',
      message: 'Unable to retrieve token stats',
    });
  }
}

// =========================================================================
// Rate Limiting Stats Handlers
// =========================================================================

/**
 * GET /api/admin/ratelimit/stats
 * Get rate limiting statistics including current counters and blocked request counts
 */
async function handleGetRateLimitStats(res: ServerResponse) {
  try {
    const stats = getRateLimitStats();
    const blockedCounts = getBlockedRequestCounts();

    // Get configured limits for reference
    const configuredLimits: Record<string, { windowMs: number; maxRequests: number }> = {};
    for (const [key, config] of Object.entries(RATE_LIMITS)) {
      configuredLimits[key] = {
        windowMs: config.windowMs,
        maxRequests: config.maxRequests,
      };
    }

    sendJson(res, 200, {
      generatedAt: new Date().toISOString(),
      currentState: {
        totalActiveEntries: stats.totalEntries,
        entriesByEndpoint: stats.entriesByType,
      },
      blockedRequests: blockedCounts,
      configuredLimits,
    });
  } catch (error: any) {
    console.error('Get rate limit stats failed');
    sendJson(res, 500, {
      error: 'Failed to get rate limit stats',
      message: 'Unable to retrieve rate limit stats',
    });
  }
}

// =========================================================================
// Provider Routing Handlers
// =========================================================================

/**
 * GET /api/admin/routing
 * List all provider routing rules
 */
async function handleGetRouting(res: ServerResponse) {
  try {
    const result = await query(`
      SELECT
        id,
        mail_type,
        provider,
        enabled,
        updated_at,
        updated_by
      FROM provider_routing
      ORDER BY mail_type
    `);

    sendJson(res, 200, {
      routing: result.rows.map(row => ({
        id: row.id,
        mailType: row.mail_type,
        provider: row.provider,
        enabled: row.enabled,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      })),
    });
  } catch (error: any) {
    console.error('Get routing failed');
    sendJson(res, 500, {
      error: 'Failed to get routing rules',
      message: 'Unable to retrieve routing rules',
    });
  }
}

/**
 * PUT /api/admin/routing/:mailType
 * Update provider routing for a specific mail type
 */
async function handleUpdateRouting(
  req: IncomingMessage,
  res: ServerResponse,
  mailType: string,
  adminInfo: { userId: string; email?: string }
) {
  try {
    const body = await parseBody(req);

    // Validate mail type
    const validMailTypes = ['text_only_letter', 'header_image_letter', 'inline_image_letter', 'postcard'];
    if (!validMailTypes.includes(mailType)) {
      sendJson(res, 400, {
        error: 'Invalid mail type',
        message: `Mail type must be one of: ${validMailTypes.join(', ')}`,
      });
      return;
    }

    // Validate provider
    const validProviders = ['postgrid', 'diy', 'lob', 'dummy'];
    if (!body.provider || !validProviders.includes(body.provider)) {
      sendJson(res, 400, {
        error: 'Invalid provider',
        message: `Provider must be one of: ${validProviders.join(', ')}`,
      });
      return;
    }

    // Update routing
    const result = await query(
      `UPDATE provider_routing
       SET provider = $1, enabled = $2, updated_by = $3
       WHERE mail_type = $4
       RETURNING *`,
      [
        body.provider,
        body.enabled !== false, // Default to true if not specified
        adminInfo.email || adminInfo.userId,
        mailType,
      ]
    );

    if (result.rows.length === 0) {
      sendJson(res, 404, {
        error: 'Routing not found',
        message: `No routing rule found for mail type: ${mailType}`,
      });
      return;
    }

    const row = result.rows[0];
    console.log(`🔧 Admin updated routing: ${mailType} → ${body.provider}`);

    sendJson(res, 200, {
      success: true,
      routing: {
        id: row.id,
        mailType: row.mail_type,
        provider: row.provider,
        enabled: row.enabled,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      },
    });
  } catch (error: unknown) {
    writeDiagnostic('error', 'admin.routing_update_failed', {
      errorClass: classifyDiagnosticError(error, 'database_error')
    });
    sendJson(res, 500, {
      error: 'Failed to update routing',
      message: 'Unable to update routing',
    });
  }
}

/**
 * GET /api/admin/providers
 * List available providers with their status
 */
async function handleGetProviders(res: ServerResponse) {
  try {
    // Get environment configuration
    const currentProvider = process.env.LETTER_PROVIDER || 'postgrid';
    const postgridConfigured = !!(process.env.POSTGRID_API_KEY);
    const diyServiceUrl = process.env.DIY_SERVICE_URL;
    const lobConfigured = !!(process.env.LOB_API_KEY);

    const providers = [
      {
        id: 'postgrid',
        name: 'PostGrid',
        description: 'Third-party print and mail API',
        configured: postgridConfigured,
        status: postgridConfigured ? 'available' : 'not_configured',
        isDefault: currentProvider === 'postgrid',
      },
      {
        id: 'diy',
        name: 'DIY',
        description: 'Manual print fulfillment service',
        configured: !!diyServiceUrl,
        status: diyServiceUrl ? 'available' : 'not_configured',
        serviceUrl: diyServiceUrl || null,
        isDefault: currentProvider === 'diy',
      },
      {
        id: 'lob',
        name: 'Lob',
        description: 'Third-party print and mail API (alternative)',
        configured: lobConfigured,
        status: lobConfigured ? 'available' : 'not_configured',
        isDefault: currentProvider === 'lob',
      },
      {
        id: 'dummy',
        name: 'Dummy',
        description: 'Testing only - does not send mail',
        configured: true,
        status: 'available',
        isDefault: currentProvider === 'dummy',
      },
    ];

    sendJson(res, 200, {
      defaultProvider: currentProvider,
      providers,
    });
  } catch (error: any) {
    console.error('Get providers failed');
    sendJson(res, 500, {
      error: 'Failed to get providers',
      message: 'Unable to retrieve providers',
    });
  }
}
