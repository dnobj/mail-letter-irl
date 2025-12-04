/**
 * Admin API Request Handler
 *
 * Handles admin-only API routes:
 * - POST /api/admin/credits/adjust - Manually adjust user credits
 * - GET /api/admin/users/:userId - Get user details
 * - GET /api/admin/stats - Get system statistics
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { authenticateAdmin } from './middleware/adminAuth.js';
import { adjustCredits } from '../services/creditService.js';
import { getUser, getAllUsers } from '../services/userService.js';
import { getAllJobs, getJobById, getJobsByUserId } from '../services/letterJobService.js';
import { query } from '../db/index.js';
import {
  createCampaign,
  getCampaignById,
  listCampaigns,
  updateCampaignStatus,
  getCampaignRedemptions,
} from '../services/promoService.js';
import type { PromoCampaignStatus } from '../services/types.js';
import {
  reconcileStripePayments,
  autoFixMissingCredits,
} from '../services/stripeReconciliationService.js';

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

  // Authenticate and verify admin status
  const adminInfo = await authenticateAdmin(req, res);
  if (!adminInfo) {
    return true; // Auth failed, response already sent
  }

  // Route handlers
  try {
    console.log(`🔍 Admin API: ${req.method} ${pathname}`);

    // POST /api/admin/credits/adjust
    if (pathname === '/api/admin/credits/adjust' && req.method === 'POST') {
      await handleAdjustCredits(req, res, adminInfo);
      return true;
    }

    // GET /api/admin/users/:userId
    if (pathname.startsWith('/api/admin/users/') && req.method === 'GET') {
      const userId = pathname.split('/').pop();
      console.log(`🔍 Extracted userId from pathname: "${userId}"`);
      if (userId) {
        // Decode the userId (pathname is not auto-decoded in our setup)
        const decodedUserId = decodeURIComponent(userId);
        console.log(`🔍 Decoded userId: "${decodedUserId}"`);
        await handleGetUser(res, decodedUserId);
        return true;
      }
    }

    // GET /api/admin/stats
    if (pathname === '/api/admin/stats' && req.method === 'GET') {
      await handleGetStats(res);
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

    // GET /api/admin/pgboss/jobs - View pg-boss jobs directly
    if (pathname === '/api/admin/pgboss/jobs' && req.method === 'GET') {
      await handleGetPgBossJobs(res);
      return true;
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

    // Route not found
    sendJson(res, 404, {
      error: 'Not found',
      message: `Admin route not found: ${req.method} ${pathname}`
    });
    return true;

  } catch (error) {
    console.error('Admin API error:', error);
    sendJson(res, 500, {
      error: 'Internal server error',
      message: error.message
    });
    return true;
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

  console.log(`🔧 Admin ${adminInfo.userId} adjusted ${body.amount} credits for ${body.userId}`);

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

    sendJson(res, 200, {
      user: {
        userId: user.user_id,
        email: user.email,
        credits: user.credits,
        creditsPurchased: user.credits_purchased,
        creditsUsed: user.credits_used,
        createdAt: user.created_at,
        updatedAt: user.updated_at
      },
      stats: {
        totalLetters: parseInt(letterResult.rows[0].count),
        recentTransactions: txResult.rows
      }
    });
  } catch (error) {
    if (error.message.includes('User not found')) {
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
  const limit = parseInt(queryParams.get('limit') || '50');
  const offset = parseInt(queryParams.get('offset') || '0');

  const result = await getAllUsers(limit, offset);

  sendJson(res, 200, {
    users: result.users.map(u => ({
      userId: u.user_id,
      email: u.email,
      credits: u.credits,
      creditsPurchased: u.credits_purchased,
      creditsUsed: u.credits_used,
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
       SUM(amount_cents) as total_revenue,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count
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
      total: parseInt(userStats.rows[0].count),
      totalCreditsHeld: parseInt(userStats.rows[0].total_credits || '0')
    },
    transactions: {
      totalCreditsPurchased: parseInt(txStats.rows[0].total_purchased || '0'),
      totalCreditsUsed: parseInt(txStats.rows[0].total_used || '0')
    },
    orders: {
      total: parseInt(orderStats.rows[0].count || '0'),
      completed: parseInt(orderStats.rows[0].completed_count || '0'),
      totalRevenueCents: parseInt(orderStats.rows[0].total_revenue || '0')
    },
    letters: {
      total: parseInt(letterStats.rows[0].count || '0'),
      sent: parseInt(letterStats.rows[0].sent_count || '0')
    }
  });
}

/**
 * GET /api/admin/jobs
 * List all jobs with pagination and filtering
 */
async function handleGetJobs(res: ServerResponse, queryParams: URLSearchParams) {
  const limit = parseInt(queryParams.get('limit') || '50');
  const offset = parseInt(queryParams.get('offset') || '0');
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
  const limit = parseInt(queryParams.get('limit') || '50');
  const offset = parseInt(queryParams.get('offset') || '0');

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
 * GET /api/admin/pgboss/jobs
 * View pg-boss jobs directly (for debugging)
 */
async function handleGetPgBossJobs(res: ServerResponse) {
  const result = await query(`
    SELECT
      id, name, state, priority,
      retry_limit, retry_count, start_after,
      created_on, started_on, completed_on
    FROM pgboss.job
    ORDER BY created_on DESC
    LIMIT 50
  `);

  const countResult = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM pgboss.job'
  );

  sendJson(res, 200, {
    jobs: result.rows,
    total: parseInt(countResult.rows[0].count)
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
  if (!body.creditsAmount || typeof body.creditsAmount !== 'number' || body.creditsAmount <= 0) {
    sendJson(res, 400, { error: 'creditsAmount must be a positive number' });
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

    console.log(`📢 Admin ${adminInfo.userId} created promo campaign: ${campaign.code}`);

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
  const limit = parseInt(queryParams.get('limit') || '50');
  const offset = parseInt(queryParams.get('offset') || '0');
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
  const limit = parseInt(queryParams.get('limit') || '50');
  const offset = parseInt(queryParams.get('offset') || '0');

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
  const days = Math.min(parseInt(queryParams.get('days') || '30'), 90);

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
        stripeSessionId: d.stripeSessionId,
        userId: d.userId,
        stripeAmount: d.stripeAmount,
        expectedCredits: d.expectedCredits,
        actualCredits: d.actualCredits,
        message: d.message,
        suggestedAction: d.suggestedAction,
      })),
      recommendations: result.recommendations,
    });
  } catch (error: any) {
    console.error('Stripe reconciliation error:', error);
    sendJson(res, 500, {
      error: 'Reconciliation failed',
      message: error.message,
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

  console.log(`🔧 Admin ${adminInfo.userId} triggered Stripe reconciliation fix (dryRun=${dryRun})`);

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
  } catch (error: any) {
    console.error('Stripe reconciliation fix error:', error);
    sendJson(res, 500, {
      error: 'Fix failed',
      message: error.message,
    });
  }
}
