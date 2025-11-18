# Letter IRL Credit Purchase Flow

## Overview

This document describes the complete end-to-end flow for purchasing Letter IRL credits through ChatGPT using the Agentic Commerce Protocol (ACP).

## User Experience Flow

### 1. Discovery (User initiates)

**User:** "I want to send a letter to my grandmother"

**ChatGPT:** Calls `quote_and_preview_letter` tool to generate preview

**Response:**
```
Great! I can help you send a physical letter to your grandmother.

Preview: [HTML preview of letter]

Cost: 2 credits
Current balance: 0 credits

You don't have enough credits. Would you like to purchase some?
I have packages available: 5, 20, or 100 credits.
```

### 2. Browse Products (ChatGPT retrieves product feed)

**User:** "Show me the credit packages"

**ChatGPT:** Fetches product feed from `/api/acp/v1/products.json`

**Response:**
```
Here are the available credit packages:

📦 Starter Pack - 5 Credits - $2.99
   Perfect for trying out Letter IRL
   Send 1-2 letters

📦 Regular Pack - 20 Credits - $9.99 ⭐ POPULAR
   Save 16% vs Starter Pack
   Send 6-10 letters
   Most popular choice

📦 Power Pack - 100 Credits - $39.99 💎 BEST VALUE
   Save 33% vs Starter Pack
   Send 30-50 letters
   Best for businesses

Which package would you like to purchase?
```

### 3. Add to Cart

**User:** "I'll get the Regular Pack"

**ChatGPT:** Calls `POST /api/acp/v1/cart/create`

**Server Response:**
```json
{
  "cart_id": "cart_abc123xyz",
  "created_at": "2025-01-14T12:00:00Z",
  "expires_at": "2025-01-15T12:00:00Z",
  "status": "active"
}
```

**ChatGPT:** Calls `POST /api/acp/v1/cart/items`

**Server Response:**
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
  ]
}
```

**ChatGPT to User:**
```
Added Regular Pack (20 credits) to your cart for $9.99.
Ready to checkout?
```

### 4. Review Cart

**User:** "Yes, let's checkout"

**ChatGPT:** Calls `GET /api/acp/v1/cart/cart_abc123xyz`

**Server Response:**
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
  "subtotal": "USD 9.99",
  "tax": "USD 0.00",
  "total": "USD 9.99"
}
```

### 5. Get Quote

**ChatGPT:** Calls `POST /api/acp/v1/checkout/quote`

**Request:**
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

**Server Response:**
```json
{
  "quote_id": "quote_xyz789",
  "cart_id": "cart_abc123xyz",
  "subtotal": "USD 9.99",
  "tax": "USD 0.00",
  "total": "USD 9.99",
  "currency": "USD",
  "expires_at": "2025-01-14T12:20:00Z"
}
```

**ChatGPT to User:**
```
Your total is $9.99 (no tax for digital credits).
Ready to complete your purchase?
```

### 6. Payment Authorization

**User:** "Yes"

**ChatGPT:** Initiates Stripe payment flow

**Stripe:** User authorizes payment (if not already connected)
- Select payment method
- Confirm billing address
- Authorize ChatGPT to charge

**Stripe:** Issues Shared Payment Token (SPT)

### 7. Complete Checkout

**ChatGPT:** Calls `POST /api/acp/v1/checkout/complete`

**Request:**
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

**Headers:**
```
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json
Idempotency-Key: chatgpt_20250114_120500_abc123
```

**Server:**
1. Validates JWT (user authentication)
2. Validates cart and quote
3. Calls Stripe API to charge SPT
4. Adds credits to user account
5. Creates order record

**Server Response:**
```json
{
  "order_id": "order_abc123",
  "status": "completed",
  "total": "USD 9.99",
  "currency": "USD",
  "created_at": "2025-01-14T12:15:00Z",
  "credits_added": 20,
  "new_balance": 20,
  "receipt_url": "https://amitotically-gubernacular-elise.ngrok-free.dev/receipts/order_abc123"
}
```

**ChatGPT to User:**
```
✅ Purchase complete!

You've successfully purchased 20 credits for $9.99.
New balance: 20 credits

Receipt: [link to receipt]

Now you can send that letter to your grandmother!
```

### 8. Send Letter (Using New Credits)

**User:** "Great, let's send the letter"

**ChatGPT:** Calls `send_letter` tool with `confirm: true`

**Server:**
1. Deducts 2 credits from balance
2. Creates print/mail order
3. Returns confirmation

**Response:**
```
✅ Letter sent successfully!

To: Grandma Smith
   123 Oak Street
   Springfield, IL 62701

Credits used: 2
Remaining balance: 18 credits

Expected delivery: January 18, 2025

Tracking: [tracking link]
```

## System Architecture Flow

```
┌──────────┐                 ┌──────────┐                 ┌──────────┐                 ┌─────────┐
│  User    │                 │ ChatGPT  │                 │ Letter   │                 │ Stripe  │
│          │                 │          │                 │   IRL    │                 │         │
└────┬─────┘                 └────┬─────┘                 └────┬─────┘                 └────┬────┘
     │                            │                            │                            │
     │ "Buy credits"              │                            │                            │
     ├───────────────────────────>│                            │                            │
     │                            │                            │                            │
     │                            │  GET /products.json        │                            │
     │                            ├───────────────────────────>│                            │
     │                            │<───────────────────────────┤                            │
     │                            │  [Product feed]            │                            │
     │                            │                            │                            │
     │ [Shows packages]           │                            │                            │
     │<───────────────────────────┤                            │                            │
     │                            │                            │                            │
     │ "Regular Pack"             │                            │                            │
     ├───────────────────────────>│                            │                            │
     │                            │                            │                            │
     │                            │  POST /cart/create         │                            │
     │                            │  Authorization: Bearer JWT │                            │
     │                            ├───────────────────────────>│                            │
     │                            │<───────────────────────────┤                            │
     │                            │  {cart_id: "cart_123"}     │                            │
     │                            │                            │                            │
     │                            │  POST /cart/items          │                            │
     │                            │  {product_id: "pack-20"}   │                            │
     │                            ├───────────────────────────>│                            │
     │                            │<───────────────────────────┤                            │
     │                            │  {items: [...]}            │                            │
     │                            │                            │                            │
     │                            │  POST /checkout/quote      │                            │
     │                            ├───────────────────────────>│                            │
     │                            │<───────────────────────────┤                            │
     │                            │  {quote_id: "quote_789"}   │                            │
     │                            │                            │                            │
     │ [Payment authorization]    │                            │                            │
     │<───────────────────────────┤                            │                            │
     │                            │                            │                            │
     ├────────────────────────────┼────────────────────────────┼───────────────────────────>│
     │                     Authorize payment & get SPT         │                            │
     │<───────────────────────────┼────────────────────────────┼────────────────────────────┤
     │                            │  spt_1234567890            │                            │
     │                            │                            │                            │
     │                            │  POST /checkout/complete   │                            │
     │                            │  {spt: "spt_123..."}       │                            │
     │                            │  Idempotency-Key: xxx      │                            │
     │                            ├───────────────────────────>│                            │
     │                            │                            │  POST /payment_intents     │
     │                            │                            │  {payment_method: spt}     │
     │                            │                            ├───────────────────────────>│
     │                            │                            │                            │
     │                            │                            │<───────────────────────────┤
     │                            │                            │  {status: "succeeded"}     │
     │                            │                            │                            │
     │                            │                            ├─────────┐                  │
     │                            │                            │ Add     │                  │
     │                            │                            │ credits │                  │
     │                            │                            │<────────┘                  │
     │                            │                            │                            │
     │                            │<───────────────────────────┤                            │
     │                            │  {order_id, credits: 20}   │                            │
     │                            │                            │                            │
     │ "Purchase complete!"       │                            │                            │
     │<───────────────────────────┤                            │                            │
     │                            │                            │                            │
```

## Server-Side Flow (Detailed)

### POST /checkout/complete Implementation

```typescript
async function handleCheckoutComplete(req: Request, res: Response) {
  const { cart_id, quote_id, payment } = req.body;
  const idempotencyKey = req.headers['idempotency-key'] as string;
  const authInfo = await authenticateRequest(req, res);

  try {
    // Step 1: Check idempotency
    const existingOrder = await checkIdempotency(idempotencyKey);
    if (existingOrder) {
      if (existingOrder.cart_id !== cart_id) {
        return res.status(409).json({ error: 'Idempotency key conflict' });
      }
      return res.json(existingOrder.response);
    }

    // Step 2: Validate cart ownership
    const cart = await getCart(cart_id);
    if (!cart) {
      return res.status(404).json({ error: 'Cart not found' });
    }
    if (cart.user_id !== authInfo.userId) {
      return res.status(403).json({ error: 'Cart does not belong to user' });
    }
    if (cart.status !== 'active') {
      return res.status(400).json({ error: 'Cart is not active' });
    }

    // Step 3: Validate quote
    const quote = await getQuote(quote_id);
    if (!quote || quote.cart_id !== cart_id) {
      return res.status(400).json({ error: 'Invalid quote' });
    }
    if (new Date() > new Date(quote.expires_at)) {
      return res.status(400).json({ error: 'Quote has expired' });
    }

    // Step 4: Calculate order details
    const totalAmount = cart.total;
    const creditsPurchased = cart.items.reduce(
      (sum, item) => sum + (item.metadata.credits * item.quantity),
      0
    );

    // Step 5: Charge payment via Stripe
    const orderId = `order_${Date.now()}_${randomId()}`;
    const chargeResult = await chargeSharedPaymentToken(
      payment.shared_payment_token,
      totalAmount,
      'usd',
      orderId,
      authInfo.userId,
      `Letter IRL Credits - Order ${orderId}`
    );

    if (!chargeResult.success) {
      return res.status(402).json({
        error: 'Payment failed',
        details: chargeResult.error
      });
    }

    // Step 6: Add credits to user account
    const account = await getAccount(authInfo.userId);
    const oldBalance = account.credits;
    account.credits += creditsPurchased;
    account.creditsPurchased += creditsPurchased;

    // Step 7: Create order record
    const order = {
      order_id: orderId,
      user_id: authInfo.userId,
      cart_id,
      quote_id,
      created_at: new Date(),
      status: 'completed',
      payment_intent_id: chargeResult.payment_intent_id,
      amount_total: totalAmount,
      currency: 'USD',
      items: cart.items,
      credits_purchased: creditsPurchased
    };

    // Step 8: Save everything
    await saveAccount(account);
    await saveOrder(order);
    await updateCartStatus(cart_id, 'completed');

    // Step 9: Store idempotency record
    const response = {
      order_id: orderId,
      status: 'completed',
      total: `USD ${totalAmount.toFixed(2)}`,
      currency: 'USD',
      created_at: order.created_at.toISOString(),
      credits_added: creditsPurchased,
      new_balance: account.credits,
      receipt_url: `${process.env.LETTER_IRL_PUBLIC_BASE_URL}/receipts/${orderId}`
    };

    await storeIdempotency(idempotencyKey, {
      cart_id,
      response,
      created_at: new Date()
    });

    // Step 10: Return success
    return res.json(response);

  } catch (error) {
    console.error('Checkout complete error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}
```

## Error Scenarios

### Scenario 1: Insufficient Funds

**Flow:**
1. User attempts checkout
2. ChatGPT sends SPT to server
3. Server calls Stripe API
4. Stripe returns `insufficient_funds` error
5. Server returns 402 Payment Required

**User Experience:**
```
❌ Payment failed: Insufficient funds

Please try:
- Using a different payment method
- Choosing a smaller package
- Adding funds to your account
```

**Implementation:**
```typescript
if (chargeResult.error_code === 'insufficient_funds') {
  return res.status(402).json({
    error: {
      code: 'insufficient_funds',
      message: 'Insufficient funds on payment method',
      user_message: 'Your payment method has insufficient funds. Please try a different payment method or choose a smaller package.'
    }
  });
}
```

### Scenario 2: Card Declined

**Flow:**
1. Stripe declines card (fraud prevention, etc.)
2. Server receives `card_declined` error
3. Returns 402 with user-friendly message

**User Experience:**
```
❌ Your card was declined

This can happen for several reasons:
- Incorrect card details
- Card expired
- Bank's fraud prevention

Please try:
- Updating your payment method in ChatGPT settings
- Using a different card
- Contacting your bank
```

### Scenario 3: Duplicate Request (Idempotency)

**Flow:**
1. ChatGPT sends checkout request
2. Network timeout before response received
3. ChatGPT retries with same Idempotency-Key
4. Server detects duplicate, returns original response
5. No duplicate charge

**Implementation:**
```typescript
const existing = await checkIdempotency(idempotencyKey);
if (existing) {
  if (existing.cart_id === cart_id) {
    // Same request, return original response
    return res.json(existing.response);
  } else {
    // Different cart with same key = conflict
    return res.status(409).json({
      error: 'Idempotency key reused with different cart'
    });
  }
}
```

### Scenario 4: Expired Cart

**Flow:**
1. User creates cart
2. Waits 25 hours (cart expires after 24)
3. Attempts checkout
4. Server rejects with 400 Bad Request

**User Experience:**
```
❌ Your cart has expired

Shopping carts expire after 24 hours.
Please create a new cart to continue.
```

### Scenario 5: Expired Quote

**Flow:**
1. ChatGPT gets quote (valid 15 minutes)
2. User takes 20 minutes to authorize payment
3. Server rejects checkout
4. ChatGPT automatically gets new quote and retries

**Implementation:**
```typescript
if (new Date() > new Date(quote.expires_at)) {
  return res.status(400).json({
    error: {
      code: 'quote_expired',
      message: 'Quote has expired, please request a new quote',
      recoverable: true
    }
  });
}
```

## Data Flow Diagram

### Cart Creation
```
User               ChatGPT           Letter IRL
  │                   │                   │
  │  "Buy credits"    │                   │
  ├──────────────────>│                   │
  │                   │  POST /cart/create│
  │                   │  + JWT token      │
  │                   ├──────────────────>│
  │                   │                   ├──────────┐
  │                   │                   │ Create   │
  │                   │                   │ cart_id  │
  │                   │                   │ Store    │
  │                   │                   │<─────────┘
  │                   │<──────────────────┤
  │                   │  cart_id          │
  │                   │                   │
```

### Payment Processing
```
ChatGPT           Letter IRL        Stripe
   │                   │                │
   │  POST /checkout   │                │
   │  + SPT token      │                │
   ├──────────────────>│                │
   │                   │  POST          │
   │                   │  /payment_     │
   │                   │  intents       │
   │                   ├───────────────>│
   │                   │                │
   │                   │<───────────────┤
   │                   │  succeeded     │
   │                   │                │
   │                   ├─────────┐      │
   │                   │ Add     │      │
   │                   │ credits │      │
   │                   │<────────┘      │
   │                   │                │
   │<──────────────────┤                │
   │  order_id         │                │
   │  new_balance      │                │
   │                   │                │
```

## State Transitions

### Cart States
```
     create
       │
       v
   ┌────────┐  add/remove items   ┌────────┐
   │ active │◄──────────────────>│ active │
   └───┬────┘                     └────────┘
       │
       ├─── 24 hours ─────> expired
       │
       ├─── checkout ─────> completed
       │
       └─── cancel ───────> cancelled
```

### Order States
```
                  payment success
     ┌─────────────────────────────────┐
     │                                 │
     v                                 │
┌─────────┐  payment failed   ┌───────┴────┐
│ pending ├──────────────────>│   failed   │
└────┬────┘                   └────────────┘
     │
     │ payment success
     v
┌───────────┐  refund issued   ┌──────────┐
│ completed ├─────────────────>│ refunded │
└───────────┘                  └──────────┘
```

### Credit Balance Updates
```
Purchase:  balance = balance + credits_purchased
Send:      balance = balance - credits_used
Refund:    balance = balance - credits_refunded
```

## Security Considerations

### 1. Authentication
- All ACP endpoints require valid JWT Bearer token
- Token validated against Auth0 JWKS
- User ID extracted from `sub` claim

### 2. Authorization
- Users can only access their own carts
- Users can only purchase for their own account
- User ID from JWT must match cart owner

### 3. Idempotency
- Required for checkout complete to prevent duplicate charges
- Keys stored for 24 hours
- Same key + same cart = return original response
- Same key + different cart = 409 Conflict

### 4. Payment Security
- Stripe SPT token used only once
- Payment processed server-side, never client-side
- Webhook signature verification for Stripe events
- HTTPS required for all production endpoints

### 5. Data Validation
- Zod schemas validate all inputs
- Product IDs verified against product catalog
- Amounts verified against quote
- Expiration times enforced

## Performance Considerations

### 1. Cart Expiration Cleanup

Run periodic cleanup job:
```typescript
async function cleanupExpiredCarts() {
  const now = new Date();
  const carts = await getAllCarts();

  for (const cart of carts) {
    if (cart.status === 'active' && new Date(cart.expires_at) < now) {
      await updateCartStatus(cart.cart_id, 'expired');
    }
  }
}

// Run every hour
setInterval(cleanupExpiredCarts, 60 * 60 * 1000);
```

### 2. Idempotency Cleanup

Clean up old idempotency records:
```typescript
async function cleanupIdempotencyKeys() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
  await deleteIdempotencyKeysBefore(cutoff);
}

// Run daily
setInterval(cleanupIdempotencyKeys, 24 * 60 * 60 * 1000);
```

### 3. Database Indexes

For file-based storage, organize by user:
```
/data/
├── accounts/
│   └── auth0|user123.json
├── carts/
│   ├── by-user/
│   │   └── auth0|user123/
│   │       ├── cart_abc.json
│   │       └── cart_xyz.json
│   └── by-id/
│       ├── cart_abc.json -> ../by-user/auth0|user123/cart_abc.json
│       └── cart_xyz.json -> ../by-user/auth0|user123/cart_xyz.json
└── orders/
    ├── by-user/
    │   └── auth0|user123/
    │       └── order_123.json
    └── by-id/
        └── order_123.json -> ../by-user/auth0|user123/order_123.json
```

For database, add indexes:
```sql
CREATE INDEX idx_carts_user_id ON carts(user_id);
CREATE INDEX idx_carts_status ON carts(status);
CREATE INDEX idx_carts_expires_at ON carts(expires_at);
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_created_at ON orders(created_at);
```

## Monitoring and Logging

### Key Events to Log

```typescript
// Cart created
console.log({
  event: 'cart_created',
  cart_id,
  user_id,
  timestamp: new Date()
});

// Item added
console.log({
  event: 'cart_item_added',
  cart_id,
  product_id,
  quantity,
  timestamp: new Date()
});

// Quote generated
console.log({
  event: 'quote_generated',
  quote_id,
  cart_id,
  total,
  timestamp: new Date()
});

// Payment attempt
console.log({
  event: 'payment_attempt',
  order_id,
  amount,
  user_id,
  timestamp: new Date()
});

// Payment success
console.log({
  event: 'payment_success',
  order_id,
  payment_intent_id,
  amount,
  credits_added,
  timestamp: new Date()
});

// Payment failure
console.log({
  event: 'payment_failure',
  order_id,
  error_code,
  error_message,
  timestamp: new Date()
});
```

## Testing Checklist

### Unit Tests
- [ ] Cart creation
- [ ] Item addition/removal
- [ ] Quote generation
- [ ] Quote expiration
- [ ] Cart expiration
- [ ] Idempotency key handling
- [ ] Credit balance updates

### Integration Tests
- [ ] Complete purchase flow (create cart → add items → quote → checkout)
- [ ] Stripe payment processing
- [ ] Webhook handling
- [ ] Error scenarios (declined card, insufficient funds, etc.)

### End-to-End Tests
- [ ] Purchase via ChatGPT with test SPT
- [ ] Credits added to account
- [ ] Order created correctly
- [ ] Receipt generated
- [ ] Send letter using new credits

## Next Steps

1. Implement all 5 ACP endpoints (Week 3-5)
2. Integrate Stripe SPT charging (Week 4)
3. Add webhook handling (Week 5)
4. Test complete flow (Week 6)
5. Deploy to production (Week 7)
6. Submit for OpenAI certification (Week 8)

## Related Documentation

- `docs/acp-implementation-guide.md` - Technical implementation
- `docs/acp-stripe-integration.md` - Stripe integration details
- `docs/credit-packages-spec.md` - Product specifications
- `docs/acp-quickstart.md` - Quick start guide
