# Mail API Provider Comparison

**Last Updated:** January 9, 2026
**Purpose:** Evaluate alternatives to PostGrid for Letter IRL, focusing on production speed, tracking, and cost.

---

## Background

PostGrid testing revealed concerns:
- **30+ day delivery times** during holiday period testing
- **No IMb tracking** for individual letters (requires 200+ mailings per batch)
- **No visibility** into mail routing after handoff to USPS
- `trackingNumber` field only populated for Certified Mail
- `imbStatus` field not populated for individual mailings

This document compares mail API providers on production SLA, tracking capabilities, and pricing.

---

## Provider Comparison Summary

| Provider | Monthly Fee | Production SLA | IMb Tracking | Letter (Color, FC) |
|----------|-------------|----------------|--------------|-------------------|
| **PostGrid** | $0 | 2 days | 200+ min | $1.18 |
| **Lob** | $0 (500 cap) | ~4 days | Yes | ~$0.85 |
| **Click2Mail** | $0 | **Next day** | Yes | $1.45 |
| **Stannp** | $48+ for tracking | 24 hours | Yes ($48/mo) | $1.24 |
| **Postalytics** | $0-$399 | Unknown | Yes | $1.13 |

---

## Detailed Provider Analysis

### PostGrid (Current Provider)

**Website:** https://www.postgrid.com/

**Pricing Model:** Pay-per-piece, no subscription

| Item | First Class | Standard |
|------|-------------|----------|
| Letter (B&W) | $1.02 | $0.80 |
| Letter (Color) | $1.18 | $0.96 |
| Postcard 4x6 | $0.86 | - |
| Postcard 6x9 | $0.98 | - |
| Postcard 6x11 | $1.25 | - |

**Production SLA:** 2 business days (guaranteed)

**Tracking:**
- IMb tracking requires **200+ mailings per batch** (confirmed by PostGrid support)
- `trackingNumber` only for Certified Mail ($6.69+)
- Individual letters get NO tracking data
- "Delivered" status is **estimated** after 10-12 days, not confirmed

**API:** REST API, test/live modes, webhooks

**Pros:**
- No monthly fee
- Fast 2-day production SLA
- Good API documentation
- Address verification included
- Postcards supported

**Cons:**
- No tracking for individual letters (confirmed limitation)
- No visibility after USPS handoff
- Holiday delivery times were 30+ days in testing

---

### Click2Mail (Recommended for Launch)

**Website:** https://click2mail.com/

**Pricing Model:** Pay-per-piece, no subscription

| Item | Price | Notes |
|------|-------|-------|
| Letter (Color, First Class, 1 sheet) | **$1.45** | Includes print + postage |
| Additional sheet | +$0.75 | |
| Postcard 4.25x6 | ~$0.64 | Full color |
| Postcard 6x9 | Available | |
| Postcard 6x11 | Available | |

*Note: Base prices starting at $0.59 are for B&W or bulk configurations. Color First Class is $1.45.*

**Production SLA:**
- **Next business day** (submit by 8 PM Eastern)
- Same-day for Priority Mail (submit by 12 PM Eastern)
- 1, 3, or 7-day options available (slower = cheaper)

**Tracking:**
- IMb tracking included on all products (since 2009)
- Scan events: Acceptance, En Route, Arrived at Unit, USPS Indicated Delivery
- **Confirmation of Mailing (CoM):** Downloadable PDF with:
  - Proof of mailing (date, sender, recipient)
  - All Click2Mail timestamps
  - All USPS Informed Visibility scan data
  - Can be regenerated to pull latest scans

**Tracking Limitation (same as all providers):**
> "First-Class Intelligent Mail Barcode tracing does not include a delivery scan. Letter carriers don't scan individual letters upon delivery."

**API:**
- REST API (recommended)
- REST Batch XML
- SOAP
- **Test/Staging environment available**
- Developer docs: https://developers.click2mail.com/

**Postcards:** Yes - 3.5x5, 4.25x6, 5x8, 6x9, 6x11

**Pros:**
- **Fastest production SLA (next-day)**
- No monthly fee or subscription
- IMb tracking included on every piece
- Confirmation of Mailing documentation
- Test/sandbox mode available
- Full REST API
- Postcards supported

**Cons:**
- Higher per-piece cost ($1.45 vs $1.18 PostGrid)
- API/interface less modern than Lob/PostGrid
- No confirmed delivery scan (USPS limitation, not Click2Mail)

---

### Lob

**Website:** https://www.lob.com/

**Pricing Model:** Tiered subscription + per-piece

| Plan | Monthly Fee | Letter (First Class) | Volume Limit |
|------|-------------|---------------------|--------------|
| Developer | $0 | ~$0.85 | 500/month |
| Startup | $260 | $0.64 | 3,000/month |
| Growth | $550 | $0.61 | 6,000/month |
| Enterprise | Custom | Custom | Unlimited |

| Item | Developer | Startup | Growth |
|------|-----------|---------|--------|
| Postcard 4x6 | $0.87 | $0.61 | $0.58 |
| Postcard 6x9 | $0.99 | $0.67 | $0.62 |
| Postcard 6x11 | $1.26 | $0.92 | $0.88 |

**Production SLA:** ~4 days (user-reported, no official SLA published for standard plans)

**Tracking:**
- IMb tracking included on **all plans**
- **No volume minimum** for tracking
- Tracking events: In Transit, In Local Area, Processed for Delivery, Delivered, Re-routed, Returned to Sender
- "Mailed" confirmation event is **Enterprise-only**
- First tracking event within 3 business days of send

**API:** REST API, test mode, webhooks, modern developer experience

**Postcards:** Yes - 4x6, 5x7, 6x9, 6x11

**Pros:**
- IMb tracking for individual letters
- No volume minimum for tracking
- Lowest per-piece cost on free tier
- Strong compliance (HIPAA, GDPR)
- Modern API/developer experience

**Cons:**
- Developer plan capped at 500/month
- **Slower production (~4 days vs next-day)**
- $260/month jump to Startup plan

---

### Stannp

**Website:** https://www.stannp.com/us/

**Pricing Model:** Tiered subscription + per-piece

| Plan | Monthly Fee | Letter (First Class) | Tracking | Production SLA |
|------|-------------|---------------------|----------|----------------|
| Free | $0 | $1.24 | **No** | No SLA |
| Starter | $12 | $1.24 | **No** | 24 hours |
| Growth | $48 | Volume discounts | **Yes** | 24 hours |
| Premium | $315 | $0.98 (50k+) | Yes | 24 hours |

**CORRECTION:** Tracking requires **Growth plan ($48/month)**, not Starter.

**Production SLA:**
- Free plan: No SLA
- Paid plans ($12+): **24-hour production SLA**

**Tracking:**
- "Live mail tracking" with 2D integrity barcodes
- Requires **Growth plan ($48/month)** minimum
- Not available on Free or Starter plans

**API:** REST API, test mode

**Postcards:** Yes - 4x6, 6x9, 6x11

**Pros:**
- **Fastest production SLA (24 hours)** on paid plans
- Good for international (UK-based, global reach)

**Cons:**
- Tracking requires $48/month minimum
- Higher per-piece cost than competitors
- Less US-focused than Lob/PostGrid

---

### Postalytics

**Website:** https://www.postalytics.com/

**Pricing Model:** Tiered subscription + per-piece

| Plan | Monthly Fee | Letter 8.5x11 Duplex |
|------|-------------|---------------------|
| Free | $0 | $1.13 |
| Marketer | $199 | $0.98 |
| Pro/Agency | $399 | $0.89 |

**Production SLA:** Not explicitly stated

**Tracking:**
- "Unlimited IMB Mail Tracking" on all plans including free
- Unlimited pURLs and QR codes
- Real-time delivery alerts

**API:** REST API

**Postcards:** Yes - 4x6, 6x9, 6x11

**Pros:**
- IMb tracking included on free plan
- Marketing-focused features (pURLs, QR codes, campaign analytics)

**Cons:**
- Higher per-piece cost on free plan ($1.13)
- Marketing-focused, may be overkill for transactional mail
- Production SLA unclear

---

## Feature Comparison Matrix

| Feature | PostGrid | Click2Mail | Lob | Stannp | Postalytics |
|---------|----------|------------|-----|--------|-------------|
| **Monthly fee** | $0 | $0 | $0 (500 cap) | $0-$315 | $0-$399 |
| **Letter (Color, FC)** | $1.18 | $1.45 | ~$0.85 | $1.24 | $1.13 |
| **Postcards** | Yes | Yes | Yes | Yes | Yes |
| **IMb tracking** | 200+ min | **Yes** | **Yes** | $48/mo | **Yes** |
| **Production SLA** | 2 days | **Next day** | ~4 days | 24 hrs* | Unknown |
| **Test/Sandbox** | Yes | Yes | Yes | Yes | Yes |
| **REST API** | Yes | Yes | Yes | Yes | Yes |
| **Address verification** | Yes | Yes (CASS) | Yes | Yes | Yes |

*Stannp 24-hour SLA requires paid plan ($12+)

---

## Recommendation for Letter IRL Launch

### Primary Choice: Click2Mail

**Why:**
1. **Fastest production** - Next-day mailing (submit by 8 PM ET)
2. **IMb tracking included** - Every piece gets tracking, no volume minimum
3. **No subscription** - Pay-per-piece like PostGrid
4. **Confirmation of Mailing** - Downloadable proof with all scan data
5. **Test environment** - Full staging/sandbox for development
6. **REST API** - Modern integration capability

**Trade-off:** +$0.27/letter vs PostGrid ($1.45 vs $1.18)

**For launch, this premium is worth it for:**
- Faster production (next-day vs 2 days)
- Visibility into mail movement
- Confidence that mail is actually being sent

### Alternative: Lob Developer Plan

**When to consider:**
- If Click2Mail API proves difficult to integrate
- If per-piece cost becomes a concern
- Lower cost ($0.85 vs $1.45) but slower (~4 days)

### Future Scaling Options

| Volume | Recommendation |
|--------|----------------|
| <500/month | Click2Mail or Lob Developer |
| 500-3000/month | Evaluate Lob Startup ($260/mo) vs Click2Mail |
| 3000+/month | Lob Growth or negotiate enterprise rates |

---

## Implementation Plan

### Phase 1: Click2Mail Integration

1. Create Business account on Click2Mail staging site
2. Get API access (My Account → Profile → API Access → Start Now)
3. Implement `Click2MailProvider` following existing `PostGridProvider` pattern
4. Test with staging environment
5. Send test letters to verify:
   - Production timeline (next-day?)
   - IMb tracking data population
   - Confirmation of Mailing generation

### Phase 2: Provider Abstraction

The existing provider system (`src/services/providers/`) already supports multiple providers:
- `DummyProvider` - Testing
- `PostGridProvider` - Current production
- `Click2MailProvider` - New (to implement)

Configuration via environment variables:
```bash
LETTER_PROVIDER=click2mail
LETTER_PROVIDER_API_KEY=your_api_key
```

### Phase 3: Monitoring & Comparison

Track metrics for both providers:
- Actual production time (submission → mailed)
- Delivery time (mailed → delivered)
- Tracking event frequency
- Cost per letter

---

## Open Questions

1. **Click2Mail postcard pricing** - Need to verify exact pricing for 6x4, 6x9, 6x11 with color
2. **Click2Mail webhook support** - Does API support webhooks for status updates, or polling only?
3. **International mail** - Does Click2Mail support international destinations?

---

## Sources

- [Click2Mail Developer Portal](https://developers.click2mail.com/)
- [Click2Mail API Quick Start](https://rest.click2mail.com/quick-start.html)
- [Click2Mail Pricing](https://easylettersender.click2mail.com/pricing)
- [Click2Mail IMb Guide](https://blog.click2mail.com/2025/03/06/a-guide-to-the-intelligent-mail-barcode-how-to-use-modern-mail-tracking/)
- [Click2Mail Confirmation of Mailing](https://support.click2mail.com/en-us/article/743-confirmation-of-mailing)
- [Click2Mail Production Schedule](https://support.click2mail.com/article/166-production-and-mailing-schedule)
- [Lob Pricing](https://www.lob.com/pricing)
- [Lob Tracking Documentation](https://help.lob.com/print-and-mail/getting-data-and-results/tracking-your-mail)
- [PostGrid Pricing](https://www.postgrid.com/pricing-print-mail/)
- [PostGrid Tracking Documentation](https://postgrid.readme.io/docs/tracking-your-mailings)
- [Stannp Pricing](https://www.stannp.com/us/pricing)
- [Postalytics Pricing](https://www.postalytics.com/direct-mail-pricing/)
