# Letter IRL - Service Provider System

**Last Updated:** November 18, 2025
**Status:** ✅ Implemented with DummyProvider and PostGridProvider

---

## Overview

The Service Provider System provides a flexible, pluggable architecture for sending letters through different fulfillment providers. This allows Letter IRL to:
- Switch between providers easily
- Test without real API costs (DummyProvider)
- Compare provider performance and pricing
- Have fallback options if a provider fails

---

## Architecture

```
┌─────────────────────────────────────────┐
│         Letter Worker                   │
│  (processes jobs from pg-boss queue)    │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│    Provider Factory (index.ts)          │
│  getLetterProvider()                    │
│  - Reads LETTER_PROVIDER from env       │
│  - Returns configured provider instance │
└──────────────┬──────────────────────────┘
               │
      ┌────────┴────────┐
      ▼                 ▼
┌──────────┐     ┌──────────┐      ┌──────────┐
│  Dummy   │     │   Lob    │      │PostGrid  │
│ Provider │     │ Provider │  ... │ Provider │
└──────────┘     └──────────┘      └──────────┘
```

---

## Available Providers

### 1. **DummyProvider** ✅ Implemented

**Purpose:** Testing and development without costs

**Features:**
- Simulates letter sending with configurable delays
- Configurable failure rate for testing retries
- In-memory tracking status simulation
- Realistic status progression (queued → processing → in_transit → delivered)
- No external API calls
- **FREE!**

**Configuration:**
```bash
LETTER_PROVIDER=dummy
LETTER_PROVIDER_CONFIG='{"delayMs":1000,"failureRate":0.05,"costCents":100,"deliveryDays":3,"verbose":true}'
```

**Use Cases:**
- Development and testing
- CI/CD pipeline tests
- Load testing without costs
- Simulating failures for retry logic testing

---

### 2. **Lob Provider** (Planned)

**Purpose:** Production letter fulfillment

**Pricing:** $0.75 - $1.25 per letter
**Minimum:** $260/month platform fee
**Best For:** High volume (100+ letters/month)

**Features:**
- Professional print quality
- USPS First-Class Mail
- Tracking and delivery confirmation
- Address verification
- Robust API with webhooks

**When to Use:**
- Production deployment
- High volume (100+ letters/month)
- Need reliable delivery tracking

---

### 3. **PostGrid Provider** ✅ **Implemented**

**Purpose:** Production fulfillment option

**Pricing:** $0.85 - $1.35 per letter
**Minimum:** Pay-as-you-go
**Best For:** Medium to high volume (10+ letters/month)

**Features:**
- Pay-per-letter pricing (no monthly fees)
- Address verification for 245 countries
- 2-day production SLA
- Real-time tracking
- Test/live environment separation
- HIPAA, SOC-2, PCI-DSS compliance
- 5-star rating on G2
- Market leader (39.4% market share)

**Configuration:**
```bash
LETTER_PROVIDER=postgrid
LETTER_PROVIDER_API_KEY=your_test_or_live_api_key
LETTER_PROVIDER_CONFIG='{"mode":"test","verbose":true}'
```

**When to Use:**
- Production deployment
- Medium to high volume (10+ letters/month)
- Need reliable delivery tracking
- Require compliance certifications
- International mail needs

---

### 4. **Click2Mail Provider** (Planned - Recommended for Launch)

**Purpose:** Production fulfillment with tracking and fast production

**Pricing:** $1.45 per color First Class letter (includes print + postage)
**Minimum:** None (pay-per-piece)
**Best For:** Launch phase - fast production + IMb tracking

**Features:**
- **Next-day production SLA** (submit by 8 PM ET)
- IMb tracking on every piece (no volume minimum)
- Confirmation of Mailing (CoM) documentation
- REST API with test/staging environment
- CASS address verification
- Postcards: 3.5x5, 4.25x6, 5x8, 6x9, 6x11

**Configuration:**
```bash
LETTER_PROVIDER=click2mail
LETTER_PROVIDER_API_KEY=your_api_key
LETTER_PROVIDER_CONFIG='{"mode":"test","verbose":true}'
```

**When to Use:**
- Launch phase (need confidence mail is being sent)
- When tracking visibility is important
- When fast production matters more than lowest cost

**Trade-off vs PostGrid:**
- +$0.27/letter ($1.45 vs $1.18)
- But: Next-day production vs 2 days
- But: IMb tracking included vs 200+ volume minimum

See `docs/mail-provider-comparison.md` for detailed provider comparison.

---

## Provider Interface

All providers implement the `LetterFulfillmentProvider` interface:

```typescript
interface LetterFulfillmentProvider {
  // Configuration
  readonly config: ProviderConfig;

  // Send a letter
  sendLetter(params: LetterParams): Promise<LetterResult>;

  // Get delivery status
  getStatus(trackingId: string): Promise<LetterStatus>;

  // Estimate cost
  estimateCost(params: LetterParams): Promise<CostEstimate>;

  // Cancel queued letter (optional)
  cancelLetter?(trackingId: string): Promise<boolean>;

  // Validate connection
  validateConnection(): Promise<boolean>;
}
```

---

## Configuration

### Environment Variables

```bash
# Provider Selection
LETTER_PROVIDER=dummy                    # Provider name (dummy, lob, postgrid, etc.)

# Provider API Key (for real providers)
LETTER_PROVIDER_API_KEY=your_api_key    # Provider-specific API key

# Additional Configuration (JSON)
LETTER_PROVIDER_CONFIG='{"delayMs":1000,"failureRate":0.05}'
```

### DummyProvider Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `delayMs` | number | 1000 | Simulated processing delay in milliseconds |
| `failureRate` | number | 0.05 | Probability of failure (0-1, 0.05 = 5%) |
| `costCents` | number | 100 | Simulated cost per letter in cents |
| `deliveryDays` | number | 3 | Simulated delivery time in days |
| `verbose` | boolean | true | Whether to log operations |

### Example Configurations

**Dummy Provider - Fast Testing (Low Delay, No Failures):**
```bash
LETTER_PROVIDER=dummy
LETTER_PROVIDER_CONFIG='{"delayMs":100,"failureRate":0,"costCents":100,"deliveryDays":1}'
```

**Dummy Provider - Realistic Simulation:**
```bash
LETTER_PROVIDER=dummy
LETTER_PROVIDER_CONFIG='{"delayMs":2000,"failureRate":0.05,"costCents":120,"deliveryDays":3}'
```

**Dummy Provider - Failure Testing (High Failure Rate):**
```bash
LETTER_PROVIDER=dummy
LETTER_PROVIDER_CONFIG='{"delayMs":500,"failureRate":0.5,"costCents":100,"deliveryDays":3}'
```

**PostGrid Provider - Test Mode (Free Testing):**
```bash
LETTER_PROVIDER=postgrid
LETTER_PROVIDER_API_KEY=test_xxxxxxxxxxxxxxxxxxxxxxxxxx
LETTER_PROVIDER_CONFIG='{"mode":"test","verbose":true}'
```

**PostGrid Provider - Live Mode (Production):**
```bash
LETTER_PROVIDER=postgrid
LETTER_PROVIDER_API_KEY=live_xxxxxxxxxxxxxxxxxxxxxxxxxx
LETTER_PROVIDER_CONFIG='{"mode":"live","verbose":false}'
```

---

## Usage

### In Worker (Automatic)

The worker automatically uses the configured provider:

```typescript
import { getLetterProvider } from '../services/providers/index.js';

// Get configured provider
const provider = getLetterProvider();

// Send letter
const result = await provider.sendLetter({
  recipientName: 'John Doe',
  recipientAddress: {
    line1: '123 Main St',
    city: 'San Francisco',
    state: 'CA',
    postalCode: '94102',
    country: 'US'
  },
  message: 'Hello from Letter IRL!'
});

console.log(`Tracking ID: ${result.trackingId}`);
```

### Manual Usage

```typescript
import { createProvider, DummyProvider } from '../services/providers/index.js';

// Create DummyProvider instance
const provider = new DummyProvider({
  name: 'dummy',
  displayName: 'Dummy Provider',
  enabled: true
}, {
  delayMs: 500,
  failureRate: 0,
  costCents: 100
});

// Send letter
const result = await provider.sendLetter(params);
```

---

## Testing

### Unit Tests

```typescript
import { DummyProvider } from '../services/providers/DummyProvider.js';

describe('DummyProvider', () => {
  it('should send letter successfully', async () => {
    const provider = new DummyProvider(
      { name: 'dummy', displayName: 'Test', enabled: true },
      { delayMs: 0, failureRate: 0 }
    );

    const result = await provider.sendLetter({
      recipientName: 'Test User',
      recipientAddress: {
        line1: '123 Test St',
        city: 'Test City',
        state: 'TS',
        postalCode: '12345',
        country: 'US'
      },
      message: 'Test message'
    });

    expect(result.success).toBe(true);
    expect(result.trackingId).toBeDefined();
  });

  it('should simulate failures', async () => {
    const provider = new DummyProvider(
      { name: 'dummy', displayName: 'Test', enabled: true },
      { delayMs: 0, failureRate: 1.0 } // 100% failure rate
    );

    const result = await provider.sendLetter({...});

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
```

### Integration Tests

```typescript
// Test with real worker
import { startLetterWorker } from '../workers/letterWorker.js';

// Set environment
process.env.LETTER_PROVIDER = 'dummy';
process.env.LETTER_PROVIDER_CONFIG = '{"delayMs":100,"failureRate":0}';

// Start worker
await startLetterWorker();

// Create job
await createLetterJob(testLetter);

// Wait for processing
await new Promise(resolve => setTimeout(resolve, 500));

// Verify letter was sent
const letter = await query('SELECT * FROM letters WHERE letter_id = $1', [testLetter.letter_id]);
expect(letter.rows[0].status).toBe('sent');
expect(letter.rows[0].tracking_id).toBeDefined();
```

---

## Adding a New Provider

### Step 1: Create Provider Class

```typescript
// src/services/providers/LobProvider.ts
import type { LetterFulfillmentProvider, LetterParams, LetterResult } from './types.js';

export class LobProvider implements LetterFulfillmentProvider {
  constructor(public readonly config: ProviderConfig) {
    // Initialize Lob API client
  }

  async sendLetter(params: LetterParams): Promise<LetterResult> {
    // Call Lob API
  }

  async getStatus(trackingId: string): Promise<LetterStatus> {
    // Query Lob API
  }

  // ... implement other methods
}
```

### Step 2: Register Provider

```typescript
// src/services/providers/index.ts
import { LobProvider } from './LobProvider.js';

registerProvider('lob', (config) => new LobProvider(config));
```

### Step 3: Configure

```bash
LETTER_PROVIDER=lob
LETTER_PROVIDER_API_KEY=your_lob_api_key
```

---

## Database Schema

The `letters` table stores provider-specific data:

```sql
ALTER TABLE letters ADD COLUMN tracking_id VARCHAR(255);
ALTER TABLE letters ADD COLUMN provider VARCHAR(50);
ALTER TABLE letters ADD COLUMN cost_cents INTEGER;
ALTER TABLE letters ADD COLUMN expected_delivery TIMESTAMP;
```

---

## Monitoring

### Check Active Provider

```typescript
const provider = getLetterProvider();
console.log(`Active provider: ${provider.config.displayName}`);
```

### Provider Validation

```typescript
const provider = getLetterProvider();
const isValid = await provider.validateConnection();

if (!isValid) {
  console.error('Provider validation failed!');
}
```

### Tracking Status

```typescript
const status = await provider.getStatus('DUMMY-abc-123');
console.log(`Status: ${status.status}`);
console.log(`Message: ${status.statusMessage}`);
```

---

## Best Practices

### 1. **Use DummyProvider for Development**
- Don't waste money on test letters
- Fast iteration without API delays
- Simulate edge cases (failures, delays)

### 2. **Validate Provider on Startup**
```typescript
const provider = getLetterProvider();
const isValid = await provider.validateConnection();
if (!isValid) {
  throw new Error('Provider not available');
}
```

### 3. **Handle Provider Errors Gracefully**
```typescript
try {
  const result = await provider.sendLetter(params);
  if (!result.success) {
    // Log and retry
  }
} catch (error) {
  // Provider is down - queue for retry
}
```

### 4. **Monitor Provider Performance**
- Track success/failure rates
- Monitor delivery times
- Compare costs
- Set up alerts for high failure rates

### 5. **Have Fallback Options**
- Configure multiple providers
- Automatic fallback on provider failure
- Load balance across providers

---

## Costs Comparison

| Provider | Per Letter (Color, FC) | Monthly Fee | IMb Tracking | Production SLA |
|----------|------------------------|-------------|--------------|----------------|
| **Dummy** | $0 | $0 | Simulated | Instant |
| **PostGrid** | $1.18 | $0 | 200+ min | 2 days |
| **Click2Mail** | $1.45 | $0 | **Yes** | **Next day** |
| **Lob** | ~$0.85 | $0 (500 cap) | **Yes** | ~4 days |

**Recommendation by Phase:**
- **Launch (<500/month):** Click2Mail - fast production + tracking for confidence
- **Growth (500-3000/month):** Evaluate Lob Startup ($260/mo) vs Click2Mail
- **Scale (3000+/month):** Lob Growth or negotiate enterprise rates

See `docs/mail-provider-comparison.md` for detailed comparison.

---

## Roadmap

- [x] Define provider interface
- [x] Implement DummyProvider
- [x] Integrate with worker
- [x] Add configuration system
- [x] **Implement PostGrid provider** ✅ **COMPLETE**
- [ ] Add webhook support for PostGrid status updates
- [ ] Implement Lob provider
- [ ] Add provider fallback logic
- [ ] Add cost tracking/comparison
- [ ] Add international mail support (PostGrid supports this)

---

## Troubleshooting

### Provider Not Found

```
Error: Unknown provider: xyz
```

**Solution:** Check `LETTER_PROVIDER` value matches registered provider name (dummy, lob, etc.)

### Connection Validation Failed

```
Error: Provider connection validation failed
```

**Solution:**
1. Check `LETTER_PROVIDER_API_KEY` is set
2. Verify API key is valid
3. Check network connectivity

### Letters Stuck in Queue

**Check:** Is worker running?
```bash
ps aux | grep letterWorker
```

**Check:** Is provider configured?
```bash
echo $LETTER_PROVIDER
```

---

## Support

For provider integration help:
- DummyProvider: See `src/services/providers/DummyProvider.ts`
- Interface definition: See `src/services/providers/types.ts`
- Factory: See `src/services/providers/index.ts`
- Worker integration: See `src/workers/letterWorker.ts`

---

**Ready to send letters!** 📬
