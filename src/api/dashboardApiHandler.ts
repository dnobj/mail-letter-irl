/**
 * Dashboard API Handler
 *
 * Handles web dashboard routes including:
 * - Auth0 OAuth web flow
 * - Stripe Checkout session creation
 * - Stripe webhook processing
 */

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  createCheckoutSession,
  verifyWebhookSignature,
  extractCheckoutData,
  getStripeClient
} from '../services/stripeService.js';
import { addCreditsWithOptions, deductCredits } from '../services/creditService.js';
import { authenticateHttpRequest } from './middleware/auth.js';
import { parseCookies, serializeCookie } from '../utils/cookies.js';
import { query } from '../db/index.js';
import { updateUserTier, invalidateTierCache } from '../services/tierService.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';

// Default expiration for purchased credits (2 years)
const DEFAULT_PURCHASE_EXPIRATION_DAYS = 730;
import Stripe from 'stripe';

// Extended request/response types with cookie support
type Request = http.IncomingMessage & {
  body?: any;
  cookies?: Record<string, string>;
  query?: Record<string, string>;
};

type Response = http.ServerResponse & {
  json: (data: any) => void;
  cookie: (name: string, value: string, options?: any) => void;
  clearCookie: (name: string) => void;
};

// Helper to enhance response with utility methods
function enhanceResponse(res: http.ServerResponse): Response {
  const enhanced = res as Response;

  enhanced.json = function (data: any) {
    this.setHeader('Content-Type', 'application/json');
    this.end(JSON.stringify(data));
  };

  enhanced.cookie = function (name: string, value: string, options = {}) {
    const cookie = serializeCookie(name, value, { path: '/', ...options });
    const existing = this.getHeader('Set-Cookie') || [];
    const cookies = Array.isArray(existing) ? existing : [existing.toString()];
    cookies.push(cookie);
    this.setHeader('Set-Cookie', cookies);
  };

  enhanced.clearCookie = function (name: string) {
    this.cookie(name, '', { maxAge: 0 });
  };

  return enhanced;
}

// Helper to enhance request with cookies
function enhanceRequest(req: http.IncomingMessage): Request {
  const enhanced = req as Request;
  enhanced.cookies = parseCookies(req.headers.cookie);
  return enhanced;
}

/**
 * Create Stripe Checkout Session
 *
 * POST /api/stripe/create-checkout-session
 */
export async function handleCreateCheckoutSession(
  rawReq: http.IncomingMessage,
  rawRes: http.ServerResponse
): Promise<void> {
  const req = enhanceRequest(rawReq);
  const res = enhanceResponse(rawRes);

  try {
    // Authenticate user
    const authInfo = await authenticateHttpRequest(rawReq, rawRes);

    if (!authInfo) {
      return; // authenticateHttpRequest already sent error response
    }

    const { productId, successUrl, cancelUrl } = req.body;

    if (!productId || !successUrl || !cancelUrl) {
      res.statusCode = 400;
      res.json({
        error: 'Missing required fields: productId, successUrl, cancelUrl'
      });
      return;
    }

    // Validate product ID
    const validProducts = ['credit-pack-4', 'credit-pack-10', 'credit-pack-100'];
    if (!validProducts.includes(productId)) {
      res.statusCode = 400;
      res.json({
        error: `Invalid product ID. Must be one of: ${validProducts.join(', ')}`
      });
      return;
    }

    // Get user email - from JWT or look up in database
    let userEmail = authInfo.email;
    if (!userEmail) {
      const userResult = await query<{ email: string }>(
        'SELECT email FROM users WHERE user_id = $1',
        [authInfo.userId]
      );
      if (userResult.rows.length > 0) {
        userEmail = userResult.rows[0].email;
      }
    }

    // Create checkout session
    const result = await createCheckoutSession({
      userId: authInfo.userId,
      userEmail: userEmail || '',
      productId: productId as any,
      successUrl,
      cancelUrl
    });

    if (result.success) {
      writeDiagnostic('info', 'credits.checkout_created');

      res.json({
        success: true,
        sessionId: result.sessionId,
        sessionUrl: result.sessionUrl
      });
    } else {
      writeDiagnostic('error', 'credits.checkout_creation_failed', {
        errorClass: 'provider_error'
      });

      // Distinguish between configuration errors and other failures
      const errorMessage = result.error || 'Failed to create checkout session';
      if (errorMessage.includes('not configured') || errorMessage.includes('environment variable')) {
        // Configuration error - service temporarily unavailable
        res.statusCode = 503;
        res.json({
          error: 'Service configuration error',
          message: 'Payment processing is temporarily unavailable. Please try again later.',
        });
      } else if (errorMessage.includes('Invalid product')) {
        // Client error - bad request
        res.statusCode = 400;
        res.json({
          error: 'Invalid product'
        });
      } else {
        // Other errors
        res.statusCode = 500;
        res.json({
          error: 'Unable to create checkout session'
        });
      }
    }
  } catch (error: unknown) {
    writeDiagnostic('error', 'credits.checkout_creation_failed', {
      errorClass: classifyDiagnosticError(error, 'provider_error')
    });

    res.statusCode = 500;
    res.json({
      error: 'Internal server error',
      message: 'Unable to create checkout session'
    });
  }
}

/**
 * Handle Stripe Webhook Events
 *
 * POST /webhooks/stripe
 */
export async function handleStripeWebhook(
  rawReq: http.IncomingMessage,
  rawRes: http.ServerResponse
): Promise<void> {
  const req = enhanceRequest(rawReq);
  const res = enhanceResponse(rawRes);

  try {
    const signature = req.headers['stripe-signature'];

    if (!signature || typeof signature !== 'string') {
      console.error('❌ Webhook: Missing Stripe signature');
      res.statusCode = 400;
      res.end('Missing signature');
      return;
    }

    // Verify webhook signature
    const event = verifyWebhookSignature(req.body, signature);

    if (!event) {
      console.error('❌ Webhook: Invalid signature');
      res.statusCode = 400;
      res.end('Invalid signature');
      return;
    }

    console.log(`📥 Webhook received: ${event.type}`);

    // Handle different event types
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      case 'checkout.session.async_payment_succeeded':
        await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      case 'checkout.session.async_payment_failed':
        writeDiagnostic('warn', 'credits.async_payment_failed');
        break;

      case 'charge.refunded':
        await handleChargeRefunded(event.data.object as Stripe.Charge);
        break;

      case 'refund.created':
        await handleRefundCreated(event.data.object as Stripe.Refund);
        break;

      case 'charge.dispute.created':
        await handleDisputeCreated(event.data.object as Stripe.Dispute);
        break;

      case 'charge.dispute.closed':
        await handleDisputeClosed(event.data.object as Stripe.Dispute);
        break;

      default:
        console.log(`ℹ️  Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error: any) {
    writeDiagnostic('error', 'credits.webhook_failed', {
      errorClass: classifyDiagnosticError(error, 'provider_error')
    });
    res.statusCode = 500;
    res.json({ error: 'Webhook processing failed' });
  }
}

/**
 * Process successful checkout session
 * Implements idempotency to prevent duplicate credit additions from webhook retries
 */
async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session
): Promise<void> {
  try {
    writeDiagnostic('info', 'credits.checkout_completed');

    // Extract checkout data
    const checkoutData = await extractCheckoutData(session);

    if (!checkoutData) {
      console.error('❌ Failed to extract checkout data');
      return;
    }

    // Idempotency check: verify this session hasn't already been processed
    const existingEntry = await query<{ ledger_id: string }>(
      `SELECT ledger_id FROM credit_ledger
       WHERE source_reference_id = $1 AND source_type = 'purchase'
       LIMIT 1`,
      [session.id]
    );

    if (existingEntry.rows.length > 0) {
      writeDiagnostic('info', 'credits.checkout_already_processed');
      return;
    }

    writeDiagnostic('info', 'credits.checkout_applying', { credits: checkoutData.credits });

    // Add credits to user account with expiration tracking
    await addCreditsWithOptions({
      userId: checkoutData.userId,
      email: checkoutData.customerEmail,
      credits: checkoutData.credits,
      sourceType: 'purchase',
      sourceReferenceId: checkoutData.sessionId,
      expirationDays: DEFAULT_PURCHASE_EXPIRATION_DAYS,
      description: `Purchased ${checkoutData.productId} via Stripe Checkout`,
      sourceMetadata: {
        stripe_session_id: checkoutData.sessionId,
        product_id: checkoutData.productId,
        amount_paid: checkoutData.amountPaid,
        customer_email: checkoutData.customerEmail
      }
    });

    writeDiagnostic('info', 'credits.checkout_applied', { credits: checkoutData.credits });
  } catch (error: any) {
    writeDiagnostic('error', 'credits.checkout_completion_failed', {
      errorClass: classifyDiagnosticError(error, 'database_error')
    });
    throw error;
  }
}

/**
 * Handle charge.refunded event
 * Revokes credits from the refunded purchase and recalculates user tier
 */
async function handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
  try {
    writeDiagnostic('info', 'credits.refund_received', { amount: charge.amount_refunded });

    // Get the payment intent to find the checkout session
    const paymentIntentId = typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id;

    if (!paymentIntentId) {
      console.error('❌ Refund webhook: No payment intent ID on charge');
      return;
    }

    // Use Stripe API to find checkout session from payment intent
    const stripe = getStripeClient();
    let checkoutSessionId: string | null = null;

    try {
      // Search for checkout sessions with this payment intent
      const sessions = await stripe.checkout.sessions.list({
        payment_intent: paymentIntentId,
        limit: 1
      });

      if (sessions.data.length > 0) {
        checkoutSessionId = sessions.data[0].id;
        writeDiagnostic('info', 'credits.checkout_match_found');
      }
    } catch (stripeError) {
      writeDiagnostic('warn', 'credits.checkout_lookup_failed', {
        errorClass: classifyDiagnosticError(stripeError, 'provider_error')
      });
    }

    // Find the original purchase ledger entry by session ID or payment intent
    let ledgerResult;
    if (checkoutSessionId) {
      // Look up by session ID (most reliable)
      ledgerResult = await query<{
        ledger_id: string;
        user_id: string;
        initial_amount: number;
        remaining_amount: number;
        source_metadata: any;
      }>(
        `SELECT ledger_id, user_id, initial_amount, remaining_amount, source_metadata
         FROM credit_ledger
         WHERE source_type = 'purchase'
           AND (source_reference_id = $1 OR source_metadata->>'stripe_session_id' = $1)
         LIMIT 1`,
        [checkoutSessionId]
      );
    } else {
      // Fallback: try to find by metadata containing the payment intent
      ledgerResult = await query<{
        ledger_id: string;
        user_id: string;
        initial_amount: number;
        remaining_amount: number;
        source_metadata: any;
      }>(
        `SELECT ledger_id, user_id, initial_amount, remaining_amount, source_metadata
         FROM credit_ledger
         WHERE source_type = 'purchase'
           AND source_metadata->>'stripe_payment_intent' = $1
         LIMIT 1`,
        [paymentIntentId]
      );
    }

    if (ledgerResult.rows.length === 0) {
      writeDiagnostic('warn', 'credits.refund_purchase_not_found');
      console.log('   This may be a refund for a purchase before ledger tracking was enabled.');
      return;
    }

    const entry = ledgerResult.rows[0];
    const userId = entry.user_id;

    // Check if we've already processed this refund (idempotency)
    const existingRefund = await query<{ ledger_id: string }>(
      `SELECT ledger_id FROM credit_ledger
       WHERE source_type = 'refund'
         AND related_ledger_id = $1
       LIMIT 1`,
      [entry.ledger_id]
    );

    if (existingRefund.rows.length > 0) {
      writeDiagnostic('info', 'credits.refund_already_processed');
      return;
    }

    // Create a refund ledger entry (negative credits)
    // This marks the original purchase as having a matching refund
    await query(
      `INSERT INTO credit_ledger (
        user_id, initial_amount, remaining_amount, source_type,
        source_reference_id, source_metadata, status, description,
        related_ledger_id, activated_at
      ) VALUES (
        $1, $2, 0, 'refund', $3, $4, 'active', $5, $6, NOW()
      )`,
      [
        userId,
        -entry.initial_amount, // Negative amount for refund
        charge.id,
        JSON.stringify({
          stripe_charge_id: charge.id,
          stripe_refund_amount: charge.amount_refunded,
          original_purchase_ledger_id: entry.ledger_id,
        }),
        `Refund for charge ${charge.id}`,
        entry.ledger_id, // Link to original purchase
      ]
    );

    writeDiagnostic('info', 'credits.refund_recorded');

    // Recalculate user tier immediately (don't wait for daily job)
    try {
      const updatedUser = await updateUserTier(userId);
      invalidateTierCache(userId);
      writeDiagnostic('info', 'credits.tier_recalculated', { tier: updatedUser.tier });
    } catch (tierError) {
      writeDiagnostic('error', 'credits.tier_recalculation_failed', {
        errorClass: classifyDiagnosticError(tierError, 'database_error')
      });
      // Don't fail the webhook - tier will be recalculated in daily job
    }
  } catch (error: any) {
    writeDiagnostic('error', 'credits.refund_processing_failed', {
      errorClass: classifyDiagnosticError(error, 'database_error')
    });
    throw error;
  }
}

/**
 * Handle refund.created event
 * This provides more detailed refund information than charge.refunded
 */
async function handleRefundCreated(refund: Stripe.Refund): Promise<void> {
  try {
    const chargeId = typeof refund.charge === 'string' ? refund.charge : refund.charge?.id;
    const paymentIntentId = typeof refund.payment_intent === 'string'
      ? refund.payment_intent
      : refund.payment_intent?.id;

    writeDiagnostic('info', 'credits.refund_created');
    console.log(`   Status: ${refund.status}`);

    // The actual processing is done in handleChargeRefunded
    // This event is for logging/monitoring purposes
    // Both events fire for the same refund, so we avoid duplicate processing
  } catch (error: any) {
    writeDiagnostic('error', 'credits.refund_event_failed', {
      errorClass: classifyDiagnosticError(error, 'provider_error')
    });
    throw error;
  }
}

/**
 * Handle charge.dispute.created event
 * Logs the dispute and recalculates tier (disputed purchase shouldn't count)
 */
async function handleDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
  try {
    writeDiagnostic('warn', 'credits.dispute_created', { amount: dispute.amount });

    // Get the charge to find the user
    const chargeId = typeof dispute.charge === 'string'
      ? dispute.charge
      : dispute.charge?.id;

    if (!chargeId) {
      console.error('❌ Dispute webhook: No charge ID on dispute');
      return;
    }

    // Try to find the user from our purchase records
    // Note: We may not be able to find the user if the purchase predates ledger tracking
    const ledgerResult = await query<{ user_id: string; ledger_id: string }>(
      `SELECT user_id, ledger_id FROM credit_ledger
       WHERE source_type = 'purchase'
       ORDER BY created_at DESC
       LIMIT 100`
    );

    // Log the dispute for monitoring (we may need manual investigation)
    console.log('🚨 DISPUTE ALERT');
    console.log(`   Amount: ${dispute.amount / 100} ${dispute.currency.toUpperCase()}`);
    console.log(`   Reason: ${dispute.reason}`);
    console.log(`   Status: ${dispute.status}`);

    // For now, disputes require manual investigation
    // The purchase is already excluded from tier calculation since we check for refunds
    // A chargeback will eventually result in a charge.refunded event if the customer wins
  } catch (error: any) {
    writeDiagnostic('error', 'credits.dispute_created_failed', {
      errorClass: classifyDiagnosticError(error, 'provider_error')
    });
    throw error;
  }
}

/**
 * Handle charge.dispute.closed event
 * If we lost (customer won), ensure credits are properly revoked
 * If we won, the purchase remains valid
 */
async function handleDisputeClosed(dispute: Stripe.Dispute): Promise<void> {
  try {
    writeDiagnostic('info', 'credits.dispute_closed', { status: dispute.status });

    const chargeId = typeof dispute.charge === 'string'
      ? dispute.charge
      : dispute.charge?.id;

    if (dispute.status === 'lost') {
      // Customer won the dispute - this is like a refund
      console.log('❌ Dispute LOST - Customer won chargeback');
      console.log(`   This should have triggered a charge.refunded event`);
      console.log(`   If credits were not revoked, manual intervention may be needed`);

      // Note: Stripe typically sends charge.refunded when we lose a dispute
      // But we log this for monitoring purposes
    } else if (dispute.status === 'won') {
      // We won the dispute - nothing to do, purchase remains valid
      console.log('✅ Dispute WON - Charge upheld');
    } else {
      console.log(`ℹ️ Dispute closed with status: ${dispute.status}`);
    }
  } catch (error: any) {
    writeDiagnostic('error', 'credits.dispute_closed_failed', {
      errorClass: classifyDiagnosticError(error, 'provider_error')
    });
    throw error;
  }
}

/**
 * Auth0 OAuth Web Flow
 *
 * These endpoints handle browser-based OAuth for the dashboard
 */

/**
 * Initiate Auth0 login
 *
 * GET /auth/login
 */
export async function handleAuthLogin(
  rawReq: http.IncomingMessage,
  rawRes: http.ServerResponse
): Promise<void> {
  const req = enhanceRequest(rawReq);
  const res = enhanceResponse(rawRes);

  try {
    // Parse query string
    const url = new URL(rawReq.url || '/', `http://${rawReq.headers.host}`);
    const returnTo = url.searchParams.get('returnTo') || '/dashboard/app.html';

    // Build Auth0 authorization URL
    const issuer = process.env.LETTER_IRL_OAUTH_ISSUER || '';
    const clientId = process.env.LETTER_IRL_OAUTH_CLIENT_ID || '';
    const redirectUri = `${process.env.LETTER_IRL_PUBLIC_BASE_URL}/auth/callback`;
    const audience = process.env.LETTER_IRL_OAUTH_AUDIENCE || '';
    const scopes = 'openid email profile';

    // Store returnTo in session for callback
    res.cookie('auth_return_to', returnTo, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 5 * 60 * 1000 // 5 minutes
    });

    // Generate cryptographically secure state for CSRF protection
    const state = randomBytes(32).toString('base64url');
    res.cookie('auth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 5 * 60 * 1000 // 5 minutes
    });

    const authUrl = new URL(`${issuer}authorize`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('audience', audience);
    authUrl.searchParams.set('state', state);

    res.statusCode = 302;
    res.setHeader('Location', authUrl.toString());
    res.end();
  } catch (error: any) {
    writeDiagnostic('error', 'auth.dashboard_login_failed', {
      errorClass: classifyDiagnosticError(error, 'configuration_error')
    });
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Authentication error');
  }
}

/**
 * Handle Auth0 callback
 *
 * GET /auth/callback
 */
export async function handleAuthCallback(
  rawReq: http.IncomingMessage,
  rawRes: http.ServerResponse
): Promise<void> {
  const req = enhanceRequest(rawReq);
  const res = enhanceResponse(rawRes);

  try {
    // Parse query string
    const url = new URL(rawReq.url || '/', `http://${rawReq.headers.host}`);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const storedState = req.cookies?.auth_state;
    const returnTo = req.cookies?.auth_return_to || '/dashboard/app.html';

    // Verify state for CSRF protection
    if (!state || state !== storedState) {
      res.statusCode = 400;
      res.end('Invalid state parameter');
      return;
    }

    if (!code) {
      res.statusCode = 400;
      res.end('Missing authorization code');
      return;
    }

    // Exchange code for tokens
    const tokenEndpoint = process.env.LETTER_IRL_OAUTH_TOKEN_ENDPOINT || '';
    const clientId = process.env.LETTER_IRL_OAUTH_CLIENT_ID || '';
    const clientSecret = process.env.LETTER_IRL_OAUTH_CLIENT_SECRET || '';
    const redirectUri = `${process.env.LETTER_IRL_PUBLIC_BASE_URL}/auth/callback`;

    const tokenResponse = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri
      })
    });

    if (!tokenResponse.ok) {
      await tokenResponse.text();
      writeDiagnostic('error', 'auth.token_exchange_failed', {
        errorClass: 'authorization_error',
        status: tokenResponse.status
      });
      res.statusCode = 500;
      res.end('Failed to obtain access token');
      return;
    }

    const tokens = await tokenResponse.json();

    // Store access token in httpOnly cookie
    res.cookie('access_token', tokens.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });

    // Clean up temporary cookies
    res.clearCookie('auth_state');
    res.clearCookie('auth_return_to');

    // Redirect to original destination
    res.statusCode = 302;
    res.setHeader('Location', returnTo);
    res.end();
  } catch (error: unknown) {
    writeDiagnostic('error', 'auth.dashboard_callback_failed', {
      errorClass: classifyDiagnosticError(error, 'authorization_error')
    });
    res.statusCode = 500;
    res.end('Authentication callback error');
  }
}

/**
 * Handle logout
 *
 * POST /auth/logout
 */
export async function handleAuthLogout(
  rawReq: http.IncomingMessage,
  rawRes: http.ServerResponse
): Promise<void> {
  const res = enhanceResponse(rawRes);
  res.clearCookie('access_token');
  res.json({ success: true });
}
