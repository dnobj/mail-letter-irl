# Agentic Commerce Protocol (ACP) Implementation Guide

## Overview

The **Agentic Commerce Protocol (ACP)** is an open-source standard co-maintained by OpenAI and Stripe that enables AI agents to make purchases on behalf of users through natural conversation. This guide covers the complete implementation for the Letter IRL MCP server.

## What is ACP?

ACP allows ChatGPT users to:
1. Browse products through natural conversation
2. Add items to cart via AI agent actions
3. Complete checkout without leaving the ChatGPT interface
4. Use delegated payment via Stripe's Shared Payment Token (SPT)

**Key Benefits:**
- Seamless UX - Users never leave ChatGPT
- Secure - Stripe handles all payment processing
- Merchant Control - You remain merchant of record, money flows directly to your Stripe account
- AI-Native - Built specifically for conversational commerce

## Architecture

ACP consists of three required components:

### 1. Product Feed
A structured file (TSV/CSV/JSON) listing all available products, hosted at a public URL.

### 2. Agentic Checkout API
Five REST endpoints that handle the shopping and checkout flow:
- `POST /cart/create` - Create new shopping cart
- `POST /cart/items` - Add/update items in cart
- `GET /cart/:cartId` - Retrieve cart details
- `POST /checkout/quote` - Get pricing quote for cart
- `POST /checkout/complete` - Finalize purchase

### 3. Delegated Payment
Integration with Stripe's Shared Payment Token (SPT) system for secure, delegated payments.

## Component 1: Product Feed

### Format

Product feeds can be TSV, CSV, or JSON. For Letter IRL, we'll use JSON for maximum flexibility.

### Required Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `product_id` | string | Unique identifier | `"credit-pack-5"` |
| `name` | string | Display name | `"5 Credit Package"` |
| `price` | string | Price with currency | `"USD 2.99"` |
| `description` | string | Product description | `"Perfect for sending 1-2 letters"` |
| `category` | string | Product category | `"credit-packages"` |
| `image_url` | string | Product image (HTTPS) | `"https://..."` |
| `availability` | string | Stock status | `"in stock"` |

### Letter IRL Product Feed Structure

```json
{
  "products": [
    {
      "product_id": "credit-pack-5",
      "name": "Starter Pack - 5 Credits",
      "price": "USD 2.99",
      "description": "Perfect for sending 1-2 letters. Each letter costs 2-3 credits depending on page count.",
      "category": "credit-packages",
      "image_url": "https://your-domain.com/images/credit-pack-5.png",
      "availability": "in stock",
      "metadata": {
        "credits": 5,
        "best_for": "trying_out",
        "value_per_credit": 0.598
      }
    },
    {
      "product_id": "credit-pack-20",
      "name": "Regular Pack - 20 Credits",
      "price": "USD 9.99",
      "description": "Great for regular letter senders. Send 6-10 letters with this package.",
      "category": "credit-packages",
      "image_url": "https://your-domain.com/images/credit-pack-20.png",
      "availability": "in stock",
      "metadata": {
        "credits": 20,
        "best_for": "regular_use",
        "value_per_credit": 0.4995,
        "savings_percent": 16
      }
    },
    {
      "product_id": "credit-pack-100",
      "name": "Power Pack - 100 Credits",
      "price": "USD 39.99",
      "description": "Best value for frequent senders. Send 30-50 letters. Save 33% vs Starter Pack!",
      "category": "credit-packages",
      "image_url": "https://your-domain.com/images/credit-pack-100.png",
      "availability": "in stock",
      "metadata": {
        "credits": 100,
        "best_for": "power_users",
        "value_per_credit": 0.3999,
        "savings_percent": 33,
        "popular": true
      }
    }
  ]
}
```

### Hosting Requirements

- Must be publicly accessible HTTPS URL
- Recommended: Update feed at most every 15 minutes (avoid excessive polling)
- Consider caching with appropriate `Cache-Control` headers
- File size limit: 100 MB (we'll be well under this)

### Implementation File

Create: `src/acp/productFeed.ts`

## Component 2: Agentic Checkout API

All endpoints require HTTPS and Bearer token authentication.

### Base URL Structure

```
https://your-domain.com/api/acp/v1
```

For Letter IRL:
```
https://amitotically-gubernacular-elise.ngrok-free.dev/api/acp/v1
```

### Authentication

All requests include:
```
Authorization: Bearer <access_token>
```

Use the same Auth0 JWT validation we implemented for MCP tools.

### Endpoint 1: Create Cart

**`POST /api/acp/v1/cart/create`**

Creates a new shopping cart for the authenticated user.

**Request Headers:**
```
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "metadata": {
    "source": "chatgpt",
    "user_agent": "ChatGPT/1.0"
  }
}
```

**Response (200 OK):**
```json
{
  "cart_id": "cart_abc123xyz",
  "created_at": "2025-01-14T12:00:00Z",
  "expires_at": "2025-01-15T12:00:00Z",
  "status": "active"
}
```

**Error Responses:**
- `401 Unauthorized` - Invalid or missing Bearer token
- `500 Internal Server Error` - Server error creating cart

### Endpoint 2: Add/Update Cart Items

**`POST /api/acp/v1/cart/items`**

Adds or updates items in an existing cart.

**Request Headers:**
```
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "cart_id": "cart_abc123xyz",
  "items": [
    {
      "product_id": "credit-pack-20",
      "quantity": 1
    }
  ]
}
```

**Response (200 OK):**
```json
{
  "cart_id": "cart_abc123xyz",
  "items": [
    {
      "product_id": "credit-pack-20",
      "name": "Regular Pack - 20 Credits",
      "quantity": 1,
      "unit_price": "USD 9.99",
      "total_price": "USD 9.99"
    }
  ],
  "updated_at": "2025-01-14T12:05:00Z"
}
```

**Error Responses:**
- `400 Bad Request` - Invalid cart_id or product_id
- `401 Unauthorized` - Invalid or missing Bearer token
- `404 Not Found` - Cart not found or expired

### Endpoint 3: Get Cart Details

**`GET /api/acp/v1/cart/:cartId`**

Retrieves current cart contents and totals.

**Request Headers:**
```
Authorization: Bearer <jwt_token>
```

**Response (200 OK):**
```json
{
  "cart_id": "cart_abc123xyz",
  "created_at": "2025-01-14T12:00:00Z",
  "expires_at": "2025-01-15T12:00:00Z",
  "status": "active",
  "items": [
    {
      "product_id": "credit-pack-20",
      "name": "Regular Pack - 20 Credits",
      "quantity": 1,
      "unit_price": "USD 9.99",
      "total_price": "USD 9.99"
    }
  ],
  "subtotal": "USD 9.99",
  "tax": "USD 0.00",
  "total": "USD 9.99"
}
```

**Error Responses:**
- `401 Unauthorized` - Invalid or missing Bearer token
- `404 Not Found` - Cart not found or expired

### Endpoint 4: Get Checkout Quote

**`POST /api/acp/v1/checkout/quote`**

Gets final pricing including tax before completing purchase.

**Request Headers:**
```
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "cart_id": "cart_abc123xyz",
  "billing_address": {
    "country": "US",
    "state": "IL",
    "postal_code": "62701"
  }
}
```

**Response (200 OK):**
```json
{
  "quote_id": "quote_xyz789",
  "cart_id": "cart_abc123xyz",
  "subtotal": "USD 9.99",
  "tax": "USD 0.00",
  "total": "USD 9.99",
  "currency": "USD",
  "expires_at": "2025-01-14T12:20:00Z",
  "line_items": [
    {
      "product_id": "credit-pack-20",
      "name": "Regular Pack - 20 Credits",
      "quantity": 1,
      "unit_price": "USD 9.99",
      "total_price": "USD 9.99"
    }
  ]
}
```

**Error Responses:**
- `400 Bad Request` - Invalid cart_id or billing address
- `401 Unauthorized` - Invalid or missing Bearer token
- `404 Not Found` - Cart not found

### Endpoint 5: Complete Checkout

**`POST /api/acp/v1/checkout/complete`**

Finalizes the purchase using Stripe's Shared Payment Token.

**Request Headers:**
```
Authorization: Bearer <jwt_token>
Content-Type: application/json
Idempotency-Key: <unique_key>
```

**Request Body:**
```json
{
  "cart_id": "cart_abc123xyz",
  "quote_id": "quote_xyz789",
  "payment": {
    "shared_payment_token": "spt_1234567890abcdef",
    "billing_address": {
      "country": "US",
      "state": "IL",
      "postal_code": "62701",
      "city": "Springfield",
      "line1": "123 Main St"
    }
  }
}
```

**Response (200 OK):**
```json
{
  "order_id": "order_abc123",
  "status": "completed",
  "total": "USD 9.99",
  "currency": "USD",
  "created_at": "2025-01-14T12:15:00Z",
  "credits_added": 20,
  "new_balance": 45,
  "receipt_url": "https://your-domain.com/receipts/order_abc123"
}
```

**Error Responses:**
- `400 Bad Request` - Invalid cart, quote, or payment token
- `401 Unauthorized` - Invalid or missing Bearer token
- `402 Payment Required` - Payment failed
- `409 Conflict` - Duplicate request (check Idempotency-Key)
- `500 Internal Server Error` - Server error processing payment

### Idempotency

The `POST /checkout/complete` endpoint MUST support idempotency to prevent duplicate charges:

1. Client sends `Idempotency-Key` header with unique value
2. Server stores key + response for 24 hours
3. Duplicate requests with same key return original response (not 409)
4. Different cart_id with same key returns 409 Conflict

**Example:**
```typescript
// Store idempotency keys
const idempotencyStore = new Map<string, {
  response: CheckoutCompleteResponse;
  cart_id: string;
  created_at: Date;
}>();

function handleCheckoutComplete(req) {
  const idempotencyKey = req.headers['idempotency-key'];
  const { cart_id } = req.body;

  // Check for duplicate request
  const existing = idempotencyStore.get(idempotencyKey);
  if (existing) {
    if (existing.cart_id !== cart_id) {
      return { status: 409, error: 'Idempotency key reused with different cart' };
    }
    return { status: 200, data: existing.response };
  }

  // Process new payment...
  const response = processPayment(req.body);

  // Store for future duplicate detection
  idempotencyStore.set(idempotencyKey, {
    response,
    cart_id,
    created_at: new Date()
  });

  return { status: 200, data: response };
}
```

## Component 3: Delegated Payment with Stripe SPT

### Overview

Stripe's **Shared Payment Token (SPT)** enables delegated payment where:
1. User authorizes ChatGPT to make purchases
2. ChatGPT receives SPT from Stripe
3. ChatGPT passes SPT to your server
4. Your server charges user's payment method via Stripe API
5. Money flows directly to your Stripe account

### Setup Requirements

1. **Stripe Account** with SPT enabled
2. **Stripe API Keys** (test and live)
3. **Webhook Endpoint** for payment events
4. **HTTPS** endpoints (required for production)

### SPT Flow

```
┌──────────┐                                  ┌─────────┐
│  User    │                                  │ ChatGPT │
└────┬─────┘                                  └────┬────┘
     │                                             │
     │  1. "Buy 20 credits"                        │
     ├────────────────────────────────────────────>│
     │                                             │
     │  2. Authorize payment with Stripe           │
     │<────────────────────────────────────────────┤
     │                                             │
     ├──────────────┐                              │
     │ Stripe auth  │                              │
     │<─────────────┘                              │
     │                                             │
     │  3. SPT token                               │
     ├────────────────────────────────────────────>│
     │                                             │
     │                                             │  4. POST /checkout/complete
     │                                             │     {shared_payment_token: "spt_..."}
     │                                             ├──────────────────────────────>│
     │                                             │                           ┌───┴────┐
     │                                             │                           │ Letter │
     │                                             │                           │  IRL   │
     │                                             │                           │ Server │
     │                                             │                           └───┬────┘
     │                                             │                               │
     │                                             │  5. Charge SPT via Stripe API │
     │                                             │                               ├──────────┐
     │                                             │                               │  Stripe  │
     │                                             │                               │<─────────┘
     │                                             │                               │
     │                                             │  6. Add credits, return order │
     │                                             │<──────────────────────────────┤
     │                                             │                               │
     │  7. "Purchase complete! +20 credits"        │                               │
     │<────────────────────────────────────────────┤                               │
     │                                             │                               │
```

### Charging an SPT

When you receive a `shared_payment_token` in the checkout complete request:

```typescript
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function chargeSharedPaymentToken(
  spt: string,
  amount: number,
  currency: string,
  orderId: string
) {
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: currency.toLowerCase(),
      payment_method: spt,
      confirm: true,
      description: `Letter IRL Credit Purchase - Order ${orderId}`,
      metadata: {
        order_id: orderId,
        service: 'letter-irl'
      }
    });

    if (paymentIntent.status === 'succeeded') {
      return { success: true, payment_intent_id: paymentIntent.id };
    } else {
      return { success: false, error: 'Payment not completed' };
    }
  } catch (error) {
    console.error('Stripe payment failed:', error);
    return { success: false, error: error.message };
  }
}
```

### Error Handling

Common SPT errors:

| Error Code | Reason | Action |
|------------|--------|--------|
| `card_declined` | Card issuer declined | Return 402 with user-friendly message |
| `insufficient_funds` | Not enough funds | Return 402, suggest lower amount |
| `invalid_token` | SPT expired or invalid | Return 400, ask user to retry |
| `authentication_required` | 3D Secure needed | Return 402 with next_action URL |

### Webhooks

Stripe sends webhook events for payment status updates. Required events:

- `payment_intent.succeeded` - Payment completed successfully
- `payment_intent.payment_failed` - Payment failed
- `charge.refunded` - Refund issued

**Webhook Handler Structure:**
```typescript
app.post('/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'payment_intent.succeeded':
      await handlePaymentSuccess(event.data.object);
      break;
    case 'payment_intent.payment_failed':
      await handlePaymentFailure(event.data.object);
      break;
    case 'charge.refunded':
      await handleRefund(event.data.object);
      break;
  }

  res.json({ received: true });
});
```

## Security Requirements

### 1. HTTPS Only

All endpoints MUST use HTTPS in production. Local development can use HTTP.

### 2. Bearer Token Authentication

Reuse existing Auth0 JWT validation:

```typescript
import { jwtVerify, createRemoteJWKSet } from 'jose';

const JWKS = createRemoteJWKSet(
  new URL(process.env.LETTER_IRL_OAUTH_JWKS_URI)
);

async function authenticateRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing Bearer token');
  }

  const token = authHeader.substring(7);
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: process.env.LETTER_IRL_OAUTH_ISSUER,
    audience: process.env.LETTER_IRL_OAUTH_AUDIENCE
  });

  return { userId: payload.sub, email: payload.email };
}
```

### 3. HMAC Request Signing (Optional but Recommended)

For added security, sign requests with HMAC:

```typescript
import crypto from 'crypto';

function generateHMAC(body: string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
}

function verifyHMAC(body: string, signature: string, secret: string): boolean {
  const expected = generateHMAC(body, secret);
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}
```

### 4. Rate Limiting

Implement rate limiting to prevent abuse:

```typescript
import rateLimit from 'express-rate-limit';

const acpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each user to 100 requests per window
  keyGenerator: (req) => req.auth.userId, // Rate limit per user
  message: 'Too many requests, please try again later'
});

app.use('/api/acp/v1', acpLimiter);
```

### 5. Input Validation

Validate all inputs with Zod schemas:

```typescript
import { z } from 'zod';

const CartCreateSchema = z.object({
  metadata: z.object({
    source: z.string().optional(),
    user_agent: z.string().optional()
  }).optional()
});

const CartItemsSchema = z.object({
  cart_id: z.string().min(1),
  items: z.array(z.object({
    product_id: z.string().min(1),
    quantity: z.number().int().positive().max(100)
  }))
});
```

## Data Storage

### Cart Schema

```typescript
interface Cart {
  cart_id: string;
  user_id: string; // From JWT
  created_at: Date;
  expires_at: Date; // 24 hours from creation
  status: 'active' | 'expired' | 'completed';
  items: CartItem[];
  subtotal: number;
  tax: number;
  total: number;
}

interface CartItem {
  product_id: string;
  name: string;
  quantity: number;
  unit_price: number;
  total_price: number;
}
```

### Order Schema

```typescript
interface Order {
  order_id: string;
  user_id: string;
  cart_id: string;
  quote_id: string;
  created_at: Date;
  status: 'pending' | 'completed' | 'failed' | 'refunded';

  // Payment details
  payment_intent_id: string;
  amount_total: number;
  currency: string;

  // Items purchased
  items: CartItem[];

  // Credits
  credits_purchased: number;

  // Receipt
  receipt_url: string;
}
```

### Storage Options

For Phase 1-2, use file-based storage (like current account system):
```
/mnt/c/letter-irl/data/
├── accounts/
│   └── auth0|user123.json
├── carts/
│   └── cart_abc123.json
└── orders/
    └── order_abc123.json
```

For production, migrate to PostgreSQL or similar database.

## Error Handling Standards

### Standard Error Response Format

```json
{
  "error": {
    "code": "invalid_cart",
    "message": "Cart not found or has expired",
    "details": {
      "cart_id": "cart_abc123"
    }
  }
}
```

### HTTP Status Codes

| Status | Use Case |
|--------|----------|
| 200 | Success |
| 400 | Bad Request (invalid input) |
| 401 | Unauthorized (missing/invalid token) |
| 402 | Payment Required (payment failed) |
| 404 | Not Found (cart/order doesn't exist) |
| 409 | Conflict (idempotency key reused) |
| 429 | Too Many Requests (rate limit) |
| 500 | Internal Server Error |

## Testing Strategy

### 1. Unit Tests

Test individual functions:
- Cart creation and expiration logic
- Item addition/removal
- Quote calculation
- Idempotency key handling

### 2. Integration Tests

Test complete flows:
- Create cart → Add items → Get quote → Complete checkout
- SPT payment processing with Stripe test mode
- Webhook handling

### 3. End-to-End Tests

Test with ChatGPT in test environment:
- Product discovery via ChatGPT
- Add to cart via ChatGPT
- Complete purchase flow
- Verify credits added to account

### Test Data

Stripe provides test SPT tokens:
- `spt_test_success` - Always succeeds
- `spt_test_decline` - Card declined
- `spt_test_insufficient_funds` - Insufficient funds

## Implementation Files Summary

### New Files to Create

1. `src/acp/productFeed.ts` - Product feed generation
2. `src/acp/cartService.ts` - Cart management logic
3. `src/acp/checkoutService.ts` - Checkout and payment processing
4. `src/acp/stripeService.ts` - Stripe SPT integration
5. `src/acp/acpRoutes.ts` - Express routes for 5 endpoints
6. `src/acp/acpSchemas.ts` - Zod validation schemas
7. `src/acp/webhookHandler.ts` - Stripe webhook processing
8. `src/acp/idempotency.ts` - Idempotency key management

### Files to Modify

1. `src/mcp/httpServer.ts` - Add ACP routes
2. `.env` - Add Stripe configuration
3. `package.json` - Add Stripe SDK dependency

## Environment Variables

Add to `.env`:

```bash
# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# ACP Configuration
LETTER_IRL_PRODUCT_FEED_URL=https://your-domain.com/api/acp/v1/products.json
LETTER_IRL_ACP_BASE_URL=https://your-domain.com/api/acp/v1

# Feature Flags
LETTER_IRL_ACP_ENABLED=true
```

## Next Steps

After completing this implementation:

1. Apply to ChatGPT Merchants Program: https://chatgpt.com/merchants
2. Complete Stripe onboarding and enable SPT
3. Create product images for credit packages
4. Test complete flow in ChatGPT staging environment
5. Submit for OpenAI certification
6. Launch to production

## References

- [OpenAI Agentic Commerce Protocol Spec](https://platform.openai.com/docs/agentic-commerce)
- [Stripe Shared Payment Token Docs](https://stripe.com/docs/payments/shared-payment-token)
- [ChatGPT Merchants Program](https://chatgpt.com/merchants)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
- Letter IRL Docs: `docs/acp-stripe-integration.md`, `docs/credit-packages-spec.md`
