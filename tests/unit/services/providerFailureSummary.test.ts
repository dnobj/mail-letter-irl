import { describe, expect, it } from 'vitest';
import { summarizeProviderRejection } from '../../../src/services/providerFailureSummary.js';

describe('summarizeProviderRejection', () => {
  // The shape PostGrid produces: "HTTP <status>: <message>", where the message
  // can name the failing field and its value.
  const leaked = "HTTP 400: to.postalCode 'M5V 3L9' is not a valid postal code for 12 Private Lane";

  it('keeps the status and nothing else from a provider message', () => {
    const summary = summarizeProviderRejection({
      error: leaked,
      metadata: { statusCode: 400, retryable: false, submissionOutcome: 'definite_rejection' },
    });
    expect(summary).toBe('provider_rejected http_400');
    expect(summary).not.toMatch(/M5V|Private Lane|postalCode/);
  });

  it('prefers the structured status over the message prefix', () => {
    expect(
      summarizeProviderRejection({ error: 'HTTP 400: anything', metadata: { statusCode: 422 } }),
    ).toBe('provider_rejected http_422');
  });

  it('falls back to the message prefix when the metadata carries no status', () => {
    expect(summarizeProviderRejection({ error: 'HTTP 400 invalid address', metadata: {} })).toBe(
      'provider_rejected http_400',
    );
    expect(summarizeProviderRejection({ error: leaked })).toBe('provider_rejected http_400');
  });

  it('is a bare class when there is no status anywhere', () => {
    expect(summarizeProviderRejection({ error: 'Simulated provider failure (10% chance)' })).toBe(
      'provider_rejected',
    );
    expect(summarizeProviderRejection({})).toBe('provider_rejected');
    expect(summarizeProviderRejection({ metadata: { statusCode: 'HTTP 500' } })).toBe('provider_rejected');
  });
});
