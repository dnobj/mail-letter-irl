/**
 * Dashboard API Handler
 *
 * Handles web dashboard routes including:
 * - Auth0 OAuth web flow
 * - Stripe Checkout session creation
 * - Stripe webhook processing
 */

import http from 'node:http';
import {
  createCheckoutSession,
  verifyWebhookSignature,
  extractCheckoutData
} from '../services/stripeService.js';
import { addCredits } from '../services/creditService.js';
import { authenticateHttpRequest } from './middleware/auth.js';
import { parseCookies, serializeCookie } from '../utils/cookies.js';
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

    // Create checkout session
    const result = await createCheckoutSession({
      userId: authInfo.userId,
      userEmail: authInfo.email || authInfo.userId,
      productId: productId as any,
      successUrl,
      cancelUrl
    });

    if (result.success) {
      console.log(`✅ Created checkout session for user ${authInfo.userId}: ${result.sessionId}`);

      res.json({
        success: true,
        sessionId: result.sessionId,
        sessionUrl: result.sessionUrl
      });
    } else {
      console.error(`❌ Failed to create checkout session: ${result.error}`);

      res.statusCode = 500;
      res.json({
        error: result.error || 'Failed to create checkout session'
      });
    }
  } catch (error: any) {
    console.error('Error in handleCreateCheckoutSession:', error);

    res.statusCode = 500;
    res.json({
      error: 'Internal server error'
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
        console.log(`❌ Async payment failed for session: ${event.data.object.id}`);
        break;

      default:
        console.log(`ℹ️  Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error: any) {
    console.error('Error in handleStripeWebhook:', error);
    res.statusCode = 500;
    res.json({ error: 'Webhook processing failed' });
  }
}

/**
 * Process successful checkout session
 */
async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session
): Promise<void> {
  try {
    console.log(`✅ Checkout completed: ${session.id}`);

    // Extract checkout data
    const checkoutData = await extractCheckoutData(session);

    if (!checkoutData) {
      console.error('❌ Failed to extract checkout data');
      return;
    }

    console.log(`💳 Adding ${checkoutData.credits} credits to user ${checkoutData.userId}`);

    // Add credits to user account
    await addCredits({
      userId: checkoutData.userId,
      credits: checkoutData.credits,
      orderId: checkoutData.sessionId,
      description: `Purchased ${checkoutData.productId} via Stripe Checkout`,
      metadata: {
        stripe_session_id: checkoutData.sessionId,
        product_id: checkoutData.productId,
        amount_paid: checkoutData.amountPaid,
        customer_email: checkoutData.customerEmail
      }
    });

    console.log(`✅ Credits added successfully to user ${checkoutData.userId}`);
  } catch (error: any) {
    console.error('Error processing checkout completion:', error);
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
    // Note: This requires session middleware - we'll add a cookie-based session
    res.cookie('auth_return_to', returnTo, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 5 * 60 * 1000 // 5 minutes
    });

    // Generate state for CSRF protection
    const state = Buffer.from(Math.random().toString()).toString('base64').substring(0, 20);
    res.cookie('auth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
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
