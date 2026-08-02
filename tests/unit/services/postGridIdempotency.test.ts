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

  // A shared edge, proxy, or gateway can answer any of these after the origin
  // already accepted and queued the physical piece, so none of them prove the
  // provider refused the submission. Treating them as definite rejection would
  // let exhaustion refund mail that was actually printed and posted.
  it.each([408, 409, 425, 429, 500, 502, 503, 504])(
    'classifies HTTP %s as ambiguous rather than authoritative rejection',
    async (statusCode) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
        error: { message: 'provider error' },
      }), { status: statusCode, headers: { 'Content-Type': 'application/json' } })));

      const result = await provider().sendLetter(params);
      expect(result).toMatchObject({
        success: false,
        metadata: { statusCode, submissionOutcome: 'ambiguous' },
      });
    }
  );

  it.each([400, 401, 403, 404, 422])(
    'classifies safe HTTP %s as an authoritative provider rejection',
    async (statusCode) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
        error: { message: 'provider error' },
      }), { status: statusCode, headers: { 'Content-Type': 'application/json' } })));

      const result = await provider().sendLetter(params);
      expect(result).toMatchObject({
        success: false,
        metadata: { statusCode, retryable: false, submissionOutcome: 'definite_rejection' },
      });
    }
  );

  it('classifies a transport timeout as ambiguous acceptance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket timeout')));
    await expect(provider().sendLetter(params)).resolves.toMatchObject({
      success: false,
      metadata: { submissionOutcome: 'ambiguous' },
    });
  });

  it('classifies an unreadable success body as ambiguous instead of a failed send', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } })
    ));
    await expect(provider().sendLetter(params)).resolves.toMatchObject({
      success: false,
      metadata: { statusCode: 200, submissionOutcome: 'ambiguous' },
    });
  });

  it.each([
    ['missing id', { status: 'ready', createdAt: 'x', updatedAt: 'x', url: 'u' }],
    ['blank id', { id: '   ', status: 'ready', createdAt: 'x', updatedAt: 'x', url: 'u' }],
    ['missing status', { id: 'provider-1', createdAt: 'x', updatedAt: 'x', url: 'u' }],
    ['non-string id', { id: 42, status: 'ready', createdAt: 'x', updatedAt: 'x', url: 'u' }],
  ])('refuses to record an unreconcilable 2xx submission (%s)', async (_label, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));

    const result = await provider().sendLetter(params);
    // Never a success without a usable tracking reference, and never a definite
    // rejection: the provider may still have accepted the piece.
    expect(result).toMatchObject({
      success: false,
      trackingId: '',
      metadata: { submissionOutcome: 'ambiguous' },
    });
  });

  it('does not leave the response body read outside the request timeout', async () => {
    // A body that never settles must be aborted by the provider timeout rather
    // than hanging the outbox worker forever.
    const stalled = new Response(
      new ReadableStream({ start() { /* never enqueues, never closes */ } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stalled));

    const result = await provider().sendLetter(params);
    expect(result).toMatchObject({
      success: false,
      metadata: { submissionOutcome: 'ambiguous' },
    });
  }, 10_000);
});
