import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostGridProvider } from '../../../src/services/providers/PostGridProvider.js';

function provider() {
  return new PostGridProvider(
    { name: 'postgrid', displayName: 'PostGrid', enabled: true },
    { apiKey: 'test-key', verbose: false, timeoutMs: 100 }
  );
}

const params = {
  idempotencyKey: 'letter-stable-id',
  recipientName: 'Recipient',
  recipientAddress: {
    line1: '2 Main St',
    city: 'Dallas',
    state: 'TX',
    postalCode: '75201',
  },
  senderName: 'Sender',
  senderAddress: {
    line1: '1 Main St',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
  },
  message: 'Hello',
} as const;

describe('PostGrid idempotency and retry metadata', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends Idempotency-Key on order creation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'provider-1',
      status: 'ready',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      url: 'https://example.test/provider-1',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider().sendLetter(params)).resolves.toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/letters'),
      expect.objectContaining({
        headers: expect.objectContaining({ 'Idempotency-Key': 'letter-stable-id' }),
      })
    );
  });

  it.each([
    [429, true],
    [503, true],
    [400, false],
  ])('classifies HTTP %s retryability as %s', async (statusCode, retryable) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'provider error' },
    }), { status: statusCode, headers: { 'Content-Type': 'application/json' } })));

    const result = await provider().sendLetter(params);
    expect(result).toMatchObject({
      success: false,
      metadata: { statusCode, retryable, submissionOutcome: 'definite_rejection' },
    });
  });

  it('classifies a transport timeout as ambiguous acceptance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket timeout')));
    await expect(provider().sendLetter(params)).resolves.toMatchObject({
      success: false,
      metadata: { submissionOutcome: 'ambiguous' },
    });
  });
});
