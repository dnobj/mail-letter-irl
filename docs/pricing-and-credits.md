# Letter IRL Pricing & Packages

**Last Updated:** February 5, 2026

## Overview

Letter IRL offers letter packages for purchase. Users buy letter packs and use them to send physical letters through ChatGPT.

**Note:** Internally, the system uses "credits" (2 credits = 1 letter) for flexibility, but all user-facing messaging uses "letters".

---

## Letter Packages

| Package | Letters | Price | Per Letter | Savings |
|---------|---------|-------|------------|---------|
| **Starter Pack** | 2 | $5.00 | $2.50 | - |
| **Regular Pack** | 5 | $10.00 | $2.00 | - |
| **Power Pack** | 50 | $90.00 | $1.80 | 10% off |

**Recommended:** Regular Pack - best balance of value and flexibility

**Best Value:** Power Pack - 10% discount per letter compared to Regular

---

## Letter Specifications

### Standard Letter
- **Page Limit:** One page maximum (~1,800 characters)
- **Delivery:** Standard First Class Mail (USPS)
- **Features:** Black & white, single-sided

### Character Limits
- **Maximum:** ~1,800 characters total (body text + sign-off)
- **Approximately:** 300-400 words, or about 2-3 paragraphs
- **Font:** Times New Roman, 12pt
- **Margins:** Standard (1 inch all sides, 3.5 inch top for address window)

---

## Future Letter Options (Planned)

We plan to introduce additional letter types:

### Basic Letter (Planned)
- **Price:** ~$1.50 per letter
- **Features:** Plain text, standard delivery
- **Use Case:** Simple messages, maximum value

### Premium Letter (Planned)
- **Price:** ~$3.00+ per letter
- **Features:** Multi-page, color printing, expedited delivery, special formatting
- **Use Case:** Important communications, formal letters

---

## Payment Methods

### Stripe Checkout
- **Primary Method:** Credit/debit card via Stripe
- **Security:** PCI-compliant, encrypted transactions
- **Accepted Cards:** Visa, Mastercard, American Express, Discover

### OpenAI Agentic Commerce (Coming Soon)
- **In-ChatGPT Purchases:** Buy letter packs directly in conversation
- **Seamless:** No leaving ChatGPT
- **Same Pricing:** Identical packages and rates

---

## Provider Costs & Margins

### Cost Breakdown (Estimated)

**Per Letter Cost:**
- Printing & handling: ~$0.50
- First Class postage: ~$0.73
- **Total provider cost:** ~$1.23 per letter

**Pricing Analysis:**

| Package | Sell Price/Letter | Provider Cost | Gross Margin | Margin % |
|---------|-------------------|---------------|--------------|----------|
| Starter | $2.50 | $1.23 | $1.27 | 51% |
| Regular | $2.00 | $1.23 | $0.77 | 39% |
| Power | $1.80 | $1.23 | $0.57 | 32% |

**Note:** Margins account for payment processing fees (~3%), infrastructure costs, and support.

---

## Refund Policy

### Letters Are Refundable If:
- ✅ Letter fails to send due to provider error
- ✅ Invalid address (after verification attempt)
- ✅ Service outage or system issue on our end
- ✅ Letter quality issue (misprinting, damage)

### Letters Are Non-Refundable After:
- ❌ Letter successfully dispatched to USPS
- ❌ Address was valid and deliverable
- ❌ User error in letter content or recipient details

### Refund Process:
1. Contact support with order ID
2. Issue reviewed within 1 business day
3. Letters restored to account (not cash refund)
4. Notification sent via email

---

## Pricing Philosophy

### Why Letter Packs?

**Advantages:**
1. **Predictable costs** - Know exactly what you'll pay
2. **No hidden fees** - Letters never expire
3. **Volume discounts** - Save more with larger purchases
4. **Flexibility** - Use letters when you need them
5. **Future-ready** - Easy to add premium letter types

### Fair Pricing Commitment

We strive to:
- Keep pricing simple and transparent
- Offer volume discounts for regular users
- Maintain competitive rates vs. traditional mail
- Provide value through convenience and automation

---

## Comparison to Traditional Mail

### DIY Letter Mailing
- **Postage:** $0.73 (First Class stamp)
- **Paper & envelope:** ~$0.10
- **Printing:** ~$0.05
- **Time cost:** 15-30 minutes per letter
- **Total:** ~$0.88 + your time

### Letter IRL (Regular Pack)
- **Cost:** $2.00 per letter
- **Time:** 2-3 minutes via ChatGPT
- **Convenience:** No trips to post office
- **Automation:** Send from anywhere
- **Premium:** ~$1.12 for convenience & automation

---

## Enterprise & Custom Pricing

For high-volume users (500+ letters/month), contact us for custom pricing:
- Volume discounts beyond Power pack
- Dedicated account management
- Custom integrations and API access
- SLA guarantees

Email: support@letter-irl.com

---

## Pricing Updates

This pricing is effective as of November 19, 2025 and subject to change. Users will be notified 30 days before any price increases.

**Version:** 1.0
**Effective Date:** November 19, 2025

# Pay & Send pricing

Pay & Send sells one exact physical letter or postcard and does not add prepaid
balance. Letter packs remain the discounted prepaid option. JIT cent amounts and
Stripe Prices are environment configuration and must match exactly; the values
shown in example env files are placeholders until the launch price is approved.
Payment authorizes immediate fulfillment of the immutable previewed item.

Qualifying purchases grant explicit image entitlements. The defaults are five
per prepaid physical-mail entitlement and one future generation per completed
JIT order, both configurable. `IMAGE_TRIAL_ENABLED` remains false unless a
separate, budget-capped acquisition experiment is approved.
