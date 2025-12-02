# Testing PostGrid Provider

**Last Updated:** November 19, 2025

---

## Overview

This guide explains how to test the PostGrid Print & Mail API integration for Letter IRL. PostGrid is a production-ready letter fulfillment provider that offers both **test mode** (free, no actual mail) and **live mode** (paid, real mail).

**Current Configuration:**
- Provider: `postgrid`
- Mode: `test`
- API Key: `test_sk_ertXEPkwdcvuubGby49cKC`

---

## What is Test Mode?

PostGrid provides a **test environment** that allows you to:
- ✅ Test API integration without cost
- ✅ Generate test PDFs of letters
- ✅ View letters in PostGrid dashboard
- ✅ Test address validation
- ✅ Simulate the complete workflow
- ❌ **NOT** send actual physical mail

**Important:** Test mode letters are generated as PDFs and tracked in the PostGrid dashboard, but they are never printed or mailed. This is perfect for development and testing!

---

## Quick Start

### 1. Validate API Connection

Test that your PostGrid API key is working:

```bash
npm run test:postgrid
```

**Expected Output:**
```
🧪 Testing PostGrid Provider Integration

📦 Initializing provider...
✅ PostGridProvider initialized
   Mode: test
   Base URL: https://api.postgrid.com/print-mail/v1
✅ Provider loaded: PostGrid Provider

🔌 Validating API connection...
🌐 [PostGrid] GET /letters?limit=1
✅ [PostGrid] Connection validated
✅ API connection validated successfully!

✅ PostGrid is configured correctly!

💡 To send a test letter, run:
   npm run test:postgrid -- --send-test
```

**What this checks:**
- API key is valid
- Network connection to PostGrid API works
- Provider is properly configured

---

### 2. Send a Test Letter

Send an actual test letter (generates PDF, tracked in dashboard, NOT mailed):

```bash
npm run test:postgrid -- --send-test
```

**Expected Output:**
```
🧪 Testing PostGrid Provider Integration

📦 Initializing provider...
✅ Provider loaded: PostGrid Provider

🔌 Validating API connection...
✅ API connection validated successfully!

📮 Sending test letter...

📤 [PostGrid] Sending letter to Test Recipient
🌐 [PostGrid] POST /letters
✅ [PostGrid] Letter created successfully
   Letter ID: letter_abc123xyz456
   Status: ready
   Expected Delivery: 12/1/2025

✅ Test letter sent successfully!

📋 Letter Details:
   Tracking ID: letter_abc123xyz456
   Estimated Cost: $0.85
   Expected Delivery: 12/1/2025
   Details URL: https://dashboard.postgrid.com/letters/letter_abc123xyz456

📊 Metadata:
   Provider: postgrid
   Mode: test
   Status: ready

💡 Next Steps:
   1. Check PostGrid dashboard: https://dashboard.postgrid.com/
   2. View your test letter in the "Letters" section
   3. Remember: Test mode letters are NOT actually mailed!
```

**What this does:**
1. Connects to PostGrid API
2. Creates a test letter with sample content
3. Returns tracking ID and details URL
4. Letter appears in PostGrid dashboard

---

### 3. View in PostGrid Dashboard

1. Go to: https://dashboard.postgrid.com/
2. Sign in with your PostGrid account
3. Navigate to **Letters** section
4. Find your test letter by ID (e.g., `letter_abc123xyz456`)
5. Click to view the generated PDF

**What you'll see:**
- Letter details (recipient, sender, status)
- **Download PDF** button to view the letter
- Tracking information
- Status timeline

---

## Test Scenarios

### Scenario 1: Basic Connection Test

**Purpose:** Verify API credentials are working

```bash
npm run test:postgrid
```

**Success Criteria:**
- ✅ Connection validated successfully
- ✅ No authentication errors

---

### Scenario 2: Send Test Letter

**Purpose:** Test end-to-end letter creation

```bash
npm run test:postgrid -- --send-test
```

**Success Criteria:**
- ✅ Letter created with tracking ID
- ✅ Returns expected delivery date
- ✅ Letter visible in PostGrid dashboard
- ✅ PDF can be downloaded

---

### Scenario 3: Direct API Test

**Purpose:** Test PostGrid API directly (bypasses Letter IRL provider layer)

```bash
tsx scripts/test-postgrid-detailed.ts
```

**What this does:**
- Makes raw API call to PostGrid
- Sends minimal test letter
- Shows full request/response

**Expected Output:**
```
Testing PostGrid API directly...

Sending letter...
Request: {
  "to": {
    "firstName": "John",
    "lastName": "Doe",
    "addressLine1": "145 Mulberry St",
    "city": "New York",
    "provinceOrState": "NY",
    "postalOrZip": "10013",
    "country": "US"
  },
  "from": { ... },
  "html": "<html>...</html>",
  "description": "Test letter from CLI",
  "color": false,
  "doubleSided": false,
  "addressPlacement": "top_first_page"
}

Response Status: 201
Response: {
  "id": "letter_abc123xyz456",
  "object": "letter",
  "live": false,
  "status": "ready",
  ...
}

✅ Letter created: letter_abc123xyz456
View in dashboard: https://dashboard.postgrid.com/letters/letter_abc123xyz456
```

---

### Scenario 4: Test via MCP Tool

**Purpose:** Test through the actual Letter IRL MCP interface

1. **Start the MCP HTTP server:**
   ```bash
   npm run mcp:http
   ```

2. **In another terminal, use the sendLetter tool:**
   ```bash
   # Use Claude Desktop or MCP client to call:
   # Tool: sendLetter
   # Parameters:
   {
     "recipientName": "Test User",
     "recipientAddress": {
       "line1": "145 Mulberry St",
       "city": "New York",
       "state": "NY",
       "postalCode": "10013",
       "country": "US"
     },
     "bodyText": "Hello! This is a test letter from Letter IRL.",
     "signOff": "Best regards,\nLetter IRL"
   }
   ```

3. **Check job queue processed the letter:**
   ```bash
   tsx scripts/check-pgboss-jobs.ts
   ```

**Success Criteria:**
- ✅ Letter job created and processed
- ✅ Letter appears in database with status 'sent'
- ✅ Tracking ID stored in database
- ✅ Letter visible in PostGrid dashboard

---

### Scenario 5: Test Address Validation

**Purpose:** Verify PostGrid validates addresses

**Valid Test Address (will succeed):**
```
145 Mulberry St
New York, NY 10013
```

**Invalid Test Address (should fail or get corrected):**
```
123 Fake Street
Nowhere, XX 00000
```

Try sending to invalid address and check error response.

---

## Test Addresses

PostGrid validates all addresses. Use these verified test addresses:

### US Test Addresses

**Address 1: New York**
```
Name: John Doe
Address: 145 Mulberry St
City: New York
State: NY
Zip: 10013
```

**Address 2: San Francisco**
```
Name: Jane Smith
Address: 1600 Market St
City: San Francisco
State: CA
Zip: 94102
```

**Address 3: Austin**
```
Name: Bob Johnson
Address: 301 Congress Ave
City: Austin
State: TX
Zip: 78701
```

### International Test Address (if enabled)

**Address: Canada**
```
Name: Alice Williams
Address: 123 Main St
City: Toronto
Province: ON
Postal Code: M5H 2N2
Country: CA
```

---

## Understanding Test Mode vs Live Mode

### Test Mode (Current Configuration)

**API Key Format:** `test_sk_...`

**Configuration:**
```bash
LETTER_PROVIDER=postgrid
LETTER_PROVIDER_API_KEY=test_sk_ertXEPkwdcvuubGby49cKC
LETTER_PROVIDER_CONFIG='{"mode":"test","verbose":true}'
```

**What happens:**
- ✅ Letters created in PostGrid test environment
- ✅ PDFs generated for preview
- ✅ Letters tracked in dashboard
- ✅ **FREE** - no charges
- ❌ Letters NOT printed or mailed

**Dashboard:** https://dashboard.postgrid.com/ (Test section)

---

### Live Mode (Production)

**API Key Format:** `live_sk_...`

**Configuration:**
```bash
LETTER_PROVIDER=postgrid
LETTER_PROVIDER_API_KEY=live_sk_YOUR_LIVE_KEY_HERE
LETTER_PROVIDER_CONFIG='{"mode":"live","verbose":false}'
```

**What happens:**
- ✅ Letters created in PostGrid production environment
- ✅ Letters **ACTUALLY PRINTED** and **MAILED**
- ✅ Real postage purchased
- ✅ Delivery to physical addresses
- 💰 **CHARGED** ~$0.85-$1.35 per letter

**⚠️ WARNING:** Only switch to live mode when ready for production!

---

## Pricing

### Test Mode
- **Cost:** $0 (FREE)
- **Letters:** Unlimited
- **Delivery:** None (PDFs only)

### Live Mode (Production)
- **Base Cost:** ~$0.85 per letter (black & white, single-sided)
- **Color Printing:** +$0.35 per letter
- **Double-Sided:** +$0.10 per letter
- **International:** Varies by country
- **No Monthly Fees:** Pay-as-you-go

**Example Costs:**
- Standard letter (B&W, single-sided): $0.85
- Color letter (single-sided): $1.20
- Color letter (double-sided): $1.30

---

## Troubleshooting

### Error: "Authentication failed"

```
❌ [PostGrid] Connection validation failed: HTTP 401: Unauthorized
```

**Solution:**
1. Check `LETTER_PROVIDER_API_KEY` in `.env`
2. Verify API key starts with `test_sk_` (for test mode)
3. Verify API key is valid in PostGrid dashboard

---

### Error: "Address validation failed"

```
❌ Failed to send test letter
   Error: Address validation failed
```

**Solution:**
1. Use valid US addresses (see Test Addresses section above)
2. Ensure all required fields are provided (line1, city, state, postalCode)
3. Check address format matches PostGrid requirements

---

### Error: "Network timeout"

```
❌ Test failed with error: fetch failed
```

**Solution:**
1. Check internet connection
2. Verify no firewall blocking `api.postgrid.com`
3. Try again (temporary network issue)

---

### Letters not appearing in dashboard

**Solution:**
1. Make sure you're viewing the **Test** section (not Live)
2. Refresh the dashboard page
3. Check the correct PostGrid account
4. Verify letter was created successfully (check tracking ID)

---

### PDF not generated

**Symptom:** Letter shows "ready" or "rendered" status but no PDF available

**Solution:**
- Wait a few moments (PDF generation takes 1-2 seconds)
- Refresh dashboard page
- Check letter status (should progress: ready → rendered → processed)

---

## API Response Codes

| Code | Meaning | Action |
|------|---------|--------|
| 201 | Created | ✅ Letter created successfully |
| 400 | Bad Request | Check request parameters (address, etc.) |
| 401 | Unauthorized | Check API key |
| 402 | Payment Required | Insufficient credits (live mode only) |
| 422 | Validation Error | Address validation failed |
| 429 | Rate Limited | Slow down requests |
| 500 | Server Error | PostGrid issue - try again later |

---

## Testing Workflow Integration

### Test with Letter Worker

1. **Start the worker:**
   ```bash
   npm run mcp:http
   ```
   (The HTTP server includes the worker)

2. **Create a letter job** (via MCP tool or directly):
   ```typescript
   import { createLetterJob } from '../src/services/letterJobService.js';

   await createLetterJob({
     userId: 'test-user',
     recipientName: 'Test User',
     recipientAddress: { ... },
     message: 'Hello from test!',
     creditsRequired: 2
   });
   ```

3. **Check job was processed:**
   ```bash
   tsx scripts/check-pgboss-jobs.ts
   ```

4. **Verify letter in database:**
   ```sql
   SELECT * FROM letters ORDER BY created_at DESC LIMIT 1;
   ```

5. **Check PostGrid dashboard** for the created letter

---

## Monitoring and Logs

### Enable Verbose Logging

Already enabled in current config:
```json
{"mode":"test","verbose":true}
```

**What you'll see:**
```
✅ PostGridProvider initialized
   Mode: test
   Base URL: https://api.postgrid.com/print-mail/v1
📤 [PostGrid] Sending letter to Test Recipient
🌐 [PostGrid] POST /letters
✅ [PostGrid] Letter created successfully
   Letter ID: letter_abc123xyz456
   Status: ready
   Expected Delivery: 12/1/2025
```

### Disable Verbose Logging

For production:
```json
{"mode":"live","verbose":false}
```

---

## Next Steps

After testing successfully:

1. **✅ Test Mode Verified** - You're here!
2. **Configure Live Mode** - Get production API key from PostGrid
3. **Update Configuration:**
   ```bash
   LETTER_PROVIDER_API_KEY=live_sk_YOUR_KEY
   LETTER_PROVIDER_CONFIG='{"mode":"live","verbose":false}'
   ```
4. **Test with Small Volume** - Send 1-2 live letters first
5. **Monitor Costs** - Check PostGrid billing dashboard
6. **Scale Up** - Ready for production!

---

## PostGrid Dashboard Features

### View Letters
- **URL:** https://dashboard.postgrid.com/letters
- **Filter:** Test vs Live
- **Search:** By tracking ID, recipient name
- **Download:** PDF preview of letter

### View Account Balance
- **URL:** https://dashboard.postgrid.com/billing
- **Shows:** Available credits (live mode)
- **Add Credits:** Top up account

### View API Keys
- **URL:** https://dashboard.postgrid.com/settings/api-keys
- **Test Keys:** Start with `test_sk_`
- **Live Keys:** Start with `live_sk_`

### Webhooks (Future)
- **URL:** https://dashboard.postgrid.com/settings/webhooks
- **Use:** Get real-time status updates
- **Events:** `letter.mailed`, `letter.delivered`, `letter.returned`

---

## Integration Testing Checklist

Before going live, verify:

- [ ] PostGrid API key validated
- [ ] Test letter sent successfully
- [ ] PDF generated and viewable
- [ ] Letter appears in dashboard
- [ ] Address validation works
- [ ] Cost estimation matches expectations
- [ ] Worker processes letter jobs
- [ ] Database stores tracking IDs
- [ ] Status tracking works
- [ ] Error handling works (invalid addresses)
- [ ] Costs understood (test vs live)
- [ ] Production API key obtained
- [ ] Billing configured in PostGrid
- [ ] Live mode tested with 1-2 letters

---

## Support and Resources

**PostGrid Documentation:**
- API Docs: https://docs.postgrid.com/
- Dashboard: https://dashboard.postgrid.com/
- Support: support@postgrid.com

**Letter IRL Documentation:**
- Provider System: `docs/service-providers.md`
- Implementation: `src/services/providers/PostGridProvider.ts`
- Test Scripts: `scripts/test-postgrid.ts`, `scripts/test-postgrid-detailed.ts`

**Common Commands:**
```bash
# Validate connection
npm run test:postgrid

# Send test letter
npm run test:postgrid -- --send-test

# Direct API test
tsx scripts/test-postgrid-detailed.ts

# Check job queue
tsx scripts/check-pgboss-jobs.ts

# Start server with worker
npm run mcp:http
```

---

## Status

✅ **PostGrid Integration:** Complete
✅ **Test Mode:** Working
✅ **Test Scripts:** Available
⏳ **Live Mode:** Not configured (pending production API key)
⏳ **Webhooks:** Not implemented (future enhancement)

---

**Ready to test PostGrid!** 📬

Run `npm run test:postgrid` to get started!
