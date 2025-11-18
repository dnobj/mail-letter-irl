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
    // POST /api/admin/credits/adjust
    if (pathname === '/api/admin/credits/adjust' && req.method === 'POST') {
      await handleAdjustCredits(req, res, adminInfo);
      return true;
    }

    // GET /api/admin/users/:userId
    if (pathname.startsWith('/api/admin/users/') && req.method === 'GET') {
      const userId = pathname.split('/').pop();
      if (userId) {
        await handleGetUser(res, userId);
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
        await handleGetJobById(res, jobId);
        return true;
      }
    }

    // GET /api/admin/jobs/user/:userId - Get jobs by user
    if (pathname.match(/^\/api\/admin\/jobs\/user\/[^/]+$/) && req.method === 'GET') {
      const userId = pathname.split('/').pop();
      const url = new URL(req.url!, `http://${req.headers.host}`);
      if (userId) {
        await handleGetJobsByUser(res, userId, url.searchParams);
        return true;
      }
    }

    // GET /api/admin/pgboss/jobs - View pg-boss jobs directly
    if (pathname === '/api/admin/pgboss/jobs' && req.method === 'GET') {
      await handleGetPgBossJobs(res);
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
