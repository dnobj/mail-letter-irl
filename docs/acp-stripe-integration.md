# Stripe Shared Payment Token (SPT) Integration Guide

## Overview

This guide covers integrating Stripe's **Shared Payment Token (SPT)** system with Letter IRL for Agentic Commerce Protocol (ACP) delegated payments.

## What is Shared Payment Token (SPT)?

SPT is Stripe's implementation of delegated payment for AI agents. It allows:

1. **User authorizes once** - User connects payment method to ChatGPT via Stripe
2. **ChatGPT receives SPT** - Stripe issues a token representing user's payment method
3. **Merchant charges SPT** - Your server uses Stripe API to charge the SPT
4. **Direct payment flow** - Money goes directly from user to your Stripe account

**Key Point:** You remain the merchant of record. ChatGPT never handles the payment directly.

## Prerequisites

### 1. Stripe Account Setup

1. Create or log in to Stripe account: https://dashboard.stripe.com
2. Complete business verification (required for live mode)
3. Enable test mode for development

### 2. Enable SPT Feature

SPT may require explicit enablement:

1. Contact Stripe support or your account manager
2. Request "Shared Payment Token" feature access
3. Mention you're building for OpenAI's Agentic Commerce Protocol
4. Wait for confirmation (usually 1-2 business days)

### 3. Obtain API Keys

**Test Mode Keys** (for development):
```
Secret Key: sk_test_xxxxxxxxxxxxx
Publishable Key: pk_test_xxxxxxxxxxxxx
```

**Live Mode Keys** (for production):
```
Secret Key: sk_live_xxxxxxxxxxxxx
Publishable Key: pk_live_xxxxxxxxxxxxx
```

**Where to find:**
- Dashboard → Developers → API keys
- Keep secret keys secure - never commit to git

### 4. Configure Webhooks

Set up webhook endpoint to receive payment events:

1. Dashboard → Developers → Webhooks → Add endpoint
2. Endpoint URL: `https://your-domain.com/webhooks/stripe`
3. Events to listen for:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `charge.refunded`
   - `payment_intent.requires_action`
4. Copy webhook signing secret: `whsec_xxxxxxxxxxxxx`

## Installation

Install Stripe Node.js SDK:

```bash
npm install stripe
```

Add to `package.json` dependencies:
```json
{
  "dependencies": {
    "stripe": "^14.11.0"
  }
}
```

## Environment Configuration

Add to `.env`:

```bash
# Stripe API Keys
STRIPE_SECRET_KEY=sk_test_51xxxxxxxxxxxxx
STRIPE_PUBLISHABLE_KEY=pk_test_51xxxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxx

# Stripe Configuration
STRIPE_API_VERSION=2023-10-16
STRIPE_CURRENCY=usd

# Business Information
STRIPE_BUSINESS_NAME=Letter IRL
STRIPE_SUPPORT_EMAIL=support@your-domain.com
STRIPE_SUPPORT_PHONE=+1-555-123-4567
```

## Implementation

### 1. Initialize Stripe Client

Create `src/acp/stripeService.ts`:

```typescript
import Stripe from 'stripe';

// Initialize Stripe with API version pinning
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
  typescript: true,
  appInfo: {
    name: 'Letter IRL',
    version: '0.1.0',
    url: 'https://your-domain.com'
  }
});

export interface ChargeResult {
  success: boolean;
  payment_intent_id?: string;
  error?: string;
  error_code?: string;
}
```

### 2. Charging an SPT

Main function to process payment:

```typescript
/**
 * Charge a Shared Payment Token (SPT) for a purchase
 *
 * @param spt - The shared payment token from ChatGPT
 * @param amount - Amount in dollars (will be converted to cents)
 * @param currency - Currency code (e.g., 'usd')
 * @param orderId - Your order ID for tracking
 * @param userId - Authenticated user ID
 * @param description - Payment description
 * @returns ChargeResult with success status and payment_intent_id
 */
export async function chargeSharedPaymentToken(
  spt: string,
  amount: number,
  currency: string,
  orderId: string,
  userId: string,
  description: string
): Promise<ChargeResult> {
  try {
    console.log(`Processing SPT payment: order=${orderId}, amount=${amount}, currency=${currency}`);

    // Create PaymentIntent with SPT as payment method
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert dollars to cents
      currency: currency.toLowerCase(),
      payment_method: spt, // This is the SPT token
      confirm: true, // Automatically confirm the payment
      description,
      metadata: {
        order_id: orderId,
        user_id: userId,
        service: 'letter-irl',
        acp_version: '1.0'
      },
      statement_descriptor: 'LETTER IRL', // Appears on bank statement (max 22 chars)
      receipt_email: undefined, // User email if you want to send Stripe receipt
    });

    console.log(`PaymentIntent created: ${paymentIntent.id}, status: ${paymentIntent.status}`);

    // Check payment status
    if (paymentIntent.status === 'succeeded') {
      return {
        success: true,
        payment_intent_id: paymentIntent.id
      };
    } else if (paymentIntent.status === 'requires_action') {
      // 3D Secure or other authentication required
      return {
        success: false,
        error: 'Payment requires additional authentication',
        error_code: 'authentication_required'
      };
    } else {
      return {
        success: false,
        error: `Payment status: ${paymentIntent.status}`,
        error_code: 'payment_incomplete'
      };
    }

  } catch (error) {
    console.error('Stripe payment failed:', error);

    if (error instanceof Stripe.errors.StripeError) {
      return {
        success: false,
        error: error.message,
        error_code: error.code || 'unknown_error'
      };
    }

    return {
      success: false,
      error: 'Unknown payment error',
      error_code: 'unknown_error'
    };
  }
}
```

### 3. Error Handling

Handle specific Stripe error types:

```typescript
export interface StripeErrorDetails {
  message: string;
  userMessage: string;
  httpStatus: number;
  retryable: boolean;
}

export function handleStripeError(error: Stripe.errors.StripeError): StripeErrorDetails {
  const code = error.code;

  switch (code) {
    case 'card_declined':
      return {
        message: error.message,
        userMessage: 'Your card was declined. Please try a different payment method.',
        httpStatus: 402,
        retryable: true
      };

    case 'insufficient_funds':
      return {
        message: error.message,
        userMessage: 'Insufficient funds. Please use a different payment method or try a smaller amount.',
        httpStatus: 402,
        retryable: true
      };

    case 'expired_card':
      return {
        message: error.message,
        userMessage: 'Your card has expired. Please update your payment method.',
        httpStatus: 402,
        retryable: true
      };

    case 'incorrect_cvc':
    case 'incorrect_number':
    case 'invalid_expiry_month':
    case 'invalid_expiry_year':
      return {
        message: error.message,
        userMessage: 'Invalid card details. Please check your payment information.',
        httpStatus: 402,
        retryable: true
      };

    case 'processing_error':
      return {
        message: error.message,
        userMessage: 'A processing error occurred. Please try again.',
        httpStatus: 500,
        retryable: true
      };

    case 'rate_limit':
      return {
        message: error.message,
        userMessage: 'Too many requests. Please try again in a moment.',
        httpStatus: 429,
        retryable: true
      };

    case 'authentication_required':
      return {
        message: error.message,
        userMessage: 'Additional authentication required. Please complete verification.',
        httpStatus: 402,
        retryable: false
      };

    case 'invalid_request_error':
      return {
        message: error.message,
        userMessage: 'Invalid request. Please contact support if this persists.',
        httpStatus: 400,
        retryable: false
      };

    default:
      return {
        message: error.message,
        userMessage: 'Payment failed. Please try again or contact support.',
        httpStatus: 500,
        retryable: false
      };
  }
}
```

### 4. Refund Handling

Support refunds for customer service:

```typescript
export interface RefundResult {
  success: boolean;
  refund_id?: string;
  error?: string;
}

/**
 * Refund a completed payment
 *
 * @param paymentIntentId - Original payment intent ID
 * @param amount - Amount to refund in dollars (optional, defaults to full refund)
 * @param reason - Reason for refund
 * @returns RefundResult with success status
 */
export async function refundPayment(
  paymentIntentId: string,
  amount?: number,
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer'
): Promise<RefundResult> {
  try {
    const refundParams: Stripe.RefundCreateParams = {
      payment_intent: paymentIntentId,
      reason: reason || 'requested_by_customer'
    };

    if (amount !== undefined) {
      refundParams.amount = Math.round(amount * 100); // Partial refund
    }

    const refund = await stripe.refunds.create(refundParams);

    console.log(`Refund created: ${refund.id}, status: ${refund.status}`);

    return {
      success: refund.status === 'succeeded',
      refund_id: refund.id
    };

  } catch (error) {
    console.error('Stripe refund failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown refund error'
    };
  }
}
```

### 5. Webhook Handler

Process Stripe webhook events:

Create `src/acp/webhookHandler.ts`:

```typescript
import { Request, Response } from 'express';
import Stripe from 'stripe';
import { stripe } from './stripeService.js';
import { updateOrderPaymentStatus } from './checkoutService.js';
import { refundCredits } from '../services/accountService.js';

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

/**
 * Handle incoming Stripe webhook events
 */
export async function handleStripeWebhook(req: Request, res: Response) {
  const sig = req.headers['stripe-signature'] as string;

  let event: Stripe.Event;

  try {
    // Verify webhook signature
    event = stripe.webhooks.constructEvent(
      req.body, // Raw body buffer required
      sig,
      WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`Stripe webhook received: ${event.type}, id: ${event.id}`);

  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentSuccess(event.data.object as Stripe.PaymentIntent);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentFailure(event.data.object as Stripe.PaymentIntent);
        break;

      case 'charge.refunded':
        await handleRefund(event.data.object as Stripe.Charge);
        break;

      case 'payment_intent.requires_action':
        await handleRequiresAction(event.data.object as Stripe.PaymentIntent);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });

  } catch (err) {
    console.error('Error processing webhook:', err);
    res.status(500).send('Webhook processing failed');
  }
}

async function handlePaymentSuccess(paymentIntent: Stripe.PaymentIntent) {
  const orderId = paymentIntent.metadata.order_id;
  const userId = paymentIntent.metadata.user_id;

  console.log(`Payment succeeded: order=${orderId}, user=${userId}, amount=${paymentIntent.amount}`);

  // Update order status to completed
  await updateOrderPaymentStatus(orderId, 'completed', paymentIntent.id);

  // Send confirmation email (optional)
  // await sendPurchaseConfirmationEmail(userId, orderId);
}

async function handlePaymentFailure(paymentIntent: Stripe.PaymentIntent) {
  const orderId = paymentIntent.metadata.order_id;
  const userId = paymentIntent.metadata.user_id;

  console.log(`Payment failed: order=${orderId}, user=${userId}, reason=${paymentIntent.last_payment_error?.message}`);

  // Update order status to failed
  await updateOrderPaymentStatus(orderId, 'failed', paymentIntent.id);

  // Notify user (optional)
  // await sendPaymentFailureEmail(userId, orderId);
}

async function handleRefund(charge: Stripe.Charge) {
  const paymentIntentId = charge.payment_intent as string;

  // Get order from payment intent
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const orderId = paymentIntent.metadata.order_id;
  const userId = paymentIntent.metadata.user_id;
  const refundAmount = charge.amount_refunded / 100; // Convert cents to dollars

  console.log(`Refund processed: order=${orderId}, user=${userId}, amount=${refundAmount}`);

  // Update order status
  await updateOrderPaymentStatus(orderId, 'refunded', paymentIntentId);

  // Deduct credits from user account
  await refundCredits(userId, orderId);

  // Send refund confirmation email (optional)
  // await sendRefundConfirmationEmail(userId, orderId, refundAmount);
}

async function handleRequiresAction(paymentIntent: Stripe.PaymentIntent) {
  const orderId = paymentIntent.metadata.order_id;

  console.log(`Payment requires action: order=${orderId}, next_action=${paymentIntent.next_action?.type}`);

  // Update order status to pending_action
  await updateOrderPaymentStatus(orderId, 'pending_action', paymentIntent.id);
}
```

### 6. Webhook Security

Ensure webhook endpoint receives raw body:

In `src/mcp/httpServer.ts`:

```typescript
import express from 'express';

const app = express();

// IMPORTANT: Stripe webhooks need raw body for signature verification
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }), // Raw body middleware
  handleStripeWebhook
);

// Regular JSON parsing for other routes
app.use(express.json());
```

## Testing

### 1. Test Mode Setup

Use Stripe test mode for development:

1. Switch to Test Mode in Stripe Dashboard (toggle in top-right)
2. Use test API keys (start with `sk_test_` and `pk_test_`)
3. All transactions are simulated - no real money

### 2. Test SPT Tokens

Stripe provides special test tokens for SPT:

| Token | Result |
|-------|--------|
| `spt_test_success` | Payment succeeds |
| `spt_test_decline` | Card declined |
| `spt_test_insufficient_funds` | Insufficient funds |
| `spt_test_processing_error` | Processing error |
| `spt_test_authentication_required` | 3D Secure required |

### 3. Test Card Numbers

For end-to-end testing with Stripe Checkout:

| Card Number | Result |
|-------------|--------|
| `4242 4242 4242 4242` | Success |
| `4000 0000 0000 9995` | Declined |
| `4000 0000 0000 9987` | Insufficient funds |
| `4000 0025 0000 3155` | Requires 3D Secure |

Any future expiry date and any 3-digit CVC works.

### 4. Testing Webhooks Locally

Use Stripe CLI to forward webhooks to localhost:

```bash
# Install Stripe CLI
# macOS
brew install stripe/stripe-cli/stripe

# Linux/WSL
curl -s https://packages.stripe.com/api/security/keypair/stripe-cli-gpg/public | gpg --dearmor | sudo tee /usr/share/keyrings/stripe.gpg
echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.com/stripe-cli-debian-local stable main" | sudo tee -a /etc/apt/sources.list.d/stripe.list
sudo apt update
sudo apt install stripe

# Login to Stripe
stripe login

# Forward webhooks to local server
stripe listen --forward-to localhost:8788/webhooks/stripe

# Trigger test events
stripe trigger payment_intent.succeeded
stripe trigger payment_intent.payment_failed
stripe trigger charge.refunded
```

### 5. Manual Testing Flow

```bash
# 1. Start local server
npm run mcp:http

# 2. In another terminal, start Stripe webhook forwarding
stripe listen --forward-to localhost:8788/webhooks/stripe

# 3. Create test payment
curl -X POST http://localhost:8788/api/acp/v1/checkout/complete \
  -H "Authorization: Bearer <test_jwt>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-$(date +%s)" \
  -d '{
    "cart_id": "cart_test123",
    "quote_id": "quote_test123",
    "payment": {
      "shared_payment_token": "spt_test_success",
      "billing_address": {
        "country": "US",
        "state": "IL",
        "postal_code": "62701"
      }
    }
  }'

# 4. Verify in Stripe Dashboard
# Dashboard → Payments → All payments
# Should see test payment with metadata
```

## Production Checklist

Before going live with real payments:

### 1. Switch to Live Mode
- [ ] Obtain live API keys from Stripe Dashboard
- [ ] Update `.env` with live keys: `sk_live_...`, `pk_live_...`
- [ ] Switch Stripe Dashboard to Live Mode

### 2. Security
- [ ] Ensure all endpoints use HTTPS
- [ ] Verify webhook signature validation is active
- [ ] Enable rate limiting on payment endpoints
- [ ] Implement request logging for audit trail
- [ ] Set up monitoring and alerts for failed payments

### 3. Webhooks
- [ ] Configure production webhook endpoint in Stripe Dashboard
- [ ] Use production webhook secret: `whsec_...`
- [ ] Test webhook delivery to production URL
- [ ] Set up webhook failure notifications

### 4. Business Configuration
- [ ] Complete Stripe account verification
- [ ] Configure business details in Stripe Dashboard
- [ ] Set up bank account for payouts
- [ ] Configure statement descriptors
- [ ] Set up tax collection (if applicable)

### 5. Compliance
- [ ] Review and accept Stripe Terms of Service
- [ ] Implement PCI compliance requirements (Stripe handles most)
- [ ] Add privacy policy covering payment data
- [ ] Add terms of service covering refunds and disputes
- [ ] Configure receipt emails (optional)

### 6. Monitoring
- [ ] Set up Stripe Dashboard alerts
- [ ] Configure email notifications for disputes
- [ ] Set up logging for all payment events
- [ ] Create alerts for unusual payment patterns
- [ ] Set up daily reconciliation process

### 7. Testing in Production
- [ ] Make small test purchase with real card
- [ ] Verify credits added correctly
- [ ] Check payment appears in Stripe Dashboard
- [ ] Verify webhook events received
- [ ] Test refund process
- [ ] Verify receipt generation

## Common Issues and Solutions

### Issue: "No such payment_method"

**Cause:** SPT token is invalid or expired

**Solution:**
- Ensure you're using the SPT token exactly as received
- Check token hasn't expired (typically valid for 24 hours)
- Verify you're in correct Stripe mode (test vs live)

### Issue: Webhook signature verification fails

**Cause:** Wrong webhook secret or raw body not preserved

**Solution:**
```typescript
// Ensure webhook route gets raw body
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }), // Must come before express.json()
  handleStripeWebhook
);
```

### Issue: "Amount must be at least $0.50"

**Cause:** Stripe minimum charge amount

**Solution:**
- Ensure credit packages are priced at $0.50 or higher
- For testing, use amounts >= $0.50

### Issue: Payment succeeds but credits not added

**Cause:** Race condition - webhook arrives before checkout complete returns

**Solution:**
- Process credit addition in checkout complete endpoint, not webhook
- Use webhook only for failed payment handling and reconciliation

### Issue: Duplicate charges

**Cause:** Missing or incorrect idempotency key handling

**Solution:**
- Always require `Idempotency-Key` header
- Store processed keys for 24 hours
- Return original response for duplicate requests

## Monitoring and Observability

### Key Metrics to Track

1. **Payment Success Rate**
   ```typescript
   // Log every payment attempt
   console.log({
     event: 'payment_attempt',
     order_id,
     amount,
     success,
     error_code,
     duration_ms
   });
   ```

2. **Revenue Metrics**
   - Daily/weekly/monthly revenue
   - Average transaction value
   - Credits purchased per transaction

3. **Error Rates**
   - Payment failures by error type
   - Webhook delivery failures
   - Refund rate

### Stripe Dashboard Reports

Useful reports in Stripe Dashboard:

- **Payments** - All successful transactions
- **Failed payments** - Declined and failed attempts
- **Disputes** - Chargebacks and customer disputes
- **Payouts** - Money transferred to your bank
- **Balance** - Current Stripe balance
- **Radar** - Fraud detection (if enabled)

## Support and Resources

### Stripe Support

- **Documentation:** https://stripe.com/docs
- **API Reference:** https://stripe.com/docs/api
- **Support:** https://support.stripe.com
- **Status Page:** https://status.stripe.com

### Testing Resources

- **Test Cards:** https://stripe.com/docs/testing
- **Webhook Testing:** https://stripe.com/docs/webhooks/test
- **Stripe CLI:** https://stripe.com/docs/stripe-cli

### OpenAI ACP Resources

- **ACP Specification:** https://platform.openai.com/docs/agentic-commerce
- **Merchants Program:** https://chatgpt.com/merchants

## Next Steps

After setting up Stripe SPT integration:

1. **Create test account** in Stripe test mode
2. **Implement checkout endpoint** using `chargeSharedPaymentToken()`
3. **Set up webhook handler** for payment events
4. **Test with test tokens** (spt_test_success, etc.)
5. **Test end-to-end** with ChatGPT in staging
6. **Apply for production** Stripe account approval
7. **Launch** with live keys

See `docs/acp-implementation-guide.md` for complete implementation details.
