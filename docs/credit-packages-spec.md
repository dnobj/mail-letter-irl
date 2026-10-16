# Letter IRL Letter Packages Specification

**Last Updated:** September 16, 2026
**Purpose:** Letter pack definitions, plus planned ACP product-feed material

> The authoritative pack table is `PACK_PRODUCTS` in `src/config/products.ts`; the catalogue refuses
> to sell a pack whose Stripe Price does not match its pinned amount. The **Product Feed JSON** and
> **Product Images** sections below belong to the planned Agentic Commerce Protocol integration
> ([acp-implementation-guide.md](acp-implementation-guide.md)) and are not built: there is no
> product feed, no `public/` directory, and no product image route.

## Overview

Letter IRL offers three letter packages for purchase through the website dashboard or ChatGPT. Users buy letter packs and use them to send physical letters.

**Note:** Internally, the system uses "credits" (2 credits = 1 letter) for flexibility, but all user-facing messaging uses "letters".

## Pricing Model

**Current Limitation:** All letters are limited to one page: 1,600 characters for text-only letters, 1,100 with a header image, 800 with an enclosed image (see [pricing-and-credits.md](pricing-and-credits.md)). Multi-page letters may be added later.

**Validity:** Purchased letters are valid for 24 months (`PURCHASE_CREDIT_EXPIRY_DAYS` in `src/services/commerceService.ts`).

**What's Included Per Letter:**
- Printing: Black & white
- Paper: Standard letter stock
- Postage: USPS First Class Mail
- Envelope: Standard #10 business envelope
- Processing: Automated mail handling

## Package Offerings

### Starter Pack - 2 Letters

**Product ID:** `credit-pack-4` (internal: 4 credits)

**Pricing:** $5.00 USD

**Stripe Description:** "Perfect for trying out Letter IRL. Send 2 physical letters through ChatGPT."

**Value Proposition:**
- Perfect for trying out the service
- Send 2 letters
- No commitment required

**Target Audience:**
- First-time users
- One-off letter senders
- Users testing the service

**Cost per Letter:** $2.50

---

### Regular Pack - 5 Letters

**Product ID:** `credit-pack-10` (internal: 10 credits)

**Pricing:** $10.00 USD

**Stripe Description:** "Most popular choice! Send 5 physical letters. Simple $2 per letter pricing."

**Value Proposition:**
- Best for regular letter senders
- Send 5 letters
- Simple $2 per letter pricing
- Most popular choice

**Target Audience:**
- Regular users
- Small businesses
- Personal correspondence
- Thank you notes, invitations, announcements

**Cost per Letter:** $2.00

**Badge:** "POPULAR"

---

### Power Pack - 50 Letters

**Product ID:** `credit-pack-100` (internal: 100 credits)

**Pricing:** $90.00 USD

**Stripe Description:** "Best value for frequent senders. Send 50 physical letters."

**Value Proposition:**
- Maximum savings - 10% off per letter
- Send 50 letters
- Best for power users
- Volume discount

**Target Audience:**
- Business users
- Marketing campaigns
- Frequent personal correspondence
- Organizations and groups

**Cost per Letter:** $1.80

**Savings:** 10% per letter compared to Regular Pack

**Badge:** "BEST VALUE"

---

## Comparison Table

| Package | Letters | Price | Per Letter | Savings | Best For |
|---------|---------|-------|------------|---------|----------|
| Starter | 2 | $5.00 | $2.50 | - | Trying out |
| Regular | 5 | $10.00 | $2.00 | - | Regular use |
| Power | 50 | $90.00 | $1.80 | 10% | Power users |

## Product Feed JSON (planned)

Planned location: `public/products.json`, or served at `/api/acp/v1/products.json`. Neither exists yet.

```json
{
  "version": "1.0",
  "updated_at": "2025-12-03T00:00:00Z",
  "currency": "USD",
  "products": [
    {
      "product_id": "credit-pack-4",
      "name": "Starter Pack - 2 Letters",
      "price": "USD 5.00",
      "description": "Perfect for trying out Letter IRL. Send 2 physical letters through ChatGPT.",
      "category": "letter-packages",
      "image_url": "https://api.letterirl.com/images/products/starter-pack.png",
      "availability": "in stock",
      "metadata": {
        "letters": 2,
        "credits": 4,
        "best_for": "trying_out",
        "price_per_letter": 2.50,
        "badge": null,
        "features": [
          "Send 2 letters",
          "Valid for 24 months",
          "Black & white printing",
          "USPS First Class Mail"
        ]
      }
    },
    {
      "product_id": "credit-pack-10",
      "name": "Regular Pack - 5 Letters",
      "price": "USD 10.00",
      "description": "Most popular choice! Send 5 physical letters. Simple $2 per letter pricing.",
      "category": "letter-packages",
      "image_url": "https://api.letterirl.com/images/products/regular-pack.png",
      "availability": "in stock",
      "metadata": {
        "letters": 5,
        "credits": 10,
        "best_for": "regular_use",
        "price_per_letter": 2.00,
        "badge": "POPULAR",
        "features": [
          "Send 5 letters",
          "Simple $2 per letter",
          "Valid for 24 months",
          "Black & white printing",
          "USPS First Class Mail",
          "Perfect for small businesses"
        ]
      }
    },
    {
      "product_id": "credit-pack-100",
      "name": "Power Pack - 50 Letters",
      "price": "USD 90.00",
      "description": "Best value for frequent senders. Send 50 physical letters.",
      "category": "letter-packages",
      "image_url": "https://api.letterirl.com/images/products/power-pack.png",
      "availability": "in stock",
      "metadata": {
        "letters": 50,
        "credits": 100,
        "best_for": "power_users",
        "price_per_letter": 1.80,
        "savings_percent": 10,
        "badge": "BEST VALUE",
        "features": [
          "Send 50 letters",
          "10% savings per letter",
          "Valid for 24 months",
          "Black & white printing",
          "USPS First Class Mail",
          "Perfect for marketing campaigns"
        ]
      }
    }
  ]
}
```

## Product Images (planned)

### Image Requirements

- **Format:** PNG with transparency
- **Size:** 1200x1200 pixels (1:1 aspect ratio)
- **File size:** < 500 KB
- **Background:** Transparent or white
- **Style:** Clean, modern, professional

### Image Locations

```
public/images/products/        (planned; the directory does not exist)
├── starter-pack.png     (Starter Pack - 2 Letters)
├── regular-pack.png     (Regular Pack - 5 Letters)
└── power-pack.png       (Power Pack - 50 Letters)
```

### Serve via HTTP

The sketch below is from the original plan and assumes Express. The server is plain `node:http`, so a
real route would be added to the dispatch in `src/mcp/httpServer.ts` instead.

```typescript
import express from 'express';
import path from 'path';

const app = express();

// Serve product images
app.use('/images', express.static(path.join(__dirname, '../../public/images')));
```

### Image Design Suggestions

**Starter Pack (2 Letters):**
- Icon: Single envelope or stamp
- Color: Light blue (#3B82F6)
- Text: "2 LETTERS" prominently displayed
- Subtitle: "Perfect for trying out"

**Regular Pack (5 Letters):**
- Icon: Stack of 3-4 envelopes
- Color: Green (#10B981)
- Text: "5 LETTERS" prominently displayed
- Badge: "POPULAR" in corner
- Subtitle: "Most popular choice"

**Power Pack (50 Letters):**
- Icon: Large stack of envelopes or mailbox
- Color: Purple (#8B5CF6)
- Text: "50 LETTERS" prominently displayed
- Badge: "BEST VALUE - SAVE 10%" in corner
- Subtitle: "Maximum savings"

### Placeholder Images

For initial testing, use placeholder images:
- https://placehold.co/1200x1200/3B82F6/FFFFFF/png?text=2+Letters
- https://placehold.co/1200x1200/10B981/FFFFFF/png?text=5+Letters
- https://placehold.co/1200x1200/8B5CF6/FFFFFF/png?text=50+Letters

## Credit Management

### Credit Balance

Each user account maintains a credit balance:

```typescript
interface UserAccount {
  userId: string;
  email: string;
  credits: number;
  creditsPurchased: number;
  creditsUsed: number;
  createdAt: Date;
  updatedAt: Date;
}
```

### Adding Credits (Purchase)

When a user completes a purchase:

```typescript
async function addCredits(userId: string, credits: number, orderId: string) {
  const account = await getAccount(userId);

  account.credits += credits;
  account.creditsPurchased += credits;
  account.updatedAt = new Date();

  // Log transaction
  account.transactions.push({
    type: 'purchase',
    credits: credits,
    orderId: orderId,
    timestamp: new Date()
  });

  await saveAccount(account);
}
```

### Deducting Credits (Letter Sent)

When a user sends a letter:

```typescript
async function deductCredits(userId: string, credits: number, letterId: string) {
  const account = await getAccount(userId);

  if (account.credits < credits) {
    throw new Error('Insufficient credits');
  }

  account.credits -= credits;
  account.creditsUsed += credits;
  account.updatedAt = new Date();

  // Log transaction
  account.transactions.push({
    type: 'deduction',
    credits: -credits,
    letterId: letterId,
    timestamp: new Date()
  });

  await saveAccount(account);
}
```

### Credit Expiration

**Policy:** Purchased letters are valid for 24 months from purchase (`PURCHASE_CREDIT_EXPIRY_DAYS = 730`),
matching the Terms of Service. The ledger consumes lots in order of expiry, and the daily maintenance
run marks expired lots. Promo and operator-adjustment lots carry their own expiry policy.

## Purchase Limits

### Minimum Purchase

- **Limit:** 1 package of any size
- **Reason:** No minimum needed - even Starter Pack is profitable

### Maximum Purchase

- **Per Transaction:** 10 Power Packs (1,000 credits)
- **Per Day:** 50 Power Packs (5,000 credits)
- **Reason:** Fraud prevention, unusual activity monitoring

**Implementation:**
```typescript
const MAX_CREDITS_PER_TRANSACTION = 1000;
const MAX_CREDITS_PER_DAY = 5000;

async function validatePurchase(userId: string, credits: number) {
  // Check transaction limit
  if (credits > MAX_CREDITS_PER_TRANSACTION) {
    throw new Error('Purchase exceeds maximum credits per transaction');
  }

  // Check daily limit
  const todaysPurchases = await getTodaysPurchases(userId);
  const todaysCredits = todaysPurchases.reduce((sum, p) => sum + p.credits, 0);

  if (todaysCredits + credits > MAX_CREDITS_PER_DAY) {
    throw new Error('Purchase exceeds daily credit limit');
  }
}
```

## Pricing Strategy

### Current Pricing (Launch)

Based on estimated costs and market positioning:

| Package | Letters | Price | Per Letter | Margin* |
|---------|---------|-------|------------|---------|
| Starter | 2 | $5.00 | $2.50 | ~51% |
| Regular | 5 | $10.00 | $2.00 | ~39% |
| Power | 50 | $90.00 | $1.80 | ~32% |

*Estimated margin after print/postage/processing costs (~$1.23 per letter)

### Competitor Comparison

Traditional mail services:

| Service | Cost per Letter | Notes |
|---------|----------------|-------|
| DIY (stamp + envelope) | $0.73 | User prints, stuffs, stamps, mails |
| Lob | $0.75 - $1.25 | Requires API integration |
| PostGrid | $0.85 - $1.35 | Bulk pricing |
| Click2Mail | $1.00 - $1.50 | Web interface |
| **Letter IRL (Starter)** | **$2.50** | **ChatGPT integration** |
| **Letter IRL (Regular)** | **$2.00** | **Best value + AI** |
| **Letter IRL (Power)** | **$1.80** | **Bulk discount + AI** |

**Value Proposition:** Premium pricing for unique ChatGPT integration and conversational UX. Convenience and automation justify the premium over traditional services.

### Future Pricing Options

Consider adding in future:

1. **Single Letter** - 1 letter for $2.99 (testing ultra-low commitment)
2. **Mega Pack** - 250 letters for $399.99 (40% savings, enterprise tier)
3. **Subscription** - 10 letters/month for $17.99/mo (monthly commitment, 10% discount)
4. **Business Plans** - Custom pricing for >500 letters/month

## Promotional Strategy

### Launch Promotions

**Option 1: First Purchase Bonus**
- "Get 2 bonus credits with your first purchase"
- Apply to any package size
- One-time per user
- Encourages trial

**Option 2: Volume Discount**
- "Buy Power Pack, get 10% more credits"
- 100 credits → 110 credits for same $39.99 price
- Limited time offer
- Encourages larger purchases

**Option 3: Referral Program**
- "Invite a friend, you both get 5 free credits"
- Viral growth mechanism
- Low cost per acquisition

### Seasonal Promotions

- **Holiday Season (Nov-Dec):** "Holiday Card Pack" - 50 credits for $19.99 (20% bonus)
- **Valentine's Day (Feb):** "Love Letter Pack" - 10 credits for $4.99
- **Mother's/Father's Day:** "Thank You Pack" - 15 credits for $6.99
- **Back to School (Aug-Sep):** "Student Pack" - 20% off Regular Pack

## Analytics and Metrics

### Key Metrics to Track

1. **Purchase Metrics:**
   - Total revenue
   - Average transaction value (ATV)
   - Revenue per user (RPU)
   - Purchase frequency

2. **Product Mix:**
   - % of sales by package (Starter vs Regular vs Power)
   - Most popular package
   - Average credits per purchase

3. **User Behavior:**
   - Time to first purchase
   - Repeat purchase rate
   - Credits purchased vs credits used
   - Unused credit balance

4. **Pricing Effectiveness:**
   - Price elasticity testing
   - Conversion rate by package
   - Impact of promotions

### Target Metrics (Year 1)

- **Avg Transaction Value:** $15-20 (mix of packages)
- **Repeat Purchase Rate:** 40% (users buy more credits after using first batch)
- **Power Pack Adoption:** 25% (high-value customers)
- **Regular Pack Adoption:** 50% (mainstream choice)
- **Starter Pack Adoption:** 25% (trial users)

## Customer Support

### Common Questions

**Q: Do letters expire?**
A: Yes, 24 months after purchase.

**Q: Can I get a refund?**
A: All purchases are final. Letter IRL may, at its discretion, refund whole unused letters at the
price paid for that pack; email support@letterirl.com with the order id and a person decides. A send
that fails on our side returns the letter to your balance automatically. See
[pricing-and-credits.md](pricing-and-credits.md#refund-policy) and the Terms of Service.

**Q: What if I run out of letters?**
A: When a preview needs more letters than you have, the card offers Pay & Send for that item or a
letter pack. You can also buy a pack on letterirl.com at any time.

**Q: Can I share letters with someone?**
A: No, letters are tied to your account and non-transferable.

**Q: What payment methods are accepted?**
A: Cards, and any wallets enabled in Stripe, through Stripe-hosted Checkout.

## Next Steps

Done: Stripe products and prices for all three packs, credit management, and in-conversation pack
checkout.

Remaining, for the planned ACP integration:

1. **Create product images** (see Product Images above)
2. **Implement a product feed** (see Product Feed JSON above)
3. **Monitor metrics** and adjust pricing as needed

## Related Documentation

- `docs/acp-implementation-guide.md` - Technical implementation details
- `docs/acp-stripe-integration.md` - Payment processing with Stripe
- `docs/credit-purchase-flow.md` - End-to-end purchase flow
- `docs/functional-requirements.md` - Overall system requirements
