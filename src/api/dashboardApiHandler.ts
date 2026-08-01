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
import { verifyWebhookSignature } from '../services/stripeService.js';
import { createPackCheckout, processStripeWebhookEvent } from '../services/commerceService.js';
import { authenticateHttpRequest } from './middleware/auth.js';
import { parseCookies, serializeCookie } from '../utils/cookies.js';
import { query } from '../db/index.js';

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
    const result = await createPackCheckout({
      userId: authInfo.userId,
      userEmail: userEmail || '',
      productId: productId as any,
      successUrl,
      cancelUrl
    });

    if (result.success) {
      console.log(`✅ Created checkout session for user ${authInfo.userId}: ${result.sessionId}`);

      res.json({
        success: true,
        orderId: result.orderId,
        sessionId: result.sessionId,
        sessionUrl: result.sessionUrl
      });
    } else {
      console.error(`❌ Failed to create checkout session: ${result.error}`);

      // Distinguish between configuration errors and other failures
      const errorMessage = result.error || 'Failed to create checkout session';
      if (
        errorMessage.includes('not configured') ||
        errorMessage.includes('environment variable')
      ) {
        // Configuration error - service temporarily unavailable
        res.statusCode = 503;
        res.json({
          error: 'Service configuration error',
          message: 'Payment processing is temporarily unavailable. Please try again later.',
          details: process.env.NODE_ENV === 'development' ? errorMessage : undefined
        });
      } else if (errorMessage.includes('Invalid product')) {
        // Client error - bad request
        res.statusCode = 400;
        res.json({
          error: errorMessage
        });
      } else {
        // Other errors
        res.statusCode = 500;
        res.json({
          error: errorMessage
        });
      }
    }
  } catch (error: any) {
    console.error('Error in handleCreateCheckoutSession:', error);

    res.statusCode = 500;
    res.json({
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
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

    // The commerce service claims the Stripe event and applies its state
    // transition in one database transaction.
    const processed = await processStripeWebhookEvent(event);
    res.json({ received: true, duplicate: processed.duplicate });
    return;
  } catch (error: any) {
    console.error('Error in handleStripeWebhook:', error);
    res.statusCode = 500;
    res.json({ error: 'Webhook processing failed' });
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
    console.error('Error in handleAuthLogin:', error);
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
      const error = await tokenResponse.text();
      console.error('Token exchange failed:', error);
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
  } catch (error: any) {
    console.error('Error in handleAuthCallback:', error);
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
