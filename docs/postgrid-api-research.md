# PostGrid API Research

**Last Updated:** November 18, 2025
**Status:** Ready for Implementation
**Official Docs:** https://docs.postgrid.com/ | https://postgrid.readme.io/

---

## Overview

PostGrid is a cloud-based Print & Mail API platform with a **5-star rating** on G2 and **39.4% market share** in the Direct Mail Automation category (as of 2025).

**Key Strengths:**
- Pay-as-you-go pricing (no monthly fees)
- 2-day production SLA
- Test/live environment separation
- Address verification for 245 countries (CASS & SERP certified)
- HIPAA, SOC-2, PCI-DSS compliance
- Real-time tracking
- Simple, well-documented REST API

---

## Authentication

### API Keys

PostGrid provides **two API keys** per user:
- **Test Key** - Sandbox environment (no real mail sent)
- **Live Key** - Production environment (real mail sent)

### Authentication Method

**HTTP Basic Authentication** via header:

```http
x-api-key: your_test_or_live_api_key
```

### Getting API Keys

1. Sign up at https://www.postgrid.com/
2. Navigate to Settings page
3. Copy your test and live API keys

---

## Test vs Live Environment

### Test Mode (Sandbox)
- **Isolated** from live environment
- **No mail is actually sent**
- **Address verification is disabled** (for faster testing)
- Orders are processed but not printed/mailed
- Perfect for:
  - Testing integrations
  - Verifying variable data assignment
  - Development without costs

### Live Mode (Production)
- **Real mail is sent**
- **Addresses are verified** before sending
- **Actual costs incurred**
- Switch by simply changing API key

**Important:** Test and live environments are completely separate - resources created in one do not affect the other.

---

## API Endpoints

### Base URL

```
https://api.postgrid.com/print-mail/v1
```

### Send Letter Endpoint

**Endpoint:** `POST /letters`

**Content-Type:** `application/json`

---

## Sending Letters

### Method 1: Using Contact IDs + Template

**Use Case:** Pre-defined contacts and templates in PostGrid dashboard

```json
{
  "to": "contact_abc123",
  "from": "contact_xyz789",
  "template": "template_def456"
}
```

### Method 2: Inline Contacts + HTML (Recommended for Letter IRL)

**Use Case:** Dynamic letters with custom content

```json
{
  "to": {
    "firstName": "John",
    "lastName": "Doe",
    "companyName": "Acme Corp",
    "addressLine1": "145 Mulberry St",
    "addressLine2": "Apt 123",
    "city": "New York",
    "provinceOrState": "NY",
    "postalOrZip": "10013",
    "country": "US"
  },
  "from": {
    "companyName": "Letter IRL",
    "addressLine1": "90 Canal St",
    "city": "Boston",
    "provinceOrState": "MA",
    "postalOrZip": "02114",
    "country": "US"
  },
  "html": "<html><body><p>Your letter content here</p></body></html>",
  "description": "Letter to John Doe",
  "color": false,
  "doubleSided": false,
  "addressPlacement": "top_first_page"
}
```

---

## Request Fields

### Contact Object (to/from)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `firstName` | string | No | Recipient's first name |
| `lastName` | string | No | Recipient's last name |
| `companyName` | string | No | Company name |
| `addressLine1` | string | **Yes** | Street address |
| `addressLine2` | string | No | Apartment, suite, etc. |
| `city` | string | **Yes** | City |
| `provinceOrState` | string | **Yes** | State/province code (e.g., "NY", "CA") |
| `postalOrZip` | string | **Yes** | Postal/ZIP code |
| `country` | string | **Yes** | Country code (e.g., "US", "CA") |
| `email` | string | No | Email address |
| `phoneNumber` | string | No | Phone number |
| `jobTitle` | string | No | Job title |

### Letter Options

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `html` | string | **Yes*** | - | HTML content for the letter |
| `template` | string | **Yes*** | - | Template ID (alternative to html) |
| `description` | string | No | - | Internal description |
| `color` | boolean | No | false | Print in color (vs black & white) |
| `doubleSided` | boolean | No | false | Print double-sided |
| `addressPlacement` | string | No | "top_first_page" | "top_first_page" or "insert_blank_page" |

**Note:** Either `html` or `template` is required, not both.

---

## Response Format

### Successful Response (201 Created)

```json
{
  "id": "letter_abc123xyz",
  "object": "letter",
  "live": false,
  "description": "Letter to John Doe",
  "to": {
    "id": "contact_generated_123",
    "firstName": "John",
    "lastName": "Doe",
    "addressLine1": "145 Mulberry St",
    "city": "New York",
    "provinceOrState": "NY",
    "postalOrZip": "10013",
    "country": "US"
  },
  "from": {
    "id": "contact_generated_456",
    "companyName": "Letter IRL",
    "addressLine1": "90 Canal St",
    "city": "Boston",
    "provinceOrState": "MA",
    "postalOrZip": "02114",
    "country": "US"
  },
  "url": "https://api.postgrid.com/print-mail/v1/letters/letter_abc123xyz",
  "color": false,
  "doubleSided": false,
  "addressPlacement": "top_first_page",
  "status": "ready",
  "createdAt": "2025-11-18T10:30:00.000Z",
  "updatedAt": "2025-11-18T10:30:00.000Z",
  "sendDate": "2025-11-19",
  "expectedDeliveryDate": "2025-11-22"
}
```

### Error Response (4xx/5xx)

```json
{
  "error": {
    "message": "Address validation failed",
    "code": "INVALID_ADDRESS",
    "details": {
      "field": "addressLine1",
      "reason": "Street address is required"
    }
  }
}
```

---

## Status Tracking

### Letter Status Values

| Status | Description |
|--------|-------------|
| `ready` | Letter created, queued for printing |
| `rendered` | PDF generated |
| `processed` | Sent to printer |
| `printed` | Printed and ready to mail |
| `mailed` | Handed to postal service |
| `in_transit` | In postal system |
| `delivered` | Delivered to recipient |
| `returned` | Returned to sender (undeliverable) |
| `canceled` | Canceled before printing |

### Get Letter Status

**Endpoint:** `GET /letters/{letter_id}`

**Response:**
```json
{
  "id": "letter_abc123xyz",
  "status": "delivered",
  "trackingNumber": "9400123456789012345678",
  "trackingUrl": "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400123456789012345678",
  "deliveredAt": "2025-11-22T14:35:00.000Z"
}
```

---

## Webhooks

PostGrid supports webhooks for real-time status updates.

### Available Events

- `letter.created`
- `letter.rendered`
- `letter.processed`
- `letter.printed`
- `letter.mailed`
- `letter.in_transit`
- `letter.delivered`
- `letter.returned`

### Webhook Configuration

Configure in PostGrid Dashboard → Settings → Webhooks

**Webhook Payload:**
```json
{
  "event": "letter.delivered",
  "data": {
    "id": "letter_abc123xyz",
    "status": "delivered",
    "deliveredAt": "2025-11-22T14:35:00.000Z"
  },
  "timestamp": "2025-11-22T14:35:05.000Z"
}
```

---

## Pricing (2025)

### Letter Costs

| Type | Price Range | Notes |
|------|-------------|-------|
| **Black & White** | $0.85 - $1.00 | Single-sided |
| **Color** | $1.20 - $1.35 | Single-sided |
| **Double-Sided** | +$0.10 - $0.15 | Additional cost |

**Pricing Notes:**
- Pay-as-you-go (no monthly fees)
- Volume discounts available
- First-Class Mail postage included
- Address verification included (free)
- No setup fees, no tech fees

### USPS Postage (for reference)

- First-Class Letter: $0.73 (2025 rate)
- Each additional ounce: +$0.20

**PostGrid handles postage** - you don't need to calculate it separately.

---

## Address Verification

PostGrid automatically verifies addresses in **live mode** using:
- **CASS Certification** (Coding Accuracy Support System)
- **SERP Certification** (Standardized Enhanced Residential Privacy)
- Coverage: **245 countries**

**In test mode:** Address verification is disabled for faster testing.

**Validation Response:**
- Valid addresses are automatically standardized (e.g., "St" → "Street")
- Invalid addresses return error before letter creation
- Saves money by preventing undeliverable mail

---

## Rate Limits

PostGrid's rate limits (to confirm with support):
- Estimated: 100 requests/minute
- Burst: 1000 requests/hour
- Contact support for higher limits

---

## Error Handling

### Common Error Codes

| Code | Description | Solution |
|------|-------------|----------|
| `INVALID_API_KEY` | API key is invalid | Check API key in settings |
| `INVALID_ADDRESS` | Address validation failed | Verify address fields |
| `INSUFFICIENT_FUNDS` | Account balance too low | Add funds to account |
| `RATE_LIMIT_EXCEEDED` | Too many requests | Wait and retry with backoff |
| `INVALID_HTML` | HTML content is malformed | Validate HTML syntax |

### Best Practices

1. **Retry with exponential backoff** for 5xx errors
2. **Validate addresses client-side** before API call
3. **Use test mode extensively** before going live
4. **Monitor webhooks** for delivery status
5. **Handle async processing** - letters aren't sent instantly

---

## Integration with Letter IRL

### Mapping Our Schema to PostGrid

| Letter IRL Field | PostGrid Field |
|------------------|----------------|
| `sender.name` | `from.companyName` |
| `sender.addressLine1` | `from.addressLine1` |
| `sender.city` | `from.city` |
| `sender.state` | `from.provinceOrState` |
| `sender.postalCode` | `from.postalOrZip` |
| `sender.country` | `from.country` |
| `recipient.name` | `to.firstName` + `to.lastName` |
| `recipient.addressLine1` | `to.addressLine1` |
| `recipient.city` | `to.city` |
| `recipient.state` | `to.provinceOrState` |
| `recipient.postalCode` | `to.postalOrZip` |
| `recipient.country` | `to.country` |
| `bodyText` + `signOff` | `html` (formatted) |

### HTML Template for Letters

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: 'Times New Roman', serif;
      font-size: 12pt;
      line-height: 1.6;
      margin: 1in;
    }
    .letter-body {
      margin-top: 0.5in;
      white-space: pre-wrap;
    }
    .signature {
      margin-top: 0.5in;
    }
  </style>
</head>
<body>
  <div class="letter-body">{{bodyText}}</div>
  <div class="signature">{{signOff}}</div>
</body>
</html>
```

---

## SDKs & Libraries

PostGrid provides official SDKs:
- **Node.js/TypeScript** - npm package (to verify)
- **Python** - pip package
- **PHP** - composer package
- **Java** - Maven package
- **Ruby** - gem

**For Letter IRL:** We'll use direct REST API calls with `fetch()` or `axios`.

---

## Testing Strategy

### Phase 1: Test Mode
1. Use test API key
2. Send test letters with our actual letter format
3. Verify HTML rendering looks good
4. Check status tracking works
5. Test error scenarios (invalid addresses, etc.)

### Phase 2: Live Mode (Small Scale)
1. Switch to live API key
2. Send 1-2 real letters to ourselves
3. Verify actual delivery quality
4. Monitor tracking numbers
5. Confirm costs match expectations

### Phase 3: Production
1. Enable for Letter IRL users
2. Monitor success/failure rates
3. Set up webhook handling
4. Track costs and delivery times

---

## Implementation Checklist

- [ ] Create PostGrid provider class implementing `LetterFulfillmentProvider`
- [ ] Add API key configuration to `.env`
- [ ] Implement `sendLetter()` method
- [ ] Implement `getStatus()` method
- [ ] Implement `estimateCost()` method
- [ ] Add HTML template generation
- [ ] Handle address formatting (name splitting, state codes)
- [ ] Add error handling with retry logic
- [ ] Test in sandbox mode
- [ ] Add webhook support (future)
- [ ] Document configuration in README

---

## Environment Variables

```bash
# PostGrid Configuration
LETTER_PROVIDER=postgrid
POSTGRID_API_KEY=your_test_key_here  # or live key
POSTGRID_MODE=test                    # or 'live'
```

---

## Next Steps

1. **Implement PostGridProvider class**
2. **Test with PostGrid test API**
3. **Compare with DummyProvider output**
4. **Document setup process**
5. **Get real API key and send test letters**

---

## Resources

- **Main Docs:** https://docs.postgrid.com/
- **Getting Started:** https://postgrid.readme.io/docs/overview
- **Send Letter Guide:** https://postgrid.readme.io/docs/sending-letters-using-the-api
- **Dashboard:** https://dashboard.postgrid.com/ (sign up required)
- **Support:** Via dashboard or email

---

**Ready to implement!** 🚀
