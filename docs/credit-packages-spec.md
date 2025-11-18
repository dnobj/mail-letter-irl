# Letter IRL Credit Packages Specification

## Overview

Letter IRL offers three credit packages for purchase through ChatGPT's Agentic Commerce Protocol (ACP). Credits are used to send physical letters, with each letter costing 2-3 credits depending on page count.

## Credit Pricing Model

| Letter Pages | Credit Cost |
|--------------|-------------|
| 1 page | 2 credits |
| 2 pages | 2 credits |
| 3-4 pages | 3 credits |
| 5+ pages | Contact support |

**Cost Components:**
- Printing: Color or B&W
- Paper: Standard letter stock
- Postage: USPS First Class Mail
- Envelope: Standard #10 business envelope
- Processing: Automated mail handling

## Package Offerings

### Starter Pack - 5 Credits

**Product ID:** `credit-pack-5`

**Pricing:** $2.99 USD

**Value Proposition:**
- Perfect for trying out the service
- Send 1-2 letters
- No commitment required
- Instant delivery

**Target Audience:**
- First-time users
- One-off letter senders
- Users testing the service

**Messaging:**
- "Try Letter IRL risk-free"
- "Send your first letter today"
- "Perfect for a thank you note or quick message"

**Cost per Credit:** $0.598

**Cost per Letter (1 page):** ~$1.20

---

### Regular Pack - 20 Credits

**Product ID:** `credit-pack-20`

**Pricing:** $9.99 USD

**Value Proposition:**
- Best for regular letter senders
- Send 6-10 letters
- 16% savings vs Starter Pack
- Most popular choice

**Target Audience:**
- Regular users
- Small businesses
- Personal correspondence
- Thank you notes, invitations, announcements

**Messaging:**
- "Most popular choice"
- "Save 16% vs Starter Pack"
- "Perfect for regular correspondence"
- "Great for small businesses"

**Cost per Credit:** $0.4995

**Cost per Letter (1 page):** ~$1.00

**Savings:** 16% compared to Starter Pack

**Badge:** "POPULAR" or "BEST VALUE"

---

### Power Pack - 100 Credits

**Product ID:** `credit-pack-100`

**Pricing:** $39.99 USD

**Value Proposition:**
- Maximum savings - 33% off
- Send 30-50 letters
- Best for power users
- Bulk discount

**Target Audience:**
- Business users
- Marketing campaigns
- Frequent personal correspondence
- Organizations and groups

**Messaging:**
- "Best value - Save 33%"
- "Perfect for businesses and power users"
- "Send up to 50 letters"
- "Lowest per-letter cost"

**Cost per Credit:** $0.3999

**Cost per Letter (1 page):** ~$0.80

**Savings:** 33% compared to Starter Pack

**Badge:** "BEST VALUE" or "SAVE 33%"

---

## Comparison Table

| Package | Credits | Price | Per Credit | Per Letter* | Savings | Best For |
|---------|---------|-------|------------|-------------|---------|----------|
| Starter | 5 | $2.99 | $0.60 | $1.20 | - | Trying out |
| Regular | 20 | $9.99 | $0.50 | $1.00 | 16% | Regular use |
| Power | 100 | $39.99 | $0.40 | $0.80 | 33% | Power users |

*Assuming 1-page letter (2 credits)

## Product Feed JSON

Location: `public/products.json` or served at `/api/acp/v1/products.json`

```json
{
  "version": "1.0",
  "updated_at": "2025-01-14T00:00:00Z",
  "currency": "USD",
  "products": [
    {
      "product_id": "credit-pack-5",
      "name": "Starter Pack - 5 Credits",
      "price": "USD 2.99",
      "description": "Perfect for trying out Letter IRL. Send 1-2 physical letters through ChatGPT. Each letter costs 2-3 credits depending on page count.",
      "category": "credit-packages",
      "image_url": "https://amitotically-gubernacular-elise.ngrok-free.dev/images/products/credit-pack-5.png",
      "availability": "in stock",
      "metadata": {
        "credits": 5,
        "credits_per_dollar": 1.67,
        "best_for": "trying_out",
        "typical_letters": "1-2 letters",
        "value_per_credit": 0.598,
        "badge": null,
        "features": [
          "Instant credit delivery",
          "No expiration",
          "Full-color printing",
          "USPS First Class Mail"
        ]
      }
    },
    {
      "product_id": "credit-pack-20",
      "name": "Regular Pack - 20 Credits",
      "price": "USD 9.99",
      "description": "Most popular choice! Great for regular letter senders. Send 6-10 physical letters with 16% savings compared to Starter Pack.",
      "category": "credit-packages",
      "image_url": "https://amitotically-gubernacular-elise.ngrok-free.dev/images/products/credit-pack-20.png",
      "availability": "in stock",
      "metadata": {
        "credits": 20,
        "credits_per_dollar": 2.00,
        "best_for": "regular_use",
        "typical_letters": "6-10 letters",
        "value_per_credit": 0.4995,
        "savings_percent": 16,
        "savings_amount": 1.97,
        "badge": "POPULAR",
        "features": [
          "16% savings",
          "Instant credit delivery",
          "No expiration",
          "Full-color printing",
          "USPS First Class Mail",
          "Perfect for small businesses"
        ]
      }
    },
    {
      "product_id": "credit-pack-100",
      "name": "Power Pack - 100 Credits",
      "price": "USD 39.99",
      "description": "Best value for frequent senders! Send 30-50 physical letters with maximum 33% savings. Perfect for businesses and power users.",
      "category": "credit-packages",
      "image_url": "https://amitotically-gubernacular-elise.ngrok-free.dev/images/products/credit-pack-100.png",
      "availability": "in stock",
      "metadata": {
        "credits": 100,
        "credits_per_dollar": 2.50,
        "best_for": "power_users",
        "typical_letters": "30-50 letters",
        "value_per_credit": 0.3999,
        "savings_percent": 33,
        "savings_amount": 19.84,
        "badge": "BEST VALUE",
        "features": [
          "33% savings - lowest price per letter",
          "Instant credit delivery",
          "No expiration",
          "Full-color printing",
          "USPS First Class Mail",
          "Priority support",
          "Perfect for marketing campaigns"
        ]
      }
    }
  ]
}
```

## Product Images

### Image Requirements

- **Format:** PNG with transparency
- **Size:** 1200x1200 pixels (1:1 aspect ratio)
- **File size:** < 500 KB
- **Background:** Transparent or white
- **Style:** Clean, modern, professional

### Image Locations

```
/mnt/c/letter-irl/public/images/products/
├── credit-pack-5.png     (Starter Pack)
├── credit-pack-20.png    (Regular Pack)
└── credit-pack-100.png   (Power Pack)
```

### Serve via HTTP

In `src/mcp/httpServer.ts`, add static file serving:

```typescript
import express from 'express';
import path from 'path';

const app = express();

// Serve product images
app.use('/images', express.static(path.join(__dirname, '../../public/images')));
```

### Image Design Suggestions

**Starter Pack (5 Credits):**
- Icon: Single envelope or stamp
- Color: Light blue (#3B82F6)
- Text: "5 CREDITS" prominently displayed
- Subtitle: "Perfect for trying out"

**Regular Pack (20 Credits):**
- Icon: Stack of 3-4 envelopes
- Color: Green (#10B981)
- Text: "20 CREDITS" prominently displayed
- Badge: "POPULAR" in corner
- Subtitle: "Most popular choice"

**Power Pack (100 Credits):**
- Icon: Large stack of envelopes or mailbox
- Color: Purple (#8B5CF6)
- Text: "100 CREDITS" prominently displayed
- Badge: "BEST VALUE - SAVE 33%" in corner
- Subtitle: "Maximum savings"

### Placeholder Images

For initial testing, use placeholder images:
- https://placehold.co/1200x1200/3B82F6/FFFFFF/png?text=5+Credits
- https://placehold.co/1200x1200/10B981/FFFFFF/png?text=20+Credits
- https://placehold.co/1200x1200/8B5CF6/FFFFFF/png?text=100+Credits

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

**Policy:** Credits never expire

**Rationale:**
- Better user experience
- Encourages larger purchases
- Standard practice for credit-based services
- No complex expiration tracking needed

**Future Consideration:** Could add expiration (e.g., 1 year) if needed for business reasons.

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

| Package | Price | Per Credit | Per Letter* | Margin** |
|---------|-------|------------|-------------|----------|
| Starter | $2.99 | $0.60 | $1.20 | ~45% |
| Regular | $9.99 | $0.50 | $1.00 | ~55% |
| Power | $39.99 | $0.40 | $0.80 | ~60% |

*1-page letter = 2 credits
**Estimated margin after print/postage/processing costs (~$0.45 per letter)

### Competitor Comparison

Traditional mail services:

| Service | Cost per Letter | Notes |
|---------|----------------|-------|
| DIY (stamp + envelope) | $0.73 | User prints, stuffs, stamps, mails |
| Lob | $0.75 - $1.25 | Requires API integration |
| PostGrid | $0.85 - $1.35 | Bulk pricing |
| Click2Mail | $1.00 - $1.50 | Web interface |
| **Letter IRL (Starter)** | **$1.20** | **ChatGPT integration** |
| **Letter IRL (Regular)** | **$1.00** | **Best value + AI** |
| **Letter IRL (Power)** | **$0.80** | **Bulk discount + AI** |

**Value Proposition:** Similar pricing to competitors but with unique ChatGPT integration and conversational UX.

### Future Pricing Options

Consider adding in future:

1. **Micro Pack** - 1 credit for $0.99 (testing ultra-low commitment)
2. **Mega Pack** - 500 credits for $149.99 (40% savings, enterprise tier)
3. **Subscription** - 20 credits/month for $8.99/mo (monthly commitment, 10% discount)
4. **Business Plans** - Custom pricing for >1,000 credits/month

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

**Q: Do credits expire?**
A: No, credits never expire.

**Q: Can I get a refund?**
A: Yes, unused credits can be refunded within 30 days of purchase.

**Q: What if I run out of credits?**
A: ChatGPT will notify you when your balance is low. You can purchase more anytime.

**Q: How many credits does a letter cost?**
A: 1-2 page letters cost 2 credits. 3-4 page letters cost 3 credits.

**Q: Can I share credits with someone?**
A: No, credits are tied to your account and non-transferable.

**Q: What payment methods are accepted?**
A: All major credit/debit cards via Stripe (Visa, Mastercard, Amex, Discover).

## Next Steps

1. **Create product images** (see Image Requirements above)
2. **Implement product feed** endpoint at `/api/acp/v1/products.json`
3. **Set up Stripe products** in Stripe Dashboard matching these specs
4. **Implement credit management** functions (add/deduct/check balance)
5. **Test pricing** with small user group before full launch
6. **Monitor metrics** and adjust pricing as needed

## Related Documentation

- `docs/acp-implementation-guide.md` - Technical implementation details
- `docs/acp-stripe-integration.md` - Payment processing with Stripe
- `docs/credit-purchase-flow.md` - End-to-end purchase flow
- `docs/functional-requirements.md` - Overall system requirements
