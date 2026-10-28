/**
 * The account every tool call loads (src/store/fileAccountStore.ts) carries
 * the image quota, except while image generation is switched off
 * (LETTER_IRL_IMAGE_GEN_MODE=off): then there is nothing to count, and the
 * query is not run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBalance: vi.fn(),
  getGenerationQuota: vi.fn(),
  query: vi.fn()
}));

vi.mock('../../../src/services/creditService.js', () => ({ getBalance: mocks.getBalance }));
vi.mock('../../../src/services/imageGenerationLimitService.js', () => ({
  getGenerationQuota: mocks.getGenerationQuota
}));
vi.mock('../../../src/db/index.js', () => ({ query: mocks.query }));

import { FileAccountStore } from '../../../src/store/fileAccountStore.js';

describe('the account a tool call loads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBalance.mockResolvedValue({ credits: 4 });
    mocks.getGenerationQuota.mockResolvedValue({ used: 1, allowance: 3, remaining: 2 });
    mocks.query.mockResolvedValue({ rows: [] });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('carries the image quota while image generation is on', async () => {
    const account = await new FileAccountStore().getOrCreate('auth0|user');
    expect(account.imageGenerationsRemaining).toBe(2);
    expect(mocks.getGenerationQuota).toHaveBeenCalledTimes(1);
  });

  it('carries none, and reads none, while the switch is off', async () => {
    vi.stubEnv('LETTER_IRL_IMAGE_GEN_MODE', 'off');
    const account = await new FileAccountStore().getOrCreate('auth0|user');
    expect(account.imageGenerationsRemaining).toBeUndefined();
    expect(account.creditsRemaining).toBe(4);
    expect(mocks.getGenerationQuota).not.toHaveBeenCalled();
  });
});
