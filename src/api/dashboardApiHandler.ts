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
import { PACK_PRODUCTS } from '../config/products.js';
import { authenticateHttpRequest } from './middleware/auth.js';
import { parseCookies, serializeCookie } from '../utils/cookies.js';
import { query } from '../db/index.js';
import {
  carriedDiagnosticClass,
  classifyDiagnosticError,
  isTerminalDiagnosticClass,
  writeDiagnostic
} from '../utils/diagnosticLog.js';

// The fourth copy of the pack table until #275 gave it one home. Adding a
// tier in products.ts prices it, validates its env var, resolves it and
// reports it in /readyz - while a hand-kept list here answered 400 and left
// the Buy button dead for a product every other layer believed was live.
// Static derivation, so it is derived ONCE (#278 round 8).
const VALID_PACK_CODES = PACK_PRODUCTS.map(product => product.productCode);

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
    if (!VALID_PACK_CODES.includes(productId)) {
      res.statusCode = 400;
      res.json({
        error: `Invalid product ID. Must be one of: ${VALID_PACK_CODES.join(', ')}`
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

    // createPackCheckout either succeeds or THROWS - its result type's
    // `success` is the literal `true`, so the else-branch that used to sit
    // here was dead code tsc could not flag, and an unpriced pack fell through
    // to the generic catch as a bare 500 instead of the 503 the branch
    // promised (#278 review round 4). Failure mapping lives in the catch now.
    writeDiagnostic('info', 'credits.checkout_created');
    res.json({
      success: true,
      orderId: result.orderId,
      sessionId: result.sessionId,
      sessionUrl: result.sessionUrl
    });
  } catch (error: unknown) {
    // Prefer a class the failing layer already resolved. createPackCheckout
    // carries the Stripe error's own class (e.g. resource_missing) here, which
    // is what #213 needed: without it a Stripe misconfiguration reached this
    // catch as a bare Error and took the database_error default, sending the
    // investigation on a schema hunt. The default stays database_error because
    // the *uncarried* errors that reach here are genuine database operations -
    // the user-email lookup above and the order INSERT inside createPackCheckout.
    const carried = carriedDiagnosticClass(error);
    writeDiagnostic('error', 'credits.checkout_creation_failed', {
      errorClass: carried ?? classifyDiagnosticError(error, 'database_error')
    });

    const code =
      error && typeof error === 'object' && 'code' in error &&
      typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined;
    // No validation_error branch: this handler pre-validates productId
    // against PACK_PRODUCTS before calling createPackCheckout, so the
    // commerce layer's invalid-product throw is unreachable from here - the
    // branch that used to sit in this chain had zero real coverage and its
    // test asserted a 400 that actually came from the pre-validation (#278
    // round 6).
    if (
      code === 'PACK_AMOUNT_NOT_CONFIGURED' ||
      code === 'PRICE_ID_NOT_CONFIGURED' ||
      // The vocabulary's own terminality answer, so a terminal class carried
      // verbatim (configuration_error, amount_too_small, resource_missing,
      // StripeAuthenticationError) maps like the configuration fault it is
      // instead of falling to a bare 500 while the sibling guard one layer
      // earlier answered 503 (#278 r5). configuration_error is IN the
      // terminal set - a separate disjunct for it was the scattered copy the
      // vocabulary helper exists to end (#278 round 8).
      isTerminalDiagnosticClass(carried)
    ) {
      // An unpriced or misconfigured product - transient (a Stripe blip mid
      // resolution) or terminal (a human must fix config), the customer-facing
      // answer is the same: unavailable right now, try again later.
      res.statusCode = 503;
      res.json({
        error: 'Service configuration error',
        message: 'Payment processing is temporarily unavailable. Please try again later.'
      });
    } else {
      res.statusCode = 500;
      res.json({
        error: 'Internal server error',
        message: 'Unable to create checkout session'
      });
    }
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
      writeDiagnostic('warn', 'stripe.webhook_signature_missing');
      res.statusCode = 400;
      res.end('Missing signature');
      return;
    }

    // Verify webhook signature
    const event = verifyWebhookSignature(req.body, signature);

    if (!event) {
      writeDiagnostic('warn', 'stripe.webhook_signature_invalid');
      res.statusCode = 400;
      res.end('Invalid signature');
      return;
    }

    writeDiagnostic('info', 'stripe.webhook_received', { eventType: event.type });

    // The commerce service claims the Stripe event and applies its state
    // transition in one database transaction.
    const processed = await processStripeWebhookEvent(event);
    res.json({ received: true, duplicate: processed.duplicate });
    return;
  } catch (error: unknown) {
    writeDiagnostic('error', 'credits.webhook_failed', {
      errorClass: carriedDiagnosticClass(error) ?? classifyDiagnosticError(error, 'provider_error')
    });
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
  } catch (error: unknown) {
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
