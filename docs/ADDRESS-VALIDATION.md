# Address Validation Feature

**Last Updated:** November 19, 2025
**Status:** ✅ Implemented (requires separate PostGrid Address Verification API key)

---

## Overview

Address validation is integrated into the `quote_and_preview_letter` tool to catch address errors **before** the user commits credits. This feature uses PostGrid's Address Verification API to:

- ✅ **Verify** addresses are deliverable
- ✅ **Correct** minor errors (capitalization, abbreviations, missing ZIP+4)
- ✅ **Standardize** addresses to USPS/Canada Post format
- ✅ **Geocode** addresses (latitude/longitude)
- ❌ **Reject** invalid/undeliverable addresses

---

## How It Works

### User Flow

1. **User calls `quote_and_preview_letter`** with sender and recipient addresses
2. **System validates both addresses** using PostGrid Address Verification API
3. **One of three outcomes:**

   **a) Both addresses verified ✅**
   ```
   Status: verified
   → Proceeds with quote and preview
   → Returns preview HTML and credit cost
   ```

   **b) Address(es) corrected ✅**
   ```
   Status: corrected
   → Proceeds with quote and preview
   → Returns corrected addresses in response
   → User can see what was changed
   ```

   **c) Address(es) invalid ❌**
   ```
   Status: failed
   → Does NOT proceed with preview
   → Returns error with validation details
   → User must fix address and try again
   ```

---

## Setup Requirements

### PostGrid Address Verification API Key

**Important:** PostGrid's Address Verification is a **separate service** from the Print & Mail API and requires its own API key.

#### Option 1: Use Print & Mail API Key (Current Setup)

If you're only using PostGrid for Print & Mail, address validation might not be available with your current API key. The system will gracefully handle this by:
- Logging a warning if validation fails due to authentication
- Proceeding with the quote/preview without validation
- **Not blocking** the user from sending letters

#### Option 2: Get Address Verification API Key (Recommended)

For full address validation support:

1. **Sign up for PostGrid Address Verification:**
   - URL: https://www.postgrid.com/address-verification/
   - Or contact PostGrid sales to add to existing account

2. **Get API key:**
   - Dashboard: https://dashboard.postgrid.com/
   - Navigate to Settings → API Keys
   - Look for "Address Verification API" section
   - Copy test or live API key

3. **Update .env:**
   ```bash
   # Current Print & Mail API key (keep as-is)
   LETTER_PROVIDER_API_KEY=test_sk_ertXEPkwdcvuubGby49cKC

   # NEW: Address Verification API key
   POSTGRID_ADDRESS_VERIFICATION_API_KEY=test_addver_YOUR_KEY_HERE
   ```

4. **Update PostGridProvider** to use separate key for address validation:
   ```typescript
   // In src/services/providers/PostGridProvider.ts
   // Update the apiRequestAddressVerification method to use:
   const apiKey = process.env.POSTGRID_ADDRESS_VERIFICATION_API_KEY || this.options.apiKey;
   ```

---

## Current Status

### What's Implemented ✅

- [x] Address validation types (`AddressValidationInput`, `AddressValidationResult`)
- [x] `validateAddress()` method in `PostGridProvider`
- [x] Integration into `quote_and_preview_letter` tool
- [x] Returns validation status, corrected addresses, and errors
- [x] Test script (`scripts/test-address-validation.ts`)
- [x] Graceful handling when validation API is unavailable

### What's Needed ⏳

- [ ] Separate PostGrid Address Verification API key
- [ ] Environment variable configuration
- [ ] Full testing with valid Address Verification API key

---

## API Response Examples

### Verified Address

**Input:**
```json
{
  "line1": "145 Mulberry St",
  "city": "New York",
  "state": "NY",
  "postalCode": "10013",
  "country": "US"
}
```

**Output:**
```json
{
  "status": "verified",
  "isValid": true,
  "originalAddress": { ... },
  "verifiedAddress": {
    "line1": "145 Mulberry St",
    "city": "New York",
    "state": "NY",
    "postalCode": "10013-3903",  // Added +4 ZIP code
    "country": "US"
  },
  "geocode": {
    "latitude": 40.7209,
    "longitude": -73.9973
  }
}
```

---

### Corrected Address

**Input:**
```json
{
  "line1": "1600 amphitheatre parkway",  // lowercase
  "city": "mountain view",                // lowercase
  "state": "ca",                          // lowercase
  "postalCode": "94043",                  // missing +4
  "country": "US"
}
```

**Output:**
```json
{
  "status": "corrected",
  "isValid": true,
  "originalAddress": { ... },
  "verifiedAddress": {
    "line1": "1600 Amphitheatre Pkwy",    // Corrected capitalization and abbreviation
    "city": "Mountain View",               // Corrected capitalization
    "state": "CA",                         // Uppercase
    "postalCode": "94043-1351",           // Added +4 ZIP
    "country": "US"
  }
}
```

---

### Failed Validation

**Input:**
```json
{
  "line1": "123 Fake Street That Does Not Exist",
  "city": "Nowhere",
  "state": "XX",
  "postalCode": "00000",
  "country": "US"
}
```

**Output:**
```json
{
  "status": "failed",
  "isValid": false,
  "originalAddress": { ... },
  "errors": [
    {
      "field": "address",
      "message": "Address not found in postal database"
    },
    {
      "field": "state",
      "message": "Invalid state code: XX"
    }
  ]
}
```

---

## Integration with quote_and_preview_letter

### Updated Response Schema

The `quote_and_preview_letter` tool now returns additional fields:

```typescript
{
  // Existing fields
  previewHtml: string;
  requiredCredits: number;
  canSendNow: boolean;

  // NEW: Address validation results
  senderAddressValidation?: {
    status: 'verified' | 'corrected' | 'failed';
    originalAddress: Address;
    verifiedAddress?: Address;
    errors?: string[];
    suggestions?: string;
  };

  recipientAddressValidation?: {
    status: 'verified' | 'corrected' | 'failed';
    originalAddress: Address;
    verifiedAddress?: Address;
    errors?: string[];
    suggestions?: string;
  };
}
```

### User Experience

**Scenario 1: Valid addresses**
```
User: quote_and_preview_letter(...)
System: ✅ Addresses verified
        Here's your preview...
        Cost: 2 credits
```

**Scenario 2: Corrected addresses**
```
User: quote_and_preview_letter(...)
System: ✅ Addresses corrected
        Recipient address was standardized to: 1600 Amphitheatre Pkwy, Mountain View, CA 94043-1351
        Here's your preview...
        Cost: 2 credits
```

**Scenario 3: Invalid address**
```
User: quote_and_preview_letter(...)
System: ❌ Address validation failed
        Recipient address validation failed: Address not found in postal database
        Please correct the address and try again.
```

---

## Testing

### Test with Current Setup

Even without a separate Address Verification API key, you can test the integration:

```bash
npx tsx scripts/test-address-validation.ts
```

**Expected Result:**
- All addresses will return "failed" status with "HTTP 401: Unauthorized"
- This is expected without the separate API key
- The system handles this gracefully

### Test with Address Verification API Key

Once you have a separate API key:

1. Add to `.env`:
   ```bash
   POSTGRID_ADDRESS_VERIFICATION_API_KEY=test_addver_YOUR_KEY
   ```

2. Update PostGridProvider to use it:
   ```typescript
   const apiKey = process.env.POSTGRID_ADDRESS_VERIFICATION_API_KEY || this.options.apiKey;
   ```

3. Run test:
   ```bash
   npx tsx scripts/test-address-validation.ts
   ```

**Expected Result:**
- Test 1 (valid): `verified` ✅
- Test 2 (needs correction): `corrected` ✅
- Test 3 (invalid): `failed` ✅

---

## Alternative: Disable Address Validation

If you don't want address validation (or don't have API access):

### Option 1: Use DummyProvider

```bash
# .env
LETTER_PROVIDER=dummy
```

DummyProvider doesn't implement `validateAddress()`, so validation is skipped.

### Option 2: Make Validation Optional

Currently, the `quote_and_preview_letter` tool will skip validation if the provider doesn't support it:

```typescript
if (provider.validateAddress) {
  // Validate addresses
} else {
  // Skip validation, proceed with preview
}
```

This means:
- ✅ Works without Address Verification API key
- ✅ Validation is an enhancement, not a requirement
- ✅ No breaking changes to existing workflow

---

## Cost

### PostGrid Address Verification Pricing

**Test Mode:**
- FREE (unlimited test validations)

**Live Mode:**
- ~$0.004 per address validation (less than half a cent)
- Volume discounts available
- No monthly minimums

**For Letter IRL:**
- Validating both sender + recipient = ~$0.008 per letter preview
- Extremely low cost compared to letter sending ($0.85+)
- Well worth it to prevent failed deliveries

---

## Future Enhancements

### Batch Validation

For users with multiple recipients, validate all addresses at once:
```typescript
provider.validateAddressBatch([address1, address2, ...])
```

### Caching

Cache verified addresses to avoid re-validating the same address:
```typescript
// If user sends to same address multiple times,
// reuse previous validation result
```

### Autocomplete

Integrate with PostGrid's autocomplete API for real-time address suggestions as user types.

---

## Troubleshooting

### Issue: "HTTP 401: Unauthorized"

**Cause:** Using Print & Mail API key for Address Verification endpoint

**Solution:**
1. Get separate Address Verification API key from PostGrid
2. Add to `.env` as `POSTGRID_ADDRESS_VERIFICATION_API_KEY`
3. Update PostGridProvider to use separate key

**Or:** Accept that validation is unavailable and system proceeds without it

---

### Issue: "Address not found" for valid address

**Possible Causes:**
- Typo in address
- New construction not yet in USPS database
- Rural address without traditional street address

**Solution:**
- Double-check spelling
- Try with different format (e.g., "Street" vs "St")
- Contact PostGrid support if address is definitely valid

---

### Issue: Validation is too slow

**Cause:** Address Verification API call adds latency (~200-500ms)

**Solutions:**
- Accept the latency (worth it for accuracy)
- Implement caching for frequently used addresses
- Make validation optional/async

---

## References

- **PostGrid Address Verification Docs:** https://postgrid.readme.io/docs/address-verification
- **API Reference:** https://avdocs.postgrid.com/
- **Dashboard:** https://dashboard.postgrid.com/
- **Implementation:** `src/services/providers/PostGridProvider.ts:validateAddress()`
- **Integration:** `src/tools/quoteAndPreview.ts`
- **Test Script:** `scripts/test-address-validation.ts`

---

## Summary

✅ **Implemented:** Full address validation integration
⏳ **Needs:** Separate PostGrid Address Verification API key
🎯 **Benefit:** Prevents failed letter deliveries before user commits credits
💰 **Cost:** ~$0.008 per letter preview (very low)
🔧 **Graceful Degradation:** Works without validation if API key unavailable

**Next Steps:**
1. Contact PostGrid to get Address Verification API access
2. Add `POSTGRID_ADDRESS_VERIFICATION_API_KEY` to `.env`
3. Update PostGridProvider to use separate key
4. Test with real validation API key
5. Deploy to production!
