# ACP Implementation Quickstart

Get Letter IRL's Agentic Commerce Protocol (ACP) credit purchasing up and running in 8 weeks.

## Week 1: Setup and Documentation ✅

### Prerequisites

- [ ] Existing Letter IRL MCP server running
- [ ] Auth0 OAuth integration working
- [ ] Ngrok or production domain with HTTPS
- [ ] Node.js 20+ and npm

### Read Documentation

- [ ] `docs/acp-implementation-guide.md` - Full technical spec
- [ ] `docs/acp-stripe-integration.md` - Stripe SPT details
- [ ] `docs/credit-packages-spec.md` - Product definitions
- [ ] `docs/credit-purchase-flow.md` - End-to-end flow

### Apply to Merchants Program

1. Visit https://chatgpt.com/merchants
2. Fill out application form
3. Provide app description and ACP implementation plans
4. Wait for approval (typically 1-2 weeks)

**Status:** ✅ Documentation complete

---

## Week 2: Stripe Setup

### Create Stripe Account

1. Sign up at https://dashboard.stripe.com
2. Complete business verification
3. Enable test mode

### Enable Shared Payment Token (SPT)

1. Contact Stripe support: https://support.stripe.com/contact
2. Request "Shared Payment Token" feature access
3. Mention OpenAI Agentic Commerce Protocol implementation
4. Wait for confirmation (1-2 business days)

### Get API Keys

In Stripe Dashboard → Developers → API keys:

```bash
# Test mode (for development)
STRIPE_SECRET_KEY=sk_test_51xxxxxxxxxxxxxxxx
STRIPE_PUBLISHABLE_KEY=pk_test_51xxxxxxxxxxxxxxxx
```

### Configure Webhooks

1. Dashboard → Developers → Webhooks → Add endpoint
2. URL: `https://your-domain.com/webhooks/stripe`
3. Events: `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`
4. Copy webhook secret: `whsec_xxxxxxxxxxxxxxxx`

### Install Stripe SDK

```bash
cd /mnt/c/letter-irl
npm install stripe
```

### Update Environment

Add to `.env`:

```bash
# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_51xxxxxxxxxxxxxxxx
STRIPE_PUBLISHABLE_KEY=pk_test_51xxxxxxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxx
STRIPE_API_VERSION=2023-10-16
STRIPE_CURRENCY=usd

# ACP Configuration
LETTER_IRL_PRODUCT_FEED_URL=https://your-domain.com/api/acp/v1/products.json
LETTER_IRL_ACP_BASE_URL=https://your-domain.com/api/acp/v1
LETTER_IRL_ACP_ENABLED=true
```

---

## Week 3: Product Feed Implementation

### Create Product Feed Service

**File:** `src/acp/productFeed.ts`

```typescript
export interface Product {
  product_id: string;
  name: string;
  price: string; // "USD 9.99"
  description: string;
  category: string;
  image_url: string;
  availability: string;
  metadata: {
    credits: number;
    [key: string]: any;
  };
}

export function getProducts(): Product[] {
  return [
    {
      product_id: "credit-pack-5",
      name: "Starter Pack - 2 Letters",
      price: "USD 2.99",
      description: "Perfect for trying out Letter IRL. Send 1-2 letters.",
      category: "credit-packages",
      image_url: `${process.env.LETTER_IRL_PUBLIC_BASE_URL}/images/products/credit-pack-5.png`,
      availability: "in stock",
      metadata: {
        credits: 5,
        best_for: "trying_out"
      }
    },
    {
      product_id: "credit-pack-20",
      name: "Regular Pack - 5 Letters",
      price: "USD 9.99",
      description: "Most popular! Send 6-10 letters. Save 16%.",
      category: "credit-packages",
      image_url: `${process.env.LETTER_IRL_PUBLIC_BASE_URL}/images/products/credit-pack-20.png`,
      availability: "in stock",
      metadata: {
        credits: 20,
        best_for: "regular_use",
        savings_percent: 16,
        badge: "POPULAR"
      }
    },
    {
      product_id: "credit-pack-100",
      name: "Power Pack - 50 Letters",
      price: "USD 39.99",
      description: "Best value! Send 30-50 letters. Save 33%.",
      category: "credit-packages",
      image_url: `${process.env.LETTER_IRL_PUBLIC_BASE_URL}/images/products/credit-pack-100.png`,
      availability: "in stock",
      metadata: {
        credits: 100,
        best_for: "power_users",
        savings_percent: 33,
        badge: "BEST VALUE"
      }
    }
  ];
}
```

### Add Product Feed Endpoint

In `src/mcp/httpServer.ts`:

```typescript
import { getProducts } from '../acp/productFeed.js';

// Add route
app.get('/api/acp/v1/products.json', (req, res) => {
  res.json({
    version: "1.0",
    updated_at: new Date().toISOString(),
    currency: "USD",
    products: getProducts()
  });
});
```

### Create Product Images

Create placeholder images for now:

```bash
mkdir -p /mnt/c/letter-irl/public/images/products
cd /mnt/c/letter-irl/public/images/products

# Download placeholders (replace with real images later)
curl "https://placehold.co/1200x1200/3B82F6/FFFFFF/png?text=5+Credits" > credit-pack-5.png
curl "https://placehold.co/1200x1200/10B981/FFFFFF/png?text=20+Credits" > credit-pack-20.png
curl "https://placehold.co/1200x1200/8B5CF6/FFFFFF/png?text=100+Credits" > credit-pack-100.png
```

### Serve Static Files

In `src/mcp/httpServer.ts`:

```typescript
import express from 'express';
import path from 'path';

app.use('/images', express.static(path.join(__dirname, '../../public/images')));
```

### Test Product Feed

```bash
npm run mcp:http

# In another terminal
curl http://localhost:8788/api/acp/v1/products.json | jq
```

Expected: JSON with 3 products

---

## Week 4: Cart and Checkout API - Part 1

### Create Data Schemas

**File:** `src/acp/acpSchemas.ts`

```typescript
import { z } from 'zod';

export const CartCreateSchema = z.object({
  metadata: z.object({
    source: z.string().optional(),
    user_agent: z.string().optional()
  }).optional()
});

export const CartItemsSchema = z.object({
  cart_id: z.string().min(1),
  items: z.array(z.object({
    product_id: z.string().min(1),
    quantity: z.number().int().positive().max(100)
  }))
});

export const CheckoutQuoteSchema = z.object({
  cart_id: z.string().min(1),
  billing_address: z.object({
    country: z.string().length(2),
    state: z.string().optional(),
    postal_code: z.string().optional()
  })
});

export const CheckoutCompleteSchema = z.object({
  cart_id: z.string().min(1),
  quote_id: z.string().min(1),
  payment: z.object({
    shared_payment_token: z.string().min(1),
    billing_address: z.object({
      country: z.string().length(2),
      state: z.string().optional(),
      postal_code: z.string().optional(),
      city: z.string().optional(),
      line1: z.string().optional()
    })
  })
});
```

### Create Cart Service

**File:** `src/acp/cartService.ts`

```typescript
import { randomUUID } from 'crypto';
import { getProducts } from './productFeed.js';

export interface Cart {
  cart_id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
  status: 'active' | 'expired' | 'completed';
  items: CartItem[];
  subtotal: number;
  tax: number;
  total: number;
}

export interface CartItem {
  product_id: string;
  name: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  metadata: any;
}

export async function createCart(userId: string): Promise<Cart> {
  const cart: Cart = {
    cart_id: `cart_${randomUUID()}`,
    user_id: userId,
    created_at: new Date(),
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    status: 'active',
    items: [],
    subtotal: 0,
    tax: 0,
    total: 0
  };

  await saveCart(cart);
  return cart;
}

export async function addCartItems(
  cartId: string,
  items: { product_id: string; quantity: number }[]
): Promise<Cart> {
  const cart = await getCart(cartId);
  if (!cart) throw new Error('Cart not found');

  const products = getProducts();

  for (const item of items) {
    const product = products.find(p => p.product_id === item.product_id);
    if (!product) throw new Error(`Product not found: ${item.product_id}`);

    const price = parseFloat(product.price.split(' ')[1]);

    const existingIndex = cart.items.findIndex(i => i.product_id === item.product_id);

    if (existingIndex >= 0) {
      cart.items[existingIndex].quantity = item.quantity;
      cart.items[existingIndex].total_price = price * item.quantity;
    } else {
      cart.items.push({
        product_id: item.product_id,
        name: product.name,
        quantity: item.quantity,
        unit_price: price,
        total_price: price * item.quantity,
        metadata: product.metadata
      });
    }
  }

  // Recalculate totals
  cart.subtotal = cart.items.reduce((sum, item) => sum + item.total_price, 0);
  cart.tax = 0; // Digital credits are not taxed
  cart.total = cart.subtotal + cart.tax;

  await saveCart(cart);
  return cart;
}

// Implement file-based storage (similar to account storage)
async function saveCart(cart: Cart): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');

  const dir = path.join(process.cwd(), 'data', 'carts');
  await fs.mkdir(dir, { recursive: true });

  const filePath = path.join(dir, `${cart.cart_id}.json`);
  await fs.writeFile(filePath, JSON.stringify(cart, null, 2));
}

async function getCart(cartId: string): Promise<Cart | null> {
  const fs = await import('fs/promises');
  const path = await import('path');

  const filePath = path.join(process.cwd(), 'data', 'carts', `${cartId}.json`);

  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}
```

### Create ACP Routes

**File:** `src/acp/acpRoutes.ts`

```typescript
import { Router } from 'express';
import { createCart, addCartItems } from './cartService.js';
import { CartCreateSchema, CartItemsSchema } from './acpSchemas.js';

export const acpRouter = Router();

// POST /cart/create
acpRouter.post('/cart/create', async (req, res) => {
  try {
    const authInfo = req.authInfo; // Set by auth middleware
    const body = CartCreateSchema.parse(req.body);

    const cart = await createCart(authInfo.userId);

    res.json({
      cart_id: cart.cart_id,
      created_at: cart.created_at.toISOString(),
      expires_at: cart.expires_at.toISOString(),
      status: cart.status
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /cart/items
acpRouter.post('/cart/items', async (req, res) => {
  try {
    const body = CartItemsSchema.parse(req.body);
    const cart = await addCartItems(body.cart_id, body.items);

    res.json({
      cart_id: cart.cart_id,
      items: cart.items,
      updated_at: new Date().toISOString()
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /cart/:cartId
acpRouter.get('/cart/:cartId', async (req, res) => {
  try {
    const cart = await getCart(req.params.cartId);
    if (!cart) {
      return res.status(404).json({ error: 'Cart not found' });
    }

    res.json({
      cart_id: cart.cart_id,
      created_at: cart.created_at.toISOString(),
      expires_at: cart.expires_at.toISOString(),
      status: cart.status,
      items: cart.items,
      subtotal: `USD ${cart.subtotal.toFixed(2)}`,
      tax: `USD ${cart.tax.toFixed(2)}`,
      total: `USD ${cart.total.toFixed(2)}`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### Add Auth Middleware

In `src/mcp/httpServer.ts`:

```typescript
import { jwtVerify, createRemoteJWKSet } from 'jose';

const JWKS = createRemoteJWKSet(
  new URL(process.env.LETTER_IRL_OAUTH_JWKS_URI!)
);

async function acpAuthMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Bearer token' });
    }

    const token = authHeader.substring(7);
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: process.env.LETTER_IRL_OAUTH_ISSUER,
      audience: process.env.LETTER_IRL_OAUTH_AUDIENCE
    });

    req.authInfo = { userId: payload.sub, email: payload.email };
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Apply to ACP routes
import { acpRouter } from '../acp/acpRoutes.js';
app.use('/api/acp/v1', acpAuthMiddleware, acpRouter);
```

---

## Week 5: Cart and Checkout API - Part 2

### Implement Quote Endpoint

In `src/acp/acpRoutes.ts`, add:

```typescript
import { randomUUID } from 'crypto';

// POST /checkout/quote
acpRouter.post('/checkout/quote', async (req, res) => {
  try {
    const body = CheckoutQuoteSchema.parse(req.body);
    const cart = await getCart(body.cart_id);

    if (!cart) {
      return res.status(404).json({ error: 'Cart not found' });
    }

    const quote = {
      quote_id: `quote_${randomUUID()}`,
      cart_id: cart.cart_id,
      subtotal: `USD ${cart.subtotal.toFixed(2)}`,
      tax: `USD ${cart.tax.toFixed(2)}`,
      total: `USD ${cart.total.toFixed(2)}`,
      currency: 'USD',
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 min
      line_items: cart.items
    };

    // Store quote (implement similar to cart storage)
    await saveQuote(quote);

    res.json(quote);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
```

### Implement Checkout Complete Endpoint

**File:** `src/acp/checkoutService.ts`

```typescript
import { chargeSharedPaymentToken } from './stripeService.js';
import { getAccount, saveAccount } from '../services/accountService.js';

export async function completeCheckout(
  cartId: string,
  quoteId: string,
  spt: string,
  userId: string
) {
  // Validate cart and quote
  const cart = await getCart(cartId);
  const quote = await getQuote(quoteId);

  if (!cart || !quote) {
    throw new Error('Invalid cart or quote');
  }

  if (cart.user_id !== userId) {
    throw new Error('Cart does not belong to user');
  }

  // Calculate credits
  const creditsPurchased = cart.items.reduce(
    (sum, item) => sum + (item.metadata.credits * item.quantity),
    0
  );

  // Create order ID
  const orderId = `order_${Date.now()}_${randomUUID().substring(0, 8)}`;

  // Charge payment via Stripe
  const result = await chargeSharedPaymentToken(
    spt,
    cart.total,
    'usd',
    orderId,
    userId,
    `Letter IRL Credits - Order ${orderId}`
  );

  if (!result.success) {
    throw new Error(`Payment failed: ${result.error}`);
  }

  // Add credits to account
  const account = await getAccount(userId);
  account.credits += creditsPurchased;
  account.creditsPurchased += creditsPurchased;
  await saveAccount(account);

  // Save order
  const order = {
    order_id: orderId,
    user_id: userId,
    cart_id: cartId,
    quote_id: quoteId,
    created_at: new Date(),
    status: 'completed',
    payment_intent_id: result.payment_intent_id,
    amount_total: cart.total,
    currency: 'USD',
    items: cart.items,
    credits_purchased: creditsPurchased
  };
  await saveOrder(order);

  // Update cart status
  cart.status = 'completed';
  await saveCart(cart);

  return {
    order_id: orderId,
    status: 'completed',
    total: `USD ${cart.total.toFixed(2)}`,
    currency: 'USD',
    created_at: order.created_at.toISOString(),
    credits_added: creditsPurchased,
    new_balance: account.credits,
    receipt_url: `${process.env.LETTER_IRL_PUBLIC_BASE_URL}/receipts/${orderId}`
  };
}
```

Add to `src/acp/acpRoutes.ts`:

```typescript
// POST /checkout/complete
acpRouter.post('/checkout/complete', async (req, res) => {
  try {
    const body = CheckoutCompleteSchema.parse(req.body);
    const idempotencyKey = req.headers['idempotency-key'];

    if (!idempotencyKey) {
      return res.status(400).json({ error: 'Missing Idempotency-Key header' });
    }

    // Check idempotency (implement similar to other storage)
    const existing = await checkIdempotency(idempotencyKey);
    if (existing) {
      return res.json(existing.response);
    }

    const result = await completeCheckout(
      body.cart_id,
      body.quote_id,
      body.payment.shared_payment_token,
      req.authInfo.userId
    );

    // Store idempotency
    await storeIdempotency(idempotencyKey, { response: result, cart_id: body.cart_id });

    res.json(result);
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(402).json({ error: error.message });
  }
});
```

### Implement Stripe Service

**File:** `src/acp/stripeService.ts`

```typescript
import Stripe from 'stripe';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
  typescript: true
});

export async function chargeSharedPaymentToken(
  spt: string,
  amount: number,
  currency: string,
  orderId: string,
  userId: string,
  description: string
) {
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency,
      payment_method: spt,
      confirm: true,
      description,
      metadata: { order_id: orderId, user_id: userId }
    });

    return {
      success: paymentIntent.status === 'succeeded',
      payment_intent_id: paymentIntent.id
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      error_code: error.code
    };
  }
}
```

---

## Week 6: Webhooks and Testing

### Implement Webhook Handler

**File:** `src/acp/webhookHandler.ts`

```typescript
import { stripe } from './stripeService.js';

export async function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];

  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );

    switch (event.type) {
      case 'payment_intent.succeeded':
        console.log('Payment succeeded:', event.data.object.id);
        break;
      case 'payment_intent.payment_failed':
        console.log('Payment failed:', event.data.object.id);
        break;
      case 'charge.refunded':
        console.log('Charge refunded:', event.data.object.id);
        break;
    }

    res.json({ received: true });
  } catch (error) {
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
}
```

Add to `src/mcp/httpServer.ts`:

```typescript
import express from 'express';
import { handleStripeWebhook } from '../acp/webhookHandler.js';

// Webhook needs raw body
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook
);
```

### Test with Stripe CLI

```bash
# Install Stripe CLI
brew install stripe/stripe-cli/stripe

# Login
stripe login

# Forward webhooks to local server
stripe listen --forward-to localhost:8788/webhooks/stripe

# Trigger test events
stripe trigger payment_intent.succeeded
```

### Manual Testing

```bash
# 1. Start server
npm run mcp:http

# 2. Create cart
curl -X POST http://localhost:8788/api/acp/v1/cart/create \
  -H "Authorization: Bearer <test_jwt>" \
  -H "Content-Type: application/json" \
  -d '{}'

# 3. Add items
curl -X POST http://localhost:8788/api/acp/v1/cart/items \
  -H "Authorization: Bearer <test_jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "cart_id": "cart_xxx",
    "items": [{"product_id": "credit-pack-20", "quantity": 1}]
  }'

# 4. Get quote
curl -X POST http://localhost:8788/api/acp/v1/checkout/quote \
  -H "Authorization: Bearer <test_jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "cart_id": "cart_xxx",
    "billing_address": {"country": "US", "state": "IL", "postal_code": "62701"}
  }'

# 5. Complete checkout (with test SPT)
curl -X POST http://localhost:8788/api/acp/v1/checkout/complete \
  -H "Authorization: Bearer <test_jwt>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-$(date +%s)" \
  -d '{
    "cart_id": "cart_xxx",
    "quote_id": "quote_xxx",
    "payment": {
      "shared_payment_token": "spt_test_success",
      "billing_address": {"country": "US"}
    }
  }'
```

---

## Week 7: Production Deployment

### Switch to Live Stripe Keys

Update `.env`:

```bash
STRIPE_SECRET_KEY=sk_live_51xxxxxxxxxxxxxxxx
STRIPE_PUBLISHABLE_KEY=pk_live_51xxxxxxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_live_xxxxxxxxxxxxxxxx
```

### Deploy to Production

```bash
# Ensure ngrok is running (or use production domain)
ngrok http 8788

# Update .env with production URL
LETTER_IRL_PUBLIC_BASE_URL=https://your-production-domain.com

# Restart server
npm run mcp:http
```

### Update Manifest

Update `manifest.json` to include ACP capabilities (if required by OpenAI spec).

### Security Checklist

- [ ] All endpoints use HTTPS
- [ ] JWT validation active
- [ ] Webhook signature verification enabled
- [ ] Rate limiting configured
- [ ] Idempotency keys required
- [ ] Error logging active

### Test End-to-End in ChatGPT

1. Open ChatGPT
2. Connect to Letter IRL MCP server
3. Authenticate via Auth0
4. Try: "Show me credit packages"
5. Try: "Buy the Regular Pack"
6. Complete Stripe payment authorization
7. Verify credits added: "Check my credit balance"
8. Send a letter using new credits

---

## Week 8: Certification and Launch

### Submit for OpenAI Certification

1. Ensure all ACP endpoints working
2. Complete end-to-end testing
3. Submit certification request to OpenAI
4. Provide test account credentials
5. Wait for approval

### Launch Checklist

- [ ] All 5 ACP endpoints tested
- [ ] Stripe live mode active
- [ ] Webhooks configured and tested
- [ ] Product images finalized
- [ ] Error handling tested
- [ ] Monitoring and logging active
- [ ] Support email configured
- [ ] Privacy policy updated
- [ ] Terms of service updated

### Monitor Key Metrics

- Payment success rate
- Average transaction value
- Credits purchased vs used
- Error rates by endpoint
- Popular packages

### Celebrate! 🎉

You've successfully implemented full ACP support for Letter IRL!

---

## Quick Reference

### Key Endpoints

```
GET  /api/acp/v1/products.json          # Product feed
POST /api/acp/v1/cart/create            # Create cart
POST /api/acp/v1/cart/items             # Add items
GET  /api/acp/v1/cart/:cartId           # Get cart
POST /api/acp/v1/checkout/quote         # Get quote
POST /api/acp/v1/checkout/complete      # Complete purchase
POST /webhooks/stripe                    # Stripe webhooks
```

### Environment Variables

```bash
# Stripe
STRIPE_SECRET_KEY=sk_xxx
STRIPE_PUBLISHABLE_KEY=pk_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx

# ACP
LETTER_IRL_PRODUCT_FEED_URL=https://domain/api/acp/v1/products.json
LETTER_IRL_ACP_BASE_URL=https://domain/api/acp/v1
LETTER_IRL_ACP_ENABLED=true
```

### Test Commands

```bash
# Test product feed
curl http://localhost:8788/api/acp/v1/products.json

# Test with Stripe CLI
stripe listen --forward-to localhost:8788/webhooks/stripe
stripe trigger payment_intent.succeeded
```

### Documentation

- `docs/acp-implementation-guide.md` - Full technical spec
- `docs/acp-stripe-integration.md` - Stripe details
- `docs/credit-packages-spec.md` - Product specs
- `docs/credit-purchase-flow.md` - User flow

### Support

- **Stripe:** https://support.stripe.com
- **OpenAI:** https://platform.openai.com/docs/agentic-commerce
- **Letter IRL:** Review implementation docs

---

## Troubleshooting

### "Payment failed: Invalid SPT"

- Ensure using correct Stripe mode (test vs live)
- Check SPT token hasn't expired
- Verify Stripe SPT feature is enabled

### "Cart not found"

- Check cart hasn't expired (24 hour lifetime)
- Verify cart_id is correct
- Ensure cart storage is working

### "Webhook signature verification failed"

- Check webhook secret is correct
- Ensure raw body is passed to webhook handler
- Verify endpoint URL matches Stripe dashboard

### "401 Unauthorized"

- Verify JWT Bearer token is valid
- Check Auth0 configuration
- Ensure JWKS URI is accessible

---

## Next Steps After Launch

1. Monitor metrics and user feedback
2. Design professional product images
3. Add promotional campaigns
4. Implement referral program
5. Consider subscription plans
6. Add business tier pricing
7. Migrate to database from file storage
8. Add analytics and reporting
9. Implement customer support tools
10. Scale infrastructure as needed

**You're ready to go! 🚀**
