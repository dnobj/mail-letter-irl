/**
 * PostGrid's statuses as the status sync reads them (#566). PostGrid's
 * tracking guide lists ready, printing, processed_for_delivery, completed and
 * cancelled; probe P9a answered `cancelled`. A cancelled piece was never
 * printed, so it reads as failed; printing reads as processing. The older
 * spellings keep their meaning.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostGridProvider } from '../../../src/services/providers/PostGridProvider.js';

const baseUrl = 'https://postgrid.invalid/print-mail/v1';

function answering(status: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    id: 'letter_status_map',
    object: 'letter',
    live: false,
    status,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T01:00:00.000Z'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  return new PostGridProvider(
    { name: 'postgrid', displayName: 'PostGrid', enabled: true },
    { apiKey: 'test-key', baseUrl, timeoutMs: 100 }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PostGrid's statuses (#566)", () => {
  it.each([
    ['ready', 'accepted'],
    ['printing', 'processing'],
    ['processed_for_delivery', 'in_transit'],
    ['completed', 'delivered'],
    ['cancelled', 'failed'],
    ['canceled', 'failed'],
    ['CANCELLED', 'failed']
  ])('reads %s as %s', async (postgrid, ours) => {
    const provider = answering(postgrid);
    await expect(provider.getStatus('letter_status_map')).resolves.toMatchObject({ status: ours });
  });

  it('says a cancelled piece was cancelled before sending, in either spelling', async () => {
    for (const postgrid of ['cancelled', 'canceled']) {
      await expect(answering(postgrid).getStatus('letter_status_map')).resolves.toMatchObject({
        statusMessage: 'Letter was canceled before sending'
      });
    }
    await expect(answering('printing').getStatus('letter_status_map')).resolves.toMatchObject({
      statusMessage: 'Letter is being printed'
    });
  });
});
