/**
 * Dashboard API Handler
 *
 * Handles web dashboard routes including:
 * - Stripe Checkout session creation
 * - Stripe webhook processing
 */

import http from 'node:http';
import { verifyWebhookSignature } from '../services/stripeService.js';
import { createPackCheckout, processStripeWebhookEvent } from '../services/commerceService.js';
import { PACK_PRODUCTS } from '../config/products.js';
import { authenticateHttpRequest } from './middleware/auth.js';
import { rateLimitAccount } from './middleware/rateLimit.js';
import { requiredRestScopes } from '../auth/restScopes.js';
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

// Extended request/response types
type Request = http.IncomingMessage & {
  body?: any;
  query?: Record<string, string>;
};

type Response = http.ServerResponse & {
  json: (data: any) => void;
};

// Helper to enhance response with utility methods
function enhanceResponse(res: http.ServerResponse): Response {
  const enhanced = res as Response;

  enhanced.json = function (data: any) {
    this.setHeader('Content-Type', 'application/json');
    this.end(JSON.stringify(data));
  };

  return enhanced;
}

// Helper to type the request, whose body httpServer.ts has already parsed
function enhanceRequest(req: http.IncomingMessage): Request {
  return req as Request;
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
    // Authenticate user, including the route's scope (src/auth/restScopes.ts)
    const authInfo = await authenticateHttpRequest(
      rawReq,
      rawRes,
      requiredRestScopes('POST', '/api/stripe/create-checkout-session')
    );

    if (!authInfo) {
      return; // authenticateHttpRequest already sent error response
    }

    // The account stage of the checkout limit. The 'checkout' limit in
    // httpServer.ts runs before authentication and keys on the address, which
    // every dashboard user shares through the website's proxy.
    if (await rateLimitAccount(rawReq, rawRes, authInfo.userId, 'checkout_account')) {
      return; // Rate limited
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
      // PACK_AMOUNT_NOT_CONFIGURED stays: its carried class is legitimately
      // transient (a Stripe blip mid-resolution), so the terminal test below
      // does not cover it. PRICE_ID_NOT_CONFIGURED does not - its one producer
      // always carries configuration_error, which IS in the terminal set, so
      // the disjunct never changed the outcome (#278 round 10).
      code === 'PACK_AMOUNT_NOT_CONFIGURED' ||
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
